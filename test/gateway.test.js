const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { createGateway } = require('../src/server');

const get = (port, p, headers = {}) =>
  new Promise((resolve, reject) => {
    http.get({ port, path: p, headers, agent: false }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    }).on('error', reject);
  });

function signJWT(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

test('proxies, counts tracked routes and alerts on down', async () => {
  let healthy = true;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = healthy ? 200 : 500;
      return res.end('ok');
    }
    res.end('hello ' + req.url);
  });
  await new Promise((r) => upstream.listen(0, r));
  const events = [];
  const gw = createGateway({
    port: 0,
    adminToken: 'test-token',
    health: { intervalMs: 3600000, timeoutMs: 500, failThreshold: 2 },
    services: [{ name: 'api', prefix: '/api-x', target: `http://127.0.0.1:${upstream.address().port}`, tracked: ['GET /api/public/*'] }],
    notifiers: [],
  });
  gw.monitor.notifier = { notify: async (e) => events.push(e.type) };
  await gw.start();
  const port = gw.server.address().port;

  const r = await get(port, '/api-x/api/public/quote?id=1');
  assert.equal(r.body, 'hello /api/public/quote?id=1');
  await get(port, '/api-x/api/public/other');
  await get(port, '/api-x/misc');
  await new Promise((r) => setTimeout(r, 50));
  const stats = JSON.parse(
    (await get(port, '/_gateway/stats', { authorization: 'Bearer test-token' })).body,
  );
  assert.equal(stats.routes.find((x) => x.route === 'GET /api/public/*').count, 2);
  assert.equal(stats.routes.find((x) => x.route === 'GET (other)').count, 1);

  healthy = false;
  await gw.monitor.checkAll();
  assert.deepEqual(events, []);
  await gw.monitor.checkAll();
  assert.deepEqual(events, ['down']);
  healthy = true;
  await gw.monitor.checkAll();
  assert.deepEqual(events, ['down', 'recovered']);

  await gw.stop();
  upstream.close();
});

test('requires a valid admin JWT', async () => {
  const secret = 'test-jwt-secret';
  const gw = createGateway({
    port: 0,
    jwtSecret: secret,
    adminUserIds: [6],
    health: { intervalMs: 3600000, timeoutMs: 500, failThreshold: 2 },
    services: [],
    notifiers: [],
  });
  await gw.start();
  const port = gw.server.address().port;

  // 未登录
  assert.equal((await get(port, '/_gateway/stats')).status, 401);

  // 普通用户
  const normal = signJWT(
    { user_id: 7, email: 'user@example.com', exp: Math.floor(Date.now() / 1000) + 60 },
    secret,
  );
  assert.equal(
    (await get(port, '/_gateway/stats', { authorization: `Bearer ${normal}` })).status,
    403,
  );

  // 管理员
  const admin = signJWT(
    { user_id: 6, email: 'admin@example.com', exp: Math.floor(Date.now() / 1000) + 60 },
    secret,
  );
  const ok = await get(port, '/_gateway/stats', { authorization: `Bearer ${admin}` });
  assert.equal(ok.status, 200);

  // 过期 token
  const expired = signJWT(
    { user_id: 6, email: 'admin@example.com', exp: Math.floor(Date.now() / 1000) - 1 },
    secret,
  );
  assert.equal(
    (await get(port, '/_gateway/stats', { authorization: `Bearer ${expired}` })).status,
    401,
  );

  // 错误签名
  const forged = signJWT(
    { user_id: 6, email: 'admin@example.com', exp: Math.floor(Date.now() / 1000) + 60 },
    'wrong-secret',
  );
  assert.equal(
    (await get(port, '/_gateway/stats', { authorization: `Bearer ${forged}` })).status,
    401,
  );

  await gw.stop();
});

test('admin fallback queries node-api POST /user/info', async () => {
  const { AdminResolver } = require('../src/auth');
  const secret = 'test-jwt-secret';
  const calls = [];
  const resolver = new AdminResolver({
    jwtSecret: secret,
    adminUserIds: [],
    nodeApiUrl: 'http://node-api:8020/',
    fetchImpl: async (url, opts) => {
      calls.push({ url, method: opts.method, auth: opts.headers.Authorization });
      return { ok: true, json: async () => ({ userInfo: { group: 100 } }) };
    },
  });

  const token = signJWT(
    { user_id: 6, email: 'admin@example.com', exp: Math.floor(Date.now() / 1000) + 60 },
    secret,
  );
  const result = await resolver.authenticate({
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(result.status, 200);
  assert.equal(result.user.kind, 'admin');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://node-api:8020/user/info');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].auth, `Bearer ${token}`);
});

test('readGitHead resolves branch ref', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readGitHead } = require('../src/release');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
  const sha = 'a'.repeat(40);
  fs.mkdirSync(path.join(dir, '.git/refs/heads'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git/HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dir, '.git/refs/heads/main'), sha + '\n');
  assert.deepEqual(readGitHead(dir), { sha, branch: 'main' });
  fs.rmSync(dir, { recursive: true });
});
