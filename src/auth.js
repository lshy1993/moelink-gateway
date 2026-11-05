const crypto = require('node:crypto');

/**
 * MoeLink 统一用户系统 JWT（ES256）。
 * token 由 auth-service 签发，claims: { user_id, email, exp }。
 * 这里只用 JWKS 公钥做本地验签和过期校验，不依赖 node-api 是否在线。
 */

function getBearer(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

class AdminResolver {
  /**
   * @param {object} opts
   * @param {import('./jwksVerifier').JwtVerifier} opts.verifier  token 验签器（公钥来自 auth-service 的 JWKS）
   * @param {Array<string>} opts.adminEmails 管理员邮箱白名单（break-glass；邮箱来自 JWT）
   * @param {string} opts.nodeApiUrl     用于查询 user_role 的 node-api 地址；网页后台改角色后从这里生效
   * @param {boolean} opts.requireAdmin  是否要求管理员（默认 true）
   * @param {number} opts.cacheMs        角色查询缓存时间
   */
  constructor({
    verifier = null,
    adminEmails = [],
    nodeApiUrl = '',
    requireAdmin = true,
    cacheMs = 60_000,
    fetchImpl = fetch,
  } = {}) {
    this.verifier = verifier;
    this.adminEmails = new Set(
      adminEmails.map((v) => String(v).trim().toLowerCase()).filter(Boolean),
    );
    this.nodeApiUrl = nodeApiUrl;
    this.requireAdmin = requireAdmin;
    this.cacheMs = cacheMs;
    this.fetch = fetchImpl;
    this.cache = new Map();
  }

  /**
   * @returns {Promise<{status:number,error?:string,user?:object}>}
   */
  async authenticate(req) {
    const token = getBearer(req);
    if (!token) return { status: 401, error: 'unauthorized' };

    const payload = this.verifier ? this.verifier.verify(token) : null;
    if (!payload) return { status: 401, error: 'unauthorized' };

    if (!this.requireAdmin) {
      return { status: 200, user: { kind: 'user', ...payload } };
    }

    // 邮箱白名单是 break-glass：即使 node-api 不可用，这些邮箱也能进入后台。
    const email = String(payload.email || '').trim().toLowerCase();
    if (this.adminEmails.has(email)) {
      return { status: 200, user: { kind: 'admin', ...payload } };
    }

    // 常规路径：以 users.user_role 为准，网页后台改角色后从这里生效。
    // 短时间缓存，避免每次请求都访问 node-api。
    const ok = await this.isAdmin(token);
    return ok
      ? { status: 200, user: { kind: 'admin', ...payload } }
      : { status: 403, error: 'forbidden' };
  }

  async isAdmin(token) {
    if (!this.nodeApiUrl) return false;

    const key = crypto.createHash('sha256').update(token).digest('hex');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheMs) return hit.ok;

    let ok = false;
    try {
      // node-api 的 /user/info 是 POST（route/user.js）
      const res = await this.fetch(
        this.nodeApiUrl.replace(/\/$/, '') + '/user/info',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: '{}',
          signal: AbortSignal.timeout(3_000),
        },
      );
      if (res.ok) {
        const body = await res.json();
        ok = body && body.userInfo && body.userInfo.group === 100;
      }
    } catch {
      ok = false;
    }

    this.cache.set(key, { at: Date.now(), ok });
    if (this.cache.size > 1000) {
      const oldest = [...this.cache.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, 200);
      for (const [k] of oldest) this.cache.delete(k);
    }
    return ok;
  }
}

module.exports = { getBearer, AdminResolver };
