const crypto = require('node:crypto');

/**
 * MoeLink 统一用户系统 JWT（HS256）。
 * token 由 genshin-quiz Go 后端签发，claims: { user_id, email, exp }。
 * 这里只做本地验签和过期校验，不依赖 node-api 是否在线。
 */

const ALLOWED_ALG = 'HS256';

function decodeJSON(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function verifyJWT(token, secret) {
  if (!secret || !token) return null;

  const parts = String(token).split('.');
  if (parts.length !== 3) return null;

  let header;
  let payload;
  try {
    header = decodeJSON(parts[0]);
    payload = decodeJSON(parts[1]);
  } catch {
    return null;
  }

  if (!header || header.alg !== ALLOWED_ALG) return null;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest('base64url');

  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  if (!payload.exp || Math.floor(Date.now() / 1000) >= Number(payload.exp)) return null;
  if (typeof payload.user_id !== 'number' || typeof payload.email !== 'string') return null;

  return payload;
}

function getBearer(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

class AdminResolver {
  /**
   * @param {object} opts
   * @param {string} opts.jwtSecret      与 Go 后端一致的 JWT_SECRET
   * @param {Array<number|string>} opts.adminUserIds 管理员 user_id 白名单（配置后不再依赖 node-api）
   * @param {string} opts.nodeApiUrl     未配置白名单时，用于查询 user_role 的 node-api 地址
   * @param {boolean} opts.requireAdmin  是否要求管理员（默认 true）
   * @param {number} opts.cacheMs        角色查询缓存时间
   */
  constructor({
    jwtSecret = '',
    adminUserIds = [],
    nodeApiUrl = '',
    requireAdmin = true,
    cacheMs = 60_000,
    fetchImpl = fetch,
  } = {}) {
    this.jwtSecret = jwtSecret;
    this.adminUserIds = new Set(
      adminUserIds.map((v) => Number(v)).filter((v) => Number.isFinite(v)),
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

    const payload = verifyJWT(token, this.jwtSecret);
    if (!payload) return { status: 401, error: 'unauthorized' };

    if (!this.requireAdmin) {
      return { status: 200, user: { kind: 'user', ...payload } };
    }

    // 配置了白名单：完全本地判断，node-api 挂了也能进后台
    if (this.adminUserIds.size > 0) {
      return this.adminUserIds.has(payload.user_id)
        ? { status: 200, user: { kind: 'admin', ...payload } }
        : { status: 403, error: 'forbidden' };
    }

    // 没配白名单：向 node-api 查询 user_role（group=100 为管理员），短时间缓存
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

module.exports = { verifyJWT, getBearer, AdminResolver };
