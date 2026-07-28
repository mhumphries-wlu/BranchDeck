#!/usr/bin/env node
/**
 * End-to-end tests for branchdeck.
 *
 * Builds a throwaway git origin plus two branches, drives the real CLI against
 * it, and asserts on observable behaviour: served content, pool sharing, pool
 * isolation when dependencies diverge, port allocation, and cleanup.
 *
 * Uses only Node — no python, no npm registry access — so it runs identically
 * on Linux, macOS and Windows CI.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import httpClient from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'branchdeck-e2e-'));

let failures = 0;
let current = '';

function test(name, fn) {
  current = name;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

async function testAsync(name, fn) {
  current = name;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

function sh(cmd, args, cwd, { allowFail = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (!allowFail && res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${res.status})\n${res.stdout}\n${res.stderr}`);
  }
  return `${res.stdout || ''}${res.stderr || ''}`;
}

const git = (args, cwd) => sh('git', args, cwd);
const deck = (args, cwd, opts) => sh(process.execPath, [CLI, ...args], cwd, opts);

/**
 * GET with a few retries, over a FRESH socket every time (agent: false).
 *
 * fetch() pools keep-alive sockets per origin, and a preview that restarts
 * between two requests leaves the pool holding a socket to the old, now-dead
 * server. How undici recovers from that differs across Node versions —
 * Node 18's bundled undici fails these requests outright — so the test
 * client sidesteps pooling entirely rather than depending on any
 * particular recovery behaviour.
 */
function get(url, attempts = 5) {
  // Node 18 resolves `localhost` to ::1 with no IPv4 fallback (Happy Eyeballs
  // landed in Node 20); the preview servers bind 127.0.0.1. Pin the address.
  url = url.replace('//localhost:', '//127.0.0.1:');
  return new Promise((resolve, reject) => {
    const attempt = (n, lastErr) => {
      if (n <= 0) return reject(lastErr || new Error('no attempts'));
      const req = httpClient.get(url, { agent: false }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
        res.on('error', (err) => setTimeout(() => attempt(n - 1, err), 400));
      });
      req.setTimeout(5000, () => req.destroy(new Error('timeout')));
      req.on('error', (err) => setTimeout(() => attempt(n - 1, err), 400));
    };
    attempt(attempts, null);
  });
}

// --- fixture ----------------------------------------------------------------

/**
 * A tiny app with a real dependency manifest and a real build step, so pool
 * sharing and build invalidation are genuinely exercised. The "dependency"
 * is a file the install step writes into the pool — enough to prove sharing
 * without hitting a package registry.
 */
