import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createDefaultConfig, normalizeProject, normalizeProjects, writeJsonFile } from '../src/workspace.mjs';

const runFile = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'bin/mr-watch.mjs');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const env = { ...process.env, GITLAB_TOKEN: '', MR_WATCH_HOME: '', MR_WATCH_CONFIG: '' };

async function until(check, message, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(40);
  }
  throw new Error(`等待超时: ${message}`);
}
const cleanups = new WeakMap();
function cleanup(t, action) {
  if (!cleanups.has(t)) {
    cleanups.set(t, []);
    t.after(async () => {
      for (const dispose of cleanups.get(t).reverse()) await dispose();
    });
  }
  cleanups.get(t).push(action);
}
async function temp(t) {
  const path = await mkdtemp(resolve(tmpdir(), 'mr-watch-test-'));
  cleanup(t, () => rm(path, { recursive: true, force: true }));
  return path;
}
async function listen(server) {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${server.address().port}`;
}
async function freePort() {
  const server = createServer();
  await listen(server);
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function command(args, cwd, extraEnv = {}) {
  return runFile(process.execPath, [cli, ...args], { cwd, env: { ...env, ...extraEnv }, timeout: 10000 });
}
async function start(t, home, cwd, args = [], extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [cli, '--home', home, '--dashboard-port', String(port), ...args], {
    cwd, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  cleanup(t, async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await until(() => child.exitCode !== null, `service exit: ${output}`);
  });
  const url = `http://127.0.0.1:${port}`;
  await until(async () => {
    if (child.exitCode !== null) throw new Error(output);
    try { return (await fetch(`${url}/healthz`)).ok; } catch { return false; }
  }, '管理页启动');
  return { url, child, output: () => output };
}
async function json(url, method = 'GET', body) {
  const response = await fetch(url, {
    method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function mockGitLab(t) {
  const calls = [];
  const hooks = [];
  let pipeline = 'running';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    calls.push({ path: url.pathname, token: req.headers['private-token'] });
    let value;
    if (url.pathname === '/hook') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      hooks.push(JSON.parse(Buffer.concat(chunks)));
      value = {};
    } else if (url.pathname === '/api/v4/user') {
      if (req.headers['private-token'] === 'invalid-token') { res.writeHead(401); res.end('invalid token'); return; }
      value = { username: 'tester' };
    }
    else if (decodeURIComponent(url.pathname).includes('team/broken')) {
      res.writeHead(500); res.end('project unavailable'); return;
    } else if (url.pathname.endsWith('/discussions')) value = [];
    else {
      const mr = {
        iid: 22, title: 'Example MR', author: { username: 'tester' },
        sha: '0123456789abcdef', state: 'opened', detailed_merge_status: 'mergeable',
        head_pipeline: { status: pipeline }, web_url: 'https://git.example.com/team/repo/-/merge_requests/22',
      };
      value = url.pathname.endsWith('/merge_requests') ? [mr] : mr;
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
  });
  const host = await listen(server);
  cleanup(t, () => { server.closeAllConnections(); server.close(); });
  return { host, calls, hooks, setPipeline: (value) => { pipeline = value; } };
}

// Minimal RFC 6455 fixture: records the real App Server JSON-RPC requests.
async function mockAppServer(t) {
  const calls = [];
  const sockets = new Set();
  let threads = 0;
  const server = createServer();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let pending = Buffer.alloc(0);
    socket.on('data', (data) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 2) {
        const opcode = pending[0] & 15;
        let length = pending[1] & 127;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2); offset = 4;
        }
        if (length === 127) throw new Error('Unexpected fixture frame size');
        const masked = Boolean(pending[1] & 128);
        const maskOffset = offset;
        if (masked) offset += 4;
        if (pending.length < offset + length) return;
        const payload = Buffer.from(pending.subarray(offset, offset + length));
        if (masked) for (let i = 0; i < length; i++) payload[i] ^= pending[maskOffset + (i % 4)];
        pending = pending.subarray(offset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const call = JSON.parse(payload.toString()); calls.push(call);
        const result = call.method === 'thread/start' ? { thread: { id: `thread-${++threads}` } } : {};
        const response = Buffer.from(JSON.stringify({ id: call.id, result }));
        const header = response.length < 126 ? Buffer.from([0x81, response.length]) : Buffer.from([0x81, 126, response.length >> 8, response.length & 255]);
        socket.write(Buffer.concat([header, response]));
      }
    });
  });
  const url = (await listen(server)).replace('http:', 'ws:');
  cleanup(t, () => { for (const socket of sockets) socket.destroy(); server.close(); });
  return { url, calls };
}

