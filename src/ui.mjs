/**
 * branchdeck's browser control pane.
 *
 * A local HTTP server plus a single self-contained page: pick a branch from a
 * dropdown to spin up a preview, watch progress stream in, and flip between
 * this tab and the preview tabs it opens. Configuration lives in a second
 * pane, so the whole loop stays in the browser.
 *
 * Design constraints:
 * - Bound to 127.0.0.1 and gated by a per-run token. This endpoint starts
 *   processes defined by preview.config.json, so it is treated as privileged:
 *   any page in your browser can POST to localhost, and the token plus the
 *   Origin/Host checks are what stop a random site from driving it.
 * - One job at a time, serialized, holding the same on-disk lock the CLI uses,
 *   so the UI and a terminal can coexist without corrupting state.
 * - Zero dependencies; the page is inlined below.
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  CONFIG_NAMES, cmdAdd, cmdGc, cmdRemove, gitLines, inspectConfig,
  inspectConfigForWorktree, loadSettings, setExitOnFail, setEchoCommands,
  loadState, paths, pidAlive, primaryService, releaseLock, saveState, setLogSink,
  serviceLabel, serviceLogPath, slotPaths, slotUrl, stopServices, syncSlot,
  tryAcquireLock, validBranchName,
} from './cli.mjs';

// ---------------------------------------------------------------------------
// Job queue — every mutating operation runs here, one at a time
// ---------------------------------------------------------------------------

const activity = []; // recent progress lines, newest last
let currentJob = null;
let queue = [];
let watchTimer = null;
let watchEnabled = false;

function push(level, message) {
  activity.push({ at: Date.now(), level, message });
  if (activity.length > 400) activity.splice(0, activity.length - 400);
}

setLogSink((level, message) => push(level, message));
// A failure inside one job must surface in the activity log, not terminate the
// control pane the user is looking at.
setExitOnFail(false);
setEchoCommands(false);

function enqueue(label, fn) {
  return new Promise((resolve) => {
    queue.push({ label, fn, resolve });
    drain();
  });
}

async function drain() {
  if (currentJob || queue.length === 0) return;
  const job = queue.shift();
  currentJob = { label: job.label, startedAt: Date.now() };

  const lock = tryAcquireLock();
  if (!lock.ok) {
    push('error', `cannot start "${job.label}": another branchdeck process is running (pid ${lock.pid ?? '?'})`);
    currentJob = null;
    job.resolve({ ok: false });
    return drain();
  }
  push('info', `▶ ${job.label}`);
  try {
    await job.fn();
    job.resolve({ ok: true });
  } catch (err) {
    push('error', `${job.label} failed: ${err.message}`);
    job.resolve({ ok: false, error: err.message });
  } finally {
    releaseLock();
    currentJob = null;
    drain();
  }
}

// ---------------------------------------------------------------------------
// Data for the page
// ---------------------------------------------------------------------------

function snapshot({ remote = false } = {}) {
  const state = loadState();
  const settings = loadSettings();
  const { REPO_ROOT } = paths();
  const cfg = inspectConfig(REPO_ROOT);

  const previews = Object.entries(state.slots).map(([branch, slot]) => {
    let url = null;
    let cfgServices = [];
    try {
      const wtCfg = inspectConfigForWorktree(slotPaths(slot).worktree);
      if (wtCfg.ok) {
        url = slotUrl(slot, wtCfg.config);
        cfgServices = wtCfg.config.services || [];
      }
    } catch { /* worktree may be mid-operation */ }
    const services = Object.entries(slot.ports || {}).map(([id, port]) => {
      const proc = slot.procs?.[id];
      const svc = cfgServices.find((c) => c.id === id);
      return {
        id,
        port,
        running: !!(proc && pidAlive(proc.pid)),
        label: serviceLabel(svc || { id }, branch),
      };
    });
    let behind = null;
    if (remote) {
      try {
        const [line] = gitLines(['ls-remote', '--heads', 'origin', branch]);
        const sha = line ? line.split(/\s+/)[0] : null;
        behind = sha ? sha !== slot.syncedSha : null;
      } catch { behind = null; }
    }
    // Newest service start for this preview. The page watches this: when it
    // moves forward, the preview has been rebuilt/restarted underneath any
    // tab showing it, so that tab is stale and can be re-navigated.
    const startedAt = Math.max(
      0,
      ...Object.values(slot.procs || {}).map((p) => (p && pidAlive(p.pid) ? p.startedAt || 0 : 0)),
    );

    return {
      branch,
      url,
      services,
      startedAt,
      running: services.length > 0 && services.every((s) => s.running),
      partial: services.some((s) => s.running) && !services.every((s) => s.running),
      synced: slot.syncedSha ? slot.syncedSha.slice(0, 10) : null,
      behind,
      pools: slot.poolKeys || {},
    };
  });

  const poolUse = {};
  for (const p of previews) {
    for (const [id, key] of Object.entries(p.pools)) (poolUse[id] ||= new Set()).add(key);
  }

  return {
    repo: path.basename(REPO_ROOT),
    repoPath: REPO_ROOT,
    deckPath: paths().DECK_DIR,
    previews,
    sharing: Object.fromEntries(Object.entries(poolUse).map(([k, v]) => [k, v.size])),
    settings,
    configOk: cfg.ok,
    configError: cfg.ok ? null : cfg.error,
    busy: currentJob ? currentJob.label : null,
    queued: queue.map((j) => j.label),
    watch: watchEnabled,
    activity: activity.slice(-120),
  };
}

