#!/usr/bin/env node
/**
 * branchdeck — local preview deployments for every git branch.
 *
 * Runs an independent, self-contained preview of any number of branches side
 * by side from ONE clone, one browser tab each, without maintaining separate
 * checkouts or tracking git state by hand.
 *
 * Each branch gets a "slot": a git worktree pinned to origin/<branch>, links
 * into shared dependency pools, generated env files, and one port per
 * declared service. `branchdeck watch` polls the remote and re-syncs,
 * rebuilds, and restarts any slot whose branch received new commits.
 *
 * The design point that makes this practical rather than a disk-space
 * disaster: dependency pools are CONTENT-ADDRESSED. A pool entry is keyed by
 * the hash of the manifests that produced it, so branches with identical
 * dependencies share one install, while a branch that genuinely changes its
 * manifests transparently gets its own. Naive symlink sharing gets this
 * wrong and silently runs a branch against another branch's dependencies.
 *
 * Everything project-specific lives in preview.config.json; this file
 * contains no assumptions about language, framework, or layout.
 *
 * Zero runtime dependencies. Node 18+.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRESETS, detectPreset } from './presets.mjs';

const IS_WIN = process.platform === 'win32';
/** venv/virtualenv script directory name — differs on Windows. */
const BIN = IS_WIN ? 'Scripts' : 'bin';
const STATE_VERSION = 2;
export const CONFIG_NAMES = ['preview.config.json', '.preview.config.json'];
/** Written into a pool only after a fully successful install. */
const DONE_MARKER = '.branchdeck-complete';

const VERSION = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

let VERBOSE = false;

/**
 * Optional extra destination for progress messages. The browser UI installs
 * one so long-running operations stream into the page as they happen, rather
 * than appearing only in the terminal that launched the server.
 */
let logSink = null;
export const setLogSink = (fn) => { logSink = fn; };

const log = (msg) => {
  console.log(`[branchdeck] ${msg}`);
  if (logSink) logSink('info', msg);
};
const warn = (msg) => {
  console.error(`[branchdeck] warning: ${msg}`);
  if (logSink) logSink('warn', msg);
};
const debug = (msg) => VERBOSE && console.error(`[branchdeck] debug: ${msg}`);

/**
 * In the CLI a fatal error should end the process. The long-running UI server
 * must instead survive it — one bad branch cannot be allowed to take down the
 * control pane — so it switches this to throwing, and its job queue reports
 * the failure in the activity log.
 */
let exitOnFail = true;
export const setExitOnFail = (v) => { exitOnFail = v; };

// The UI server captures command output to per-preview log files and shows
// progress in the page, so echoing it to the server's console too is noise.
let echoCommands = true;
export const setEchoCommands = (v) => { echoCommands = v; };

function fail(msg) {
  if (!exitOnFail) throw new Error(msg);
  console.error(`[branchdeck] ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Paths — resolved lazily so `help`/`version` work outside a repository
// ---------------------------------------------------------------------------

let REPO_ROOT = null;
let DECK_DIR = null;
let WT_DIR = null;
let LOGS_DIR = null;
let POOL_DIR = null;
let STATE_FILE = null;
let SETTINGS_FILE = null;
let LOCK_FILE = null;

/**
 * Resolve the MAIN clone's root from wherever the command was run.
 * --git-common-dir (not --show-toplevel) so this also resolves correctly when
 * run from inside one of the preview worktrees.
 */
function detectRepoRoot() {
  let res = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  let gitDir = res.status === 0 ? res.stdout.trim() : '';
  if (!gitDir) {
    // git < 2.31 has no --path-format; the bare form may answer relatively.
    res = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8', windowsHide: true });
    const raw = res.status === 0 ? res.stdout.trim() : '';
    if (raw) gitDir = path.resolve(process.cwd(), raw);
  }
  if (!gitDir) {
    console.error(`[branchdeck] ERROR: not inside a git repository:\n    ${process.cwd()}`);
    console.error('[branchdeck] cd into your clone first. (`branchdeck help` works anywhere.)');
    process.exit(1);
  }
  return path.dirname(gitDir);
}

export function initPaths() {
  REPO_ROOT = detectRepoRoot();
  // All state lives OUTSIDE the repo so `git status` never sees it.
  DECK_DIR = path.join(path.dirname(REPO_ROOT), `${path.basename(REPO_ROOT)}-previews`);
  WT_DIR = path.join(DECK_DIR, 'wt');
  LOGS_DIR = path.join(DECK_DIR, 'logs');
  POOL_DIR = path.join(DECK_DIR, 'pool');
  STATE_FILE = path.join(DECK_DIR, 'state.json');
  SETTINGS_FILE = path.join(DECK_DIR, 'settings.json');
  LOCK_FILE = path.join(DECK_DIR, '.lock');
}

const rel = (p) => path.relative(REPO_ROOT, p) || '.';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export const sanitize = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-');

export function validBranchName(branch) {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) && !branch.includes('..');
}

function contentKey(files) {
  const h = createHash('sha256');
  for (const file of files) {
    try {
      h.update(fs.readFileSync(file));
    } catch {
      h.update('\0absent\0');
    }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

/**
 * Options that run `command` through the platform shell, so config commands
 * may use &&, quoting and pipes.
 *
 * This delegates to Node's own `shell: true` handling rather than spawning
 * cmd.exe with a hand-built argument array. Passing ['/d','/s','/c', command]
 * looks equivalent but is not: Node escapes the embedded quotes, so a config
 * command containing a quoted path — the normal case on Windows, where paths
 * have spaces — arrives at the program with literal quote characters in it
 * ("[WinError 123] The filename, directory name, or volume label syntax is
 * incorrect"). Node's shell handling sets windowsVerbatimArguments for exactly
 * this reason.
 */
const shellOptions = () => ({ shell: true, windowsHide: true });

/** Last few lines a command wrote to the log, for inline error reporting. */
function outputSince(logFile, offset, maxLines = 12) {
  try {
    const fd = fs.openSync(logFile, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return '';
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      const lines = buf.toString('utf8').split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
      return lines.slice(-maxLines).join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * Run a shell command to completion; throw on non-zero exit.
 *
 * A failure quotes what the command actually printed. Reporting only the exit
 * code sends the user off to hunt through a log file for the one line that
 * explains the problem, which is exactly when they are least inclined to.
 */
function runShell(command, { cwd, env, logFile, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    let fd = null;
    if (logFile) {
      fd = fs.openSync(logFile, 'a');
      fs.writeSync(fd, `\n$ ${command}\n`);
    }
    const recent = []; // tail kept in memory for the error message
    const child = spawn(command, {
      ...shellOptions(),
      cwd: cwd || REPO_ROOT,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onChunk = (buf) => {
      const text = buf.toString();
      if (fd !== null) fs.writeSync(fd, text);
      // Echo to the terminal as it happens. An `npm ci` or a webpack build can
      // run for minutes; with the output hidden in a log file it looks hung,
      // and the natural reaction is Ctrl+C — which corrupts a half-written
      // dependency pool. Progress is what stops that.
      if (echoCommands && !quiet) process.stdout.write(text);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) recent.push(line.trimEnd());
      }
      if (recent.length > 40) recent.splice(0, recent.length - 40);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    const finish = (fn) => { if (fd !== null) { fs.closeSync(fd); fd = null; } fn(); };

    child.on('error', (err) => finish(() => reject(new Error(`failed to start: ${err.message}`))));
    child.on('close', (code, signal) => finish(() => {
      if (code === 0) return resolve();
      const tail = recent.slice(-12).map((l) => `    | ${l}`).join('\n');
      const how = signal
        ? `was interrupted (${signal})`
        : `exited ${code}`;
      reject(new Error(
        `command ${how}: ${command}` +
          (tail ? `\n${tail}` : '') +
          (logFile ? `\n  full output: ${rel(logFile)}` : ''),
      ));
    }));
  });
}

/**
 * Delete a directory, tolerating the transient locks Windows takes on files
 * an antivirus scanner or an aborted installer still holds.
 */
function removeDirWithRetry(dir, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return true;
    } catch (err) {
      if (i === attempts - 1) {
        warn(`could not fully remove ${rel(dir)} (${err.code || err.message}) — delete it by hand if a retry fails`);
        return false;
      }
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { windowsHide: true });
    }
  }
  return false;
}

function git(args, cwd = REPO_ROOT) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || '').trim()}`);
  }
  return (res.stdout || '').trim();
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but owned by another user
  }
}

