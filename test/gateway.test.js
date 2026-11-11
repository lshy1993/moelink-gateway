const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { createGateway } = require('../src/server');
const { JwtVerifier } = require('../src/jwksVerifier');

const get = (port, p, headers = {}) =>
  new Promise((resolve, reject) => {
    http.get({ port, path: p, headers, agent: false }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    }).on('error', reject);
  });

const KID = 'test-key';
const newKeyPair = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const testKey = newKeyPair();
const testVerifier = (keyPair = testKey) => {
  const jwk = keyPair.publicKey.export({ format: 'jwk' });
  return new JwtVerifier({ jwks: { keys: [{ ...jwk, kid: KID }] } });
};

function signJWT(payload, privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: KID })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'moelink-auth', ...payload })).toString('base64url');
  const sig = crypto
    .sign('sha256', Buffer.from(`${header}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
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
    services: [
      { name: 'api', prefix: '/api-x', target: `http://127.0.0.1:${upstream.address().port}`, tracked: ['GET /api/public/*'], repo: 'lshy1993/example-repo' },
      {
        name: 'google-oauth-callback',
        prefix: '/auth/google/callback',
        target: `http://127.0.0.1:${upstream.address().port}`,
        upstreamPath: '/auth/google/callback',
        monitor: false,
        tracked: [],
      },
      {
        name: 'keep-prefix',
        prefix: '/keep',
        target: `http://127.0.0.1:${upstream.address().port}`,
        stripPrefix: false,
        monitor: false,
        tracked: [],
      },
      {
        name: 'catch-all',
        prefix: '/',
        target: `http://127.0.0.1:${upstream.address().port}`,
        monitor: false,
        tracked: [],
      },
    ],
    notifiers: [],
  });
  gw.monitor.notifier = { notify: async (e) => events.push(e.type) };
  await gw.start();
  const port = gw.server.address().port;

  const r = await get(port, '/api-x/api/public/quote?id=1');
  assert.equal(r.body, 'hello /api/public/quote?id=1');
  const callback = await get(port, '/auth/google/callback?code=secret&state=signed');
  assert.equal(callback.body, 'hello /auth/google/callback?code=secret&state=signed');
  const catchAll = await get(port, '/health');
  assert.equal(catchAll.body, 'ok');
  const keepPrefix = await get(port, '/keep/x?y=1');
  assert.equal(keepPrefix.body, 'hello /keep/x?y=1');
  await get(port, '/api-x/api/public/other');
  await get(port, '/api-x/misc');
  await new Promise((r) => setTimeout(r, 50));
  const stats = JSON.parse(
    (await get(port, '/_gateway/stats', { authorization: 'Bearer test-token' })).body,
  );
  assert.equal(stats.routes.find((x) => x.route === 'GET /api/public/*').count, 2);
  assert.equal(stats.routes.find((x) => x.route === 'GET (other)').count, 1);

  const services = JSON.parse(
    (await get(port, '/_gateway/services', { authorization: 'Bearer test-token' })).body,
  );
  assert.equal(services.api.repo, 'lshy1993/example-repo');

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

test('proxies websocket upgrades', async () => {
  const upstream = http.createServer();
  upstream.on('upgrade', (_req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.on('data', (chunk) => socket.write(chunk));
  });
  await new Promise((r) => upstream.listen(0, r));

  const gw = createGateway({
    port: 0,
    health: { intervalMs: 3600000, timeoutMs: 500, failThreshold: 2 },
    services: [
      {
        name: 'ws',
        target: `http://127.0.0.1:${upstream.address().port}`,
        websocket: true,
        monitor: false,
      },
    ],
    notifiers: [],
  });
  await gw.start();
  const port = gw.server.address().port;

  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      port,
      path: '/',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
    });
    req.on('upgrade', (res, socket) => {
      socket.write('ping');
      socket.once('data', (chunk) => {
        resolve({ status: res.statusCode, body: chunk.toString() });
        socket.destroy();
      });
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal(result.status, 101);
  assert.equal(result.body, 'ping');
  await gw.stop();
  upstream.closeAllConnections?.();
  upstream.close();
});

test('requires a valid admin JWT', async () => {
  const gw = createGateway({
    port: 0,
    verifier: testVerifier(),
    adminEmails: ['admin@example.com'],
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
    testKey.privateKey,
  );
  assert.equal(
    (await get(port, '/_gateway/stats', { authorization: `Bearer ${normal}` })).status,
    403,
  );

  // 管理员
  const admin = signJWT(
    { user_id: 6, email: 'admin@example.com', exp: Math.floor(Date.now() / 1000) + 60 },
    testKey.privateKey,
  );
  const ok = await get(port, '/_gateway/stats', { authorization: `Bearer ${admin}` });
  assert.equal(ok.status, 200);

  // 过期 token
  const expired = signJWT(
    { user_id: 6, email: 'admin@example.com', exp: Math.floor(Date.now() / 1000) - 1 },
    testKey.privateKey,
  );
  assert.equal(
    (await get(port, '/_gateway/stats', { authorization: `Bearer ${expired}` })).status,
    401,
  );

  // 错误签名
  const forged = signJWT(
    { user_id: 6, email: 'admin@example.com', exp: Math.floor(Date.now() / 1000) + 60 },
    newKeyPair().privateKey,
  );
  assert.equal(
    (await get(port, '/_gateway/stats', { authorization: `Bearer ${forged}` })).status,
    401,
  );

  await gw.stop();
});

test('admin fallback queries node-api POST /user/info', async () => {
  const { AdminResolver } = require('../src/auth');
  const calls = [];
  const resolver = new AdminResolver({
    verifier: testVerifier(),
    nodeApiUrl: 'http://node-api:8020/',
    fetchImpl: async (url, opts) => {
      calls.push({ url, method: opts.method, auth: opts.headers.Authorization });
      return { ok: true, json: async () => ({ userInfo: { group: 100 } }) };
    },
  });

  const token = signJWT(
    { user_id: 6, email: 'admin@example.com', exp: Math.floor(Date.now() / 1000) + 60 },
    testKey.privateKey,
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

test('rejects tokens issued to third-party SSO clients', () => {
  const sign = (extra) =>
    signJWT({ user_id: 6, email: 'a@b.c', exp: Math.floor(Date.now() / 1000) + 60, ...extra }, testKey.privateKey);
  assert.ok(testVerifier().verify(sign({})));
  assert.equal(testVerifier().verify(sign({ client_id: 'partner' })), null);
  const lenient = new JwtVerifier({
    jwks: { keys: [{ ...testKey.publicKey.export({ format: 'jwk' }), kid: KID }] },
    allowClientTokens: true,
  });
  assert.ok(lenient.verify(sign({ client_id: 'partner' })));
});
