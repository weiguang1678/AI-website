import express from 'express';
import {
  ADMIN_COOKIE,
  USER_COOKIE,
  clientIp,
  clearCookie,
  isLocalRequest,
  parseCookies,
} from '../lib/auth.js';
import { isSessionValid, KEY_LENGTH, normalizeCode, keyStatus } from '../lib/keys.js';

/**
 * 请求方是否算「管理员」——用于后台的多端预览：
 * 已登录后台（或后台本就免密且来自本机）时，允许直接进入前台查看真实界面。
 */
function isAdminRequest(req, ctx) {
  const s = ctx.settings();
  if (s.adminRequirePassword) {
    const session = ctx.sessions.get(parseCookies(req)[ADMIN_COOKIE]);
    return Boolean(session && session.type === 'admin');
  }
  return isLocalRequest(req);
}

/**
 * 取这次请求的访客令牌。
 *
 * 令牌只出现在响应体里，由前台收在内存中、之后随 X-Access-Token 头带回来 ——
 * 不再走 Cookie。用 Cookie 的话浏览器会替我们把凭证留到 Max-Age 到期，
 * 刷新页面、关掉浏览器再打开都还在，秘钥就等于被记住了；而这里要的是
 * 「刷新或关闭后都要重新输秘钥」，那就必须让凭证活不过一次页面加载：
 * 前台那个变量一刷新就是空的，服务端也就拿不到头，只能从头验一次。
 *
 * 只认请求头还有个附带好处：跨站请求伪造带不上自定义头，
 * 比单靠 Cookie 的 SameSite 更硬。
 */
function userToken(req) {
  const t = req.get('x-access-token');
  return typeof t === 'string' ? t.trim() : '';
}

/**
 * 老版本给访客下发过一个 12 小时的 ai_sid 持久 Cookie，现在不用了。
 * 碰到就顺手清掉，免得浏览器里那份旧凭证一直躺着 —— 不清的话，
 * 升级前就访问过本站的人刷新后还是能直接进去，看不到这次改动。
 */
function dropLegacyCookie(req, res) {
  if (parseCookies(req)[USER_COOKIE]) clearCookie(res, USER_COOKIE);
}

