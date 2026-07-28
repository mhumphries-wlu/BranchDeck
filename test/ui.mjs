#!/usr/bin/env node
/**
 * Tests for the browser control pane.
 *
 * Drives the real HTTP server against a throwaway repository: auth, the page
 * itself, listing branches, adding a preview through the API, live activity,
 * config validation and saving, and settings.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'branchdeck-ui-'));

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r.stdout || '';
};
const git = (args, cwd) => sh('git', args, cwd);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture(dir, marker) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'marker.txt'), `${marker}\n`);
  fs.writeFileSync(path.join(dir, 'deps.txt'), 'base\n');
  fs.writeFileSync(
    path.join(dir, 'server.mjs'),
    `import http from 'node:http';import fs from 'node:fs';
http.createServer((q,s)=>{s.writeHead(200);s.end(fs.readFileSync('src/marker.txt','utf8'))})
  .listen(Number(process.env.PORT),'127.0.0.1');`,
  );
  fs.writeFileSync(
    path.join(dir, 'preview.config.json'),
    JSON.stringify(
      {
        name: 'uitest',
        services: [{ id: 'web', run: `${JSON.stringify(process.execPath)} server.mjs`, open: true }],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n');
}

async function main() {
  console.log(`branchdeck ui tests (${process.platform})\n`);

  const origin = path.join(ROOT, 'o.git');
  const seed = path.join(ROOT, 'seed');
  git(['init', '--bare', '-q', origin], ROOT);
  fs.mkdirSync(seed);
  git(['init', '-q'], seed);
  git(['config', 'user.email', 't@example.com'], seed);
  git(['config', 'user.name', 'test'], seed);
  fixture(seed, 'master');
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'base'], seed);
  git(['branch', '-M', 'master'], seed);
  git(['remote', 'add', 'origin', origin], seed);
  git(['push', '-q', 'origin', 'master'], seed);
  for (const b of ['feat/alpha', 'feat/beta']) {
    git(['checkout', '-qb', b, 'master'], seed);
    fs.writeFileSync(path.join(seed, 'src', 'marker.txt'), `${b}\n`);
    git(['commit', '-qam', b], seed);
    git(['push', '-q', 'origin', b], seed);
    git(['checkout', '-q', 'master'], seed);
  }
  const work = path.join(ROOT, 'work');
  git(['clone', '-q', origin, work], ROOT);

  // --- boot the server ------------------------------------------------------
  const server = spawn(process.execPath, [CLI, 'ui', '--no-open', '--port', '8399'], {
    cwd: work,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });

  const deadline = Date.now() + 20000;
  while (!/control pane: (\S+)/.test(out) && Date.now() < deadline) await sleep(200);
  const link = /control pane: (\S+)/.exec(out)?.[1];
  if (!link) throw new Error(`server never started:\n${out}`);
  const base = new URL(link);
  const token = base.searchParams.get('token');
  const api = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${base.port}${p}`, {
      ...opts,
      headers: { 'content-type': 'application/json', 'x-branchdeck-token': token, ...(opts.headers || {}) },
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  };

  await test('serves the control pane page', async () => {
    const r = await api('/');
    assert.equal(r.status, 200);
    assert.match(r.body, /<title>branchdeck<\/title>/);
    assert.match(r.body, /Add a preview/);
    assert.doesNotMatch(r.body, /__TOKEN__/, 'token placeholder must be substituted');
  });

  await test('rejects requests without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${base.port}/api/state`);
    assert.equal(res.status, 403);
  });

  await test('rejects a cross-origin request (CSRF defence)', async () => {
    const res = await fetch(`http://127.0.0.1:${base.port}/api/state?token=${token}`, {
      headers: { origin: 'http://evil.example' },
    });
    assert.equal(res.status, 403);
  });

  await test('rejects a non-loopback Host (DNS rebinding defence)', async () => {
    // fetch() treats Host as a forbidden header and silently ignores an
    // override, so this has to go out over a raw socket to test anything.
    const raw = await new Promise((resolve, reject) => {
      const sock = net.connect(Number(base.port), '127.0.0.1', () => {
        sock.write(
          `GET /api/state?token=${token} HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n`,
        );
      });
      let data = '';
      sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
      sock.on('data', (c) => { data += c; });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 403/, `got: ${raw.split('\r\n')[0]}`);
  });

  await test('lists remote branches, excluding ones already added', async () => {
    const r = await api('/api/branches');
    assert.equal(r.status, 200);
    const names = r.body.branches.map((b) => b.name);
    assert.ok(names.includes('feat/alpha'), `saw ${names}`);
    assert.ok(names.includes('master'));
    assert.ok(r.body.branches.every((b) => !b.added), 'nothing added yet');
  });

  await test('reports initial state with a valid config', async () => {
    const r = await api('/api/state');
    assert.equal(r.status, 200);
    assert.equal(r.body.configOk, true);
    assert.deepEqual(r.body.previews, []);
  });

  await test('adds a preview through the API and it serves content', async () => {
    const r = await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'add', branch: 'feat/alpha' }) });
    assert.equal(r.status, 202);

    const until = Date.now() + 90000;
    let state;
    while (Date.now() < until) {
      state = (await api('/api/state')).body;
      if (!state.busy && state.previews.length) break;
      await sleep(500);
    }
    assert.equal(state.previews.length, 1, `activity:\n${(state.activity || []).map((a) => a.message).join('\n')}`);
    const p = state.previews[0];
    assert.equal(p.branch, 'feat/alpha');
    assert.ok(p.running, 'preview should be running');
    // localhost → ::1 on Node 18 with no IPv4 fallback; the server binds v4.
    const res = await fetch(p.url.replace('//localhost:', '//127.0.0.1:'), {
      headers: { connection: 'close' },
    });
    assert.match(await res.text(), /feat\/alpha/);
  });

  await test('activity log captured the progress', async () => {
    const { body } = await api('/api/state');
    const text = body.activity.map((a) => a.message).join('\n');
    assert.match(text, /add feat\/alpha/);
    assert.match(text, /ready ->/);
  });

  await test('branch list now marks the added branch', async () => {
    const { body } = await api('/api/branches');
    assert.equal(body.branches.find((b) => b.name === 'feat/alpha').added, true);
  });

  // The Refresh button. Nothing changed on origin, so it must report that and
  // leave the running servers alone.
  await test('the refresh action is a no-op when the branch has not moved', async () => {
    const before = (await api('/api/state')).body.previews[0].startedAt;
    await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'refresh', branch: 'feat/alpha' }) });
    const until = Date.now() + 60000;
    let s;
    do {
      await sleep(400);
      s = (await api('/api/state')).body;
    } while (s.busy && Date.now() < until);
    assert.ok(s.activity.some((a) => /already up to date and running/.test(a.message)),
      `expected a no-op refresh, got:\n${s.activity.map((a) => a.message).join('\n')}`);
    assert.equal(s.previews[0].startedAt, before, 'a no-op refresh must not restart anything');
  });

  await test('startedAt advances on restart (drives tab auto-reload)', async () => {
    const before = (await api('/api/state')).body.previews[0].startedAt;
    assert.ok(before > 0, 'a running preview must report when it started');

    await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'restart', branch: 'feat/alpha' }) });
    const until = Date.now() + 60000;
    let after = before;
    while (Date.now() < until) {
      const s = (await api('/api/state')).body;
      after = s.previews[0].startedAt;
      if (!s.busy && after > before) break;
      await sleep(400);
    }
    assert.ok(after > before, `startedAt must move forward (${before} -> ${after})`);
  });

  await test('auto-reload preference round-trips', async () => {
    assert.equal((await api('/api/state')).body.settings.autoReloadTabs, false, 'must default off');
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ autoReloadTabs: true }) });
    assert.equal((await api('/api/state')).body.settings.autoReloadTabs, true);
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ autoReloadTabs: false }) });
  });

  await test('per-preview log is retrievable', async () => {
    const { status, body } = await api('/api/logs?branch=' + encodeURIComponent('feat/alpha'));
    assert.equal(status, 200);
    assert.match(body.text, /start feat\/alpha/);
  });

  await test('service consoles: labelled in state, streamed by the API', async () => {
    const state = (await api('/api/state')).body;
    const svc = state.previews[0].services[0];
    assert.equal(svc.label, 'web \u2014 feat/alpha', `saw label: ${svc.label}`);
    const r = await api('/api/logs?branch=' + encodeURIComponent('feat/alpha') + '&service=web');
    assert.equal(r.status, 200);
    assert.match(r.body.text, /start feat\/alpha :: web/);
  });

  await test('rejects an invalid config and does not write it', async () => {
    const before = (await api('/api/config')).body.text;
    const r = await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ text: '{"services":[],"pools":[]}' }),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /services/);
    assert.equal((await api('/api/config')).body.text, before, 'file must be unchanged');
  });

  await test('accepts a valid config edit, comments and all', async () => {
    const cur = JSON.parse((await api('/api/config')).body.text);
    cur.name = 'renamed';
    const text = `// edited by the control pane\n${JSON.stringify(cur, null, 2)}`;
    const r = await api('/api/config', { method: 'PUT', body: JSON.stringify({ text }) });
    assert.equal(r.status, 200);
    const after = await api('/api/config');
    assert.match(after.body.text, /edited by the control pane/);
    assert.equal(after.body.ok, true);
  });

  await test('saves settings', async () => {
    const r = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ basePort: 8250, browser: 'msedge' }) });
    assert.equal(r.status, 200);
    assert.equal(r.body.settings.basePort, 8250);
    assert.equal((await api('/api/state')).body.settings.browser, 'msedge');
  });

  // Refreshing is on-demand only; there is no background poller to toggle.
  await test('there is no watch endpoint', async () => {
    const r = await api('/api/watch', { method: 'POST', body: JSON.stringify({ enabled: true }) });
    assert.equal(r.status, 404);
    assert.equal((await api('/api/state')).body.watch, undefined);
  });

  // Regression: a failing job used to call process.exit and take the whole
  // control pane down with it.
  await test('a failing job does not kill the server', async () => {
    const r = await api('/api/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'add', branch: 'does/not/exist' }),
    });
    assert.equal(r.status, 202);
    const until = Date.now() + 30000;
    let state;
    while (Date.now() < until) {
      state = (await api('/api/state')).body;
      if (!state.busy) break;
      await sleep(400);
    }
    assert.equal((await api('/api/state')).status, 200, 'server must still answer');
    const text = state.activity.map((a) => a.message).join('\n');
    assert.match(text, /does\/not\/exist/, 'the failure should be reported in the activity log');
    // and no debris left behind for the user to prune by hand
    assert.ok(!state.previews.some((p) => p.branch === 'does/not/exist'));
  });

  await test('unknown action is reported, server stays up', async () => {
    await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'nope' }) });
    assert.equal((await api('/api/state')).status, 200);
  });

  await test('a rejected branch name never reaches git', async () => {
    const r = await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'add', branch: '--upload-pack=evil' }) });
    assert.equal(r.status, 400);
  });

  await test('removes a preview through the API', async () => {
    await api('/api/action', { method: 'POST', body: JSON.stringify({ action: 'remove', branch: 'feat/alpha' }) });
    const until = Date.now() + 40000;
    let state;
    while (Date.now() < until) {
      state = (await api('/api/state')).body;
      if (!state.busy && !state.previews.length) break;
      await sleep(400);
    }
    assert.equal(state.previews.length, 0);
  });

  await test('the clone is untouched throughout', async () => {
    // preview.config.json was intentionally edited above; nothing else may change.
    const dirty = git(['status', '--porcelain'], work)
      .split('\n').map((l) => l.trim()).filter(Boolean);
    assert.deepEqual(dirty, ['M preview.config.json'], `saw: ${dirty.join(' | ')}`);
  });

  server.kill();
  await sleep(300);
  console.log(`\n${failures ? `${failures} FAILED` : 'all ui tests passed'}`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* windows handles */ }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`fatal: ${err.stack}`);
  process.exit(1);
});
