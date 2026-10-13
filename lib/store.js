import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_SETTINGS = {
  // ---- 前台展示 ----
  aiName: 'AI 助手',
  welcome: '你好，我是 AI 助手，有什么可以帮你的吗？',
  greetingMode: 'ai', // 'ai' = 模型现场生成；'library' = 从 AI 学习库里取；'fixed' = 固定用 welcome

  // ---- 网站图标 ----
  iconMode: 'default', // 'default' = 圆角色块 + 文字（浏览器现场画出来）；'custom' = 管理员上传的图
  iconText: '', // 默认图标上的文字（1-4 字），空则用 aiName 推导
  iconVersion: 0, // 每换一次图标 +1；只由服务端自增，用来击穿 favicon 缓存

  // ---- 欢迎语库（AI 学习）----
  greetingAutoLearn: false, // 每天定时让 AI 给每个库学习、补充欢迎语
  greetingAutoLearnHour: 3, // 自动学习的运行时刻（0-23 点）
  greetingLearnBatch: 6, // 每个库每次学习最多新增几条
  greetingPoolLimit: 60, // 每个库的容量上限，超出后淘汰用得最多的

  // ---- 前台入口 ----
  requireKey: true, // 进入网站是否需要秘钥验证
  frontLocalOnly: false, // 关闭秘钥验证时：是否仅允许本机访问

  // ---- 后台入口 ----
  adminRequirePassword: true, // 后台是否需要密码
  adminLocalOnly: true, // 关闭后台密码时：是否仅允许本机访问
  // 后台开在哪个网址下：页面在 /<adminPath>，接口在 /<adminPath>/api。
  // 默认 'admin' 就是老地址 /admin，行为一个字都不变；改成一个别人猜不到的名字后，
  // 公网就摸不到后台入口了（老地址对外变 404，见 server.js 里那段路径重写）。
  adminPath: 'admin',

  // ---- AI 接口（OpenAI 兼容）----
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  systemPrompt: '你是一个乐于助人的中文 AI 助手。回答要准确、简洁、有条理，适当使用 Markdown 排版。',
  temperature: 0.7,
  maxTokens: 2048,
  historyLimit: 20, // 发送给模型的最大历史消息条数

  // ---- 安全 ----
  adminPasswordHash: '',
};

/** 默认库的兜底快捷提问（AI 来不及生成或生成失败时用） */
export const DEFAULT_CHIPS = [
  '用三句话解释什么是量子纠缠',
  '帮我写一封请假邮件',
  '把这段话翻译成英文：今天的会议改到下午三点',
  '用 Python 写一个快速排序',
];

/** 雨花台烈士陵园主题库的预设内容（只在下述几处预置，不编造史实，全部是「问题」） */
const YUHUATAI_PRESET = {
  name: '雨花台烈士陵园',
  note: '参观者咨询雨花台烈士陵园的相关问题',
  chips: [
    '雨花台烈士陵园有哪些主要纪念建筑？',
    '雨花台烈士陵园的历史沿革是怎样的？',
    '参观雨花台烈士陵园需要注意什么？',
    '雨花台烈士陵园适合什么年龄段的孩子参观？',
  ],
  greetings: [
    '想了解雨花台烈士陵园的哪段历史？',
    '你好，想先从雨花台的哪个地方看起？',
    '欢迎，关于雨花台烈士陵园，你想知道些什么？',
    '在的，雨花台的建筑、人物、故事，你想聊哪个？',
    '你好呀，想听听雨花台背后的故事吗？',
    '来了，关于雨花台烈士陵园，尽管问我。',
  ],
};

function makeGreetingEntry(text, source) {
  return {
    id: newId('g'),
    text,
    source, // 'ai' = 学习得来；'manual' = 管理员手填；'preset' = 预置
    createdAt: new Date().toISOString(),
    usedCount: 0,
    lastUsedAt: null,
  };
}

function makeLibrary(name, note, chips, greetings = []) {
  return {
    id: newId('lib'),
    name,
    note,
    chips: [...chips],
    greetings: greetings.map((t) => makeGreetingEntry(t, 'preset')),
    learn: { lastRunAt: null, totalAdded: 0, totalRetired: 0 },
  };
}

/** 建库时用的两个预设库 */
function makeDefaultLibraries() {
  return [
    makeLibrary('默认欢迎语库', '通用场景，什么话题都可以聊', DEFAULT_CHIPS),
    makeLibrary(YUHUATAI_PRESET.name, YUHUATAI_PRESET.note, YUHUATAI_PRESET.chips, YUHUATAI_PRESET.greetings),
  ];
}

