import express from 'express';
import { testConnection } from '../lib/ai.js';
import {
  ADMIN_COOKIE,
  clearCookie,
  clientIp,
  hashPassword,
  isLocalRequest,
  parseCookies,
  setCookie,
  verifyPassword,
} from '../lib/auth.js';
import {
  KEY_LENGTH,
  generateCode,
  keyStatus,
  resolveExpiry,
  validateCustomCode,
} from '../lib/keys.js';
import { newId } from '../lib/store.js';
import { cleanGreeting, learnGreetings } from '../lib/greetings.js';
import { nextRunAt } from '../lib/learner.js';

const MAX_BATCH = 200;

/**
 * 不能拿来当后台网址的名字：它们会和本站现有路径撞车。
 * 其中 'api' 最危险 —— server.js 那段重写是拿这个名字拼前缀的，撞上会把 /api 整个吃掉。
 */
const RESERVED_ADMIN_PATHS = new Set(['api', 'assets', 'index', 'index.html', 'favicon.ico']);

/**
 * 解析可选的日期输入，统一成 ISO 串；空值 = 不设（返回 null）。
 * 关键在于「填了但解析不出来」要显式报错：直接 new Date(x).toISOString() 在
 * x 非法时会抛 RangeError，被 Express 兜成 500；而静默返回 null 又会让用户
 * 以为设了有效期、实际拿到一个永久秘钥。两条路都不行，所以这里返回判定结果。
 */
function parseOptionalDate(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: null };
  }
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return { ok: false, error: `${label}格式不正确。` };
  return { ok: true, value: new Date(t).toISOString() };
}

/**
 * 解析「可用次数」：空 = 不限次。
 * 必须挡住 NaN —— Math.max(1, Number('abc')) 是 NaN，而 usedCount >= NaN
 * 恒为 false，于是用户以为设了限次、实际拿到的是不限次。
 */
function parseOptionalMaxUses(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: true, value: null };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    return { ok: false, error: '可用次数必须是 1 以上的整数。' };
  }
  return { ok: true, value: Math.floor(n) };
}

export function requireAdmin(ctx) {
  return (req, res, next) => {
    const s = ctx.settings();

    if (!s.adminRequirePassword) {
      if (s.adminLocalOnly && !isLocalRequest(req)) {
        return res.status(403).json({ error: '后台已关闭密码验证，且设置为仅本机可访问。' });
      }
      req.admin = { mode: 'open' };
      return next();
    }

    const token = parseCookies(req)[ADMIN_COOKIE];
    const session = ctx.sessions.get(token);
    if (!session || session.type !== 'admin') {
      return res.status(401).json({ error: '后台登录已过期，请重新登录。' });
    }
    req.admin = { mode: 'password', token };
    next();
  };
}

