import crypto from 'node:crypto';

/** 秘钥固定 5 位 */
export const KEY_LENGTH = 5;

/** 去掉容易看错的 I / O / 0 / 1 */
const CHARSET_ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 个字符 → 32^5 ≈ 3355 万种组合
const CHARSET_DIGIT = '0123456789'; // 10^5 = 10 万种组合

const CHARSETS = { alnum: CHARSET_ALNUM, digit: CHARSET_DIGIT };

export function generateCode(charsetName = 'alnum') {
  const charset = CHARSETS[charsetName] || CHARSET_ALNUM;
  let out = '';
  for (let i = 0; i < KEY_LENGTH; i++) {
    out += charset[crypto.randomInt(0, charset.length)];
  }
  return out;
}

/** 去掉空格/横杠并转大写，方便用户输入 */
export function normalizeCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function isValidFormat(code) {
  return new RegExp(`^[A-Z0-9]{${KEY_LENGTH}}$`).test(code);
}

/** 校验用户自定义的秘钥是否符合格式 */
export function validateCustomCode(input) {
  const code = normalizeCode(input);
  if (!code) return { ok: false, error: '秘钥不能为空' };
  if (code.length !== KEY_LENGTH) {
    return { ok: false, error: `秘钥必须为 ${KEY_LENGTH} 位（当前 ${code.length} 位）` };
  }
  if (!isValidFormat(code)) return { ok: false, error: '秘钥只能包含大写字母和数字' };
  if (/[IO01]/.test(code)) {
    return { ok: false, error: '为避免混淆，请不要使用字母 I、O 和数字 0、1' };
  }
  return { ok: true, code };
}

/**
 * 计算一条秘钥的当前状态
 * @returns {'disabled'|'pending'|'expired'|'exhausted'|'active'}
 */
export function keyStatus(key, now = Date.now()) {
  if (!key.enabled) return 'disabled';
  if (key.startAt && new Date(key.startAt).getTime() > now) return 'pending';
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now) return 'expired';
  if (key.maxUses != null && key.usedCount >= key.maxUses) return 'exhausted';
  return 'active';
}

export const STATUS_TEXT = {
  active: '有效',
  pending: '未生效',
  expired: '已过期',
  exhausted: '次数用尽',
  disabled: '已停用',
};

export function isUsable(key, now = Date.now()) {
  return keyStatus(key, now) === 'active';
}

/**
 * 已登录会话的续期校验：只看「停用 / 未生效 / 过期」。
 * 不校验次数 —— 次数在登录那一刻已经扣减，否则 maxUses=1 的秘钥登录后立刻就无法对话了。
 */
export function isSessionValid(key, now = Date.now()) {
  if (!key?.enabled) return false;
  if (key.startAt && new Date(key.startAt).getTime() > now) return false;
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now) return false;
  return true;
}

/**
 * 把「有效期」选项换算成绝对到期时间。
 *
 * 返回 { ok, value, error } 而不是裸值：以前非法 expiresAt 会 `Number.isNaN(t) ? null`
 * 静默当成「永久有效」，用户以为设了 7 天、实际拿到一个永久秘钥；而且因为
 * expiresAt 是真值，本该兜底的 durationValue/durationUnit 会被完全忽略。
 * 现在这种情况明确报错，让路由返回 400。
 */
export function resolveExpiry({ expiresAt, durationValue, durationUnit }) {
  if (expiresAt !== undefined && expiresAt !== null && String(expiresAt).trim() !== '') {
    const t = new Date(expiresAt).getTime();
    if (!Number.isFinite(t)) return { ok: false, error: '到期时间格式不正确。' };
    return { ok: true, value: new Date(t).toISOString() };
  }

  if (durationValue === undefined || durationValue === null || String(durationValue).trim() === '') {
    return { ok: true, value: null }; // 永久有效
  }
  const value = Number(durationValue);
  if (!Number.isFinite(value)) return { ok: false, error: '有效期数值不正确。' };
  if (value <= 0) return { ok: true, value: null }; // 永久有效

  const unitMs = { minute: 60_000, hour: 3_600_000, day: 86_400_000 }[durationUnit] || 86_400_000;
  const t = Date.now() + value * unitMs;
  // 8.64e15 是 Date 能表示的上限，超过它 toISOString() 会抛 RangeError
  if (!Number.isFinite(t) || t > 8.64e15) return { ok: false, error: '有效期太长了。' };
  return { ok: true, value: new Date(t).toISOString() };
}