function normalizeLibrary(lib) {
  const base = makeLibrary(lib?.name || '未命名库', lib?.note || '', []);
  return {
    ...base,
    id: lib?.id || base.id,
    chips: Array.isArray(lib?.chips) ? lib.chips.filter((c) => typeof c === 'string') : [],
    greetings: Array.isArray(lib?.greetings)
      ? lib.greetings.filter((g) => g && typeof g.text === 'string').map((g) => ({
        ...makeGreetingEntry(g.text, g.source || 'ai'),
        id: g.id || newId('g'),
        createdAt: g.createdAt || new Date().toISOString(),
        usedCount: Number(g.usedCount) || 0,
        lastUsedAt: g.lastUsedAt || null,
      }))
      : [],
    learn: {
      lastRunAt: lib?.learn?.lastRunAt || null,
      totalAdded: Number(lib?.learn?.totalAdded) || 0,
      totalRetired: Number(lib?.learn?.totalRetired) || 0,
    },
  };
}

/**
 * 把 greetings 数据统一成「多库」结构。
 * 旧版本只有一个 pool，这里会迁移成「默认欢迎语库」，并补上预置的雨花台主题库。
 */
function migrateGreetings(g) {
  const recent = Array.isArray(g?.recent) ? g.recent : [];
  const logs = Array.isArray(g?.learn?.logs) ? g.learn.logs : [];

  if (Array.isArray(g?.libraries) && g.libraries.length) {
    const libraries = g.libraries.map(normalizeLibrary);
    const activeId = libraries.some((l) => l.id === g.activeId) ? g.activeId : libraries[0].id;
    return { recent, libraries, activeId, learn: { logs } };
  }

  const libraries = makeDefaultLibraries();
  // 旧数据里的欢迎语并进默认库，别丢
  if (Array.isArray(g?.pool) && g.pool.length) {
    libraries[0].greetings = g.pool
      .filter((p) => p && typeof p.text === 'string')
      .map((p) => ({ ...makeGreetingEntry(p.text, p.source || 'ai'), usedCount: Number(p.usedCount) || 0 }));
  }
  if (g?.learn?.lastRunAt) libraries[0].learn.lastRunAt = g.learn.lastRunAt;

  return { recent, libraries, activeId: libraries[0].id, learn: { logs } };
}

const DEFAULT_DB = {
  version: 2,
  settings: { ...DEFAULT_SETTINGS },
  keys: [],
  greetings: migrateGreetings(null),
  meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
};

/** 开场白历史保留条数 */
const GREETING_HISTORY = 40;
/** 学习日志保留条数 */
const LEARN_LOG_KEEP = 20;

/** 基于 JSON 文件的极简存储，写入采用「临时文件 + 重命名」保证原子性 */
export class Store {
  constructor(file) {
    this.file = file;
    this.data = this.#load();
  }