function writeApp(dir, { marker, dep = 'base' }) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deps.txt'), `${dep}\n`);
  fs.writeFileSync(path.join(dir, 'src', 'marker.txt'), `${marker}\n`);
  fs.writeFileSync(
    path.join(dir, 'build.mjs'),
    `import fs from 'node:fs';
const marker = fs.readFileSync('src/marker.txt','utf8').trim();
const dep = fs.readFileSync('vendor/installed.txt','utf8').trim();
fs.mkdirSync('dist',{recursive:true});
fs.writeFileSync('dist/index.txt', marker + '|' + dep);
`,
  );
  fs.writeFileSync(
    path.join(dir, 'server.mjs'),
    `import http from 'node:http';
import fs from 'node:fs';
const port = Number(process.env.PORT);
console.log('fixture server listening on ' + port);
http.createServer((req,res)=>{
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  // Report failures as a 500 body so a broken preview produces a readable
  // assertion instead of an opaque socket error.
  try { res.writeHead(200); res.end(fs.readFileSync('dist/index.txt','utf8')); }
  catch (e) { res.writeHead(500); res.end('SERVER_ERROR ' + e.message); }
}).listen(port,'127.0.0.1');
`,
  );
  fs.writeFileSync(
    path.join(dir, 'preview.config.json'),
    JSON.stringify(
      {
        name: 'testapp',
        pools: [
          {
            id: 'vendor',
            manifests: ['deps.txt'],
            // Writes a file naming the dependency set into the pool.
            install: [
              `${JSON.stringify(process.execPath)} -e "const fs=require('fs');fs.mkdirSync(process.argv[1]+'/vendor',{recursive:true});fs.copyFileSync(process.argv[2],process.argv[1]+'/vendor/installed.txt')" "\${POOL}" "\${MANIFEST}"`,
            ],
            link: { vendor: '${POOL}/vendor' },
          },
        ],
        build: [{ name: 'build', run: `${JSON.stringify(process.execPath)} build.mjs`, when: ['src', 'build.mjs'], output: 'dist' }],
        services: [
          {
            id: 'web',
            run: `${JSON.stringify(process.execPath)} server.mjs`,
            health: { path: '/healthz' },
            open: true,
          },
        ],
        envFiles: [{ path: '.env.preview', copyFrom: ['.env'], set: { BRANCH: '${BRANCH}', PORT_USED: '${PORT:web}' } }],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(dir, '.gitignore'), 'vendor/\ndist/\n.env\n.env.preview\n');
}

async function main() {
  console.log(`branchdeck e2e (${process.platform})\nworkdir: ${ROOT}\n`);

  const originDir = path.join(ROOT, 'origin.git');
  const seed = path.join(ROOT, 'seed');
  git(['init', '--bare', '-q', originDir], ROOT);
  fs.mkdirSync(seed);
  git(['init', '-q'], seed);
  git(['config', 'user.email', 't@example.com'], seed);
  git(['config', 'user.name', 'test'], seed);
  writeApp(seed, { marker: 'master' });
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'base'], seed);
  git(['branch', '-M', 'master'], seed);
  git(['remote', 'add', 'origin', originDir], seed);
  git(['push', '-q', 'origin', 'master'], seed);

  for (const b of ['feat/one', 'feat/two']) {
    git(['checkout', '-qb', b, 'master'], seed);
    fs.writeFileSync(path.join(seed, 'src', 'marker.txt'), `${b}\n`);
    git(['commit', '-qam', b], seed);
    git(['push', '-q', 'origin', b], seed);
    git(['checkout', '-q', 'master'], seed);
  }

  const work = path.join(ROOT, 'work');
  git(['clone', '-q', originDir, work], ROOT);
  fs.writeFileSync(path.join(work, '.env'), 'FROM_DEV_ENV=yes\n');

  // --- help works outside a repository ------------------------------------
  await testAsync('help works outside a git repository', async () => {
    const out = deck(['help'], os.tmpdir());
    assert.match(out, /local preview deployments/);
  });

  test('a real command outside a repository explains itself', () => {
    const out = deck(['status'], os.tmpdir(), { allowFail: true });
    assert.match(out, /not inside a git repository/);
  });

  // --- init ----------------------------------------------------------------
  test('init detects a stack and writes a config', () => {
    const probe = path.join(ROOT, 'probe');
    fs.mkdirSync(path.join(probe, 'frontend'), { recursive: true });
    git(['init', '-q'], probe);
    fs.writeFileSync(path.join(probe, 'frontend', 'package.json'), '{"name":"f"}');
    fs.mkdirSync(path.join(probe, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(probe, 'backend', 'requirements.txt'), 'fastapi\n');
    const out = deck(['init'], probe);
    assert.match(out, /Python API serving a built JavaScript frontend/);
    const cfg = fs.readFileSync(path.join(probe, 'preview.config.json'), 'utf8');
    assert.match(cfg, /"services"/);
  });

  test('init refuses to clobber an existing config', () => {
    const out = deck(['init'], path.join(ROOT, 'probe'), { allowFail: true });
    assert.match(out, /already exists/);
  });

  test('invalid config is rejected with a useful message', () => {
    const bad = path.join(ROOT, 'bad');
    fs.mkdirSync(bad, { recursive: true });
    git(['init', '-q'], bad);
    git(['commit', '-q', '--allow-empty', '-m', 'x'], bad);
    fs.writeFileSync(
      path.join(bad, 'preview.config.json'),
      '{"services":[{"id":"a","run":"x"}],"pools":[{"id":"p","manifests":["m"],"install":"i"}],"extra":"${POOL:nope}"}',
    );
    const out = deck(['status'], bad, { allowFail: true });
    assert.match(out, /undefined pool "nope"/);
  });

  // --- add two branches ----------------------------------------------------
  await testAsync('add creates a preview and serves the branch content', async () => {
    const out = deck(['add', 'feat/one'], work);
    assert.match(out, /ready ->/, out);
    const url = /ready -> (\S+)/.exec(out)[1];
    const res = await get(url);
    assert.equal(res.status, 200);
    assert.match(res.body, /^feat\/one\|base$/);
  });

  await testAsync('a second branch REUSES the shared pool (no reinstall)', async () => {
    const out = deck(['add', 'feat/two'], work);
    assert.match(out, /using shared pool vendor/, out);
    assert.doesNotMatch(out, /installing pool vendor/, 'should not have reinstalled');
    const url = /ready -> (\S+)/.exec(out)[1];
    const res = await get(url);
    assert.match(res.body, /^feat\/two\|base$/);
  });

  test('both previews are on distinct ports and both alive', () => {
    const out = deck(['status', '--offline'], work);
    const ports = [...out.matchAll(/web:(\d+)/g)].map((m) => m[1]);
    assert.equal(ports.length, 2);
    assert.notEqual(ports[0], ports[1], 'ports must differ');
    assert.match(out, /1 vendor install/);
  });

  test('env file was generated with expanded placeholders', () => {
    const env = fs.readFileSync(
      path.join(ROOT, 'work-previews', 'wt', 'feat-one', '.env.preview'),
      'utf8',
    );
    assert.match(env, /FROM_DEV_ENV=yes/, 'developer env should be copied in');
    assert.match(env, /BRANCH=feat\/one/);
    assert.match(env, /PORT_USED=\d+/);
  });

  // --- divergent dependencies get their own pool ---------------------------
  await testAsync('a branch that changes its manifest gets its OWN pool', async () => {
    git(['checkout', '-q', 'feat/two'], seed);
    fs.writeFileSync(path.join(seed, 'deps.txt'), 'special\n');
    git(['commit', '-qam', 'different deps'], seed);
    git(['push', '-q', 'origin', 'feat/two'], seed);

    const out = deck(['sync', 'feat/two'], work);
    assert.match(out, /installing pool vendor/, out);

    const restartOut = deck(['restart', 'feat/one'], work);
    const url = /ready -> (\S+)/.exec(restartOut);
    assert.ok(url, `feat/one did not come back up:\n${restartOut}`);
    let one;
    try {
      one = await get(url[1]);
    } catch (err) {
      throw new Error(
        `GET ${url[1]} failed: ${err.message}\n--- restart output ---\n${restartOut}` +
          `\n--- status ---\n${deck(['status', '--offline'], work)}` +
          `\n--- log ---\n${deck(['logs', 'feat/one'], work).split('\n').slice(-12).join('\n')}`,
      );
    }
    assert.match(one.body, /\|base$/, `feat/one must keep the shared dependency, got: ${one.body}`);
    const twoStatus = deck(['status', '--offline'], work);
    assert.match(twoStatus, /2 vendor install/, twoStatus);
  });

  await testAsync('reverting the manifest rejoins the shared pool', async () => {
    git(['checkout', '-q', 'feat/two'], seed);
    fs.writeFileSync(path.join(seed, 'deps.txt'), 'base\n');
    git(['commit', '-qam', 'back to base'], seed);
    git(['push', '-q', 'origin', 'feat/two'], seed);
    const out = deck(['sync', 'feat/two'], work);
    assert.match(out, /using shared pool vendor/, out);
    const res = await get(/ready -> (\S+)/.exec(out)[1]);
    assert.match(res.body, /\|base$/);
  });

  // --- incremental behaviour ----------------------------------------------
  test('sync with no new commits does not rebuild', () => {
    const out = deck(['sync', 'feat/one'], work);
    assert.match(out, /already up to date and running/);
  });

  await testAsync('a new commit updates the served content', async () => {
    git(['checkout', '-q', 'feat/one'], seed);
    fs.writeFileSync(path.join(seed, 'src', 'marker.txt'), 'feat/one-v2\n');
    git(['commit', '-qam', 'v2'], seed);
    git(['push', '-q', 'origin', 'feat/one'], seed);
    const out = deck(['sync', 'feat/one'], work);
    const res = await get(/ready -> (\S+)/.exec(out)[1]);
    assert.match(res.body, /^feat\/one-v2\|base$/);
  });

  await testAsync('force-push is absorbed', async () => {
    git(['checkout', '-q', 'feat/one'], seed);
    fs.writeFileSync(path.join(seed, 'src', 'marker.txt'), 'feat/one-forced\n');
    git(['commit', '-qam', 'amended', '--amend'], seed);
    git(['push', '-q', '--force', 'origin', 'feat/one'], seed);
    const out = deck(['sync', 'feat/one'], work);
    const res = await get(/ready -> (\S+)/.exec(out)[1]);
    assert.match(res.body, /^feat\/one-forced\|base$/);
  });

  // --- lifecycle -----------------------------------------------------------
  await testAsync('stop actually stops the service', async () => {
    const before = /web:(\d+)/.exec(deck(['status', '--offline'], work))[1];
    deck(['stop', 'feat/one'], work);
    await assert.rejects(() => get(`http://127.0.0.1:${before}/healthz`));
  });

  await testAsync('restart brings it back', async () => {
    const out = deck(['restart', 'feat/one'], work);
    const res = await get(/ready -> (\S+)/.exec(out)[1]);
    assert.equal(res.status, 200);
  });

  test('remove keeps shared pools; gc frees only orphans', () => {
    deck(['remove', 'feat/two'], work);
    const poolDir = path.join(ROOT, 'work-previews', 'pool', 'vendor');
    const before = fs.readdirSync(poolDir).length;
    const out = deck(['gc'], work);
    const after = fs.readdirSync(poolDir).length;
    assert.ok(after < before || /nothing to free/.test(out), 'gc should free orphans');
    assert.ok(after >= 1, 'the pool still used by feat/one must survive');
  });

  await testAsync('the surviving preview still serves after gc', async () => {
    const port = /web:(\d+)/.exec(deck(['status', '--offline'], work))[1];
    const res = await get(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
  });

  await testAsync('auto-reload: watcher injected and revision stamped every sync', async () => {
    git(['checkout', '-qb', 'feat/reload', 'master'], seed);
    const cfg = JSON.parse(fs.readFileSync(path.join(seed, 'preview.config.json'), 'utf8'));
    cfg.reload = { injectInto: ['dist/index.txt'], intervalSeconds: 2 };
    fs.writeFileSync(path.join(seed, 'preview.config.json'), JSON.stringify(cfg, null, 2));
    git(['commit', '-qam', 'enable reload'], seed);
    git(['push', '-q', 'origin', 'feat/reload'], seed);
    git(['checkout', '-q', 'master'], seed);

    const out = deck(['add', 'feat/reload'], work);
    assert.match(out, /ready ->/, out);

    const wt = path.join(ROOT, 'work-previews', 'wt', 'feat-reload');
    const idFile = path.join(wt, 'dist', 'branchdeck-build.json');
    assert.ok(fs.existsSync(idFile), 'a revision marker must be written');
    // CSP-safe: the watcher must be an EXTERNAL file referenced by src, never
    // inline code — `script-src 'self'` silently discards inline scripts.
    assert.ok(fs.existsSync(path.join(wt, 'dist', 'branchdeck-reload.js')),
      'the watcher must be its own file');
    const html = fs.readFileSync(path.join(wt, 'dist', 'index.txt'), 'utf8');
    assert.match(html, /<script src="\/branchdeck-reload\.js" defer data-branchdeck-reload>/);
    assert.doesNotMatch(html, /location\.reload/, 'no inline watcher code in the HTML');
    const first = JSON.parse(fs.readFileSync(idFile, 'utf8')).id;

    // A commit that touches nothing the build watches: the build is skipped,
    // but the page must still learn there is new code behind it.
    git(['checkout', '-q', 'feat/reload'], seed);
    fs.writeFileSync(path.join(seed, 'backend-only.txt'), 'server change\n');
    git(['add', '-A'], seed);
    git(['commit', '-qm', 'backend only'], seed);
    git(['push', '-q', 'origin', 'feat/reload'], seed);
    git(['checkout', '-q', 'master'], seed);

    const sync = deck(['sync', 'feat/reload'], work);
    assert.doesNotMatch(sync, /running build step|build \.\.\./, 'the build should have been skipped');
    const second = JSON.parse(fs.readFileSync(idFile, 'utf8')).id;
    assert.notEqual(second, first, 'the revision must change so open tabs reload');
    deck(['remove', 'feat/reload'], work, { allowFail: true });
  });

  // Regression: config commands routinely contain quoted paths, because real
  // install paths have spaces in them. Spawning the shell with a hand-built
  // argument array made Node escape those quotes, so the program received
  // them literally and failed with a syntax error on the path.
  await testAsync('quoted paths in config commands survive the shell', async () => {
    const spaced = path.join(ROOT, 'dir with spaces');
    const proof = path.join(spaced, 'quoting-ok.txt');
    fs.mkdirSync(spaced, { recursive: true });

    // The probe must live on the BRANCH: a worktree's own config wins over the
    // clone's, which is the behaviour the untracked-config test relies on.
    git(['checkout', '-qb', 'feat/quoting', 'master'], seed);
    const cfg = JSON.parse(fs.readFileSync(path.join(seed, 'preview.config.json'), 'utf8'));
    cfg.build = [{
      name: 'quoting probe',
      // An argument that is a quoted absolute path containing spaces.
      run: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.argv[1],'ok')" ${JSON.stringify(proof)}`,
    }];
    fs.writeFileSync(path.join(seed, 'preview.config.json'), JSON.stringify(cfg, null, 2));
    git(['commit', '-qam', 'quoting probe'], seed);
    git(['push', '-q', 'origin', 'feat/quoting'], seed);
    git(['checkout', '-q', 'master'], seed);

    const solo = path.join(ROOT, 'quoting');
    git(['clone', '-q', originDir, solo], ROOT);
    const out = deck(['add', 'feat/quoting'], solo);
    assert.match(out, /ready ->/, out);
    assert.ok(fs.existsSync(proof), 'the quoted path must reach the program intact');
    deck(['remove', 'feat/quoting'], solo, { allowFail: true });
  });

  // Regression: the config may deliberately be untracked (kept out of the repo
  // via .git/info/exclude), in which case NO worktree can ever contain it and
  // the clone's copy has to govern. This previously failed every add outright.
  await testAsync('previews work when the config is untracked (never committed)', async () => {
    // Remove the committed config on the branch, exactly as an unaware repo looks…
    git(['checkout', '-q', 'master'], seed);
    fs.rmSync(path.join(seed, 'preview.config.json'));
    git(['rm', '-q', '--cached', 'preview.config.json'], seed);
    git(['commit', '-qm', 'config is local-only now'], seed);
    git(['push', '-q', 'origin', 'master'], seed);
    git(['checkout', '-qb', 'feat/noconfig', 'master'], seed);
    git(['commit', '-q', '--allow-empty', '-m', 'branch without a config'], seed);
    git(['push', '-q', 'origin', 'feat/noconfig'], seed);

    // Clone AFTER the removal is pushed: the clone must never contain a
    // tracked copy of the config. (It also sidesteps Git-for-Windows autocrlf
    // marking a rewritten tracked file as modified purely over line endings.)
    const solo = path.join(ROOT, 'solo');
    git(['clone', '-q', originDir, solo], ROOT);

    // …while the developer keeps their copy only in the clone, untracked.
    // Write ONLY the config: touching tracked files would dirty the clone and
    // defeat the point of the assertion below.
    const scratch = path.join(ROOT, 'scratch-config');
    fs.mkdirSync(scratch, { recursive: true });
    writeApp(scratch, { marker: 'unused' });
    fs.copyFileSync(
      path.join(scratch, 'preview.config.json'),
      path.join(solo, 'preview.config.json'),
    );
    fs.appendFileSync(path.join(solo, '.git', 'info', 'exclude'), '\npreview.config.json\n');

    const out = deck(['add', 'feat/noconfig'], solo);
    assert.match(out, /ready ->/, out);
    assert.equal(git(['status', '--porcelain'], solo).trim(), '', 'clone must stay clean');
    deck(['remove', 'feat/noconfig'], solo, { allowFail: true });
  });

  test('each service console has its own log, readable via the CLI', () => {
    const out = deck(['logs', 'feat/one', 'web'], work);
    assert.match(out, /fixture server listening on \d+/, out);
    const bad = deck(['logs', 'feat/one', 'nope'], work, { allowFail: true });
    assert.match(bad, /services: web/, 'unknown service should list the real ones');
  });

  test('the repository clone stays clean throughout', () => {
    const out = git(['status', '--porcelain'], work);
    assert.equal(out.trim(), '', `clone should be untouched, saw:\n${out}`);
  });

  test('concurrent invocations are refused by the lock', () => {
    const lock = path.join(ROOT, 'work-previews', '.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const out = deck(['status', '--offline'], work, { allowFail: true });
    fs.rmSync(lock, { force: true });
    assert.match(out, /another branchdeck command is running/);
  });

  // --- teardown ------------------------------------------------------------
  deck(['stop', '--all'], work, { allowFail: true });
  deck(['remove', 'feat/one'], work, { allowFail: true });

  console.log(`\n${failures ? `${failures} FAILED` : 'all tests passed'}`);
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may hold handles briefly; the temp dir is disposable */
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`fatal during "${current}": ${err.stack}`);
  process.exit(1);
});