export function adminRoutes(ctx) {
  const router = express.Router();
  const guard = requireAdmin(ctx);

  // ---------------------------------------------------------- 身份

  router.get('/me', (req, res) => {
    const s = ctx.settings();
    if (!s.adminRequirePassword) {
      if (s.adminLocalOnly && !isLocalRequest(req)) {
        return res.json({ authed: false, requirePassword: false, localOnlyBlocked: true });
      }
      return res.json({ authed: true, requirePassword: false, localOnlyBlocked: false, mode: 'open' });
    }
    const session = ctx.sessions.get(parseCookies(req)[ADMIN_COOKIE]);
    const authed = Boolean(session && session.type === 'admin');
    res.json({ authed, requirePassword: true, localOnlyBlocked: false });
  });

  router.post('/login', (req, res) => {
    const s = ctx.settings();
    if (!s.adminRequirePassword) return res.json({ ok: true });

    const ip = clientIp(req);
    const password = String(req.body?.password ?? '');
    if (!verifyPassword(password, s.adminPasswordHash)) {
      return res.status(401).json({ ok: false, error: '管理员密码不正确。' });
    }

    const token = ctx.sessions.create({ type: 'admin', ip }, ctx.adminTtlMs);
    setCookie(res, ADMIN_COOKIE, token, { maxAge: ctx.adminTtlMs });
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    ctx.sessions.destroy(parseCookies(req)[ADMIN_COOKIE]);
    clearCookie(res, ADMIN_COOKIE);
    res.json({ ok: true });
  });

  router.post('/password', guard, (req, res) => {
    const s = ctx.settings();
    const current = String(req.body?.current ?? '');
    const next = String(req.body?.next ?? '');

    if (next.length < 6) {
      return res.status(400).json({ error: '新密码至少 6 位。' });
    }
    // 走 password 模式才需要验证旧密码
    if (req.admin.mode === 'password' && !verifyPassword(current, s.adminPasswordHash)) {
      return res.status(401).json({ error: '当前密码不正确。' });
    }

    ctx.store.updateSettings({ adminPasswordHash: hashPassword(next), adminRequirePassword: true });
    // 改完密码后所有后台会话强制下线，要求用新密码重新登录
    ctx.sessions.destroyWhere((sess) => sess.type === 'admin');
    clearCookie(res, ADMIN_COOKIE);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------- 配置

  router.get('/settings', guard, (req, res) => {
    res.json({ settings: publicSettings(ctx.settings()) });
  });

  router.put('/settings', guard, (req, res) => {
    const body = req.body || {};
    const patch = {};

    const strFields = ['aiName', 'welcome', 'baseUrl', 'model', 'systemPrompt'];
    for (const f of strFields) {
      if (typeof body[f] === 'string') patch[f] = body[f].trim();
    }
    // apiKey 单独走：前端拿不到原文（publicSettings 会剥掉），所以它只在
    // 「用户确实填了新值」时才覆盖。留空 = 不动，否则前端每次保存都会把密钥抹掉；
    // 真要清空得显式带 apiKeyClear。
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      patch.apiKey = body.apiKey.trim();
    } else if (body.apiKeyClear === true) {
      patch.apiKey = '';
    }
    if (typeof body.greetingMode === 'string') {
      if (!['ai', 'library', 'fixed'].includes(body.greetingMode)) {
        return res.status(400).json({ error: '开场白方式只能是 ai、library 或 fixed' });
      }
      patch.greetingMode = body.greetingMode;
    }
    // 图标只让改「用哪种」和「默认图标上的字」；图片本身走 /api/admin/icon，
    // iconVersion 也只能由服务端自增，不接受客户端传值。
    if (typeof body.iconMode === 'string') {
      if (!['default', 'custom'].includes(body.iconMode)) {
        return res.status(400).json({ error: '图标方式只能是 default 或 custom' });
      }
      patch.iconMode = body.iconMode;
    }
    if (typeof body.iconText === 'string') {
      patch.iconText = Array.from(body.iconText.trim()).slice(0, 4).join('');
    }
    // 后台网址：只收一段 URL 安全的短名。server.js 是拿它拼前缀做路径重写的，
    // 带斜杠/点号/百分号编码（中文也会被编码）的名字会让匹配变得又脆又难讲清楚，
    // 而且这类名字本来也没有「让人猜不到」的效果。
    if (typeof body.adminPath === 'string') {
      const raw = body.adminPath.trim().replace(/^\/+|\/+$/g, '');
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(raw)) {
        return res.status(400).json({
          error: '后台网址只能由字母、数字、- 和 _ 组成，以字母或数字开头，最长 40 位。',
        });
      }
      if (RESERVED_ADMIN_PATHS.has(raw.toLowerCase())) {
        return res.status(400).json({ error: `「${raw}」会和本站现有路径冲突，请换一个。` });
      }
      patch.adminPath = raw;
    }
    const boolFields = [
      'requireKey', 'frontLocalOnly', 'adminRequirePassword', 'adminLocalOnly',
      'greetingAutoLearn',
    ];
    for (const f of boolFields) {
      if (typeof body[f] === 'boolean') patch[f] = body[f];
    }
    const numFields = [
      ['temperature', 0, 2], ['maxTokens', 1, 100_000], ['historyLimit', 2, 200],
      ['greetingAutoLearnHour', 0, 23], ['greetingLearnBatch', 1, 20], ['greetingPoolLimit', 5, 500],
    ];
    for (const [f, min, max] of numFields) {
      if (body[f] !== undefined) {
        const n = Number(body[f]);
        if (!Number.isFinite(n)) return res.status(400).json({ error: `${f} 必须是数字` });
        patch[f] = Math.min(max, Math.max(min, n));
      }
    }

    if (patch.aiName !== undefined && !patch.aiName) {
      return res.status(400).json({ error: 'AI 名称不能为空。' });
    }
    if (patch.baseUrl !== undefined && patch.baseUrl && !/^https?:\/\//i.test(patch.baseUrl)) {
      return res.status(400).json({ error: '接口地址需以 http:// 或 https:// 开头。' });
    }

    ctx.store.updateSettings(patch);
    res.json({ ok: true, settings: publicSettings(ctx.settings()) });
  });

  router.post('/ai/test', guard, async (req, res) => {
    try {
      const result = await testConnection(ctx.settings());
      res.json(result);
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  // ---------------------------------------------------------- 欢迎语库（AI 学习，可多库）

  /** 这次操作针对哪个库：显式传 libraryId 就用它，否则用当前选中的库 */
  function targetLibrary(req) {
    const id = req.body?.libraryId || req.query?.libraryId;
    return id ? ctx.store.getLibrary(id) : ctx.store.activeLibrary;
  }

  router.get('/greetings', guard, (req, res) => {
    res.json(poolState(ctx));
  });

  // ---- 库本身：新建 / 重命名 / 删除 / 切换 ----

  router.post('/greetings/libraries', guard, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '库名称不能为空。' });
    if (name.length > 24) return res.status(400).json({ error: '库名称最多 24 个字。' });
    if (ctx.store.greetingLibraries.length >= 12) {
      return res.status(400).json({ error: '最多 12 个库。' });
    }
    const lib = ctx.store.addLibrary(name, String(req.body?.note || '').trim());
    res.json({ ok: true, library: lib, ...poolState(ctx) });
  });

  router.patch('/greetings/libraries/:id', guard, (req, res) => {
    const lib = ctx.store.updateLibrary(req.params.id, {
      name: req.body?.name,
      note: req.body?.note,
    });
    if (!lib) return res.status(404).json({ error: '这个库不存在。' });
    res.json({ ok: true, library: lib, ...poolState(ctx) });
  });

  router.delete('/greetings/libraries/:id', guard, (req, res) => {
    const r = ctx.store.deleteLibrary(req.params.id);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true, ...poolState(ctx) });
  });

  /**
   * 切换当前使用的库。
   * 选了库就是要用它，所以顺手把「开场白方式」切成「AI 学习库」——
   * 否则在「AI 实时生成 / 固定欢迎语」模式下，前台根本不读库，切换看起来毫无反应。
   */
  router.post('/greetings/libraries/:id/activate', guard, (req, res) => {
    if (!ctx.store.setActiveLibrary(req.params.id)) {
      return res.status(404).json({ error: '这个库不存在。' });
    }
    const modeSwitched = ctx.settings().greetingMode !== 'library';
    if (modeSwitched) ctx.store.updateSettings({ greetingMode: 'library' });
    res.json({ ok: true, modeSwitched, ...poolState(ctx) });
  });

  /** 设置当前库的「兜底快捷提问」（AI 实时生成失败或没配接口时显示的那组） */
  router.put('/greetings/chips', guard, (req, res) => {
    const lib = targetLibrary(req);
    if (!lib) return res.status(404).json({ error: '这个库不存在。' });
    const chips = Array.isArray(req.body?.chips) ? req.body.chips : [];
    ctx.store.setLibraryChips(lib.id, chips.map((c) => String(c).trim()).filter(Boolean));
    res.json({ ok: true, ...poolState(ctx, lib.id) });
  });

  // ---- 库里的欢迎语：增 / 改 / 删 / 清空 / 学习 ----

  router.post('/greetings', guard, (req, res) => {
    const lib = targetLibrary(req);
    if (!lib) return res.status(404).json({ error: '这个库不存在。' });
    const text = cleanGreeting(req.body?.text);
    if (!text) return res.status(400).json({ error: '欢迎语不能为空。' });
    if (lib.greetings.length >= 500) {
      return res.status(400).json({ error: '这个库已达上限（500 条），请先清理。' });
    }
    const entry = ctx.store.addLibraryGreeting(lib.id, text, 'manual');
    res.json({ ok: true, entry, ...poolState(ctx, lib.id) });
  });

  router.patch('/greetings/:id', guard, (req, res) => {
    const lib = targetLibrary(req);
    if (!lib) return res.status(404).json({ error: '这个库不存在。' });
    const text = cleanGreeting(req.body?.text);
    if (!text) return res.status(400).json({ error: '欢迎语不能为空。' });
    const entry = ctx.store.updateLibraryGreeting(lib.id, req.params.id, text);
    if (!entry) return res.status(404).json({ error: '这条欢迎语不存在。' });
    res.json({ ok: true, entry, ...poolState(ctx, lib.id) });
  });

  router.delete('/greetings/:id', guard, (req, res) => {
    const lib = targetLibrary(req);
    if (!lib) return res.status(404).json({ error: '这个库不存在。' });
    if (!ctx.store.deleteLibraryGreeting(lib.id, req.params.id)) {
      return res.status(404).json({ error: '这条欢迎语不存在。' });
    }
    res.json({ ok: true, ...poolState(ctx, lib.id) });
  });

  router.post('/greetings/clear', guard, (req, res) => {
    const lib = targetLibrary(req);
    if (!lib) return res.status(404).json({ error: '这个库不存在。' });
    const removed = lib.greetings.length;
    ctx.store.clearLibraryGreetings(lib.id);
    res.json({ ok: true, removed, ...poolState(ctx, lib.id) });
  });

  /** 立即学习一次，不等定时任务 */
  router.post('/greetings/learn', guard, async (req, res) => {
    // Express 4 不会接住 async 处理器抛出的异常，Node 22 下逃逸的 rejection
    // 会直接结束进程 —— 所以这里显式兜住（比如落盘 EACCES 时）。
    try {
      const s = ctx.settings();
      const lib = targetLibrary(req);
      if (!lib) return res.status(404).json({ error: '这个库不存在。' });
      const count = Number(req.body?.count) || s.greetingLearnBatch;
      const result = await learnGreetings(ctx, s, { libraryId: lib.id, count, reason: 'manual' });
      res.status(result.ok ? 200 : 400).json({ ...result, ...poolState(ctx, lib.id) });
    } catch (err) {
      console.error('[admin] 学习欢迎语失败', err);
      res.status(500).json({ error: `学习失败：${err.message}` });
    }
  });

  // ---------------------------------------------------------- 秘钥

  router.get('/keys', guard, (req, res) => {
    const now = Date.now();
    res.json({
      keys: ctx.store.listKeys().map((k) => ({ ...k, status: keyStatus(k, now) })),
      keyLength: KEY_LENGTH,
    });
  });

  router.post('/keys', guard, (req, res) => {
    const body = req.body || {};
    const mode = body.mode === 'custom' ? 'custom' : 'generate';
    const count = mode === 'custom' ? 1 : Math.min(MAX_BATCH, Math.max(1, Number(body.count) || 1));
    const charset = body.charset === 'digit' ? 'digit' : 'alnum';
    const note = String(body.note ?? '').slice(0, 100);

    const expiry = resolveExpiry(body);
    if (!expiry.ok) return res.status(400).json({ error: expiry.error });
    const start = parseOptionalDate(body.startAt, '生效时间');
    if (!start.ok) return res.status(400).json({ error: start.error });
    const uses = parseOptionalMaxUses(body.maxUses);
    if (!uses.ok) return res.status(400).json({ error: uses.error });

    const expiresAt = expiry.value;
    const startAt = start.value;
    const maxUses = uses.value;

    const existing = new Set(ctx.store.listKeys().map((k) => k.code));
    const created = [];

    if (mode === 'custom') {
      const result = validateCustomCode(body.code);
      if (!result.ok) return res.status(400).json({ error: result.error });
      if (existing.has(result.code)) return res.status(409).json({ error: '该秘钥已存在，请换一个。' });
      created.push(result.code);
    } else {
      const target = existing.size + count;
      let guardCount = 0;
      while (created.length < count && guardCount < count * 50) {
        guardCount++;
        const code = generateCode(charset);
        if (existing.has(code) || created.includes(code)) continue;
        created.push(code);
      }
      if (created.length < count) {
        return res.status(507).json({ error: `可用秘钥空间不足，仅生成了 ${created.length} 个。` });
      }
    }

    const now = new Date().toISOString();
    const records = created.map((code) =>
      ctx.store.addKey({
        id: newId(),
        code,
        note,
        enabled: true,
        createdAt: now,
        startAt,
        expiresAt,
        maxUses,
        usedCount: 0,
        lastUsedAt: null,
        lastIp: null,
      }),
    );

    res.json({ ok: true, created: records.map((r) => r.code), keys: records });
  });

  router.patch('/keys/:id', guard, (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.note === 'string') patch.note = body.note.slice(0, 100);
    if (body.expiresAt !== undefined) {
      const d = parseOptionalDate(body.expiresAt, '到期时间');
      if (!d.ok) return res.status(400).json({ error: d.error });
      patch.expiresAt = d.value;
    }
    if (body.maxUses !== undefined) {
      const u = parseOptionalMaxUses(body.maxUses);
      if (!u.ok) return res.status(400).json({ error: u.error });
      patch.maxUses = u.value;
    }
    const key = ctx.store.updateKey(req.params.id, patch);
    if (!key) return res.status(404).json({ error: '秘钥不存在。' });
    res.json({ ok: true, key: { ...key, status: keyStatus(key) } });
  });

  router.delete('/keys/:id', guard, (req, res) => {
    if (!ctx.store.deleteKey(req.params.id)) {
      return res.status(404).json({ error: '秘钥不存在。' });
    }
    res.json({ ok: true });
  });

  router.post('/keys/bulk-delete', guard, (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((i) => typeof i === 'string') : [];
    if (!ids.length) return res.status(400).json({ error: '请选择要删除的秘钥。' });
    res.json({ ok: true, deleted: ctx.store.deleteKeys(ids) });
  });

  router.get('/stats', guard, (req, res) => {
    const keys = ctx.store.listKeys();
    const now = Date.now();
    const by = { active: 0, expired: 0, disabled: 0, exhausted: 0, pending: 0 };
    for (const k of keys) by[keyStatus(k, now)]++;

    res.json({
      totalKeys: keys.length,
      byStatus: by,
      totalUses: keys.reduce((sum, k) => sum + (k.usedCount || 0), 0),
      onlineUsers: ctx.sessions.count((s) => s.type === 'user'),
      uptimeSec: Math.floor(process.uptime()),
      node: process.version,
    });
  });

  return router;
}