  #load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.#write(DEFAULT_DB);
      return structuredClone(DEFAULT_DB);
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        ...structuredClone(DEFAULT_DB),
        ...parsed,
        version: DEFAULT_DB.version,
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        keys: Array.isArray(parsed.keys) ? parsed.keys : [],
        greetings: migrateGreetings(parsed.greetings),
        meta: { ...DEFAULT_DB.meta, ...(parsed.meta || {}) },
      };
    } catch (err) {
      const backup = `${this.file}.broken-${Date.now()}`;
      fs.copyFileSync(this.file, backup);
      console.error(`[store] 数据文件损坏，已备份到 ${backup}，将重建。原因：${err.message}`);
      this.#write(DEFAULT_DB);
      return structuredClone(DEFAULT_DB);
    }
  }

  #write(payload) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }

  save() {
    this.data.meta.updatedAt = new Date().toISOString();
    this.#write(this.data);
  }

  // ---------------- 设置 ----------------

  get settings() {
    return this.data.settings;
  }

  /** 数据目录（db.json 所在处），图标之类的附属文件也放这儿 */
  get dataDir() {
    return path.dirname(this.file);
  }

  updateSettings(patch) {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    for (const [k, v] of Object.entries(patch)) {
      if (allowed.includes(k)) this.data.settings[k] = v;
    }
    this.save();
    return this.data.settings;
  }

  // ---------------- 秘钥 ----------------

  listKeys() {
    return this.data.keys;
  }

  getKey(id) {
    return this.data.keys.find((k) => k.id === id) || null;
  }

  findKeyByCode(code) {
    return this.data.keys.find((k) => k.code === code) || null;
  }

  addKey(record) {
    this.data.keys.unshift(record);
    this.save();
    return record;
  }

  updateKey(id, patch) {
    const key = this.getKey(id);
    if (!key) return null;
    Object.assign(key, patch);
    this.save();
    return key;
  }

  deleteKey(id) {
    const idx = this.data.keys.findIndex((k) => k.id === id);
    if (idx === -1) return false;
    this.data.keys.splice(idx, 1);
    this.save();
    return true;
  }

  deleteKeys(ids) {
    const set = new Set(ids);
    const before = this.data.keys.length;
    this.data.keys = this.data.keys.filter((k) => !set.has(k.id));
    this.save();
    return before - this.data.keys.length;
  }

  // ---------------- 开场白历史 ----------------

  get recentGreetings() {
    return this.data.greetings.recent;
  }

  rememberGreeting(text) {
    const list = this.data.greetings.recent;
    list.push(text);
    while (list.length > GREETING_HISTORY) list.shift();
    this.save();
    return text;
  }

  // ---------------- 欢迎语库（AI 学习，可多库）----------------

  get greetingLibraries() {
    return this.data.greetings.libraries;
  }

  get learnLogs() {
    return this.data.greetings.learn.logs;
  }

  getLibrary(id) {
    return this.data.greetings.libraries.find((l) => l.id === id) || null;
  }

  /** 当前选中的库；activeId 失效时退回第一个 */
  get activeLibrary() {
    const list = this.data.greetings.libraries;
    return this.getLibrary(this.data.greetings.activeId) || list[0] || null;
  }

  get activeLibraryId() {
    return this.data.greetings.activeId;
  }

  /**
   * 当前库预设的快捷提问 —— 「进站第一帧就显示」和「AI 生成失败时的兜底」都用这一组。
   * 库是空的就退回内置的 DEFAULT_CHIPS。
   */
  get activeChips() {
    const chips = this.activeLibrary?.chips;
    return Array.isArray(chips) && chips.length ? chips : DEFAULT_CHIPS;
  }

  setActiveLibrary(id) {
    if (!this.getLibrary(id)) return null;
    this.data.greetings.activeId = id;
    this.save();
    return id;
  }

  addLibrary(name, note = '') {
    const lib = {
      id: newId('lib'),
      name,
      note,
      chips: [],
      greetings: [],
      learn: { lastRunAt: null, totalAdded: 0, totalRetired: 0 },
    };
    this.data.greetings.libraries.push(lib);
    this.data.greetings.activeId = lib.id;
    this.save();
    return lib;
  }

  updateLibrary(id, patch = {}) {
    const lib = this.getLibrary(id);
    if (!lib) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) lib.name = patch.name.trim();
    if (typeof patch.note === 'string') lib.note = patch.note.trim();
    this.save();
    return lib;
  }

  deleteLibrary(id) {
    const list = this.data.greetings.libraries;
    if (list.length <= 1) return { ok: false, error: '至少要保留一个库' };
    const idx = list.findIndex((l) => l.id === id);
    if (idx === -1) return { ok: false, error: '库不存在' };
    list.splice(idx, 1);
    if (this.data.greetings.activeId === id) this.data.greetings.activeId = list[0].id;
    this.save();
    return { ok: true };
  }

  setLibraryChips(id, chips) {
    const lib = this.getLibrary(id);
    if (!lib) return null;
    lib.chips = chips.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim()).slice(0, 12);
    this.save();
    return lib.chips;
  }

  addLibraryGreeting(libId, text, source = 'ai') {
    const lib = this.getLibrary(libId);
    if (!lib) return null;
    const entry = makeGreetingEntry(text, source);
    lib.greetings.push(entry);
    this.save();
    return entry;
  }

  updateLibraryGreeting(libId, gid, text) {
    const e = this.getLibrary(libId)?.greetings.find((g) => g.id === gid);
    if (!e) return null;
    e.text = text;
    this.save();
    return e;
  }

  deleteLibraryGreeting(libId, gid) {
    const lib = this.getLibrary(libId);
    if (!lib) return false;
    const idx = lib.greetings.findIndex((g) => g.id === gid);
    if (idx === -1) return false;
    lib.greetings.splice(idx, 1);
    this.save();
    return true;
  }

  clearLibraryGreetings(libId) {
    const lib = this.getLibrary(libId);
    if (!lib) return false;
    lib.greetings = [];
    this.save();
    return true;
  }

  /** 直接整体替换（淘汰时用），不逐条 save */
  replaceLibraryGreetings(libId, list) {
    const lib = this.getLibrary(libId);
    if (!lib) return null;
    lib.greetings = list;
    this.save();
    return list;
  }

  markLibraryGreetingUsed(libId, gid) {
    const e = this.getLibrary(libId)?.greetings.find((g) => g.id === gid);
    if (!e) return null;
    e.usedCount = (e.usedCount || 0) + 1;
    e.lastUsedAt = new Date().toISOString();
    this.save();
    return e;
  }

  /** 记录某个库这次学习的成绩（刷新它的 lastRunAt） */
  recordLibraryLearn(libId, { added = 0, retired = 0 } = {}) {
    const lib = this.getLibrary(libId);
    if (!lib) return null;
    lib.learn.lastRunAt = new Date().toISOString();
    lib.learn.totalAdded += added;
    lib.learn.totalRetired += retired;
    this.save();
    return lib.learn;
  }

  /** 全局学习日志，每条带上库名，方便多个库混在一起看 */
  recordLearnLog({ libraryId = '', libraryName = '', added = 0, retired = 0, kept = 0, error = '', reason = 'auto' }) {
    const logs = this.data.greetings.learn.logs;
    const entry = {
      at: new Date().toISOString(),
      libraryId, libraryName, added, retired, kept, error, reason,
    };
    logs.unshift(entry);
    while (logs.length > LEARN_LOG_KEEP) logs.pop();
    this.save();
    return entry;
  }
}

export function newId(prefix = 'k') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}
