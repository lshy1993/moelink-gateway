const net = require('node:net');
const http = require('node:http');

// node:http (not fetch) so the Host header can be overridden, e.g. for Vite dev servers' host check
function checkHttp(url, timeoutMs, host) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs, headers: host ? { host } : {} }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function checkTcp(target, timeoutMs) {
  const u = new URL(target);
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: u.hostname, port: +u.port || 80, timeout: timeoutMs });
    s.once('connect', () => (s.destroy(), resolve()));
    s.once('timeout', () => (s.destroy(), reject(new Error('timeout'))));
    s.once('error', reject);
  });
}

class HealthMonitor {
  constructor({ services, options = {}, notifier }) {
    this.services = services;
    this.opts = { intervalMs: 15000, timeoutMs: 5000, failThreshold: 3, ...options };
    this.notifier = notifier;
    this.state = Object.fromEntries(
      services.map((s) => [s.name, { up: true, failures: 0, since: Date.now(), lastCheck: null, lastError: null, latencyMs: null }]),
    );
  }

  start() {
    this.checkAll();
    this.timer = setInterval(() => this.checkAll(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  checkAll() {
    return Promise.all(this.services.map((s) => this.check(s)));
  }

  async check(svc) {
    const st = this.state[svc.name];
    const t0 = Date.now();
    let err = null;
    try {
      if (svc.healthType === 'tcp') await checkTcp(svc.target, this.opts.timeoutMs);
      else await checkHttp(svc.target.replace(/\/$/, '') + (svc.healthPath || '/health'), this.opts.timeoutMs, svc.healthHost);
    } catch (e) {
      err = e.message || String(e);
    }
    st.lastCheck = new Date().toISOString();
    st.latencyMs = Date.now() - t0;

    if (!err) {
      st.lastError = null;
      st.failures = 0;
      if (!st.up) {
        const downFor = Math.round((Date.now() - st.since) / 1000);
        st.up = true;
        st.since = Date.now();
        await this.emit('recovered', svc, `✅ ${svc.name} recovered (down ${downFor}s)`);
      }
      return;
    }
    st.lastError = err;
    st.failures++;
    if (st.up && st.failures >= this.opts.failThreshold) {
      st.up = false;
      st.since = Date.now();
      await this.emit('down', svc, `🔴 ${svc.name} is DOWN: ${err} (${svc.target})`);
    }
  }

  emit(type, svc, message) {
    return this.notifier.notify({ type, service: svc.name, message, at: new Date().toISOString() });
  }

  snapshot() {
    return Object.fromEntries(Object.entries(this.state).map(([k, v]) => [k, { ...v, since: new Date(v.since).toISOString() }]));
  }
}

module.exports = { HealthMonitor };
