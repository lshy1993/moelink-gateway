const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createGateway } = require('../src/server');

const get = (port, p) =>
  new Promise((resolve, reject) => {
    http.get({ port, path: p, agent: false }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    }).on('error', reject);
  });

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
  const stats = JSON.parse((await get(port, '/_gateway/stats')).body);
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