async function repository(path, remote) {
  await mkdir(path, { recursive: true });
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', remote]);
  return path;
}

test('v2 project validation and unique paths', () => {
  assert.deepEqual(createDefaultConfig().projects, []);
  assert.equal(createDefaultConfig().gitlabHost, '');
  assert.throws(() => normalizeProject('team/old'), /对象/);
  assert.throws(() => normalizeProject({ path: 'team/a', workspace: './relative' }), /绝对路径/);
  assert.throws(() => normalizeProjects([{ path: 'team/a' }, { path: 'team/a' }]), /重复/);
  assert.throws(() => normalizeProject({ path: 'team/../a' }), /full path/);
});

test('home precedence, non-Git cwd and independent --config', async (t) => {
  const base = await temp(t);
  const cwd = resolve(base, 'unrelated'); await mkdir(cwd);
  await command(['init'], cwd, { HOME: base });
  assert.equal(JSON.parse(await readFile(resolve(base, '.config/mr-watch/config.json'))).version, 2);
  const envHome = resolve(base, 'env-home');
  await command(['init'], cwd, { MR_WATCH_HOME: envHome });
  const home = resolve(base, 'cli-home');
  const config = resolve(base, 'separate/config.json');
  await command(['--home', home, 'init', '--config', config], cwd, { MR_WATCH_HOME: envHome });
  const saved = JSON.parse(await readFile(config));
  await writeJsonFile(config, { ...saved, watchEventLogPath: '../escaped-events.jsonl' });
  await command(['--home', home, '--config', config, '--role', 'developer', '--once', '--no-dashboard'], cwd);
  assert.ok((await readdir(home)).includes('events.jsonl'));
  assert.ok(!(await readdir(base)).includes('escaped-events.jsonl'));
  assert.deepEqual(await readdir(cwd), []);
  assert.ok((await readdir(home)).includes('state-developer.json'));
  assert.deepEqual(await readdir(dirname(config)), ['config.json']);
});