/** Remote branches, marking which already have a preview. */
function remoteBranches() {
  const state = loadState();
  const taken = new Set(Object.keys(state.slots));
  const lines = gitLines(['ls-remote', '--heads', 'origin']);
  return lines
    .map((l) => l.split('\t')[1])
    .filter(Boolean)
    .map((ref) => ref.replace(/^refs\/heads\//, ''))
    .filter((name) => validBranchName(name))
    .sort()
    .map((name) => ({ name, added: taken.has(name) }));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const withState = (fn) => async () => {
  const state = loadState();
  await fn(state, loadSettings());
  saveState(state);
};

function action(name, branch) {
  switch (name) {
    case 'add':
      if (!branch) throw new Error('no branch given');
      return enqueue(`add ${branch}`, withState((s, set) => cmdAdd(branch, set, s)));
    case 'sync':
      return enqueue(`sync ${branch}`, withState(async (s, set) => {
        if (!s.slots[branch]) throw new Error(`no preview for ${branch}`);
        const r = await syncSlot(s.slots[branch], set);
        if (!r.changed) push('info', `  [${branch}] already up to date and running.`);
      }));
    case 'restart':
      return enqueue(`restart ${branch}`, withState(async (s, set) => {
        if (!s.slots[branch]) throw new Error(`no preview for ${branch}`);
        await syncSlot(s.slots[branch], set, { force: true });
      }));
    case 'stop':
      return enqueue(`stop ${branch}`, withState(async (s) => {
        if (!s.slots[branch]) throw new Error(`no preview for ${branch}`);
        await stopServices(s.slots[branch]);
        push('info', `  [${branch}] stopped.`);
      }));
    case 'remove':
      return enqueue(`remove ${branch}`, withState((s) => cmdRemove(branch, s)));
    case 'syncAll':
      return enqueue('sync all', withState(async (s, set) => {
        for (const b of Object.keys(s.slots)) {
          try {
            const r = await syncSlot(s.slots[b], set);
            if (!r.changed) push('info', `  [${b}] already up to date and running.`);
          } catch (err) {
            push('error', `  [${b}] ${err.message}`);
          }
        }
      }));
    case 'gc':
      return enqueue('gc', withState((s) => cmdGc(s)));
    default:
      throw new Error(`unknown action "${name}"`);
  }
}

function setWatch(enabled, intervalSeconds) {
  watchEnabled = !!enabled;
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  if (watchEnabled) {
    const ms = Math.max(10, Number(intervalSeconds) || 60) * 1000;
    watchTimer = setInterval(() => {
      // Skip a tick rather than pile up if something is still running.
      if (!currentJob && queue.length === 0) action('syncAll');
    }, ms);
    push('info', `watch on — checking origin every ${ms / 1000}s`);
  } else {
    push('info', 'watch off');
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

function send(res, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    // This page never embeds anything remote and must not be framed.
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => {
    data += c;
    if (data.length > 2_000_000) reject(new Error('body too large'));
  });
  req.on('end', () => resolve(data));
  req.on('error', reject);
});

export async function startUi({ port: wanted, open = true } = {}) {
  const settings = loadSettings();
  const token = randomUUID();
  const { REPO_ROOT } = paths();

  let port = Number(wanted) || Number(settings.uiPort) || 8100;
  for (let i = 0; i < 100 && !(await portFree(port)); i += 1) port += 1;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    // Defence in depth against a malicious page in the same browser: the Host
    // header must be loopback (blocks DNS rebinding), any Origin must match
    // ours, and every call must carry the token minted for this run.
    const host = (req.headers.host || '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'bad host' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      return send(res, 403, { error: 'bad origin' });
    }
    const given = url.searchParams.get('token') || req.headers['x-branchdeck-token'];
    if (given !== token) {
      return send(res, 403, 'Forbidden — open the URL printed by `branchdeck ui`.', 'text/plain');
    }

    try {
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, PAGE.replace('__TOKEN__', token), 'text/html');
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(res, 200, snapshot({ remote: url.searchParams.get('remote') === '1' }));
      }
      if (req.method === 'GET' && url.pathname === '/api/branches') {
        return send(res, 200, { branches: remoteBranches() });
      }
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const branch = url.searchParams.get('branch');
        const state = loadState();
        const slot = state.slots[branch];
        if (!slot) return send(res, 404, { error: 'no such preview' });
        const service = url.searchParams.get('service');
        const file = service ? serviceLogPath(slot, service) : slotPaths(slot).log;
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(no output yet)';
        return send(res, 200, { text: text.split('\n').slice(-300).join('\n') });
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        const file = CONFIG_NAMES.map((n) => path.join(REPO_ROOT, n)).find((p) => fs.existsSync(p));
        return send(res, 200, {
          file: file ? path.basename(file) : CONFIG_NAMES[0],
          text: file ? fs.readFileSync(file, 'utf8') : '',
          ...inspectConfig(REPO_ROOT),
        });
      }
      if (req.method === 'PUT' && url.pathname === '/api/config') {
        const { text } = JSON.parse(await readBody(req));
        const check = inspectConfig(REPO_ROOT, text);
        if (!check.ok) return send(res, 400, { error: check.error });
        const file = CONFIG_NAMES.map((n) => path.join(REPO_ROOT, n)).find((p) => fs.existsSync(p))
          || path.join(REPO_ROOT, CONFIG_NAMES[0]);
        fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
        push('info', `saved ${path.basename(file)}`);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'PUT' && url.pathname === '/api/settings') {
        const incoming = JSON.parse(await readBody(req));
        const merged = { ...loadSettings(), ...incoming };
        fs.writeFileSync(paths().SETTINGS_FILE, `${JSON.stringify(merged, null, 2)}\n`);
        push('info', 'saved settings');
        if (watchEnabled) setWatch(true, merged.watchIntervalSeconds);
        return send(res, 200, { ok: true, settings: merged });
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        const { action: name, branch } = JSON.parse(await readBody(req));
        if (branch && !validBranchName(branch)) return send(res, 400, { error: 'bad branch name' });
        action(name, branch); // fire and forget; the page polls for progress
        return send(res, 202, { accepted: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/watch') {
        const { enabled } = JSON.parse(await readBody(req));
        setWatch(enabled, loadSettings().watchIntervalSeconds);
        return send(res, 200, { watch: watchEnabled });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const link = `http://localhost:${port}/?token=${token}`;
  console.log(`[branchdeck] control pane: ${link}`);
  console.log('[branchdeck] Ctrl+C to stop (previews keep running).');
  if (open) {
    const isWin = process.platform === 'win32';
    if (isWin) {
      const b = loadSettings().browser;
      spawnSync('cmd', b ? ['/c', 'start', '', b, link] : ['/c', 'start', '', link], { stdio: 'ignore', windowsHide: true });
    } else {
      spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [link], { stdio: 'ignore' });
    }
  }
  return server;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>branchdeck</title>
<style>
  :root{
    --bg:#f6f7f9; --panel:#fff; --ink:#16181d; --muted:#666c7a; --line:#e3e6ea;
    --accent:#2f6fed; --ok:#1a7f45; --warn:#9a6700; --bad:#c1352b; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){
    :root{--bg:#14161a; --panel:#1c1f25; --ink:#e8eaed; --muted:#98a0ae; --line:#2c313a;
          --accent:#6fa0ff; --ok:#5fd08a; --warn:#e5b567; --bad:#ff7a70;}
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{display:flex;align-items:center;gap:12px;padding:12px 18px;
         border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:5}
  header h1{font-size:15px;margin:0;font-weight:650;letter-spacing:.2px}
  header .repo{color:var(--muted);font-family:var(--mono);font-size:12px}
  .spacer{flex:1}
  .tabs{display:flex;gap:4px}
  .tab{padding:6px 12px;border-radius:7px;border:1px solid transparent;cursor:pointer;color:var(--muted);background:none;font:inherit}
  .tab[aria-selected=true]{background:var(--bg);border-color:var(--line);color:var(--ink);font-weight:600}
  main{padding:18px;max-width:1080px;margin:0 auto}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:12px}
  .card h2{margin:0 0 10px;font-size:13px;font-weight:650;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
  select,input,textarea,button{font:inherit;color:inherit}
  select,input[type=text],input[type=number],textarea{
    background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:7px 9px;max-width:100%}
  textarea{width:100%;min-height:420px;font-family:var(--mono);font-size:12.5px;line-height:1.55;resize:vertical}
  button{background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:6px 11px;cursor:pointer}
  button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
  button:disabled{opacity:.45;cursor:not-allowed}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  button.primary:hover:not(:disabled){filter:brightness(1.08);color:#fff}
  button.danger:hover:not(:disabled){border-color:var(--bad);color:var(--bad)}
  .preview{display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--line)}
  .preview:first-of-type{border-top:none}
  .dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--muted)}
  .dot.on{background:var(--ok)} .dot.part{background:var(--warn)} .dot.off{background:var(--muted);opacity:.5}
  .bname{font-weight:600;font-family:var(--mono);font-size:13px;word-break:break-all}
  .meta{color:var(--muted);font-size:12px;font-family:var(--mono)}
  .badge{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
  .badge.behind{color:var(--warn);border-color:var(--warn)}
  .grow{flex:1;min-width:180px}
  .actions{display:flex;gap:6px;flex-wrap:wrap}
  a.open{color:var(--accent);text-decoration:none;font-weight:600}
  a.open:hover{text-decoration:underline}
  #log{background:#0d0f13;color:#d7dbe2;border-radius:8px;padding:11px 13px;font-family:var(--mono);
       font-size:12px;max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word}
  @media (prefers-color-scheme:light){#log{background:#14161a}}
  .log-warn{color:#e5b567}.log-error{color:#ff8b80}.log-head{color:#6fa0ff}
  .err{color:var(--bad);white-space:pre-wrap;font-family:var(--mono);font-size:12.5px}
  .ok{color:var(--ok)}
  .hint{color:var(--muted);font-size:12.5px}
  .banner{border-left:3px solid var(--warn);padding:9px 12px;background:var(--panel);border-radius:0 8px 8px 0;margin-bottom:12px}
  label.field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}
  .logtabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
  .logtab{padding:4px 10px;border-radius:99px;border:1px solid var(--line);cursor:pointer;
          font-size:12px;color:var(--muted);background:none}
  /* :hover included: the generic button:hover rule is more specific than a
     bare [aria-selected] selector and would paint accent-on-accent. */
  .logtab[aria-selected=true],.logtab[aria-selected=true]:hover{
    background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  .logtab .live{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ok);margin-right:6px;vertical-align:1px}
  .logtab .dead{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--muted);opacity:.5;margin-right:6px;vertical-align:1px}
  .spin{display:inline-block;width:11px;height:11px;border:2px solid var(--line);
        border-top-color:var(--accent);border-radius:50%;animation:s .7s linear infinite;vertical-align:-1px}
  @keyframes s{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<header>
  <h1>branchdeck</h1>
  <span class="repo" id="repo"></span>
  <div class="spacer"></div>
  <div class="tabs">
    <button class="tab" id="tab-previews" aria-selected="true" onclick="showTab('previews')">Previews</button>
    <button class="tab" id="tab-config" aria-selected="false" onclick="showTab('config')">Configuration</button>
  </div>
</header>

<main>
  <div id="cfgbanner"></div>

  <section id="view-previews">
    <div class="card">
      <h2>Add a preview</h2>
      <div class="row">
        <select id="branch" class="grow"><option>loading…</option></select>
        <button class="primary" id="addbtn" onclick="add()">Add preview</button>
        <button onclick="loadBranches()" title="Re-read branches from origin">Refresh</button>
      </div>
      <p class="hint" id="branchhint" style="margin:8px 0 0"></p>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:6px">
        <h2 style="margin:0">Previews</h2>
        <div class="spacer"></div>
        <label class="row" style="gap:6px;font-size:12.5px;color:var(--muted)">
          <input type="checkbox" id="watch" onchange="toggleWatch()"> auto-sync
        </label>
        <label class="row" style="gap:6px;font-size:12.5px;color:var(--muted)"
               title="After a preview restarts, re-navigate the tab this pane opened for it.">
          <input type="checkbox" id="autoreload" onchange="toggleAutoReload()"> auto-reload tabs
        </label>
        <button onclick="act('syncAll')">Sync all</button>
        <button onclick="openAll()">Open all tabs</button>
        <button onclick="act('gc')" title="Delete dependency pools nothing uses">Free unused pools</button>
      </div>
      <div id="previews"><p class="hint">No previews yet — add one above.</p></div>
      <p class="hint" id="sharing" style="margin:10px 0 0"></p>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <h2 style="margin:0">Consoles</h2>
        <div class="spacer"></div>
        <span id="busy" class="hint"></span>
      </div>
      <div class="logtabs" id="logtabs"></div>
      <div id="log"></div>
    </div>
  </section>

  <section id="view-config" hidden>
    <div class="card">
      <h2>Settings <span class="hint" style="text-transform:none;letter-spacing:0">— this machine only</span></h2>
      <div class="row" style="align-items:flex-end">
        <label class="field">Base port<input type="number" id="s-basePort" style="width:110px"></label>
        <label class="field">Browser<input type="text" id="s-browser" placeholder="chrome / msedge / blank" style="width:190px"></label>
        <label class="field">Auto-sync interval (s)<input type="number" id="s-interval" style="width:130px"></label>
        <button class="primary" onclick="saveSettings()">Save settings</button>
        <span id="setmsg" class="hint"></span>
      </div>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <h2 style="margin:0">preview.config.json <span class="hint" style="text-transform:none;letter-spacing:0">— committed; defines how previews build and run</span></h2>
        <div class="spacer"></div>
        <button onclick="loadConfig()">Reload</button>
        <button class="primary" onclick="saveConfig()">Save</button>
      </div>
      <div id="cfgmsg"></div>
      <textarea id="cfg" spellcheck="false"></textarea>
      <p class="hint">Changes apply on the next sync of each preview. Each preview
        actually uses the config on <em>its own branch</em>, so a branch may define extra services.</p>
    </div>
  </section>
</main>

<script>
const TOKEN = '__TOKEN__';
let STATE = null, POLL = 2000;

/*
 * Tab tracking for auto-reload.
 *
 * Previews are opened as NAMED windows. The name matters twice over: it lets
 * this page re-navigate the tab later (a cross-origin navigation is allowed
 * even though reading that tab is not), and if this pane is itself reloaded —
 * losing every WindowProxy — re-opening with the same name reuses the
 * existing tab instead of piling up duplicates.
 *
 * We cannot call reload() on a cross-origin window, and we cannot read where
 * the user navigated inside the app, so a reload sends the tab back to the
 * preview's base URL.
 */
const tabs = new Map();       // branch -> { win, name }
const lastStarted = new Map(); // branch -> startedAt last seen

const tabName = (branch) => 'branchdeck-' + branch.replace(/[^A-Za-z0-9]+/g, '-');

function openPreview(branch, url) {
  const name = tabName(branch);
  const win = window.open(url, name);
  if (win) tabs.set(branch, { win, name });
  return win;
}

function reloadPreviewTab(p) {
  const entry = tabs.get(p.branch);
  if (!entry || !p.url) return false;
  try {
    if (entry.win.closed) { tabs.delete(p.branch); return false; }
    entry.win.location.href = p.url;   // permitted cross-origin; triggers a load
    return true;
  } catch {
    tabs.delete(p.branch);             // window went away underneath us
    return false;
  }
}

/** Re-navigate any open tab whose preview restarted since we last looked. */
function syncTabs(previews) {
  for (const p of previews) {
    const seen = lastStarted.get(p.branch);
    const now = p.startedAt || 0;
    lastStarted.set(p.branch, now);
    // An undefined "seen" is the first sighting — never reload on page load.
    if (seen === undefined || now <= seen || !now) continue;
    if (!STATE?.settings?.autoReloadTabs) continue;
    if (reloadPreviewTab(p)) note('reloaded tab for ' + p.branch);
  }
}

const localNotes = [];
function note(msg) { localNotes.push({ at: Date.now(), level: 'info', message: msg }); }

const api = async (p, opts = {}) => {
  const r = await fetch(p + (p.includes('?') ? '&' : '?') + 'token=' + TOKEN, {
    ...opts, headers: { 'content-type': 'application/json', 'x-branchdeck-token': TOKEN, ...(opts.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
  return body;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function showTab(which) {
  document.getElementById('view-previews').hidden = which !== 'previews';
  document.getElementById('view-config').hidden = which !== 'config';
  document.getElementById('tab-previews').ariaSelected = which === 'previews';
  document.getElementById('tab-config').ariaSelected = which === 'config';
  if (which === 'config' && !document.getElementById('cfg').value) loadConfig();
}

async function refresh(remote) {
  try {
    STATE = await api('/api/state' + (remote ? '?remote=1' : ''));
  } catch (e) { return; }
  const repoEl = document.getElementById('repo');
  repoEl.textContent = STATE.repo;          // full path is long; keep it in the tooltip
  repoEl.title = STATE.repoPath;
  document.getElementById('watch').checked = STATE.watch;
  document.getElementById('autoreload').checked = !!STATE.settings.autoReloadTabs;
  syncTabs(STATE.previews);

  const banner = document.getElementById('cfgbanner');
  banner.innerHTML = STATE.configOk ? '' :
    '<div class="banner"><strong>Configuration problem</strong><div class="err">' +
    esc(STATE.configError) + '</div><div class="hint">Fix it in the Configuration tab.</div></div>';

  const host = document.getElementById('previews');
  if (!STATE.previews.length) {
    host.innerHTML = '<p class="hint">No previews yet — add one above.</p>';
  } else {
    host.innerHTML = STATE.previews.map((p) => {
      const cls = p.running ? 'on' : p.partial ? 'part' : 'off';
      const ports = p.services.map((s) => s.id + ':' + s.port).join(' ');
      return '<div class="preview">' +
        '<span class="dot ' + cls + '" title="' + (p.running ? 'running' : 'stopped') + '"></span>' +
        '<div class="grow"><div class="bname">' + esc(p.branch) + '</div>' +
        '<div class="meta">' + esc(ports || 'no ports yet') + (p.synced ? ' · ' + p.synced : '') +
        (p.behind === true ? ' <span class="badge behind">behind origin</span>' : '') + '</div></div>' +
        '<div class="actions">' +
        (p.url && p.running
          ? '<a class="open" href="' + p.url + '" target="' + tabName(p.branch) +
            '" onclick="return openFromLink(event,\\'' + esc(p.branch) + '\\',\\'' + p.url + '\\')">Open ↗</a>'
          : '') +
        '<button onclick="act(\\'sync\\',\\'' + esc(p.branch) + '\\')">Sync</button>' +
        '<button onclick="act(\\'restart\\',\\'' + esc(p.branch) + '\\')">Restart</button>' +
        '<button onclick="act(\\'stop\\',\\'' + esc(p.branch) + '\\')">Stop</button>' +
        '<button class="danger" onclick="remove(\\'' + esc(p.branch) + '\\')">Remove</button>' +
        '</div></div>';
    }).join('');
  }

  const share = Object.entries(STATE.sharing).map(([k, v]) => v + ' ' + k).join(', ');
  document.getElementById('sharing').textContent = share
    ? STATE.previews.length + ' preview(s) sharing ' + share + ' dependency install(s).'
    : '';

  const busy = document.getElementById('busy');
  busy.innerHTML = STATE.busy
    ? '<span class="spin"></span> ' + esc(STATE.busy) + (STATE.queued.length ? ' (+' + STATE.queued.length + ' queued)' : '')
    : '';
  document.querySelectorAll('button').forEach((b) => {
    if (b.dataset.always === undefined && /Add preview|Sync|Restart|Stop|Remove|Free unused/.test(b.textContent)) {
      b.disabled = !!STATE.busy;
    }
  });
  POLL = STATE.busy ? 900 : 2500;

  renderLogTabs();
  renderLog();
}

// Which console is showing: null = activity; {branch} = build log;
// {branch, service, label} = a service console.
let LOGSEL = null;

function renderLogTabs() {
  const host = document.getElementById('logtabs');
  const chips = [{ key: 'activity', text: 'Activity', sel: null }];
  for (const p of STATE.previews) {
    for (const svc of p.services) {
      chips.push({
        key: 'svc:' + p.branch + ':' + svc.id,
        text: svc.label,
        live: svc.running,
        sel: { branch: p.branch, service: svc.id, label: svc.label },
      });
    }
    chips.push({ key: 'build:' + p.branch, text: 'Build — ' + p.branch, sel: { branch: p.branch } });
  }
  const currentKey = LOGSEL === null ? 'activity'
    : LOGSEL.service ? 'svc:' + LOGSEL.branch + ':' + LOGSEL.service
    : 'build:' + LOGSEL.branch;
  if (!chips.some((c) => c.key === currentKey)) LOGSEL = null; // preview removed
  host.innerHTML = chips.map((c) => {
    const selected = (LOGSEL === null && c.sel === null) ||
      (LOGSEL !== null && c.sel !== null && c.key === currentKey);
    const dot = c.sel && c.sel.service ? '<span class="' + (c.live ? 'live' : 'dead') + '"></span>' : '';
    return '<button class="logtab" aria-selected="' + selected + '" data-key="' + esc(c.key) + '">' +
      dot + esc(c.text) + '</button>';
  }).join('');
  host.querySelectorAll('.logtab').forEach((btn, i) => {
    btn.onclick = () => { LOGSEL = chips[i].sel; renderLogTabs(); renderLog(); };
  });
}

async function renderLog() {
  const el = document.getElementById('log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  if (LOGSEL === null) {
    // Server-side progress interleaved with things only this page knows about,
    // such as which tabs it reloaded.
    const merged = [...(STATE?.activity || []), ...localNotes].sort((a, b) => a.at - b.at);
    el.innerHTML = merged.map((a) => {
      const cls = a.level === 'error' ? 'log-error' : a.level === 'warn' ? 'log-warn'
        : a.message.startsWith('▶') ? 'log-head' : '';
      return '<span class="' + cls + '">' + esc(a.message) + '</span>';
    }).join('\\n') || '(nothing yet)';
  } else {
    try {
      const q = '/api/logs?branch=' + encodeURIComponent(LOGSEL.branch) +
        (LOGSEL.service ? '&service=' + encodeURIComponent(LOGSEL.service) : '');
      const r = await api(q);
      el.textContent = r.text;
    } catch (e) { el.textContent = e.message; }
  }
  if (atBottom) el.scrollTop = el.scrollHeight;
}

async function loadBranches() {
  const sel = document.getElementById('branch');
  sel.innerHTML = '<option>loading…</option>';
  try {
    const { branches } = await api('/api/branches');
    const free = branches.filter((b) => !b.added);
    sel.innerHTML = free.length
      ? free.map((b) => '<option value="' + esc(b.name) + '">' + esc(b.name) + '</option>').join('')
      : '<option value="">— every remote branch already has a preview —</option>';
    document.getElementById('branchhint').textContent =
      branches.length + ' branches on origin, ' + (branches.length - free.length) + ' already added.';
    document.getElementById('addbtn').disabled = !free.length;
  } catch (e) {
    sel.innerHTML = '<option value="">' + esc(e.message) + '</option>';
  }
}

async function act(action, branch) {
  try { await api('/api/action', { method: 'POST', body: JSON.stringify({ action, branch }) }); }
  catch (e) { alert(e.message); }
  refresh();
}
async function add() {
  const branch = document.getElementById('branch').value;
  if (!branch) return;
  await act('add', branch);
  setTimeout(loadBranches, 1500);
}
async function remove(branch) {
  if (!confirm('Remove the preview for ' + branch + '?\\n\\nIts worktree and build are deleted. Shared dependency pools are kept.')) return;
  await act('remove', branch);
  setTimeout(loadBranches, 1500);
}
function openFromLink(ev, branch, url) {
  // Route clicks through window.open so the tab is registered for reloading;
  // the href/target keep middle-click and "open in new tab" working.
  ev.preventDefault();
  const w = openPreview(branch, url);
  if (w) w.focus();
  return false;
}
function openAll() {
  (STATE?.previews || []).filter((p) => p.url && p.running).forEach((p) => openPreview(p.branch, p.url));
}
async function toggleAutoReload() {
  const on = document.getElementById('autoreload').checked;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ autoReloadTabs: on }) });
    note(on
      ? 'auto-reload on — tabs opened from this pane refresh after their preview restarts'
      : 'auto-reload off');
  } catch (e) { alert(e.message); }
  refresh();
}
async function toggleWatch() {
  const enabled = document.getElementById('watch').checked;
  try { await api('/api/watch', { method: 'POST', body: JSON.stringify({ enabled }) }); } catch (e) { alert(e.message); }
  refresh();
}

async function loadConfig() {
  const r = await api('/api/config');
  document.getElementById('cfg').value = r.text;
  document.getElementById('cfgmsg').innerHTML = r.ok ? '' : '<p class="err">' + esc(r.error) + '</p>';
  const s = STATE?.settings || {};
  document.getElementById('s-basePort').value = s.basePort ?? 8101;
  document.getElementById('s-browser').value = s.browser ?? '';
  document.getElementById('s-interval').value = s.watchIntervalSeconds ?? 60;
}
async function saveConfig() {
  const msg = document.getElementById('cfgmsg');
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ text: document.getElementById('cfg').value }) });
    msg.innerHTML = '<p class="ok">Saved. Sync a preview to apply it.</p>';
    refresh();
  } catch (e) { msg.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
}
async function saveSettings() {
  const body = {
    basePort: Number(document.getElementById('s-basePort').value) || 8101,
    browser: document.getElementById('s-browser').value.trim() || null,
    watchIntervalSeconds: Number(document.getElementById('s-interval').value) || 60,
  };
  const el = document.getElementById('setmsg');
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    el.textContent = 'Saved.'; setTimeout(() => { el.textContent = ''; }, 2500);
  } catch (e) { el.textContent = e.message; }
}

loadBranches();
refresh(true);
setInterval(() => refresh(), POLL);
setInterval(() => refresh(true), 30000);   // periodic origin check
</script>
</body>
</html>`;
