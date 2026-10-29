const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Stats } = require('./stats');
const { HealthMonitor } = require('./health');
const { createNotifiers } = require('./notifiers');
const { ReleaseGuardian } = require('./release');

function loadConfig() {
  const file = process.env.GATEWAY_CONFIG || path.join(__dirname, '..', 'gateway.config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.port = +process.env.PORT || cfg.port || 8000;
  cfg.adminToken = process.env.GATEWAY_ADMIN_TOKEN || cfg.adminToken || '';
  cfg.statsFile = process.env.STATS_FILE || cfg.statsFile;
  return cfg;
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function createGateway(cfg) {
  const stats = new Stats({ file: cfg.statsFile });
  const proxied = cfg.services.filter((s) => s.prefix);
  proxied.forEach((s) => stats.register(s.name, s.tracked));
  const monitor = new HealthMonitor({ services: cfg.services, options: cfg.health, notifier: createNotifiers(cfg.notifiers) });

  const releases = new ReleaseGuardian({ services: cfg.services, githubToken: process.env.GITHUB_TOKEN });
  const uiHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'));

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  };

  const authorized = (req) => !cfg.adminToken || req.headers.authorization === `Bearer ${cfg.adminToken}`;

  function proxy(req, res, svc, subPath) {
    const target = new URL(svc.target);
    const t0 = Date.now();
    let done = false;
    const finish = (status, failed) => {
      if (done) return;
      done = true;
      stats.record(svc.name, req.method, subPath.split('?')[0], status, Date.now() - t0, failed);
    };
    const headers = { ...req.headers, host: target.host, 'x-forwarded-for': [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ') };
    HOP_BY_HOP.forEach((h) => delete headers[h]);
    const up = http.request({ hostname: target.hostname, port: target.port || 80, method: req.method, path: subPath, headers, timeout: 30000 }, (ur) => {
      const h = { ...ur.headers };
      HOP_BY_HOP.forEach((k) => delete h[k]);
      res.writeHead(ur.statusCode, h);
      ur.pipe(res);
      ur.on('end', () => finish(ur.statusCode, false));
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', (e) => {
      finish(502, true);
      if (!res.headersSent) json(res, 502, { error: 'bad_gateway', service: svc.name, detail: e.message });
      else res.destroy();
    });
    res.on('close', () => finish(res.statusCode || 499, !res.writableEnded));
    req.pipe(up);
  }

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const pathname = url.split('?')[0];

    if (pathname === '/' || pathname === '/_gateway' || pathname === '/_gateway/') {
      res.writeHead(302, { location: '/_gateway/ui' });
      return res.end();
    }
    if (pathname === '/_gateway/ui' || pathname === '/_gateway/ui/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(uiHtml);
    }
    if (pathname === '/_gateway/health') return json(res, 200, { ok: true });
    if (pathname.startsWith('/_gateway/') || pathname === '/metrics') {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      if (pathname === '/_gateway/services') return json(res, 200, monitor.snapshot());
      if (pathname === '/_gateway/releases') return releases.snapshot().then((b) => json(res, 200, b), (e) => json(res, 500, { error: e.message }));
      if (pathname === '/_gateway/stats') return json(res, 200, stats.snapshot());
      if (pathname === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        return res.end(stats.prometheus(monitor.snapshot()));
      }
      return json(res, 404, { error: 'not_found' });
    }

    const svc = proxied.find((s) => pathname === s.prefix || pathname.startsWith(s.prefix + '/'));
    if (!svc) return json(res, 404, { error: 'no_route' });
    const sub = url.slice(svc.prefix.length) || '/';
    proxy(req, res, svc, sub.startsWith('/') ? sub : '/' + sub);
  });

  return {
    server,
    stats,
    monitor,
    start() {
      monitor.start();
      this.saver = setInterval(() => stats.save(), 30000);
      this.saver.unref();
      return new Promise((r) => server.listen(cfg.port, r));
    },
    stop() {
      monitor.stop();
      clearInterval(this.saver);
      stats.save();
      server.closeAllConnections?.();
      return new Promise((r) => server.close(r));
    },
  };
}

if (require.main === module) {
  const gw = createGateway(loadConfig());
  gw.start().then(() => console.log(`moelink-gateway listening on :${gw.server.address().port}`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => gw.stop().then(() => process.exit(0)));
}

module.exports = { createGateway };
