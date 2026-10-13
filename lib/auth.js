import crypto from 'node:crypto';
import net from 'node:net';

/** Cookie 名：前台访客会话 / 后台管理员会话 */
export const USER_COOKIE = 'ai_sid';
export const ADMIN_COOKIE = 'ai_admin';

// ---------------------------------------------------------------- 密码哈希

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  if (!stored) return false;
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(plain), Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------- 会话

/** 内存会话表：服务重启后所有人需要重新登录，这是预期行为 */
export function createSessionStore({ ttlMs }) {
  const sessions = new Map();

  function sweep() {
    const now = Date.now();
    for (const [token, s] of sessions) {
      if (s.expiresAt <= now) sessions.delete(token);
    }
  }

  return {
    create(data, ttl = ttlMs) {
      sweep();
      const token = randomToken();
      sessions.set(token, { ...data, createdAt: Date.now(), expiresAt: Date.now() + ttl });
      return token;
    },
    get(token) {
      if (!token) return null;
      const s = sessions.get(token);
      if (!s) return null;
      if (s.expiresAt <= Date.now()) {
        sessions.delete(token);
        return null;
      }
      return s;
    },
    destroy(token) {
      sessions.delete(token);
    },
    /** 删除所有满足条件的会话，例如改密码后踢掉全部管理员 */
    destroyWhere(predicate) {
      let n = 0;
      for (const [token, s] of sessions) {
        if (predicate(s)) {
          sessions.delete(token);
          n++;
        }
      }
      return n;
    },
    count(predicate = () => true) {
      sweep();
      let n = 0;
      for (const s of sessions.values()) if (predicate(s)) n++;
      return n;
    },
  };
}

// ---------------------------------------------------------------- Cookie
// 注：本站未启用登录失败限流，秘钥校验与后台登录均不做封锁。

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    // 孤立 % 之类会让 decodeURIComponent 抛 URIError。这里是所有会话入口的
    // 必经之路，抛出去等于该浏览器访问本站每个接口都 500 —— 解码失败就按原文用。
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  }
  return out;
}

export function setCookie(res, name, value, { maxAge } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge != null) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  appendSetCookie(res, parts.join('; '));
}

export function clearCookie(res, name) {
  appendSetCookie(res, `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', [cookie]);
  else res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : [prev]), cookie]);
}

// ---------------------------------------------------------------- IP

function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '';
}

/** Host 头是否指向本机（防 DNS rebinding） */
function isLoopbackHost(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * 取访客真实 IP。
 *
 * 本机直连时 socket 对端就是访客地址；但 cloudflared 与本站同机运行时，
 * 所有隧道流量都从 127.0.0.1 进来，对端恒为回环，真实访客 IP 只在
 * CF-Connecting-IP 头里（Cloudflare 边缘写入，客户端伪造不了）。
 *
 * 三种情况的处理方向都是「拿不准就当远端」：
 *   对端不是回环（局域网 / 直连公网）→ 用它本身，此时伪造该头无效；
 *   对端回环、没带该头、Host 也是本机 → 真·本机直连；
 *   其余（头为空 / 格式不对 / Host 不是本机）→ 一律当远端，绝不退回成本机。
 */
export function clientIp(req) {
  const peer = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!isLoopbackIp(peer)) return peer;

  const raw = req.headers['cf-connecting-ip'];
  if (raw === undefined || raw === null) {
    // 没经过隧道：只有 Host 也指向本机才算本机直连（否则可能是 DNS rebinding）
    return isLoopbackHost(req) ? peer : '0.0.0.0';
  }

  const cf = String(raw).trim().replace(/^::ffff:/, '');
  // Cloudflare 边缘只会写一个真实公网 IP，不会是空值/回环/一坨垃圾
  if (!net.isIP(cf) || cf === '127.0.0.1' || cf === '::1') return '0.0.0.0';
  return cf;
}

export function isLocalRequest(req) {
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1' || ip === '';
}
