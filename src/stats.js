const fs = require('node:fs');
const nodePath = require('node:path');

// "GET /api/public/*" -> matcher; a trailing "/*" matches any deeper path, an inner "*" one segment
function compilePattern(pattern) {
  const [method, p] = pattern.includes(' ') ? pattern.split(' ') : ['*', pattern];
  const tail = p.endsWith('/*');
  const base = tail ? p.slice(0, -1) : p;
  const re = new RegExp('^' + base.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + (tail ? '.+' : '') + '$');
  return { path: p, method: method.toUpperCase(), re };
}

class Stats {
  constructor({ file } = {}) {
    this.file = file;
    this.startedAt = Date.now();
    this.data = {}; // service -> routeKey -> counters
    this.hourly = {}; // 'YYYY-MM-DDTHH' -> service -> count
    this.matchers = {};
    this.load();
  }

  register(service, tracked = []) {
    this.matchers[service] = tracked.map(compilePattern);
  }

  // Unmatched paths collapse into "(other)" so ids in URLs can't blow up cardinality
  routeKey(service, method, path) {
    for (const m of this.matchers[service] || []) {
      if ((m.method === '*' || m.method === method) && m.re.test(path)) return `${method} ${m.path}`;
    }
    return `${method} (other)`;
  }

  record(service, method, path, status, ms, failed = false) {
    const key = this.routeKey(service, method, path);
    const svc = (this.data[service] ||= {});
    const r = (svc[key] ||= { count: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, errors: 0, totalMs: 0, maxMs: 0, last: 0 });
    r.count++;
    if (failed) r.errors++;
    else {
      const k = `s${Math.floor(status / 100)}xx`;
      r[k] = (r[k] || 0) + 1;
    }
    r.totalMs += ms;
    r.maxMs = Math.max(r.maxMs, ms);
    r.last = Date.now();

    const hour = new Date().toISOString().slice(0, 13);
    const h = (this.hourly[hour] ||= {});
    h[service] = (h[service] || 0) + 1;
    const hours = Object.keys(this.hourly).sort();
    while (hours.length > 24 * 7) delete this.hourly[hours.shift()];
  }

  snapshot() {
    const routes = [];
    for (const [service, rs] of Object.entries(this.data)) {
      for (const [route, r] of Object.entries(rs)) {
        routes.push({ service, route, ...r, avgMs: r.count ? +(r.totalMs / r.count).toFixed(2) : 0 });
      }
    }
    return { since: new Date(this.startedAt).toISOString(), routes, hourly: this.hourly };
  }

  load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = j.data || {};
      this.hourly = j.hourly || {};
      if (j.startedAt) this.startedAt = j.startedAt;
    } catch {}
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(nodePath.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ startedAt: this.startedAt, data: this.data, hourly: this.hourly }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[stats] save failed:', e.message);
    }
  }

  prometheus(health) {
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const out = ['# TYPE gateway_requests_total counter'];
    for (const [service, rs] of Object.entries(this.data)) {
      for (const [route, r] of Object.entries(rs)) {
        out.push(`gateway_requests_total{service="${esc(service)}",route="${esc(route)}"} ${r.count}`);
      }
    }
    out.push('# TYPE gateway_service_up gauge');
    for (const [name, h] of Object.entries(health)) out.push(`gateway_service_up{service="${esc(name)}"} ${h.up ? 1 : 0}`);
    return out.join('\n') + '\n';
  }
}

module.exports = { Stats };