export function accessRoutes(ctx) {
  const router = express.Router();

  /**
   * 品牌信息：名字 / 欢迎语 / 图标。图标只要「模式 + 版本 + 文字」三样，
   * 图片本身走 /api/icon，不进 JSON。
   */
  function branding(s) {
    return {
      aiName: s.aiName,
      welcome: s.welcome,
      iconMode: s.iconMode,
      iconText: s.iconText,
      iconVersion: s.iconVersion,
    };
  }

  /** 前端启动时调用：告诉我当前站点状态 */
  router.get('/session', (req, res) => {
    const s = ctx.settings();
    dropLegacyCookie(req, res);
    const localOnlyBlocked = !s.requireKey && s.frontLocalOnly && !isLocalRequest(req);

    if (localOnlyBlocked) {
      return res.json({
        requireKey: s.requireKey,
        authed: false,
        localOnlyBlocked: true,
        ...branding(s),
      });
    }

    if (!s.requireKey) {
      return res.json({
        requireKey: false,
        authed: true,
        localOnlyBlocked: false,
        ...branding(s),
        chips: ctx.store.activeChips,
      });
    }

    const token = userToken(req);
    const session = ctx.sessions.get(token);
    const key = session?.type === 'user' && session.keyId ? ctx.store.getKey(session.keyId) : null;
    const stillValid = session?.type === 'user' && key && isSessionValid(key);

    if (session && !stillValid) ctx.sessions.destroy(token);

    if (!stillValid && isAdminRequest(req, ctx)) {
      // 管理员在后台点「预览前台」，不必输入秘钥
      return res.json({
        requireKey: true,
        authed: true,
        preview: true,
        localOnlyBlocked: false,
        ...branding(s),
        chips: ctx.store.activeChips,
        keyLength: KEY_LENGTH,
      });
    }

    res.json({
      requireKey: true,
      authed: Boolean(stillValid),
      localOnlyBlocked: false,
      ...branding(s),
      // 没登录就不下发库里的提问，免得把主题漏出去
      ...(stillValid ? { chips: ctx.store.activeChips } : {}),
      keyLength: KEY_LENGTH,
      expiresAt: stillValid ? (key?.expiresAt ?? null) : null,
    });
  });

  /** 提交秘钥 */
  router.post('/access', (req, res) => {
    const s = ctx.settings();
    const ip = clientIp(req);

    if (!s.requireKey) {
      // 与 /session 保持同一口径：关了秘钥验证 + 仅本机时，远端连库里的提问都
      // 不该拿到。少了这一条，远端直接 POST 这个接口就能绕过 /session 的拦截。
      if (s.frontLocalOnly && !isLocalRequest(req)) {
        return res.status(403).json({
          ok: false,
          localOnlyBlocked: true,
          error: '本站仅允许在本机访问。',
          ...branding(s),
        });
      }
      return res.json({ ok: true, ...branding(s), chips: ctx.store.activeChips });
    }

    const code = normalizeCode(req.body?.code);
    if (code.length !== KEY_LENGTH) {
      return res.status(400).json({ ok: false, error: `秘钥为 ${KEY_LENGTH} 位，请检查后重新输入。` });
    }

    const key = ctx.store.findKeyByCode(code);
    if (!key) {
      return res.status(401).json({ ok: false, error: '秘钥不正确，请重新输入。' });
    }

    const status = keyStatus(key);
    if (status !== 'active') {
      const message = {
        disabled: '该秘钥已被停用，请联系管理员。',
        pending: '该秘钥尚未生效，请联系管理员。',
        expired: '该秘钥已过期，请联系管理员续期。',
        exhausted: key.maxUses === 1
          ? '这是一次性秘钥，已经被使用过了。'
          : '该秘钥使用次数已用尽，请联系管理员。',
      }[status];
      return res.status(403).json({ ok: false, error: message });
    }

    key.usedCount = (key.usedCount || 0) + 1;
    key.lastUsedAt = new Date().toISOString();
    key.lastIp = ip;
    ctx.store.save();

    const token = ctx.sessions.create({ type: 'user', keyId: key.id, ip }, ctx.userTtlMs);
    // 令牌放在响应体里交给前台，**不下发 Cookie**：Cookie 会被浏览器留到 Max-Age 到期，
    // 刷新和重开都在，秘钥就被记住了。前台只把它存在内存里，页面一刷新就没了。
    dropLegacyCookie(req, res);

    res.json({
      ok: true,
      token,
      ...branding(s),
      chips: ctx.store.activeChips,
      expiresAt: key.expiresAt ?? null,
    });
  });

  router.post('/logout', (req, res) => {
    // 令牌现在从请求头来；Cookie 那行只是替老浏览器清掉遗留的 ai_sid
    ctx.sessions.destroy(userToken(req));
    clearCookie(res, USER_COOKIE);
    res.json({ ok: true });
  });

  return router;
}

/** 对话接口的准入检查：秘钥验证通过、或站点开放访问（含仅本机限制） */
export function requireAccess(ctx) {
  return (req, res, next) => {
    const s = ctx.settings();

    if (!s.requireKey) {
      if (s.frontLocalOnly && !isLocalRequest(req)) {
        return res.status(403).json({ error: '本站已关闭秘钥验证，且设置为仅本机可访问。' });
      }
      req.access = { mode: 'open' };
      return next();
    }

    const token = userToken(req);
    const session = ctx.sessions.get(token);
    const key = session?.type === 'user' ? ctx.store.getKey(session.keyId) : null;

    if (key && isSessionValid(key)) {
      req.access = { mode: 'key', keyId: key.id };
      return next();
    }

    if (session) {
      ctx.sessions.destroy(token);
      clearCookie(res, USER_COOKIE);
    }

    // 管理员在后台预览时不拦
    if (isAdminRequest(req, ctx)) {
      req.access = { mode: 'preview' };
      return next();
    }

    res.status(401).json({ error: '登录状态已失效，请重新输入秘钥。', needAuth: true });
  };
}
