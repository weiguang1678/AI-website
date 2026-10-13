import { readUpstreamError, requestChat } from './ai.js';

/** 接口不可用时的兜底问候语（尽量与最近用过的错开） */
export const FALLBACK_GREETINGS = [
  '你好呀，我在这儿，想聊点什么？',
  '嗨，今天过得怎么样？',
  '来了，有什么想让我帮忙的吗？',
  '你好！我随时准备好了。',
  '很高兴见到你，说说看吧。',
  '嘿，有什么想问的尽管说。',
  '你好，今天想做点什么？',
  '我在这儿呢，需要我帮什么忙？',
  '你好呀，新的一天有什么计划吗？',
  '欢迎回来，接着聊还是开个新话题？',
  '嗨，有什么我可以搭把手的地方？',
  '你好，我在听，慢慢说。',
  '来了来了，有什么想法想聊聊？',
  '你好！随时待命，你说。',
  '嘿，今天有什么新鲜事吗？',
  '你好，需要我陪你理一理思路吗？',
  '我在的，有什么难题交给我？',
  '你好呀，想从哪儿开始？',
  '嗨，有问题随时抛过来。',
  '你好，今天想解决点什么？',
];

/** 相似度阈值：达到即认为「重样」 */
const SIMILARITY_LIMIT = 0.72;
/** 生成失败时最多重试几次 */
const MAX_ATTEMPTS = 3;

/** 去掉空白、标点和符号，只留下实义字符，便于比较是否重复 */
export function normalizeGreeting(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigrams(str) {
  const set = new Set();
  for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
  return set;
}

/** Dice 系数，衡量两段文本的相似程度（0~1） */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  return (2 * inter) / (sa.size + sb.size);
}

/** 是否与最近用过的某句问候太像 */
export function isTooSimilar(text, recent) {
  const target = normalizeGreeting(text);
  if (!target) return true;
  for (const past of recent) {
    if (similarity(target, normalizeGreeting(past)) >= SIMILARITY_LIMIT) return true;
  }
  return false;
}