/**
 * Epoch seconds at which `pid` started, or null if it cannot be determined.
 *
 * Used to defend against PID reuse: the OS recycles process IDs, so a stale
 * PID recorded in state may by now belong to an unrelated process, and
 * killing it blindly is how a tool like this ends up terminating somebody's
 * database.
 */
function processStartEpoch(pid) {
  try {
    if (IS_WIN) {
      const res = spawnSync(
        'powershell',
        ['-NoProfile', '-Command',
          // Parenthesise so the cast applies to TotalSeconds (a double), not
          // to the TimeSpan; UTC so timezone offsets cannot skew the compare.
          `[int64](((Get-Process -Id ${pid}).StartTime.ToUniversalTime() - [datetime]'1970-01-01T00:00:00Z').TotalSeconds)`],
        { encoding: 'utf8', windowsHide: true },
      );
      const v = Number.parseInt((res.stdout || '').trim(), 10);
      return Number.isFinite(v) ? v : null;
    }
    // POSIX: elapsed seconds is simpler and more portable than absolute start.
    const res = spawnSync('ps', ['-o', 'etimes=', '-p', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const elapsed = Number.parseInt((res.stdout || '').trim(), 10);
    return Number.isFinite(elapsed) ? Math.floor(Date.now() / 1000) - elapsed : null;
  } catch {
    return null;
  }
}

/** True when `pid` still looks like the process we recorded starting. */
function isOurProcess(proc) {
  if (!proc || !pidAlive(proc.pid)) return false;
  if (!proc.startedAt) return true; // legacy state — nothing to compare
  const actual = processStartEpoch(proc.pid);
  if (actual === null) return true; // cannot verify; assume ours
  const drift = Math.abs(actual - Math.floor(proc.startedAt / 1000));
  if (drift > 120) {
    debug(`pid ${proc.pid} start time differs by ${drift}s — treating as recycled`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Next port that is neither claimed by another slot nor already bound by
 * something else on this machine.
 */
async function allocatePort(state, settings, claimed) {
  const taken = new Set(claimed);
  for (const slot of Object.values(state.slots)) {
    for (const p of Object.values(slot.ports || {})) taken.add(p);
  }
  let port = settings.basePort;
  for (let i = 0; i < 500; i += 1, port += 1) {
    if (taken.has(port)) continue;
    if (await portFree(port)) return port;
  }
  throw new Error(`no free port found starting at ${settings.basePort}`);
}

// ---------------------------------------------------------------------------
// Single-instance lock (state.json and pool builds are not concurrency-safe)
// ---------------------------------------------------------------------------

let lockHeld = false;

/** Take the lock, or return the blocking pid. Never exits the process. */
export function tryAcquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      lockHeld = true;
      return { ok: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = readJson(LOCK_FILE, null);
      if (holder && pidAlive(holder.pid) && holder.pid !== process.pid) {
        return { ok: false, pid: holder.pid };
      }
      fs.rmSync(LOCK_FILE, { force: true }); // stale lock
    }
  }
  return { ok: false };
}

function acquireLock() {
  const res = tryAcquireLock();
  if (!res.ok) {
    fail(
      `another branchdeck command is running${res.pid ? ` (pid ${res.pid})` : ''}.\n` +
        `    If that is wrong, delete ${LOCK_FILE}`,
    );
  }
}

export function releaseLock() {
  if (lockHeld) {
    fs.rmSync(LOCK_FILE, { force: true });
    lockHeld = false;
  }
}

// ---------------------------------------------------------------------------
// Settings (machine-local) and project config (committed)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  basePort: 8101,
  browser: null, // "chrome" | "msedge" | "firefox" | null = OS default
  watchIntervalSeconds: 60,
  // Re-navigate preview tabs the control pane opened once their services have
  // restarted. Off by default: reloading a tab someone is typing into loses
  // their work, so this is the user's call, not ours.
  autoReloadTabs: false,
  // Master switch for the in-page auto-reload watcher (config "reload").
  // Set false to stop injecting it without editing preview.config.json.
  autoReload: true,
  env: {}, // extra env vars for every service; ${...} expanded
};

export function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) writeJson(SETTINGS_FILE, DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };
}

export function findConfigFile(dir) {
  for (const name of CONFIG_NAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Load the project config from a specific tree (the main clone, or a
 * worktree — a branch may legitimately change its own config).
 */
export function loadConfig(fromDir) {
  const file = findConfigFile(fromDir);
  if (!file) {
    fail(
      `no preview.config.json found in ${fromDir}\n` +
        '    Run:  branchdeck init      (detects your stack and writes one)',
    );
  }
  let raw;
  try {
    raw = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    fail(`${file} is not valid JSON: ${err.message}`);
  }
  validateConfig(raw, file);
  return raw;
}

/** Tolerate // and /* *\/ comments so configs can be self-documenting. */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i += 1; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 1; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i += 1; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 1; continue; }
    out += c;
  }
  return out;
}