/**
 * 欢迎语库的完整状态，给后台用。
 * libraries 只带概要（渲染切换器用），library 是当前操作的那个库的明细。
 */
function poolState(ctx, activeId) {
  const s = ctx.settings();
  const lib = (activeId && ctx.store.getLibrary(activeId)) || ctx.store.activeLibrary;
  return {
    libraries: ctx.store.greetingLibraries.map((l) => ({
      id: l.id,
      name: l.name,
      note: l.note,
      count: l.greetings.length,
      chipCount: l.chips.length,
      learn: l.learn,
    })),
    activeId: lib?.id || null,
    library: lib
      ? { id: lib.id, name: lib.name, note: lib.note, chips: lib.chips, greetings: lib.greetings, learn: lib.learn }
      : null,
    greetingMode: s.greetingMode,
    logs: ctx.store.learnLogs,
    nextRunAt: nextRunAt(s),
    limit: s.greetingPoolLimit,
  };
}

/**
 * 下发给前端的设置。
 * 必须剔除两样东西：管理员密码哈希，以及 **明文 apiKey**——
 * 密钥只存在服务器上，一旦进了响应体就等于交给了浏览器（F12 可见、能被脚本读走）。
 * 前端只需要知道「配没配」，所以给一个布尔值。
 */
function publicSettings(s) {
  const { adminPasswordHash, apiKey, ...rest } = s;
  return {
    ...rest,
    adminPasswordSet: Boolean(adminPasswordHash),
    apiKeySet: Boolean(apiKey),
  };
}
