const fs = require('node:fs');
const path = require('node:path');

const SHA_RE = /^[0-9a-f]{40}$/i;

// Reads HEAD commit from a checkout without needing the git binary
function readGitHead(dir) {
  let gitDir = path.join(dir, '.git');
  if (fs.statSync(gitDir).isFile()) {
    const m = fs.readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/);
    gitDir = path.resolve(dir, m[1].trim());
  }
  const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  if (SHA_RE.test(head)) return { sha: head, branch: null };
  const ref = head.replace(/^ref:\s*/, '');
  const branch = ref.replace(/^refs\/heads\//, '');
  try {
    return { sha: fs.readFileSync(path.join(gitDir, ref), 'utf8').trim(), branch };
  } catch {
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(' ' + ref));
    if (!packed) throw new Error(`ref ${ref} not found`);
    return { sha: packed.split(' ')[0], branch };
  }
}

async function readVersionEndpoint(svc) {
  const res = await fetch(svc.target.replace(/\/$/, '') + svc.release.versionPath, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const sha = j.commit || j.sha || j.gitSha || j.hash;
  if (!sha) throw new Error('no commit field in version response');
  return { sha: String(sha), version: j.version, branch: j.branch || null };
}

class ReleaseGuardian {
  constructor({ services, githubToken, ttlMs = 5 * 60 * 1000 }) {
    this.services = services.filter((s) => s.release);
    this.token = githubToken;
    this.ttlMs = ttlMs;
    this.cache = new Map();
    this.last = null;
  }

  async gh(p) {
    const hit = this.cache.get(p);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.v;
    const res = await fetch('https://api.github.com' + p, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'moelink-gateway', ...(this.token && { authorization: `Bearer ${this.token}` }) },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    const v = await res.json();
    this.cache.set(p, { at: Date.now(), v });
    return v;
  }

  async deployed(svc) {
    const r = svc.release;
    if (r.versionPath) return readVersionEndpoint(svc);
    if (r.gitPath) return readGitHead(r.gitPath);
    if (r.sha) return { sha: r.sha };
    throw new Error('no deployed-version source configured (versionPath / gitPath)');
  }

  async inspect(svc) {
    const r = svc.release;
    const out = { service: svc.name, repo: r.repo, branch: r.branch, source: r.versionPath ? 'endpoint' : r.gitPath ? 'git' : 'static' };
    try {
      const d = await this.deployed(svc);
      Object.assign(out, { deployedSha: d.sha, deployedShort: d.sha.slice(0, 7), version: d.version || null, deployedBranch: d.branch || null });
    } catch (e) {
      out.error = `deployed: ${e.message}`;
    }
    if (r.repo && r.branch) {
      try {
        const latest = await this.gh(`/repos/${r.repo}/commits/${encodeURIComponent(r.branch)}`);
        Object.assign(out, { latestSha: latest.sha, latestShort: latest.sha.slice(0, 7), latestMessage: latest.commit.message.split('\n')[0], latestAt: latest.commit.committer.date });
        if (out.deployedSha) {
          if (out.deployedSha === latest.sha) Object.assign(out, { status: 'up-to-date', behindBy: 0 });
          else {
            const cmp = await this.gh(`/repos/${r.repo}/compare/${out.deployedSha}...${latest.sha}`);
            Object.assign(out, { status: cmp.ahead_by > 0 ? 'behind' : 'diverged', behindBy: cmp.ahead_by });
          }
        }
      } catch (e) {
        out.githubError = e.message;
      }
    }
    out.status ||= 'unknown';
    return out;
  }

  async snapshot() {
    const releases = await Promise.all(this.services.map((s) => this.inspect(s)));
    return { checkedAt: new Date().toISOString(), releases };
  }
}

module.exports = { ReleaseGuardian, readGitHead };