function configErrors(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return ['config must be a JSON object'];
  const services = cfg.services;
  if (!Array.isArray(services) || services.length === 0) {
    errors.push('"services" must be a non-empty array — at least one process to run');
  } else {
    const ids = new Set();
    services.forEach((s, i) => {
      if (!s.id) errors.push(`services[${i}] is missing "id"`);
      else if (ids.has(s.id)) errors.push(`duplicate service id "${s.id}"`);
      else ids.add(s.id);
      if (!s.run) errors.push(`services[${s.id || i}] is missing "run"`);
    });
  }
  const poolIds = new Set();
  for (const [i, p] of (cfg.pools || []).entries()) {
    if (!p.id) errors.push(`pools[${i}] is missing "id"`);
    else if (poolIds.has(p.id)) errors.push(`duplicate pool id "${p.id}"`);
    else poolIds.add(p.id);
    if (!Array.isArray(p.manifests) || p.manifests.length === 0) {
      errors.push(`pools[${p.id || i}] needs "manifests" (files whose content keys the pool)`);
    }
    if (!p.install) errors.push(`pools[${p.id || i}] is missing "install"`);
  }
  // Referenced pool ids must exist, or ${POOL:x} silently expands to nothing.
  const text = JSON.stringify(cfg);
  for (const m of text.matchAll(/\$\{POOL:([A-Za-z0-9_-]+)\}/g)) {
    if (!poolIds.has(m[1])) errors.push(`\${POOL:${m[1]}} refers to an undefined pool "${m[1]}"`);
  }
  const serviceIds = new Set((services || []).map((s) => s.id));
  for (const m of text.matchAll(/\$\{PORT:([A-Za-z0-9_-]+)\}/g)) {
    if (!serviceIds.has(m[1])) errors.push(`\${PORT:${m[1]}} refers to an undefined service "${m[1]}"`);
  }
  return errors;
}

function validateConfig(cfg, file) {
  const errors = configErrors(cfg);
  if (errors.length) {
    fail(`invalid configuration in ${file}:\n    - ${errors.join('\n    - ')}`);
  }
}

/**
 * Non-fatal config check for the browser UI, which must stay up precisely
 * *because* the config is broken — that is when you need the editor.
 */
export function inspectConfig(dir, text = null) {
  const file = text === null ? findConfigFile(dir) : (findConfigFile(dir) || path.join(dir, CONFIG_NAMES[0]));
  if (text === null && !file) return { ok: false, file: null, error: 'No preview.config.json in this repository. Run `branchdeck init`, or write one here.' };
  let raw;
  try {
    raw = JSON.parse(stripJsonComments(text ?? fs.readFileSync(file, 'utf8')));
  } catch (err) {
    return { ok: false, file, error: `Not valid JSON: ${err.message}` };
  }
  const errors = configErrors(raw);
  return errors.length
    ? { ok: false, file, error: errors.map((e) => `• ${e}`).join('\n'), config: raw }
    : { ok: true, file, config: raw };
}

/**
 * The config governing one preview.
 *
 * A branch may ship its own preview.config.json — that is how a branch adds a
 * service — but it is equally valid for it not to: the file can be kept
 * untracked (`.git/info/exclude`) when you would rather not commit it, in
 * which case no worktree will ever contain it. Falling back to the clone's
 * copy is therefore the normal path, not an error.
 */
export function configForWorktree(worktree) {
  return loadConfig(findConfigFile(worktree) ? worktree : REPO_ROOT);
}

export function inspectConfigForWorktree(worktree) {
  return inspectConfig(findConfigFile(worktree) ? worktree : REPO_ROOT);
}

export const paths = () => ({
  REPO_ROOT, DECK_DIR, WT_DIR, LOGS_DIR, POOL_DIR, STATE_FILE, SETTINGS_FILE,
});

export function gitLines(args) {
  const res = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) throw new Error((res.stderr || 'git failed').trim());
  return (res.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Variable expansion
// ---------------------------------------------------------------------------

/**
 * Expand ${VAR} and ${VAR:key} placeholders.
 *
 * Available: PORT, PORT:<serviceId>, WORKTREE, REPO, BRANCH, SLOT, BIN,
 *            POOL, POOL:<poolId>, MANIFEST, DECK
 */
function expand(value, ctx) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => expand(v, ctx));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, ctx)]));
  }
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z_]+)(?::([A-Za-z0-9_-]+))?\}/g, (whole, name, key) => {
    switch (name) {
      case 'PORT':
        if (key) {
          if (ctx.ports?.[key] == null) throw new Error(`unknown service in ${whole}`);
          return String(ctx.ports[key]);
        }
        return ctx.port == null ? whole : String(ctx.port);
      case 'POOL':
        if (key) {
          if (!ctx.pools?.[key]) throw new Error(`unknown pool in ${whole}`);
          return ctx.pools[key];
        }
        return ctx.pool ?? whole;
      case 'WORKTREE': return ctx.worktree ?? whole;
      case 'REPO': return REPO_ROOT;
      case 'DECK': return DECK_DIR;
      case 'BRANCH': return ctx.branch ?? whole;
      case 'SLOT': return ctx.slot ?? whole;
      case 'BIN': return BIN;
      case 'MANIFEST': return ctx.manifest ?? whole;
      default: return whole; // leave unknown placeholders alone
    }
  });
}

// ---------------------------------------------------------------------------
// Filesystem links (junction on Windows — no admin rights required)
// ---------------------------------------------------------------------------

function removeLinkOrDir(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    try {
      fs.unlinkSync(target);
    } catch {
      fs.rmdirSync(target); // Windows junctions sometimes need rmdir
    }
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function linkDir(linkPath, targetDir) {
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink() && fs.realpathSync(linkPath) === fs.realpathSync(targetDir)) return false;
  } catch {
    /* absent */
  }
  removeLinkOrDir(linkPath);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(targetDir, linkPath, 'junction');
  return true;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export const slotPaths = (slot) => ({
  worktree: path.join(WT_DIR, slot.name),
  log: path.join(LOGS_DIR, `${slot.name}.log`),
});

/** Each service's console output gets its own stream, apart from build noise. */
export const serviceLogPath = (slot, serviceId) =>
  path.join(LOGS_DIR, `${slot.name}.${sanitize(serviceId)}.log`);

export function fetchBranch(branch) {
  git(['fetch', '--quiet', 'origin', branch]);
  return git(['rev-parse', `refs/remotes/origin/${branch}`]);
}

/** The service whose URL `open` should open. */
export function primaryService(config) {
  return config.services.find((s) => s.open) || config.services[0];
}

/** Human name for a service's console: "Backend — my/branch". */
export const serviceLabel = (svc, branch) => `${svc.label || svc.id} — ${branch}`;

export function slotUrl(slot, config) {
  const svc = primaryService(config);
  const port = slot.ports?.[svc.id];
  return port ? `http://localhost:${port}` : null;
}

// --- dependency pools -------------------------------------------------------

const poolReady = (dir) => fs.existsSync(path.join(dir, DONE_MARKER));

/**
 * Ensure every configured pool exists for this slot's manifests, and link the
 * results into the worktree. Returns a map of poolId -> absolute path.
 */
