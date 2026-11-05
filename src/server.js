const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Stats } = require('./stats');
const { HealthMonitor } = require('./health');
const { createNotifiers } = require('./notifiers');
const { ReleaseGuardian } = require('./release');
const { AdminResolver, getBearer } = require('./auth');
const { JwtVerifier } = require('./jwksVerifier');

function loadConfig() {
  const file = process.env.GATEWAY_CONFIG || path.join(__dirname, '..', 'gateway.config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.port = +process.env.PORT || cfg.port || 8000;
  cfg.adminToken = process.env.GATEWAY_ADMIN_TOKEN || cfg.adminToken || '';
  cfg.jwksUrl = process.env.AUTH_JWKS_URL || cfg.jwksUrl || '';
  cfg.adminUserIds = String(
    process.env.GATEWAY_ADMIN_USER_IDS || cfg.adminUserIds || '',
  )
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  cfg.adminEmails = String(
    process.env.GATEWAY_ADMIN_EMAILS || cfg.adminEmails || '',
  )
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  cfg.nodeApiUrl = process.env.NODE_API_URL || cfg.nodeApiUrl || 'http://node-api:8020';
  cfg.requireAdmin =
    process.env.GATEWAY_REQUIRE_ADMIN !== 'false' && cfg.requireAdmin !== false;
  cfg.statsFile = process.env.STATS_FILE || cfg.statsFile;
  if (!cfg.jwksUrl && !cfg.adminToken) {
    console.warn(
      '[gateway] AUTH_JWKS_URL and GATEWAY_ADMIN_TOKEN are both empty; all admin endpoints will return 401',
    );
  }
  return cfg;
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function createGateway(cfg) {
  const stats = new Stats({ file: cfg.statsFile });
  const proxied = cfg.services.filter((s) => s.prefix);
  proxied.forEach((s) => stats.register(s.name, s.tracked));
  const websocketServices = cfg.services.filter((s) => s.websocket);
  const upgradedSockets = new Set();
  const monitor = new HealthMonitor({
    services: cfg.services.filter((s) => s.monitor !== false),
    options: cfg.health,
    notifier: createNotifiers(cfg.notifiers),
  });

  const releases = new ReleaseGuardian({ services: cfg.services, githubToken: process.env.GITHUB_TOKEN });
  const uiHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'));
  // 只持有公钥：由 auth-service 的 JWKS 提供（测试可通过 cfg.verifier 注入）
  const verifier = cfg.verifier || new JwtVerifier({ jwksUrl: cfg.jwksUrl }).start();
  const auth = new AdminResolver({
    verifier,
    adminUserIds: cfg.adminUserIds,
    adminEmails: cfg.adminEmails,
    nodeApiUrl: cfg.nodeApiUrl,
    requireAdmin: cfg.requireAdmin !== false,
  });

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  };

  // 机器 token（Prometheus / 脚本）或用户 JWT 管理员
  const authorized = async (req) => {
    const token = getBearer(req);
    if (cfg.adminToken && token === cfg.adminToken) {
      return { status: 200, user: { kind: 'machine' } };
    }
    return auth.authenticate(req);
  };

  async function handleLogin(req, res) {
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 64 * 1024) {
          return json(res, 413, { error: 'body_too_large' });
        }
      }
    } catch {
      return json(res, 400, { error: 'bad_request' });
    }

    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      return json(res, 400, { error: 'invalid_json' });
    }

    const email = typeof payload.email === 'string' ? payload.email : '';
    const password = typeof payload.password === 'string' ? payload.password : '';
    if (!email || !password) {
      return json(res, 400, { error: 'missing_credentials' });
    }

    try {
      const upstream = await fetch(cfg.nodeApiUrl.replace(/\/$/, '') + '/user/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(8_000),
      });
      const data = await upstream.json().catch(() => null);
      return json(res, upstream.status, data || { error: 'login_failed' });
    } catch {
      return json(res, 502, { error: 'auth_service_unavailable' });
    }
  }

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

  // WebSocket / HTTP Upgrade passthrough. The service is selected by `websocket: true`
  // and its optional `prefix`; with no prefix it accepts every upgrade path.
  function proxyUpgrade(req, socket, head, svc) {
    const target = new URL(svc.target);
    const headers = { ...req.headers, host: target.host };
    const up = http.request({
      hostname: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: req.url,
      headers,
      timeout: 30000,
    });

    let upgraded = false;
    up.on('upgrade', (ur, upSocket, upHead) => {
      upgraded = true;
      let response = `HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}\r\n`;
      for (let i = 0; i < ur.rawHeaders.length; i += 2) {
        response += `${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}\r\n`;
      }
      socket.write(response + '\r\n');
      if (upHead && upHead.length) socket.write(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      upgradedSockets.add(socket);
      upgradedSockets.add(upSocket);
      const cleanup = () => {
        upgradedSockets.delete(socket);
        upgradedSockets.delete(upSocket);
      };
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
      upSocket.on('close', () => { cleanup(); socket.destroy(); });
      socket.on('close', () => { cleanup(); upSocket.destroy(); });
    });
    up.on('response', (ur) => {
      // Upstream refused the upgrade; return a normal error instead of hanging.
      ur.resume();
      socket.write(
        `HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      socket.destroy();
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', () => {
      if (!upgraded) socket.destroy();
    });
    if (head && head.length) up.write(head);
    up.end();
  }

  const server = http.createServer(async (req, res) => {
    try {
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
      if (pathname === '/_gateway/login' && req.method === 'POST') {
        await handleLogin(req, res);
        return;
      }
      if (pathname.startsWith('/_gateway/') || pathname === '/metrics') {
        const result = await authorized(req);
        if (result.status !== 200) {
          return json(res, result.status, { error: result.error || 'unauthorized' });
        }
        const who = result.user;
        if (pathname === '/_gateway/me') {
          return json(res, 200, {
            kind: who.kind,
            user_id: who.user_id,
            email: who.email,
          });
        }
        if (pathname === '/_gateway/services') return json(res, 200, monitor.snapshot());
        if (pathname === '/_gateway/releases') {
          try {
            return json(res, 200, await releases.snapshot());
          } catch (e) {
            return json(res, 500, { error: e.message });
          }
        }
        if (pathname === '/_gateway/stats') return json(res, 200, stats.snapshot());
        if (pathname === '/metrics') {
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
          return res.end(stats.prometheus(monitor.snapshot()));
        }
        return json(res, 404, { error: 'not_found' });
      }

      // prefix "/" is a catch-all: it matches every path except the gateway's own
      // "/" landing page (handled above) and more specific prefixes registered earlier.
      const svc = proxied.find(
        (s) => s.prefix === '/' || pathname === s.prefix || pathname.startsWith(s.prefix + '/'),
      );
      if (!svc) return json(res, 404, { error: 'no_route' });
      const sub = url.slice(svc.prefix.length) || '/';
      const upstreamPath = svc.upstreamPath
        ? svc.upstreamPath + (sub.includes('?') ? sub.slice(sub.indexOf('?')) : '')
        : svc.stripPrefix === false
          ? url
          : sub.startsWith('/') ? sub : '/' + sub;
      proxy(req, res, svc, upstreamPath);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.destroy();
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '/').split('?')[0];
    const svc = websocketServices.find(
      (s) =>
        !s.prefix ||
        s.prefix === '/' ||
        pathname === s.prefix ||
        pathname.startsWith(s.prefix + '/'),
    );
    if (!svc) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    proxyUpgrade(req, socket, head, svc);
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
      for (const socket of upgradedSockets) socket.destroy();
      upgradedSockets.clear();
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