test('running empty service: dynamic projects, API-only review, cwd routing, auth wake and isolation', { timeout: 30000 }, async (t) => {
  const base = await temp(t);
  const gitlab = await mockGitLab(t);
  const app = await mockAppServer(t);
  const home = resolve(base, 'service');
  const cwd = resolve(base, 'launch'); await mkdir(cwd);
  const configPath = resolve(base, 'config/config.json');
  const service = await start(t, home, cwd, ['--config', configPath, '--app-server-url', app.url]);
  assert.equal((await json(`${service.url}/api/overview`)).body.stats.projectCount, 0);
  assert.equal(app.calls.length, 0);
  const a = await repository(resolve(base, 'a'), `${gitlab.host}/team/a.git`);
  const b = await repository(resolve(base, 'b'), `${gitlab.host}/team/b.git`);
  assert.equal((await json(`${service.url}/api/projects`, 'POST', { workspace: a })).status, 201);
  assert.equal((await json(`${service.url}/api/projects`, 'POST', { path: 'team/b', workspace: b })).status, 201);
  assert.equal((await json(`${service.url}/api/projects`, 'POST', { path: 'team/broken' })).status, 201);
  assert.equal((await json(`${service.url}/api/projects`, 'POST', { path: 'team/api' })).status, 201);
  assert.equal((await json(`${service.url}/api/projects`, 'POST', { path: 'team/api' })).status, 400);
  assert.equal((await json(`${service.url}/api/projects`, 'POST', { path: 'team/relative', workspace: './bad' })).status, 400);
  assert.equal((await json(`${service.url}/api/auth/gitlab`, 'POST', { token: 'mock-token' })).status, 200);
  await until(() => app.calls.filter((call) => call.method === 'turn/start').length === 3, '三个独立审查线程');
  const starts = app.calls.filter((call) => call.method === 'thread/start');
  assert.deepEqual(starts.map((call) => call.params.cwd), [a, b, home]);
  assert.match(app.calls.filter((call) => call.method === 'turn/start').at(-1).params.input[0].text, /只能使用 GitLab API/);
  await until(async () => {
    const overview = (await json(`${service.url}/api/overview`)).body;
    return overview.events.some((event) => event.project === 'team/broken' && event.type === 'error');
  }, '单项目失败被记录');
  const config = JSON.parse(await readFile(configPath));
  assert.equal(config.gitlabHost, gitlab.host);
  assert.equal(Object.keys(config.reviewThreads).length, 3);
  assert.deepEqual(await readdir(a), ['.git']);
  assert.deepEqual(await readdir(b), ['.git']);
  assert.deepEqual(await readdir(cwd), []);

  // A separate CLI changes the running service without restart.
  await command(['project', 'add', '--home', home, '--config', configPath, '--project', 'team/cli'], cwd);
  await until(() => app.calls.filter((call) => call.method === 'turn/start').length === 4, 'CLI 添加即时生效');
  await command(['auth', '--home', home, '--config', configPath, '--token', 'replacement-token'], cwd);
  await until(() => gitlab.calls.some((call) => call.path.includes('merge_requests') && call.token === 'replacement-token'), 'CLI 认证唤醒轮询');

  // Concurrent API/CLI configuration writes must preserve project and thread changes.
  await Promise.all([
    json(`${service.url}/api/mappings`, 'POST', { key: 'team/a!99', threadId: 'saved-thread' }),
    command(['project', 'add', '--home', home, '--config', configPath, '--project', 'team/concurrent'], cwd),
  ]);
  await until(() => app.calls.filter((call) => call.method === 'turn/start').length === 5, '并发添加项目');
  const latest = JSON.parse(await readFile(configPath));
  assert.equal(latest.reviewThreads['team/a!99'], 'saved-thread');
  assert.equal(Object.keys(latest.reviewThreads).length, 6);
  const paths = latest.projects.map((project) => project.path);
  for (const path of paths) assert.equal((await json(`${service.url}/api/projects?path=${encodeURIComponent(path)}`, 'DELETE')).status, 200);
  await until(async () => (await json(`${service.url}/api/overview`)).body.stats.projectCount === 0, '删除全部项目');
  assert.equal((await json(`${service.url}/api/overview`)).body.activeMergeRequests.length, 0);
  assert.equal((await json(`${service.url}/healthz`)).status, 200);
});