async function ensurePools(slot, config, ctx) {
  const { worktree, log: logFile } = slotPaths(slot);
  const pools = {};
  slot.poolKeys = slot.poolKeys || {};

  for (const pool of config.pools || []) {
    const manifests = pool.manifests.map((m) => path.join(worktree, m));
    const missing = manifests.filter((m) => !fs.existsSync(m));
    if (missing.length === pool.manifests.length) {
      throw new Error(
        `pool "${pool.id}": none of its manifests exist on this branch ` +
          `(${pool.manifests.join(', ')})`,
      );
    }
    const key = contentKey(manifests);
    const dir = path.join(POOL_DIR, pool.id, key);
    pools[pool.id] = dir;

    if (!poolReady(dir)) {
      removeDirWithRetry(dir);
      fs.mkdirSync(dir, { recursive: true });
      // Package managers that key off a manifest in CWD (npm ci, bundler…)
      // need it present in the pool; ones taking an explicit path use
      // ${MANIFEST}, which still points at the worktree original so relative
      // includes inside it keep resolving.
      if (pool.copyManifests !== false) {
        for (const m of manifests) {
          if (fs.existsSync(m)) fs.copyFileSync(m, path.join(dir, path.basename(m)));
        }
      }
      const poolCtx = { ...ctx, pool: dir, pools, manifest: manifests[0] };
      log(`  [${slot.branch}] installing pool ${pool.id}/${key} — once for every branch with these manifests`);
      const cwd = pool.installIn === 'worktree' ? worktree : dir;
      const cmds = Array.isArray(pool.install) ? pool.install : [pool.install];
      for (const cmd of cmds) {
        await runShell(expand(cmd, poolCtx), { cwd, env: expand(pool.env || {}, poolCtx), logFile });
      }
      fs.writeFileSync(path.join(dir, DONE_MARKER), `${new Date().toISOString()}\n`);
    } else if (slot.poolKeys[pool.id] !== key) {
      log(`  [${slot.branch}] using shared pool ${pool.id}/${key} (no install needed)`);
    }

    for (const [linkPath, target] of Object.entries(pool.link || {})) {
      linkDir(path.join(worktree, linkPath), expand(target, { ...ctx, pool: dir, pools }));
    }
    slot.poolKeys[pool.id] = key;
  }
  return pools;
}

// --- env files --------------------------------------------------------------

/**
 * Materialise the env files a preview needs. The developer's own untracked env
 * file is copied verbatim, then a managed block is appended; dotenv loaders
 * take the LAST occurrence of a key, so appended values win.
 */
