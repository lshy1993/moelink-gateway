const crypto = require('node:crypto');

/**
 * MoeLink 统一登录 token（ES256）的校验器。
 * 只有 auth-service 持有私钥；这里通过 JWKS 地址获取公钥，本地验签，不共享任何签名密钥。
 * verify() 是同步的：公钥在后台拉取并缓存，遇到未知 kid（密钥轮换）会触发一次限频的重新拉取。
 */

const ISSUER = 'moelink-auth';
const MIN_RETRY_MS = 10 * 1000;

function decodeJSON(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

class JwtVerifier {
  /**
   * @param {object} opts
   * @param {string} [opts.jwksUrl]  auth-service 的 JWKS 地址
   * @param {object} [opts.jwks]     直接给定 JWKS（测试 / 离线场景）
   * @param {number} [opts.refreshMs] 定时刷新间隔，默认 10 分钟
   * @param {boolean} [opts.allowClientTokens] 是否接受发给站外应用的受限 token（带 client_id），自家服务应保持 false
   * @param {Function} [opts.fetchImpl]
   */
  constructor({
    jwksUrl = '',
    jwks = null,
    refreshMs = 10 * 60 * 1000,
    allowClientTokens = false,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.jwksUrl = jwksUrl;
    this.allowClientTokens = allowClientTokens;
    this.refreshMs = refreshMs;
    this.fetchImpl = fetchImpl;
    this.keys = new Map();
    this.lastTry = 0;
    this.timer = null;
    if (jwks) this.setKeys(jwks);
  }

  setKeys(jwks) {
    const next = new Map();
    for (const jwk of (jwks && jwks.keys) || []) {
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.kid) continue;
      try {
        next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        /* 忽略无法解析的公钥 */
      }
    }
    if (next.size > 0) this.keys = next;
    return next.size;
  }

  async refresh(force = false) {
    if (!this.jwksUrl) return false;
    const now = Date.now();
    if (!force && now - this.lastTry < MIN_RETRY_MS) return false;
    this.lastTry = now;
    try {
      const res = await this.fetchImpl(this.jwksUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      return this.setKeys(await res.json()) > 0;
    } catch {
      return false;
    }
  }

  /** 启动后台拉取：auth-service 尚未就绪时会持续重试，之后定时刷新。 */
  start() {
    if (!this.jwksUrl || this.timer) return this;
    const tick = () => this.refresh(true);
    tick();
    const retry = setInterval(() => {
      if (this.keys.size > 0) {
        clearInterval(retry);
        return;
      }
      tick();
    }, 3000);
    retry.unref();
    this.timer = setInterval(tick, this.refreshMs);
    this.timer.unref();
    return this;
  }

  /** 校验通过返回 payload { user_id, email, exp, ... }，否则返回 null。 */
  verify(token) {
    if (!token) return null;
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
    if (!header || header.alg !== 'ES256' || !header.kid) return null;

    const key = this.keys.get(header.kid);
    if (!key) {
      this.refresh(false);
      return null;
    }

    let valid = false;
    try {
      valid = crypto.verify(
        'sha256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(parts[2], 'base64url'),
      );
    } catch {
      return null;
    }
    if (!valid) return null;

    if (payload.iss !== ISSUER) return null;
    // 带 client_id 的是站外应用的受限 token，不能访问自家服务
    if (payload.client_id && !this.allowClientTokens) return null;
    if (!payload.exp || Math.floor(Date.now() / 1000) >= Number(payload.exp)) return null;
    if (typeof payload.user_id !== 'number' || typeof payload.email !== 'string') return null;
    return payload;
  }
}

module.exports = { JwtVerifier, ISSUER };