test('zero-project host setup uses environment Token and never persists it', async (t) => {
  const base = await temp(t);
  const gitlab = await mockGitLab(t);
  const home = resolve(base, 'service');
  const service = await start(t, home, base, [], { GITLAB_TOKEN: 'environment-token' });
  const result = await json(`${service.url}/api/auth/gitlab`, 'POST', {
    host: gitlab.host, token: 'ignored-token',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.auth.authenticated, true);
  assert.equal(result.body.auth.credentialsSource, 'environment');
  assert.ok(gitlab.calls.filter((call) => call.path === '/api/v4/user').every((call) => call.token === 'environment-token'));
  assert.ok(!(await readdir(home)).includes('credentials.json'));
  assert.equal(JSON.parse(await readFile(resolve(home, 'config.json'))).gitlabHost, gitlab.host);
  assert.equal(result.body.stats.projectCount, 0);
  assert.ok(!JSON.stringify(result.body).includes('environment-token'));
});

test('invalid authentication preserves config; single-project numeric notify keeps its workspace', async (t) => {
  const base = await temp(t);
  const gitlab = await mockGitLab(t);
  const home = resolve(base, 'service');
  const workspace = await repository(resolve(base, 'repo'), `${gitlab.host}/team/a.git`);
  await command(['project', 'add', '--home', home, '--workspace', workspace], base);
  await assert.rejects(command(['auth', '--home', home, '--token', 'invalid-token'], base), /401/);
  assert.ok(!(await readdir(home)).includes('credentials.json'));
  await command(['auth', '--home', home, '--token', 'mock-token'], base);
  await command(['register', '--home', home, '--thread', 'project-agent', '--mr', '22'], base);
  const result = await command(['--home', home, '--notify', '22', '--dry-run'], base);
  assert.match(result.stdout, /目标会话: project-agent/);
  assert.match(result.stdout, /项目: team\/a/);
  assert.deepEqual(await readdir(workspace), ['.git']);
});

test('developer manual and poll route by project; ambiguous IID is rejected', { timeout: 20000 }, async (t) => {
  const base = await temp(t);
  const gitlab = await mockGitLab(t);
  const home = resolve(base, 'home'); await mkdir(home);
  const configPath = resolve(home, 'config.json');
  const config = { ...createDefaultConfig(), gitlabHost: gitlab.host, role: 'developer',
    projects: [{ path: 'team/a', workspace: null }, { path: 'team/b', workspace: null }],
    developerThreadId: 'global-default',
  };
  await writeJsonFile(configPath, config);
  await command(['auth', '--home', home, '--token', 'mock-token'], base);
  await command(['register', '--home', home, '--hook-url', `${gitlab.host}/hook`, '--role', 'developer', '--project', 'team/b', '--mr', '22'], base);
  await command(['--home', home, '--notify', 'team/b!22'], base);
  assert.equal(gitlab.hooks.length, 1);
  assert.equal(gitlab.hooks[0].project, 'team/b');
  await assert.rejects(command(['--home', home, '--notify', '22'], base), /必须同时指定 --project/);
  await assert.rejects(command(['register', '--home', home, '--thread', 'bad', '--mr', '22'], base), /必须同时指定 --project/);
  await command(['--home', home, '--project', 'team/b', '--mr', '22'], base);
  assert.equal(gitlab.hooks.length, 2);
  // Project a has its own hook; neither event should reach the global default.
  await command(['register', '--home', home, '--hook-url', `${gitlab.host}/hook?a`, '--role', 'developer', '--project', 'team/a'], base);
  const service = await start(t, home, base);
  await until(async () => (await json(`${service.url}/api/overview`)).body.activeMergeRequests.length === 2, 'developer 首轮基线');
  assert.ok((await json(`${service.url}/api/overview`)).body.activeMergeRequests.every((mr) => mr.threadId === null));
  gitlab.setPipeline('failed');
  await writeJsonFile(configPath, { ...config, pollIntervalMs: 10000 });
  await until(() => gitlab.hooks.length === 4, '项目级 developer 轮询路由');
  assert.deepEqual(gitlab.hooks.slice(2).map((hook) => hook.project), ['team/a', 'team/b']);
});

test('glab fallback runs only in each project workspace', { skip: process.platform === 'win32' }, async (t) => {
  const base = await temp(t);
  const home = resolve(base, 'home'); await mkdir(home);
  const tools = resolve(base, 'bin'); await mkdir(tools);
  const log = resolve(base, 'glab-calls.jsonl');
  await writeFile(resolve(tools, 'glab'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.MOCK_GLAB_LOG, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');\nconsole.log(process.argv.includes('user') ? '{"username":"tester"}' : '[]');\n`, { mode: 0o755 });
  const a = resolve(base, 'a'); const b = resolve(base, 'b');
  await mkdir(a); await mkdir(b);
  await writeJsonFile(resolve(home, 'config.json'), {
    ...createDefaultConfig(), gitlabHost: 'https://git.example.com',
    projects: [{ path: 'team/a', workspace: a }, { path: 'team/b', workspace: b }, { path: 'team/api', workspace: null }],
  });
  await command(['--home', home, '--once', '--no-dashboard', '--dry-run'], base, { PATH: `${tools}:${process.env.PATH}`, MOCK_GLAB_LOG: log });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual([...new Set(calls.map((call) => call.cwd))], [a, b]);
  assert.ok(calls.filter((call) => call.args[0] === 'mr').every((call) => call.args.includes(`https://git.example.com/team/${call.cwd === a ? 'a' : 'b'}`)));
});