/** 清理模型输出：去掉引号包裹、前缀标签、多余换行 */
export function cleanGreeting(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^\s*(?:问候语|开场白|回复|答案|回答)\s*[:：]\s*/, '');
  s = s.replace(/^["'「『【《]+/, '').replace(/["'」』】》]+$/, '');
  s = s.replace(/\s*\n+\s*/g, ' ').trim();
  if (s.length > 80) s = s.slice(0, 80).trim() + '…';
  return s;
}

function formatNow(date = new Date()) {
  const h = date.getHours();
  const period = h < 6 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午'
    : h < 14 ? '中午' : h < 18 ? '下午' : '晚上';
  const week = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 星期${week} `
    + `${period}${h}点${String(date.getMinutes()).padStart(2, '0')}分`;
}

function buildPrompt({ aiName, recent }) {
  const avoid = recent.length
    ? '\n\n下面这些是最近已经用过的问候语，**不要**与其中任何一句相同或意思相近：\n'
      + recent.map((g, i) => `${i + 1}. ${g}`).join('\n')
    : '';

  return [
    `现在是 ${formatNow()}，用户刚刚打开了对话页面。请你主动跟他打招呼。`,
    '',
    '要求：',
    '- 只输出打招呼的那一句话，不要解释、不要标题、不要用引号包起来',
    '- 语气自然、口语化、友好，不要客套过头',
    '- 长度控制在 25 个字以内',
    `- 你是「${aiName}」，可以用这个身份自称`,
    '- 每次换一个不同的角度和措辞，避免和以往重复',
  ].join('\n') + avoid;
}

/** 从兜底池里挑一句最近的没用过的 */
export function pickFallback(recent, welcome) {
  const pool = [welcome, ...FALLBACK_GREETINGS].filter(Boolean);
  const fresh = pool.filter((g) => !isTooSimilar(g, recent));
  const list = fresh.length ? fresh : pool;
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * 生成一句不重复的开场白。
 * @returns {Promise<{greeting: string, source: 'ai'|'fallback', error?: string}>}
 */
export async function generateGreeting(ctx, settings) {
  const recent = ctx.store.recentGreetings;

  const fallback = (error) => {
    const text = pickFallback(recent, settings.welcome);
    ctx.store.rememberGreeting(text);
    return { greeting: text, source: 'fallback', error };
  };

  // 接口没配好就别让前端白等
  if (!settings.apiKey || !settings.model || !settings.baseUrl) {
    return fallback('尚未配置 AI 接口');
  }

  let lastError = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await requestChat({
        settings,
        messages: [
          { role: 'system', content: settings.systemPrompt || `你是${settings.aiName}。` },
          {
            role: 'user',
            content: buildPrompt({ aiName: settings.aiName, recent: recent.slice(-15) })
              + (attempt > 0
                ? `\n\n注意：刚才那句已经用过或太接近了，请换一个完全不同的开场角度。`
                : ''),
          },
        ],
        stream: false,
        timeoutMs: 20_000,
      });
    } catch (err) {
      lastError = err.message;
      break;
    }

    try {
      if (!res.ok) {
        lastError = await readUpstreamError(res);
        break;
      }
      const json = await res.json();
      const text = cleanGreeting(json.choices?.[0]?.message?.content);
      if (text && !isTooSimilar(text, recent)) {
        ctx.store.rememberGreeting(text);
        return { greeting: text, source: 'ai' };
      }
      lastError = text ? '生成的问候语与以往重复' : '模型返回了空内容';
    } catch (err) {
      lastError = err.message;
      break;
    } finally {
      res._cleanup?.();
    }
  }

  return fallback(lastError);
}

// ================================================================ 欢迎语库（AI 学习）

/** 库容量硬上限，防止误配置把数据撑爆 */
const POOL_HARD_LIMIT = 500;

function isUsableGreeting(text) {
  if (!text) return false;
  const n = normalizeGreeting(text).length;
  return n >= 3 && text.length <= 60;
}

/** 把模型输出拆成一句一条：去掉行首编号 / 项目符号，再逐条清理 */
export function parseGreetingList(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+\s*[.、)．]|[-*•·>])\s*/, '').trim())
    .map(cleanGreeting)
    .filter(Boolean);
}

function buildLearnPrompt({ aiName, library, existing, count }) {
  const avoid = existing.length
    ? '\n\n下面这些是已经有的（含前台用过的），**不要**重复，也不要只改几个字：\n'
      + existing.slice(-40).map((g, i) => `${i + 1}. ${g}`).join('\n')
    : '';

  return [
    `请为「${aiName}」这个 AI 助手设计 ${count} 句开场白，用于用户刚打开对话页面时的主动问候。`,
    '',
    `这些句子会放进名为「${library.name}」的欢迎语库里，用途是：${library.note || library.name}。`
      + '请让句子贴合这个场景。',
    '',
    '要求：',
    `- 一共 ${count} 句，每句单独占一行，行首不要加编号或符号`,
    '- 只输出这些句子本身，不要解释、不要标题、不要用引号包起来',
    '- 语气自然、口语化、友好，不要客套过头',
    '- 每句 25 个字以内',
    '- 句句不同：有的问心情、有的问需求、有的随口闲聊、有的结合时间或天气',
  ].join('\n') + avoid;
}

/**
 * 让 AI 学习、生成一批新欢迎语，存进指定的库（不传 libraryId 就用当前选中的库）。
 * 未配置接口时直接跳过（不写日志、不推进 lastRunAt），配置好之后会自动补上。
 */
export async function learnGreetings(ctx, settings, { libraryId, count = 6, reason = 'manual' } = {}) {
  const store = ctx.store;
  const lib = libraryId ? store.getLibrary(libraryId) : store.activeLibrary;
  if (!lib) return { ok: false, skipped: true, added: 0, retired: 0, error: '欢迎语库不存在' };

  if (!settings.apiKey || !settings.model || !settings.baseUrl) {
    return { ok: false, skipped: true, added: 0, retired: 0, error: '尚未配置 AI 接口', libraryId: lib.id };
  }

  const target = Math.max(1, Math.min(20, Number(count) || 6));
  // 本库已有的 + 前台用过的，一起用来去重
  const existing = [...lib.greetings.map((p) => p.text), ...store.recentGreetings];

  const finish = (payload) => {
    store.recordLibraryLearn(lib.id, { added: payload.added || 0, retired: payload.retired || 0 });
    const log = store.recordLearnLog({
      libraryId: lib.id, libraryName: lib.name, reason,
      added: payload.added || 0,
      retired: payload.retired || 0,
      kept: store.getLibrary(lib.id)?.greetings.length || 0,
      error: payload.error || '',
    });
    return { ok: !payload.error, ...payload, libraryId: lib.id, libraryName: lib.name, log };
  };

  let res;
  try {
    res = await requestChat({
      settings,
      messages: [
        { role: 'system', content: settings.systemPrompt || `你是${settings.aiName}。` },
        {
          role: 'user',
          content: buildLearnPrompt({ aiName: settings.aiName, library: lib, existing, count: target }),
        },
      ],
      stream: false,
      timeoutMs: 40_000,
    });
  } catch (err) {
    return finish({ added: 0, retired: 0, error: err.message });
  }

  try {
    if (!res.ok) {
      return finish({ added: 0, retired: 0, error: await readUpstreamError(res) });
    }
    const json = await res.json();
    const candidates = parseGreetingList(json.choices?.[0]?.message?.content);

    const accepted = [];
    for (const text of candidates) {
      if (accepted.length >= target) break;
      if (!isUsableGreeting(text)) continue;
      if (isTooSimilar(text, [...existing, ...accepted])) continue;
      accepted.push(text);
    }

    if (!accepted.length) {
      return finish({
        added: 0, retired: 0,
        error: candidates.length ? '生成的句子与库里已有的太接近' : '模型没有返回可用内容',
      });
    }

    for (const text of accepted) store.addLibraryGreeting(lib.id, text, 'ai');
    const retired = pruneLibraryGreetings(store, lib.id, settings.greetingPoolLimit);
    return finish({ added: accepted.length, retired });
  } catch (err) {
    return finish({ added: 0, retired: 0, error: err.message });
  } finally {
    res._cleanup?.();
  }
}

/**
 * 去重 + 按容量淘汰（只作用于一个库）。
 * 淘汰策略：优先淘汰「已经被用得多」的（前台早就见腻了），并列时保留较新的。
 * @returns 淘汰掉的条数
 */
export function pruneLibraryGreetings(store, libraryId, limit) {
  const lib = store.getLibrary(libraryId);
  if (!lib) return 0;

  const max = Math.max(5, Math.min(POOL_HARD_LIMIT, Number(limit) || 60));
  const before = lib.greetings.length;

  const kept = [];
  for (const entry of lib.greetings) {
    if (kept.some((k) => isTooSimilar(entry.text, [k.text]))) continue;
    kept.push(entry);
  }

  if (kept.length > max) {
    const byFreshness = [...kept].sort((a, b) =>
      (a.usedCount || 0) - (b.usedCount || 0)
      || new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    const trimmed = byFreshness.slice(0, max);
    kept.length = 0;
    kept.push(...trimmed);
  }

  const removed = before - kept.length;
  if (removed > 0) store.replaceLibraryGreetings(libraryId, kept);
  return removed;
}

/**
 * 从库里挑一句给前台用：优先没出现过的，其次用得少的、最久没用的。
 * 从前 3 名里随机取，避免顺序固定。库为空返回 null。
 */
export function pickFromLibrary(ctx, library) {
  const store = ctx.store;
  const pool = library?.greetings || [];
  if (!pool.length) return null;

  const recent = store.recentGreetings;
  const fresh = pool.filter((p) => !isTooSimilar(p.text, recent));
  const rank = (a, b) =>
    (a.usedCount || 0) - (b.usedCount || 0)
    || new Date(a.lastUsedAt || 0).getTime() - new Date(b.lastUsedAt || 0).getTime();

  const top = (fresh.length ? fresh : pool).slice().sort(rank).slice(0, 3);
  const chosen = top[Math.floor(Math.random() * top.length)];

  store.markLibraryGreetingUsed(library.id, chosen.id);
  store.rememberGreeting(chosen.text);
  return chosen.text;
}

// ================================================================ 快捷提问（跟着欢迎语走）

/** 快捷提问按钮的条数 */
const CHIP_COUNT = 4;
/** 异步生成快捷提问时，最多等多久（超时就先用库里的兜底） */
const CHIP_TIMEOUT_MS = 20_000;

/**
 * 这行像不像一个「问句」。
 * 有些模型不写问号（「雨花台有哪些纪念建筑」），只认问号会白白退回兜底；
 * 但也不能给陈述句硬补问号，所以要么有问号，要么含疑问词。
 */
const QUESTION_WORDS = /[?？]$|[吗呢]$|什么|怎么|怎样|如何|为什么|为何|哪些|哪个|哪里|哪种|多少|是否|有没有|能不能|可不可以/;

function looksLikeQuestion(text) {
  return QUESTION_WORDS.test(text);
}

function buildChipPrompt({ aiName, greeting, library, count }) {
  return [
    `用户刚打开对话页面，AI「${aiName}」的开场白是：「${greeting}」`,
    '',
    `请给出 ${count} 个用户看完这句开场白后最可能想接着问的问题，用作界面上的「快捷提问按钮」。`,
    '',
    '要求：',
    `- 一共 ${count} 个，每行一个，行首不要编号或符号`,
    '- 每句都要是一个完整的问题，以问号结尾',
    '- 是**用户问 AI** 的问题，不是 AI 问用户的话',
    '- 每句 30 个字以内，点了就能直接发出去',
    `- 主题贴合这个场景：${library?.note || library?.name || '日常对话'}`,
    '- 只输出这些问题本身，不要解释、不要标题',
  ].join('\n');
}

/**
 * 根据当前的欢迎语，实时生成一组贴合的快捷提问。
 * 接口没配好、生成失败或结果太差时返回 null，由调用方回退到库里预设的那组。
 */
export async function generateChips(ctx, settings, { greeting, library, count = CHIP_COUNT } = {}) {
  if (!settings.apiKey || !settings.model || !settings.baseUrl) return null;
  if (!greeting) return null;

  let res;
  try {
    res = await requestChat({
      settings,
      messages: [
        { role: 'system', content: settings.systemPrompt || `你是${settings.aiName}。` },
        { role: 'user', content: buildChipPrompt({ aiName: settings.aiName, greeting, library, count }) },
      ],
      stream: false,
      timeoutMs: CHIP_TIMEOUT_MS,
    });
  } catch {
    return null;
  }

  try {
    if (!res.ok) return null;
    const json = await res.json();
    // 只认「本来就是个问句」的行——给陈述句硬补个问号只会造出莫名其妙的问题，
    // 这种情况宁可退回库里那组人工挑过的提问。
    const questions = parseGreetingList(json.choices?.[0]?.message?.content)
      .map((t) => t.replace(/[。！]+$/, '').replace(/\?/g, '？'))
      .filter((t) => t.length >= 4 && t.length <= 40 && looksLikeQuestion(t))
      .map((t) => (/？$/.test(t) ? t : `${t}？`));

    const unique = [...new Set(questions)];
    if (unique.length < 2) return null;
    return unique.slice(0, count);
  } catch {
    return null;
  } finally {
    res._cleanup?.();
  }
}