function writeEnvFiles(slot, config, ctx) {
  const { worktree } = slotPaths(slot);
  for (const spec of config.envFiles || []) {
    const sources = (spec.copyFrom || []).map((p) => path.join(REPO_ROOT, p));
    const source = sources.find((p) => fs.existsSync(p));
    const base = source ? fs.readFileSync(source, 'utf8') : '';
    if (!source && spec.required) {
      throw new Error(`env file not found in your clone: ${(spec.copyFrom || []).join(' or ')}`);
    }

    const lines = [];
    for (const [key, values] of Object.entries(spec.appendToCsv || {})) {
      const existing = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm')
        .exec(base)?.[1]?.trim()?.replace(/^["']|["']$/g, '');
      const merged = [
        ...new Set([
          ...(existing ? existing.split(',').map((s) => s.trim()).filter(Boolean) : []),
          ...expand(values, ctx),
        ]),
      ];
      lines.push(`${key}=${merged.join(',')}`);
    }
    for (const [key, value] of Object.entries(expand(spec.set || {}, ctx))) {
      lines.push(`${key}=${value}`);
    }

    const target = path.join(worktree, spec.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      [
        base.trimEnd(),
        '',
        '# --- managed by branchdeck (regenerated on every sync) ---',
        ...lines,
        '',
      ].join('\n'),
    );
  }
}

// --- build ------------------------------------------------------------------

async function runBuild(slot, config, ctx, newSha) {
  const { worktree, log: logFile } = slotPaths(slot);
  const steps = Array.isArray(config.build) ? config.build : config.build ? [config.build] : [];
  slot.buildShas = slot.buildShas || {};

  for (const [i, step] of steps.entries()) {
    const id = step.id || `build${i}`;
    const watch = step.when || step.watch;
    let changed = true;
    const previous = slot.buildShas[id];
    const outputPresent = !step.output || fs.existsSync(path.join(worktree, step.output));

    if (previous && outputPresent) {
      if (!watch || watch.length === 0) {
        changed = previous !== newSha;
      } else {
        try {
          changed = git(['diff', '--name-only', previous, newSha, '--', ...watch], worktree) !== '';
        } catch {
          changed = true; // previous sha unreachable (force-push) — rebuild
        }
      }
    }
    if (!changed) continue;
    log(`  [${slot.branch}] ${step.name || `running build step ${id}`} ...`);
    await runShell(expand(step.run, ctx), {
      cwd: path.join(worktree, step.cwd || '.'),
      env: expand(step.env || {}, ctx),
      logFile,
    });
    slot.buildShas[id] = newSha;
  }
}

// --- auto-reload --------------------------------------------------------------

const RELOAD_MARKER = 'data-branchdeck-reload';
const RELOAD_SCRIPT_BASENAME = 'branchdeck-reload.js';

/**
 * The watcher written into a preview's build output as its OWN JavaScript
 * file, referenced by a plain <script src> tag.
 *
 * An external same-origin file — not an inline snippet — because real apps
 * ship Content-Security-Policy headers, and the common `script-src 'self'`
 * silently discards inline scripts while permitting exactly this. An inline
 * watcher "works" on toy servers and then does nothing on any
 * security-conscious app, which is the worst kind of failure: invisible.
 *
 * Auto-reload has to work for a tab opened any way at all — from `open`, a
 * bookmark, a URL typed by hand — which rules out anything that depends on
 * holding a window handle. So the page itself does the watching: it polls a
 * small revision file this tool rewrites on every sync, and reloads when the
 * id changes. Same idea as livereload, minus the proxy.
 *
 * It is deliberately forgiving: a server that answers unknown paths with the
 * SPA shell yields unparseable JSON, and the watcher simply does nothing
 * rather than reloading in a loop.
 */
const reloadWatcherJs = (urlPath, seconds) => `// written by branchdeck on every sync
(function () {
  var current = null;
  var url = ${JSON.stringify(urlPath)};
  function check() {
    fetch(url + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var data;
        try { data = JSON.parse(text); } catch (e) { return; }
        if (!data || typeof data.id !== 'string') return;
        if (current === null) { current = data.id; return; }
        if (data.id !== current) { location.reload(); }
      })
      .catch(function () {});
  }
  setInterval(check, ${Math.max(1, seconds) * 1000});
  window.addEventListener('focus', check);
  check();
})();
`;

/**
 * Stamp the current revision into the preview's build output, write the
 * watcher script beside it, and make sure the built HTML references it. Runs
 * on every sync, not only when the build step ran, so a backend-only commit
 * still refreshes open tabs.
 */
function applyReloadHook(slot, config, newSha, settings) {
  const spec = config.reload;
  if (!spec || settings.autoReload === false) return;
  const { worktree } = slotPaths(slot);
  const targets = (Array.isArray(spec.injectInto) ? spec.injectInto : [spec.injectInto]).filter(Boolean);
  if (!targets.length) return;

  const outDir = path.dirname(path.join(worktree, targets[0]));
  const idFile = spec.idFile ? path.join(worktree, spec.idFile) : path.join(outDir, 'branchdeck-build.json');
  const urlPath = spec.urlPath || `/${path.basename(idFile)}`;
  const scriptFile = path.join(path.dirname(idFile), RELOAD_SCRIPT_BASENAME);
  const scriptUrl = spec.scriptUrl || `/${RELOAD_SCRIPT_BASENAME}`;
  const seconds = Number(spec.intervalSeconds) || 3;

  try {
    fs.mkdirSync(path.dirname(idFile), { recursive: true });
    fs.writeFileSync(idFile, `${JSON.stringify({ id: `${newSha}`, at: new Date().toISOString() })}\n`);
    fs.writeFileSync(scriptFile, reloadWatcherJs(urlPath, seconds));
  } catch (err) {
    warn(`${slot.branch}: could not write the reload watcher (${err.message})`);
    return;
  }

  for (const target of targets) {
    const file = path.join(worktree, target);
    if (!fs.existsSync(file)) {
      warn(`${slot.branch}: auto-reload target not found after build: ${target}`);
      continue;
    }
    let html = fs.readFileSync(file, 'utf8');
    if (html.includes(RELOAD_MARKER)) continue; // a fresh build wipes it; re-add only when absent
    const tag = `<script src="${scriptUrl}" defer ${RELOAD_MARKER}></script>`;
    html = html.includes('</body>')
      ? html.replace('</body>', `${tag}\n</body>`)
      : `${html}\n${tag}`;
    fs.writeFileSync(file, html);
  }
}

// --- service processes ------------------------------------------------------

function startServices(slot, config, ctx) {
  const { worktree, log: logFile } = slotPaths(slot);
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  slot.procs = slot.procs || {};

  for (const svc of config.services) {
    const port = slot.ports[svc.id];
    const svcCtx = { ...ctx, port };
    const header = `\n===== start ${slot.branch} :: ${svc.id} on ${port} @ ${slot.syncedSha} =====\n`;
    // Lifecycle header goes to the slot's main log; the service's own console
    // output gets its own file, so each server can be followed as a clean
    // stream (`branchdeck logs <branch> <service> --follow`, or a console tab).
    fs.appendFileSync(logFile, header);
    const svcLog = serviceLogPath(slot, svc.id);
    const out = fs.openSync(svcLog, 'a');
    fs.writeSync(out, header);
    const child = spawn(expand(svc.run, svcCtx), {
      ...shellOptions(),
      cwd: path.join(worktree, svc.cwd || '.'),
      env: { ...process.env, ...expand(svc.env || {}, svcCtx), PORT: String(port) },
      // POSIX: detached, so the service leads its own process group — it must
      // outlive this CLI and must not receive the console's Ctrl+C during
      // `watch`. Windows: NOT detached, deliberately. DETACHED_PROCESS makes
      // Windows ignore CREATE_NO_WINDOW (the windowsHide flag), so a
      // console-less shell's child — python, node — allocates itself a brand
      // new VISIBLE console window per service. windowsHide alone gives the
      // tree one hidden console: no windows, no Ctrl+C propagation (it is not
      // our console), and children on Windows survive parent exit regardless.
      detached: !IS_WIN,
      stdio: ['ignore', out, out],
    });
    child.unref();
    fs.closeSync(out);
    let pid = child.pid;
    if (IS_WIN) {
      const real = resolveWindowsServicePid(child.pid);
      if (real) pid = real;
    }
    slot.procs[svc.id] = { pid, startedAt: Date.now() };
  }
}

/**
 * Windows only: the pid spawn() returns is the cmd.exe wrapper's — and with a
 * non-detached spawn, libuv's kill-on-close job object takes the wrapper down
 * as soon as this CLI process exits, while the actual server (the wrapper's
 * child) lives on. Recording the wrapper pid therefore looks like a dead
 * preview to every LATER branchdeck invocation. Resolve the wrapper's first
 * child — the real server — and record that instead.
 */
function resolveWindowsServicePid(wrapperPid) {
  for (let i = 0; i < 10; i += 1) {
    const res = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${wrapperPid}" | Select-Object -First 1 -ExpandProperty ProcessId)`,
    ], { encoding: 'utf8', windowsHide: true });
    const v = Number.parseInt((res.stdout || '').trim(), 10);
    if (Number.isFinite(v)) return v;
    if (!pidAlive(wrapperPid)) return null; // wrapper already gone, nothing to find
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)'], { windowsHide: true });
  }
  return null;
}

/** Signal a service's whole process tree. */
function signalTree(pid, signal) {
  try {
    if (IS_WIN) {
      // /T covers the tree: the cmd.exe wrapper plus the real server.
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // The service was spawned detached, so it leads its own process group.
      // Signalling the GROUP matters: `sh -c` does not always exec away, so
      // the recorded pid can be a wrapper whose child holds the port.
      try {
        process.kill(-pid, signal);
      } catch {
        process.kill(pid, signal);
      }
    }
  } catch {
    /* already gone */
  }
}

/**
 * Stop a slot's services and do not return until their ports are actually
 * free.
 *
 * Waiting on the recorded pid alone is not enough: that pid may be a shell
 * wrapper that exits before the real server has released its listening
 * socket, in which case the replacement fails to bind while the health check
 * happily succeeds against the *dying* process — a preview that reports ready
 * and then refuses connections.
 */
export async function stopServices(slot, { quiet = false } = {}) {
  const procs = Object.entries(slot.procs || {}).filter(([, p]) => p?.pid);
  for (const [id, proc] of procs) {
    if (!pidAlive(proc.pid)) continue;
    if (!isOurProcess(proc)) {
      // Refuse to kill: this pid was recycled and now belongs to something
      // else. Forgetting the record is the safe outcome.
      warn(`pid ${proc.pid} (${slot.branch}/${id}) is no longer our process — not killing it`);
      slot.procs[id] = null;
      continue;
    }
    signalTree(proc.pid, 'SIGTERM');
  }

  const ports = Object.values(slot.ports || {});
  const settled = async () => {
    for (const [, proc] of procs) if (proc?.pid && pidAlive(proc.pid)) return false;
    for (const port of ports) if (!(await portFree(port))) return false;
    return true;
  };

  const graceful = Date.now() + 10_000;
  while (Date.now() < graceful && !(await settled())) await sleep(200);

  if (!(await settled())) {
    if (IS_WIN) {
      // taskkill /T can miss grandchildren spawned through a hidden-console
      // shell (observed on the GitHub Windows runners: the cmd wrapper dies,
      // the node child survives). Killing whoever LISTENS on the port we
      // allocated is precise — we allocated the port and started the
      // listener, so its owner is our service tree by construction.
      for (const port of ports) {
        spawnSync('powershell', ['-NoProfile', '-Command',
          `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
        ], { stdio: 'ignore', windowsHide: true });
      }
    } else {
      for (const [, proc] of procs) if (proc?.pid && pidAlive(proc.pid)) signalTree(proc.pid, 'SIGKILL');
    }
    const forced = Date.now() + 5_000;
    while (Date.now() < forced && !(await settled())) await sleep(200);
    if (!(await settled())) {
      warn(`${slot.branch}: a port is still in use after stopping — a restart may fail to bind`);
    }
  }

  for (const [id] of procs) {
    slot.procs[id] = null;
    if (!quiet) debug(`stopped ${slot.branch}/${id}`);
  }
}

function tcpReachable(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function httpOk(port, urlPath) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wait until every service answers. TCP-reachability is the default because it
 * needs no cooperation from the app; a service may opt into an HTTP check.
 */
async function waitHealthy(slot, config, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Map(config.services.map((s) => [s.id, s]));
  while (Date.now() < deadline) {
    for (const [id, svc] of [...pending]) {
      const proc = slot.procs?.[id];
      if (!proc?.pid || !pidAlive(proc.pid)) return { ok: false, service: id, reason: 'exited' };
      const port = slot.ports[id];
      const health = svc.health ?? {};
      const ok = health.path ? await httpOk(port, expand(health.path, {})) : await tcpReachable(port);
      if (ok) pending.delete(id);
    }
    if (pending.size === 0) return { ok: true };
    await sleep(1000);
  }
  return { ok: false, service: [...pending.keys()][0], reason: 'timeout' };
}

// --- sync -------------------------------------------------------------------

function slotContext(slot, worktree, pools = {}) {
  return {
    worktree,
    branch: slot.branch,
    slot: slot.name,
    ports: slot.ports || {},
    pools,
  };
}

export async function syncSlot(slot, settings, { force = false } = {}) {
  const { worktree, log: logFile } = slotPaths(slot);
  const newSha = fetchBranch(slot.branch);
  const running = Object.values(slot.procs || {}).some((p) => p && isOurProcess(p));
  if (newSha === slot.syncedSha && !force && running) return { changed: false };

  if (newSha !== slot.syncedSha) {
    log(`  [${slot.branch}] updating to ${newSha.slice(0, 10)} ...`);
    git(['reset', '--hard', newSha], worktree);
    git(['clean', '-fd'], worktree); // keeps ignored files: env, deps, builds
  }

  // The branch's own config governs its preview when it ships one; otherwise
  // the clone's config does (see configForWorktree).
  const config = configForWorktree(worktree);
  const ctx = slotContext(slot, worktree);

  // Allocate a port per service (stable across syncs unless the set changes).
  slot.ports = slot.ports || {};
  const claimed = new Set(Object.values(slot.ports));
  for (const svc of config.services) {
    if (!slot.ports[svc.id]) {
      const port = await allocatePort(loadState(), settings, claimed);
      slot.ports[svc.id] = port;
      claimed.add(port);
    }
  }
  for (const id of Object.keys(slot.ports)) {
    if (!config.services.some((s) => s.id === id)) delete slot.ports[id];
  }
  ctx.ports = slot.ports;

  ctx.pools = await ensurePools(slot, config, ctx);
  await runBuild(slot, config, ctx, newSha);
  applyReloadHook(slot, config, newSha, settings);
  writeEnvFiles(slot, config, { ...ctx, ...settings.env });
  slot.syncedSha = newSha;

  await stopServices(slot, { quiet: true });
  startServices(slot, config, { ...ctx, ...expand(settings.env || {}, ctx) });
  const health = await waitHealthy(slot, config);
  if (health.ok) {
    log(`  [${slot.branch}] ready -> ${slotUrl(slot, config)}`);
  } else {
    log(`  [${slot.branch}] FAILED (${health.service}: ${health.reason}) — see ${rel(logFile)}`);
  }
  return { changed: true, healthy: health.ok, config };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function loadState() {
  const state = readJson(STATE_FILE, { version: STATE_VERSION, slots: {} });
  if (!state.slots) state.slots = {};
  return state;
}

export const saveState = (state) => writeJson(STATE_FILE, { ...state, version: STATE_VERSION });

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function resolveTargets(state, arg) {
  const branches = Object.keys(state.slots);
  if (!arg || arg === '--all') {
    if (!branches.length) fail('no previews yet. Add one:  branchdeck add <branch>');
    return branches;
  }
  if (!state.slots[arg]) {
    fail(`no preview for branch "${arg}". Existing: ${branches.join(', ') || '(none)'}`);
  }
  return [arg];
}

export async function cmdAdd(branch, settings, state) {
  if (!branch) fail('usage: branchdeck add <branch>');
  if (!validBranchName(branch)) fail(`unsupported branch name: "${branch}"`);
  if (state.slots[branch]) {
    log(`preview for ${branch} already exists — syncing it instead.`);
    await syncSlot(state.slots[branch], settings);
    saveState(state);
    return;
  }
  let sha;
  try {
    sha = fetchBranch(branch);
  } catch {
    fail(`branch "${branch}" not found on origin.`);
  }
  const slot = {
    branch,
    name: sanitize(branch),
    ports: {},
    procs: {},
    poolKeys: {},
    buildShas: {},
    syncedSha: null,
  };
  const { worktree } = slotPaths(slot);
  log(`creating worktree for ${branch} at ${rel(worktree)} ...`);
  fs.mkdirSync(WT_DIR, { recursive: true });
  // Detached: the branch may also be checked out in the main clone, and we
  // always pin to origin/<branch> anyway.
  git(['worktree', 'add', '--detach', worktree, sha]);
  state.slots[branch] = slot;
  saveState(state);
  try {
    await syncSlot(slot, settings);
  } catch (err) {
    // Roll the half-created preview back. Leaving a worktree behind for a
    // preview that never started forces the user into `git worktree prune`,
    // and nothing of value is lost: shared pools survive on their own, and
    // there is no build yet.
    log(`  [${branch}] setup failed — removing the partial worktree`);
    await stopServices(slot, { quiet: true }).catch(() => {});
    try {
      git(['worktree', 'remove', '--force', worktree]);
    } catch {
      removeDirWithRetry(worktree);
      try { git(['worktree', 'prune']); } catch { /* best effort */ }
    }
    delete state.slots[branch];
    throw err;
  } finally {
    saveState(state);
  }
}

export async function cmdRemove(branch, state) {
  if (!branch || branch === '--all') fail('usage: branchdeck remove <branch>');
  const [target] = resolveTargets(state, branch);
  const slot = state.slots[target];
  const { worktree, log: logFile } = slotPaths(slot);
  await stopServices(slot);
  // Drop links before git touches the worktree, so nothing can recurse into a
  // SHARED pool while deleting this slot.
  try {
    const config = configForWorktree(worktree);
    for (const pool of config.pools || []) {
      for (const linkPath of Object.keys(pool.link || {})) {
        removeLinkOrDir(path.join(worktree, linkPath));
      }
    }
  } catch {
    /* config unreadable — worktree removal below still works */
  }
  try {
    git(['worktree', 'remove', '--force', worktree]);
  } catch {
    removeDirWithRetry(worktree);
    try { git(['worktree', 'prune']); } catch { /* best effort */ }
  }
  fs.rmSync(logFile, { force: true });
  for (const id of Object.keys(slot.ports || {})) {
    fs.rmSync(serviceLogPath(slot, id), { force: true });
  }
  delete state.slots[target];
  saveState(state);
  log(`removed preview for ${target}. Shared pools kept — free them with: branchdeck gc`);
}

async function cmdSync(arg, settings, state, { force = false } = {}) {
  for (const branch of resolveTargets(state, arg)) {
    try {
      const { changed } = await syncSlot(state.slots[branch], settings, { force });
      if (!changed) log(`  [${branch}] already up to date and running.`);
    } catch (err) {
      log(`  [${branch}] sync failed: ${err.message}`);
    }
    saveState(state);
  }
}

async function cmdStop(arg, state) {
  for (const branch of resolveTargets(state, arg)) {
    await stopServices(state.slots[branch]);
    log(`  [${branch}] stopped.`);
  }
  saveState(state);
}

function cmdStatus(state, { offline = false } = {}) {
  const branches = Object.keys(state.slots);
  if (!branches.length) {
    log('no previews. Add one:  branchdeck add <branch>');
    return;
  }
  const rows = branches.map((branch) => {
    const slot = state.slots[branch];
    let remote = 'not checked';
    if (!offline) {
      try {
        const sha = fetchBranch(branch);
        remote = sha === slot.syncedSha ? 'up to date' : `behind (${sha.slice(0, 10)})`;
      } catch {
        remote = 'fetch failed';
      }
    }
    const up = Object.entries(slot.procs || {}).filter(([, p]) => p && pidAlive(p.pid));
    return {
      branch,
      urls: Object.entries(slot.ports || {}).map(([id, p]) => `${id}:${p}`).join(' '),
      running: `${up.length}/${Object.keys(slot.ports || {}).length}`,
      synced: slot.syncedSha ? slot.syncedSha.slice(0, 10) : '-',
      remote,
      pools: Object.values(slot.poolKeys || {}).join(' ') || '-',
    };
  });
  console.table(rows);

  const perPool = {};
  for (const branch of branches) {
    for (const [id, key] of Object.entries(state.slots[branch].poolKeys || {})) {
      (perPool[id] ||= new Set()).add(key);
    }
  }
  const summary = Object.entries(perPool)
    .map(([id, keys]) => `${keys.size} ${id}`)
    .join(', ');
  if (summary) log(`${branches.length} preview(s) share ${summary} install(s).`);
  const orphans = orphanPools(state);
  if (orphans.length) log(`${orphans.length} unused pool(s) — free with: branchdeck gc`);
}

export function orphanPools(state) {
  const used = new Set();
  for (const slot of Object.values(state.slots)) {
    for (const [id, key] of Object.entries(slot.poolKeys || {})) used.add(`${id}/${key}`);
  }
  const orphans = [];
  let poolTypes = [];
  try {
    poolTypes = fs.readdirSync(POOL_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return orphans;
  }
  for (const type of poolTypes) {
    const dir = path.join(POOL_DIR, type.name);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !used.has(`${type.name}/${entry.name}`)) {
        orphans.push(path.join(dir, entry.name));
      }
    }
  }
  return orphans;
}

export function cmdGc(state) {
  const orphans = orphanPools(state);
  if (!orphans.length) {
    log('nothing to free — every dependency pool is still in use.');
    return;
  }
  for (const dir of orphans) {
    log(`  freeing ${rel(dir)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  log(`freed ${orphans.length} unused pool(s).`);
}

function cmdOpen(arg, settings, state) {
  const branches = resolveTargets(state, arg);
  const urls = [];
  for (const branch of branches) {
    const slot = state.slots[branch];
    const worktree = slotPaths(slot).worktree;
    let config = null;
    try { config = configForWorktree(worktree); } catch { /* fall through */ }
    const url = config ? slotUrl(slot, config) : null;
    if (url) urls.push(url);
  }
  if (!urls.length) fail('no preview URLs available — run: branchdeck sync');
  if (IS_WIN) {
    for (const url of urls) {
      const args = settings.browser
        ? ['/c', 'start', '', settings.browser, url]
        : ['/c', 'start', '', url];
      spawnSync('cmd', args, { stdio: 'ignore', windowsHide: true });
    }
  } else {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    for (const url of urls) spawnSync(opener, [url], { stdio: 'ignore' });
  }
  log(`opened: ${urls.join('  ')}`);
}

async function cmdWatch(settings, state) {
  const interval = Math.max(10, Number(settings.watchIntervalSeconds) || 60) * 1000;
  log(`watching ${Object.keys(state.slots).length} branch(es) every ${interval / 1000}s. Ctrl+C to stop.`);
  await cmdSync('--all', settings, state);
  for (;;) {
    await sleep(interval);
    for (const branch of Object.keys(state.slots)) {
      try {
        const { changed, healthy } = await syncSlot(state.slots[branch], settings);
        if (changed) {
          log(`${new Date().toLocaleTimeString()} — ${branch} updated${healthy === false ? ' (UNHEALTHY)' : ''}`);
        }
        saveState(state);
      } catch (err) {
        log(`${branch}: sync failed — ${err.message}`);
      }
    }
  }
}

function cmdLogs(branch, state, { service = null, follow = false, lines = 80 } = {}) {
  if (!branch || branch === '--all') {
    fail('usage: branchdeck logs <branch> [service] [--follow]');
  }
  const [target] = resolveTargets(state, branch);
  const slot = state.slots[target];
  const logFile = service ? serviceLogPath(slot, service) : slotPaths(slot).log;
  if (!fs.existsSync(logFile)) {
    const known = Object.keys(slot.ports || {});
    fail(
      `no ${service ? `"${service}" console ` : ''}log yet for ${target}.` +
        (service && !known.includes(service) ? `\n    services: ${known.join(', ') || '(none yet)'}` : ''),
    );
  }
  console.log(fs.readFileSync(logFile, 'utf8').split('\n').slice(-lines).join('\n'));
  if (!follow) {
    log(`(full log: ${rel(logFile)} — add --follow to stream it live)`);
    return;
  }
  log('--- following; Ctrl+C to stop (the preview keeps running) ---');
  // Poll-based tail: fs.watch is unreliable for appends on Windows.
  let offset = fs.statSync(logFile).size;
  setInterval(() => {
    let size;
    try {
      size = fs.statSync(logFile).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0; // rotated/truncated
    if (size === offset) return;
    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      process.stdout.write(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  }, 500);
}

/**
 * Open one terminal TAB per running service console, named "Backend — branch".
 *
 * Each tab is just a live tail of that service's log file — the servers
 * themselves stay hidden background processes. That split is what makes the
 * consoles safe to close: closing a tab stops the tail, never the server.
 * Windows Terminal (`wt`) gets real tabs in one window; without it, classic
 * titled console windows are the honest fallback.
 */
function cmdConsoles(arg, state) {
  const branches = resolveTargets(state, arg);
  const targets = [];
  for (const branch of branches) {
    const slot = state.slots[branch];
    let config = null;
    try {
      config = configForWorktree(slotPaths(slot).worktree);
    } catch {
      continue;
    }
    for (const svc of config.services) {
      const proc = slot.procs?.[svc.id];
      if (!proc || !pidAlive(proc.pid)) continue;
      targets.push({ title: serviceLabel(svc, branch), file: serviceLogPath(slot, svc.id) });
    }
  }
  if (!targets.length) fail('no running services. Start some with: branchdeck sync');

  if (IS_WIN) {
    const wt = spawnSync('where', ['wt'], { encoding: 'utf8', windowsHide: true }).status === 0;
    for (const t of targets) {
      const tailCmd = `Get-Content -LiteralPath '${t.file.replace(/'/g, "''")}' -Tail 50 -Wait`;
      if (wt) {
        // -w 0 lands each console as a TAB in the current/most recent window.
        spawnSync('wt', ['-w', '0', 'new-tab', '--title', t.title, 'powershell', '-NoLogo', '-NoExit', '-Command', tailCmd], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        spawnSync('cmd', ['/c', 'start', t.title, 'powershell', '-NoLogo', '-NoExit', '-Command', tailCmd], {
          stdio: 'ignore',
          windowsHide: true,
        });
      }
    }
    log(`opened ${targets.length} console tab(s)${wt ? '' : ' (install Windows Terminal to get tabs instead of windows)'}.`);
  } else {
    log('follow a console with:');
    for (const t of targets) log(`  tail -f ${JSON.stringify(t.file)}    # ${t.title}`);
  }
}

function cmdInit(arg) {
  const existing = findConfigFile(REPO_ROOT);
  if (existing && arg !== '--force') {
    fail(`${path.basename(existing)} already exists. Re-create it with: branchdeck init --force`);
  }
  const detected = detectPreset(REPO_ROOT, fs);
  const preset = PRESETS[detected] || PRESETS.generic;
  const target = path.join(REPO_ROOT, CONFIG_NAMES[0]);
  fs.writeFileSync(target, `${preset.config.trimEnd()}\n`);
  log(`detected: ${preset.label}`);
  log(`wrote ${rel(target)}`);
  if (preset.todo) {
    log('');
    log('Review it before your first `add` — in particular:');
    for (const item of preset.todo) log(`  - ${item}`);
  }
  log('');
  log('Then:  branchdeck add <branch>');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const HELP = `branchdeck ${VERSION} — local preview deployments for every git branch

One browser tab per branch, from a single clone. Dependencies are shared
across previews, so an extra branch costs megabytes, not gigabytes.

Usage: branchdeck <command>          (run from inside your repository)

  ui [--port N]          Open the browser control pane (add/manage previews)
  init [--force]         Detect your stack and write preview.config.json
  add <branch>           Create a preview for a remote branch and start it
  sync [<branch>|--all]  Fetch, rebuild what changed, restart
  watch                  Poll origin and auto-sync previews as branches move
  open [<branch>]        Open browser tab(s)
  status [--offline]     Table of previews: ports, running, sync state, pools
  stop [<branch>|--all]  Stop a preview's services
  restart [<branch>]     Rebuild if needed and restart, without new commits
  logs <branch> [svc] [--follow]  Show or live-stream a log / service console
  consoles [<branch>]    Open a named terminal tab per running service console
  remove <branch>        Delete a preview (shared pools are kept)
  gc                     Delete dependency pools nothing references
  help | version

Flags: --verbose

State lives beside your clone in <repo>-previews/ — nothing is written into
the repository itself. Config: preview.config.json (committed).
Docs: https://github.com/mhumphries-wlu/BranchDeck`;

const COMMANDS = new Set([
  'init', 'ui', 'add', 'remove', 'rm', 'sync', 'restart', 'stop',
  'status', 'open', 'watch', 'logs', 'consoles', 'gc',
]);

/** Must keep working even when preview.config.json is broken or absent. */
const CLEANUP_COMMANDS = new Set(['remove', 'rm', 'stop', 'gc', 'logs']);

async function main() {
  const argv = process.argv.slice(2).filter((a) => {
    if (a === '--verbose') { VERBOSE = true; return false; }
    return true;
  });
  const [cmd, arg] = argv;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') return console.log(VERSION);
  if (!COMMANDS.has(cmd)) {
    console.error(`[branchdeck] ERROR: unknown command "${cmd}"\n`);
    console.log(HELP);
    process.exit(1);
  }

  initPaths();
  fs.mkdirSync(DECK_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  if (cmd === 'init') return cmdInit(arg);

  if (cmd === 'ui') {
    // Imported lazily to break the cycle: ui.mjs reuses this module's
    // internals, and by now this module has finished evaluating.
    const { startUi } = await import('./ui.mjs');
    await startUi({
      port: argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : undefined,
      open: !argv.includes('--no-open'),
    });
    return; // server keeps the process alive
  }

  // Validate the clone's own config early, so a typo surfaces immediately
  // rather than midway through a slow first `add`. Cleanup commands stay
  // usable even when the config is broken or missing.
  if (!CLEANUP_COMMANDS.has(cmd)) loadConfig(REPO_ROOT);

  acquireLock();
  try {
    const settings = loadSettings();
    const state = loadState();
    switch (cmd) {
      case 'add': await cmdAdd(arg, settings, state); break;
      case 'remove': case 'rm': await cmdRemove(arg, state); break;
      case 'sync': await cmdSync(arg, settings, state); break;
      case 'restart': await cmdSync(arg, settings, state, { force: true }); break;
      case 'stop': await cmdStop(arg, state); break;
      case 'status': cmdStatus(state, { offline: arg === '--offline' }); break;
      case 'open': cmdOpen(arg, settings, state); break;
      case 'watch': await cmdWatch(settings, state); break;
      case 'logs': cmdLogs(arg, state, {
        service: argv[2] && !argv[2].startsWith('--') ? argv[2] : null,
        follow: argv.includes('--follow') || argv.includes('-f'),
      }); break;
      case 'consoles': cmdConsoles(arg, state); break;
      case 'gc': cmdGc(state); break;
    }
  } finally {
    releaseLock();
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { releaseLock(); process.exit(130); });
}
process.on('exit', releaseLock);

main().catch((err) => {
  releaseLock();
  fail(VERBOSE ? err.stack : err.message);
});
