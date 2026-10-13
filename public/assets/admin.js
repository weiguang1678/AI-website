const $ = (id) => document.getElementById(id);

const el = {
  boot: $('boot'), login: $('login'), panel: $('panel'),
  loginForm: $('loginForm'), loginPassword: $('loginPassword'), loginError: $('loginError'), loginBtn: $('loginBtn'),
  nav: $('adminNav'), logoutBtn: $('logoutBtn'),
  statGrid: $('statGrid'), sysInfo: $('sysInfo'),
  aiForm: $('aiForm'), saveAiBtn: $('saveAiBtn'), aiSaveHint: $('aiSaveHint'),
  toggleKey: $('toggleKey'), testBtn: $('testBtn'), testResult: $('testResult'),
  apiKeyHint: $('apiKeyHint'), clearKeyBtn: $('clearKeyBtn'),
  modeSeg: $('modeSeg'), generatePane: $('generatePane'), customPane: $('customPane'),
  genCount: $('genCount'), genCharset: $('genCharset'), genNote: $('genNote'),
  customCode: $('customCode'), customNote: $('customNote'),
  expiryType: $('expiryType'), durationFields: $('durationFields'), datetimeFields: $('datetimeFields'),
  durationValue: $('durationValue'), durationUnit: $('durationUnit'), expiresAt: $('expiresAt'),
  maxUses: $('maxUses'), maxUsesField: $('maxUsesField'), onetimeFields: $('onetimeFields'),
  createBtn: $('createBtn'), createHint: $('createHint'),
  keysBody: $('keysBody'), keysEmpty: $('keysEmpty'), checkAll: $('checkAll'),
  bulkDeleteBtn: $('bulkDeleteBtn'), copyAllBtn: $('copyAllBtn'),
  securityForm: $('securityForm'), frontLocalRow: $('frontLocalRow'), adminLocalRow: $('adminLocalRow'),
  frontWarn: $('frontWarn'), adminWarn: $('adminWarn'), securitySaveHint: $('securitySaveHint'),
  adminPathNow: $('adminPathNow'),
  passwordForm: $('passwordForm'), currentPwField: $('currentPwField'), currentPw: $('currentPw'),
  newPw: $('newPw'), confirmPw: $('confirmPw'), pwHint: $('pwHint'),
  resultModal: $('resultModal'), resultCodes: $('resultCodes'), resultTitle: $('resultTitle'),
  resultSub: $('resultSub'), closeModal: $('closeModal'), copyResult: $('copyResult'),
  learnNowBtn: $('learnNowBtn'), addGreetBtn: $('addGreetBtn'), clearGreetBtn: $('clearGreetBtn'),
  poolStatus: $('poolStatus'), poolList: $('poolList'), poolLogs: $('poolLogs'), learnHour: $('learnHour'),
  poolAdd: $('poolAdd'), poolAddInput: $('poolAddInput'), poolAddSave: $('poolAddSave'),
  poolAddCancel: $('poolAddCancel'),
  libSelect: $('libSelect'), libNote: $('libNote'), libServe: $('libServe'), libNewBtn: $('libNewBtn'),
  libEditBtn: $('libEditBtn'), libDelBtn: $('libDelBtn'),
  libForm: $('libForm'), libNameInput: $('libNameInput'), libNoteInput: $('libNoteInput'),
  libFormSave: $('libFormSave'), libFormCancel: $('libFormCancel'),
  chipList: $('chipList'), chipAddBtn: $('chipAddBtn'), chipAdd: $('chipAdd'),
  chipAddInput: $('chipAddInput'), chipAddSave: $('chipAddSave'), chipAddCancel: $('chipAddCancel'),
  deviceSeg: $('deviceSeg'), previewFrame: $('previewFrame'), deviceFrame: $('deviceFrame'),
  deviceScaler: $('deviceScaler'), previewStage: $('previewStage'),
  previewSize: $('previewSize'), previewReload: $('previewReload'), previewRotate: $('previewRotate'),
  adminBadge: $('adminBadge'), adminBadgeSmall: $('adminBadgeSmall'),
  iconModeSeg: $('iconModeSeg'), iconDefaultPane: $('iconDefaultPane'), iconCustomPane: $('iconCustomPane'),
  iconDefaultCanvas: $('iconDefaultCanvas'), iconCropCanvas: $('iconCropCanvas'),
  iconFile: $('iconFile'), iconZoom: $('iconZoom'), iconResetCrop: $('iconResetCrop'),
  iconRestoreBtn: $('iconRestoreBtn'), iconFileHint: $('iconFileHint'), iconHint: $('iconHint'),
  toast: $('toast'),
};

let allKeys = [];
let mode = 'generate';
let apiKeyClear = false; // 用户点了「清除」，保存时要显式告诉服务端把密钥清空
let apiKeyHas = false;   // 服务端当前有没有配密钥（原文不会下发，只知真假）
let changedKeyId = null; // 刚被启停的那一条，渲染时让它的状态徽章脉冲一下

// ================================================================ 工具

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(message, ms = 2800) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromNow(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const unit = abs < 3_600_000
    ? [Math.round(abs / 60_000), '分钟']
    : abs < 86_400_000
      ? [Math.round(abs / 3_600_000), '小时']
      : [Math.round(abs / 86_400_000), '天'];
  return diff >= 0 ? `${unit[0]} ${unit[1]}后` : `${unit[0]} ${unit[1]}前`;
}

/** 用户是否要求「减少动态效果」。CSS 那边的入场动画由媒体查询兜底，
    这里只管 JS 驱动的（统计数字滚动） */
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 统计数字从 0 补间到目标值。非数字（比如「—」）直接跳过 */
function countUp(node) {
  const target = Number(String(node.textContent).trim());
  if (!Number.isFinite(target) || reduceMotion()) return;

  const dur = 640;
  const t0 = performance.now();
  node.textContent = '0';
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    // easeOutCubic：起步快、收尾慢，读起来更像「跳到位」而不是「匀速爬」
    node.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(step);
    else node.textContent = String(target);
  };
  requestAnimationFrame(step);
}

/**
 * 挑出「这一次才出现」的条目。
 * 后台的表格和列表都是整块 innerHTML 重写，如果按 CSS 无脑挂入场动画，
 * 点一下「停用」整张表都会重放一遍。用一份「画过的 id」来过滤：
 * 只有新增的才播，顺带把已经消失的 id 清掉，免得越攒越多。
 * （比对比整串签名更细：加一条只动一条，而不是全表重播。）
 */
function freshIds(seen, ids) {
  const current = new Set(ids);
  for (const id of seen) if (!current.has(id)) seen.delete(id);
  const fresh = new Set();
  for (const id of ids) if (!seen.has(id)) { seen.add(id); fresh.add(id); }
  return fresh;
}

/**
 * 取某个库自己的记账表。
 * 欢迎语/兜底提问都是「分库」的，所有库合用一份 Set 会出问题：每次渲染传进来
 * 的 ids 只有当前库的，另一库的条目就会被 prune 掉，切回来时整库都被当成
 * 「这次才出现」而集体重播入场 —— 正好是这套记账要避免的事。
 */
function paintedFor(map, key) {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  return set;
}

const paintedKeyIds = new Set();        // 秘钥不分区，一行就是一个 id
const paintedGreetIds = new Map();      // 欢迎语：库 id → 已画过的条目 id
const paintedChipTexts = new Map();     // 兜底提问：库 id → 已画过的文本（它没有 id）

/** 保存按钮的三段反馈：转圈 → 打勾 → 复原。传进来的 task 抛错就原样退出 */
async function withSaveState(btn, task) {
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const out = await task();
    btn.classList.remove('loading');
    btn.classList.add('btn-done');
    btn.textContent = '已保存';
    setTimeout(() => {
      btn.classList.remove('btn-done');
      btn.textContent = label;
      btn.disabled = false;
    }, 1500);
    return out;
  } catch (err) {
    btn.classList.remove('loading');
    btn.disabled = false;
    throw err;
  }
}

function hint(node, text, kind = '') {
  node.textContent = text;
  node.className = 'save-hint' + (kind ? ' ' + kind : '');
  if (text) {
    // 重挂一次让 .hint-in 重播（提示文字可能是同一条，比如连续两次保存都成功）
    node.classList.remove('hint-in');
    void node.offsetWidth;
    node.classList.add('hint-in');
    // 用递增序号认领这次提示：只比 textContent 的话，3.6s 内连着两次
    // 相同内容（两次都「已保存 ✓」）会让第一颗定时器把第二条提前清掉。
    const token = (node._hintToken || 0) + 1;
    node._hintToken = token;
    setTimeout(() => {
      if (node._hintToken === token) node.textContent = '';
    }, 3600);
  }
}

// 后台接口的基址。后台网址是可改的（设置项 adminPath），服务端在发这一页时
// 把基址写进 <meta name="admin-api">，形如 /admin/api 或 /my-panel/api。
// 两个都用 let：在「入口与安全」里改完网址后这一页还得接着用（见那边的提交处理）——
// 换了基址却还往老地址发请求的话，下一次保存就会 404。
// 兜底 /api/admin：万一 meta 没注进来（比如直接拿浏览器打开了磁盘上的 admin.html）。
const adminApiMeta = (document.querySelector('meta[name="admin-api"]')?.content || '').trim();
let apiBase = adminApiMeta || '/api/admin';
let currentAdminPath = adminApiMeta ? adminApiMeta.replace(/^\//, '').replace(/\/api$/, '') : 'admin';

async function api(path, { method = 'GET', body, timeoutMs = 60_000 } = {}) {
  // 没有超时的话，一条挂起的连接会让保存按钮永远停在转圈状态，只能刷新页面才恢复。
  // 60s 比服务端自己的 AI 超时（30s）宽松；耗时更久的接口单独放宽。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(apiBase + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('请求超时了，请稍后重试。');
    throw new Error(`连不上服务器：${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new Error(data.error || '后台登录已过期');
  }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

const STATUS_TEXT = { active: '有效', pending: '未生效', expired: '已过期', exhausted: '次数用尽', disabled: '已停用' };

// ================================================================ 登录

function showLogin(message = '') {
  el.boot.classList.add('hidden');
  el.panel.classList.add('hidden');
  el.login.classList.remove('hidden');
  el.loginError.textContent = message;
  el.loginPassword.value = '';
  setTimeout(() => el.loginPassword.focus(), 60);
}

function showPanel() {
  el.boot.classList.add('hidden');
  el.login.classList.add('hidden');
  el.panel.classList.remove('hidden');
  // 淡入一次。和前台 #app 一样只动 opacity 不动 transform ——
  // .admin 一旦有 transform 就会成为 fixed 后代的包含块
  el.panel.classList.remove('view-enter');
  void el.panel.offsetWidth;
  el.panel.classList.add('view-enter');
}

el.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.loginBtn.disabled = true;
  el.loginBtn.textContent = '登录中…';
  el.loginError.textContent = '';
  try {
    await api('/login', { method: 'POST', body: { password: el.loginPassword.value } });
    showPanel();
    await refreshAll();
  } catch (err) {
    el.loginError.textContent = err.message;
    el.loginPassword.select();
  } finally {
    el.loginBtn.disabled = false;
    el.loginBtn.textContent = '登录';
  }
});

el.logoutBtn.addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ================================================================ 标签页

const TABS = ['overview', 'ai', 'keys', 'security', 'preview'];

// ---------------------------------------------------------------- 滑动的导航胶囊

function ensureNavThumb() {
  let thumb = el.nav.querySelector('.nav-thumb');
  if (!thumb) {
    thumb = document.createElement('div');
    thumb.className = 'nav-thumb';
    el.nav.prepend(thumb);
  }
  return thumb;
}

/**
 * 把高亮块挪到当前项底下。
 * 一律用 translate + 量出来的宽高：不写死方向，桌面是竖排、窄屏 `.admin-nav` 会变成
 * 横向滚动，同一段代码两边都对。宽度也要量 —— 各标签字数不一样（「概览」和「欢迎语库」）。
 */
function moveNavThumb() {
  const thumb = ensureNavThumb();
  const active = el.nav.querySelector('.nav-item.active');
  // 面板还藏着时量出来全是 0，那种时候干脆不画
  if (!active || !active.offsetWidth) { thumb.style.opacity = '0'; return; }
  thumb.style.opacity = '1';
  thumb.style.width = active.offsetWidth + 'px';
  thumb.style.height = active.offsetHeight + 'px';
  thumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
}

// ---------------------------------------------------------------- 滑动的分段滑块

const segThumbs = []; // [{ seg, thumb }]

/**
 * 给一个 .seg 装一块会滑过去的选中背景。
 * 位置一律量出来再 translate —— 不写死 top/left/bottom：内边距和边框的参照系不一样，
 * 写死迟早错位。顺带也能适配窄屏下 .seg-item 变宽变高的情况。
 */
function bindSegThumb(seg) {
  if (!seg || seg.dataset.thumbBound) return;
  seg.dataset.thumbBound = '1';
  const thumb = document.createElement('div');
  thumb.className = 'seg-thumb';
  seg.prepend(thumb);
  segThumbs.push({ seg, thumb });
  moveSegThumb({ seg, thumb });
}

function moveSegThumb({ seg, thumb }) {
  const active = seg.querySelector('.seg-item.active');
  // 量不到就先藏起来（面板还 hidden 时宽高全是 0），否则会在左上角闪一下
  if (!active || !active.offsetWidth) { thumb.style.opacity = '0'; return; }
  thumb.style.opacity = '1';
  thumb.style.width = active.offsetWidth + 'px';
  thumb.style.height = active.offsetHeight + 'px';
  thumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
}

function syncSegThumbs() {
  for (const item of segThumbs) moveSegThumb(item);
}

window.addEventListener('resize', moveNavThumb);
window.addEventListener('resize', syncSegThumbs);

function switchTab(name) {
  for (const t of TABS) {
    document.querySelector(`section.tab[data-tab="${t}"]`)?.classList.toggle('hidden', t !== name);
  }
  el.nav.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  moveNavThumb();
  if (name === 'overview') loadStats();
  if (name === 'keys') loadKeys();
  if (name === 'ai') refreshPool();
  if (name === 'preview') {
    // 先回到顶部，否则滚动位置会让可用高度的计算失真
    const main = document.querySelector('.admin-main');
    if (main) main.scrollTop = 0;
    applyDevice();
    loadPreview();
  }
}

el.nav.addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (btn) switchTab(btn.dataset.tab);
});

// ================================================================ 概览

// 第 4 个参数是错峰序号，交给 motion.css 的 .stat 逐张弹入
function statCard(label, value, kind = '', i = 0) {
  return `<div class="stat ${kind}" style="--i:${i}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`;
}

async function loadStats() {
  try {
    const s = await api('/stats');
    el.statGrid.innerHTML = [
      statCard('秘钥总数', s.totalKeys, '', 0),
      statCard('有效秘钥', s.byStatus.active, 'ok', 1),
      statCard('已过期', s.byStatus.expired, 'warn', 2),
      statCard('已停用', s.byStatus.disabled, '', 3),
      statCard('累计使用', s.totalUses, 'accent', 4),
      statCard('当前在线', s.onlineUsers, 'accent', 5),
    ].join('');
    // 卡片弹入的同时数字滚上去
    el.statGrid.querySelectorAll('.stat .value').forEach(countUp);

    const s2 = await api('/settings');
    const settings = s2.settings;
    el.sysInfo.innerHTML = `
      <dt>AI 名称</dt><dd>${esc(settings.aiName)}</dd>
      <dt>接口地址</dt><dd>${esc(settings.baseUrl || '未配置')}</dd>
      <dt>模型</dt><dd>${esc(settings.model || '未配置')}</dd>
      <dt>API Key</dt><dd>${settings.apiKeySet ? '已配置' : '未配置'}</dd>
      <dt>Node 版本</dt><dd>${esc(s.node)}</dd>
      <dt>已运行</dt><dd>${esc(formatUptime(s.uptimeSec))}</dd>`;
  } catch (err) {
    toast(err.message);
  }
}

function formatUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

// ================================================================ AI 设置

/** 密钥区的状态外观：配置过没有 → 占位文案 + 提示 + 「清除」按钮显隐 */
function syncApiKeyUi(hasKey) {
  apiKeyHas = hasKey;
  const input = el.aiForm.elements.apiKey;
  if (input) {
    input.value = '';
    input.placeholder = hasKey ? '已配置 · 留空则不修改' : 'sk-…';
  }
  if (el.apiKeyHint) {
    el.apiKeyHint.textContent = hasKey
      ? '已保存在服务器本地，不会下发到浏览器。换密钥直接填新的，留空表示不改。'
      : '只保存在服务器本地，不会下发到浏览器。';
  }
  el.clearKeyBtn?.classList.toggle('hidden', !hasKey);
}

function fillAiForm(settings) {
  const f = el.aiForm;
  // 不含 apiKey：服务器不再把密钥原文下发到浏览器（publicSettings 里剥掉了），
  // 所以这里无从回填，留空即代表「不修改」。
  for (const name of ['aiName', 'welcome', 'baseUrl', 'model', 'systemPrompt', 'greetingMode', 'iconText']) {
    if (f.elements[name]) f.elements[name].value = settings[name] ?? '';
  }
  for (const name of ['temperature', 'maxTokens', 'historyLimit',
    'greetingAutoLearnHour', 'greetingLearnBatch', 'greetingPoolLimit']) {
    if (f.elements[name]) f.elements[name].value = settings[name] ?? '';
  }
  if (f.elements.greetingAutoLearn) {
    f.elements.greetingAutoLearn.checked = Boolean(settings.greetingAutoLearn);
  }
  apiKeyClear = false;
  syncApiKeyUi(Boolean(settings.apiKeySet));
  syncIconUi(settings);
}

el.aiForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = el.aiForm;
  const payload = {};
  for (const name of ['aiName', 'welcome', 'baseUrl', 'model', 'systemPrompt', 'greetingMode', 'iconText']) {
    payload[name] = f.elements[name].value;
  }
  for (const name of ['temperature', 'maxTokens', 'historyLimit',
    'greetingAutoLearnHour', 'greetingLearnBatch', 'greetingPoolLimit']) {
    payload[name] = Number(f.elements[name].value);
  }
  payload.greetingAutoLearn = f.elements.greetingAutoLearn.checked;
  payload.iconMode = iconState.mode;

  // 密钥单独处理：填了新值才带上；留空 + 点过「清除」才发 apiKeyClear。
  // 绝不能无条件带空串 —— 表单里根本拿不到原文，一带就把服务端的密钥抹了。
  const typedKey = f.elements.apiKey.value.trim();
  if (typedKey) payload.apiKey = typedKey;
  else if (apiKeyClear) payload.apiKeyClear = true;

  // 转圈 → 打勾 → 复原，三段反馈都在 withSaveState 里
  withSaveState(el.saveAiBtn, async () => {
    await api('/settings', { method: 'PUT', body: payload });

    // 图标上传是「第二件事」：设置这时已经落库了。它失败不能把整次保存说成失败，
    // 也不能顺手跳过后面的收尾（预览失效 + 状态行刷新）。
    let iconNote = '';
    let iconErr = null;
    try {
      iconNote = await saveIconImage();
    } catch (err) {
      iconErr = err;
    }

    previewLoaded = false; // 让预览页下次进入时重新加载
    refreshPool(); // 下次运行时间取决于刚保存的设置，顺手刷一下状态行

    if (iconErr) {
      hint(el.aiSaveHint, `设置已保存，但图标上传失败：${iconErr.message}`, 'err');
      toast('设置已保存，图标未更新');
    } else {
      hint(el.aiSaveHint, iconNote ? `已保存 ✓（${iconNote}）` : '已保存 ✓', 'ok');
      toast('设置已保存');
    }

    // 保存成功后就地推算出新的密钥状态，省一次 GET /settings
    if (typedKey) { apiKeyHas = true; }
    else if (apiKeyClear) { apiKeyHas = false; }
    apiKeyClear = false;
    syncApiKeyUi(apiKeyHas);
  }).catch((err) => {
    hint(el.aiSaveHint, err.message, 'err');
    toast(err.message);
  });
});

// ================================================================ 网站图标
//
// 图标只存一张 512×512 的 PNG，四种用途共用：浏览器标签页、前台/后台头像、
// 微信/QQ 分享卡片。两条产出路径——
//   默认图标：渐变圆角块 + 文字，现场画出来
//   自定义图标：上传图片，在圆角方框里拖动缩放裁剪
// 两者最后都走同一个「圆角裁剪 → 导出 PNG」的函数。

const ICON_SIZE = 512;
const ICON_RADIUS_RATIO = 16 / 56; // 和 .brand-badge 的圆角比例一致（16px / 56px）

const iconState = { mode: 'default', version: 0 };

const crop = {
  img: null,   // 已解码的图片
  scale: 1,    // 相对「铺满」的倍数，1 = 刚好铺满
  x: 0, y: 0,  // 图片中心相对画布中心的偏移
  view: 384,   // 裁剪画布的边长
};

/** 圆角正方形路径（导出的四个角就靠它留成透明） */
function roundedPath(ctx, size) {
  const r = Math.min(size * ICON_RADIUS_RATIO, size / 2);
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(size, 0, size, size, r);
  ctx.arcTo(size, size, 0, size, r);
  ctx.arcTo(0, size, 0, 0, r);
  ctx.arcTo(0, 0, size, 0, r);
  ctx.closePath();
}

/** 图标文字里有没有表情符号 —— 表情的推进宽度约 1.37em，汉字只有 1em，字号得另算 */
const WIDE_GLYPH = /\p{Extended_Pictographic}/u;

/** 后台首页那两个字：AI 名称去掉空格后的头两个字符（英文取首字母） */
function brandShort(name) {
  const t = String(name || 'AI').trim();
  if (/^[a-zA-Z]/.test(t)) {
    const w = t.split(/\s+/).filter(Boolean);
    return (w.length > 1 ? w[0][0] + w[1][0] : t.slice(0, 2)).toUpperCase();
  }
  return t.slice(0, 2);
}

/** 默认图标上真正要画的字 */
function defaultIconLabel() {
  const typed = (el.aiForm.elements.iconText?.value || '').trim();
  return Array.from(typed).slice(0, 4).join('') || brandShort(el.aiForm.elements.aiName?.value);
}

/** 默认图标：斜向渐变圆角块 + 居中文字 */
function paintDefaultIcon(ctx, size, label) {
  ctx.save();
  roundedPath(ctx, size);
  ctx.clip();

  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#6366f1');
  g.addColorStop(0.55, '#a855f7');
  g.addColorStop(1, '#ec4899');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const text = Array.from(label || 'AI').slice(0, 4).join('');
  // 字号得跟着字数走。原来 >2 字统一给 0.28：3 个字是 430/512 刚好，
  // 4 个汉字就是 572/512 —— 第一和最后一个字会被 roundedPath 的 clip 切掉。
  // 系数和 style.css 里 .brand-badge 那三档保持一致，前台后台看着才是一套。
  const chars = Array.from(text).length;
  // 表情比汉字宽（实测约 1.37em vs 1em），得再缩一档，否则同样会顶到画布外
  const fit = WIDE_GLYPH.test(text) ? 0.72 : 1;
  const fontPx = size * (chars >= 4 ? 0.235 : chars === 3 ? 0.30 : 0.393) * fit;
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(fontPx)}px "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size * 0.54);
  ctx.restore();
}

/** 图片铺满圆角方框所需的缩放倍数 */
function coverScale() {
  if (!crop.img) return 1;
  return Math.max(crop.view / crop.img.width, crop.view / crop.img.height);
}

/** 把偏移夹回合法范围：图片任何时候都不能露出方框的边 */
function clampCrop() {
  if (!crop.img) return;
  const eff = coverScale() * crop.scale;
  const maxX = Math.max(0, (crop.img.width * eff - crop.view) / 2);
  const maxY = Math.max(0, (crop.img.height * eff - crop.view) / 2);
  crop.x = Math.min(maxX, Math.max(-maxX, crop.x));
  crop.y = Math.min(maxY, Math.max(-maxY, crop.y));
}

/** 在给定画布上画裁剪结果；size 与 crop.view 不同时自动等比换算 */
function paintCroppedIcon(ctx, size) {
  const k = size / crop.view;
  ctx.save();
  roundedPath(ctx, size);
  ctx.clip();
  ctx.fillStyle = '#e6e6ef';
  ctx.fillRect(0, 0, size, size);
  if (crop.img) {
    const eff = coverScale() * crop.scale * k;
    const w = crop.img.width * eff;
    const h = crop.img.height * eff;
    ctx.drawImage(crop.img, size / 2 + crop.x * k - w / 2, size / 2 + crop.y * k - h / 2, w, h);
  }
  ctx.restore();
}

function resetCrop() {
  crop.scale = 1;
  crop.x = 0;
  crop.y = 0;
  el.iconZoom.value = '100';
  clampCrop();
}

function drawCropCanvas() {
  const c = el.iconCropCanvas;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!crop.img) return;
  paintCroppedIcon(ctx, c.width);

  // 描个边，圆角的外面是透明的，一眼能看出来
  ctx.save();
  roundedPath(ctx, c.width);
  ctx.strokeStyle = 'rgba(0, 0, 0, .16)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawDefaultPreview() {
  const c = el.iconDefaultCanvas;
  paintDefaultIcon(c.getContext('2d'), c.width, defaultIconLabel());
}

function applyIconMode() {
  const custom = iconState.mode === 'custom';
  el.iconModeSeg.querySelectorAll('.seg-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.iconMode === iconState.mode);
  });
  el.iconDefaultPane.classList.toggle('hidden', custom);
  el.iconCustomPane.classList.toggle('hidden', !custom);
  syncSegThumbs();
  if (custom) drawCropCanvas();
  else drawDefaultPreview();
}

/** 后台自己的两处徽标 + 标签页图标，跟着最新版本走 */
function refreshAdminIcon() {
  const src = `/api/icon?v=${iconState.version}`;
  for (const node of [el.adminBadge, el.adminBadgeSmall]) if (node) node.src = src;
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = src;
}

/** 把当前生效的图标读进裁剪画布，这样切到「自定义」时是从现状接着改 */
function loadCurrentIconInto() {
  const img = new Image();
  img.onload = () => {
    crop.img = img;
    resetCrop();
    drawCropCanvas();
    el.iconFileHint.textContent = '这是当前在用的图标，可以直接裁剪，也可以另选一张。';
  };
  img.onerror = () => { /* 读不出来就保持空白，管理员选文件即可 */ };
  img.src = `/api/icon?v=${iconState.version}`;
}

/** 导出当前设置对应的 512×512 PNG（圆角外透明） */
function iconBlob() {
  const c = document.createElement('canvas');
  c.width = c.height = ICON_SIZE;
  const ctx = c.getContext('2d');
  if (iconState.mode === 'custom') {
    if (!crop.img) return Promise.resolve(null);
    paintCroppedIcon(ctx, ICON_SIZE);
  } else {
    paintDefaultIcon(ctx, ICON_SIZE, defaultIconLabel());
  }
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

/**
 * 保存图标位图。每次保存都重新生成一遍——默认图标的文字跟着 AI 名称走，
 * 而且重传一次才能让 iconVersion +1、把浏览器的 favicon 缓存顶掉。
 */
async function saveIconImage() {
  if (iconState.mode === 'custom' && !crop.img) {
    // 选了自定义却没挑图，就沿用现在这张，别把图标弄没了
    return '自定义图标还没选图片，沿用原来那张';
  }

  const blob = await iconBlob();
  if (!blob) return '图标没生成成功';

  const res = await fetch(apiBase + '/icon', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `图标上传失败（${res.status}）`);

  iconState.version = data.iconVersion;
  refreshAdminIcon();
  hint(el.iconHint, '图标已更新 ✓', 'ok');
  return '';
}

el.iconModeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-item');
  if (!btn) return;
  iconState.mode = btn.dataset.iconMode;
  applyIconMode();
});

el.aiForm.elements.iconText?.addEventListener('input', () => {
  if (iconState.mode === 'default') drawDefaultPreview();
});

el.iconFile.addEventListener('change', () => {
  const file = el.iconFile.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    crop.img = img;
    resetCrop();
    drawCropCanvas();
    el.iconFileHint.textContent = `已选择 ${file.name}（${img.width}×${img.height}）—— 拖动摆好位置后保存。`;
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    el.iconFileHint.textContent = '这张图片读不出来，换一张试试。';
  };
  img.src = url;
});

el.iconZoom.addEventListener('input', () => {
  crop.scale = Number(el.iconZoom.value) / 100;
  clampCrop();
  drawCropCanvas();
});

el.iconResetCrop.addEventListener('click', () => {
  resetCrop();
  drawCropCanvas();
});

// 按住拖动 / 滚轮缩放
el.iconCropCanvas.addEventListener('pointerdown', (e) => {
  if (!crop.img) return;
  el.iconCropCanvas.setPointerCapture(e.pointerId);
  crop.drag = { px: e.clientX, py: e.clientY, x: crop.x, y: crop.y };
  el.iconCropCanvas.style.cursor = 'grabbing';
});

el.iconCropCanvas.addEventListener('pointermove', (e) => {
  if (!crop.drag) return;
  const k = el.iconCropCanvas.width / el.iconCropCanvas.getBoundingClientRect().width;
  crop.x = crop.drag.x + (e.clientX - crop.drag.px) * k;
  crop.y = crop.drag.y + (e.clientY - crop.drag.py) * k;
  clampCrop();
  drawCropCanvas();
});

for (const ev of ['pointerup', 'pointercancel']) {
  el.iconCropCanvas.addEventListener(ev, () => {
    crop.drag = null;
    el.iconCropCanvas.style.cursor = crop.img ? 'grab' : 'default';
  });
}

el.iconCropCanvas.addEventListener('wheel', (e) => {
  if (!crop.img) return;
  e.preventDefault();
  const next = Math.min(4, Math.max(1, crop.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
  crop.scale = next;
  el.iconZoom.value = String(Math.round(next * 100));
  clampCrop();
  drawCropCanvas();
}, { passive: false });

el.iconRestoreBtn.addEventListener('click', async () => {
  el.iconRestoreBtn.disabled = true;
  try {
    // 删掉上传的那张（服务端顺带把 iconMode 改回 default），再把默认那版重新画出来传上去
    const removed = await api('/icon', { method: 'DELETE' });
    iconState.mode = 'default';
    iconState.version = Number(removed.iconVersion) || iconState.version + 1;
    crop.img = null;
    crop.drag = null;
    resetCrop();
    applyIconMode();
    // 画布弹一下，确认「确实换回去了」
    el.iconDefaultCanvas.classList.remove('canvas-pop');
    void el.iconDefaultCanvas.offsetWidth;
    el.iconDefaultCanvas.classList.add('canvas-pop');
    await saveIconImage();
    hint(el.iconHint, '已恢复默认图标 ✓', 'ok');
    toast('已恢复默认图标');
  } catch (err) {
    hint(el.iconHint, err.message, 'err');
    toast(err.message);
  } finally {
    el.iconRestoreBtn.disabled = false;
  }
});

/** 设置页拉到数据后把图标区同步一遍 */
function syncIconUi(settings) {
  iconState.mode = settings.iconMode === 'custom' ? 'custom' : 'default';
  iconState.version = Number(settings.iconVersion) || 0;
  crop.view = el.iconCropCanvas.width;
  applyIconMode();
  refreshAdminIcon();
  if (iconState.mode === 'custom' && !crop.img) loadCurrentIconInto();
}

el.toggleKey.addEventListener('click', () => {
  const input = el.aiForm.elements.apiKey;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  el.toggleKey.textContent = show ? '隐藏' : '显示';
});

el.clearKeyBtn?.addEventListener('click', () => {
  el.aiForm.elements.apiKey.value = '';
  apiKeyClear = true; // 真正清空靠「保存」时带上 apiKeyClear，见下面提交处理
  el.clearKeyBtn.classList.add('hidden');
  hint(el.aiSaveHint, '点「保存设置」后密钥会被清除。');
});

el.testBtn.addEventListener('click', async () => {
  el.testBtn.disabled = true;
  el.testResult.textContent = '测试中…';
  el.testResult.className = 'test-result';
  try {
    // 先把当前填写的配置存下来，保证测的就是将要用的
    await api('/settings', { method: 'PUT', body: {
      baseUrl: el.aiForm.elements.baseUrl.value,
      apiKey: el.aiForm.elements.apiKey.value,
      model: el.aiForm.elements.model.value,
    } });
    const r = await api('/ai/test', { method: 'POST' });
    if (r.ok) {
      el.testResult.textContent = `连接正常 · ${r.model} · ${r.ms}ms · 返回「${r.reply}」`;
      el.testResult.className = 'test-result ok';
    } else {
      el.testResult.textContent = r.error;
      el.testResult.className = 'test-result err';
    }
  } catch (err) {
    el.testResult.textContent = err.message;
    el.testResult.className = 'test-result err';
  } finally {
    el.testBtn.disabled = false;
  }
});

// ================================================================ 欢迎语库（AI 学习）

let libs = [];            // 所有库的概要（渲染切换器用）
let activeLib = null;     // 当前库的明细（含 greetings / chips）
let libFormMode = 'new';  // 'new' = 新建库；'edit' = 改当前库

const fmtAt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 带上当前库的 id，保证增删改都落在同一个库上 */
function libBody(extra = {}) {
  return { ...extra, libraryId: activeLib?.id };
}

function renderPool(payload) {
  if (Array.isArray(payload?.libraries)) libs = payload.libraries;
  if (payload?.library) activeLib = payload.library;

  const limit = payload?.limit ?? (Number(el.aiForm.elements.greetingPoolLimit.value) || 60);
  const learn = activeLib?.learn || {};
  const list = activeLib?.greetings || [];

  // ---- 库切换器 ----
  el.libSelect.innerHTML = libs.map((l) =>
    `<option value="${esc(l.id)}"${l.id === activeLib?.id ? ' selected' : ''}>`
    + `${esc(l.name)} · ${l.count} 条欢迎语 / ${l.chipCount} 条提问</option>`).join('');
  el.libSelect.disabled = libs.length === 0;
  el.libDelBtn.disabled = libs.length <= 1;
  el.libNote.textContent = activeLib
    ? `主题说明：${activeLib.note || '（未填写，自动学习时缺少场景提示，建议补上）'}`
    : '';

  // ---- 前台当前在用什么：切库到底有没有生效，看这一行 ----
  const mode = payload?.greetingMode;
  const useBtn = '<button type="button" class="btn btn-ghost btn-sm" id="libUseBtn">让前台用它</button>';
  if (mode === 'library' && activeLib) {
    el.libServe.className = 'lib-serve on';
    el.libServe.innerHTML = `<span class="dot">●</span>前台正在使用<b>「${esc(activeLib.name)}」</b>的欢迎语`;
  } else if (mode === 'ai') {
    el.libServe.className = 'lib-serve off';
    el.libServe.innerHTML = '<span class="dot">●</span>前台是「AI 实时生成」，'
      + '<b>没有使用任何库</b>的欢迎语（快捷提问除外）' + useBtn;
  } else if (mode === 'fixed') {
    el.libServe.className = 'lib-serve off';
    el.libServe.innerHTML = '<span class="dot">●</span>前台是「固定欢迎语」，<b>没有使用任何库</b>' + useBtn;
  } else {
    el.libServe.className = 'lib-serve';
    el.libServe.textContent = '';
  }

  // ---- 当前库的状态 ----
  el.poolStatus.innerHTML = [
    `库内 <b>${list.length}</b> / ${limit} 条`,
    `累计新增 <b>${learn.totalAdded || 0}</b>`,
    `累计淘汰 <b>${learn.totalRetired || 0}</b>`,
    `上次学习 ${fmtAt(learn.lastRunAt)}`,
    `<span class="pool-next">${payload?.nextRunAt ? `下次自动学习 ${fmtAt(payload.nextRunAt)}` : '自动学习未开启'}</span>`,
  ].join('<span class="sep">·</span>');

  // ---- 欢迎语 ----
  // 每次增删改都会重走这里，整块重绘。只有这次新出现的条目才播入场，
  // 否则点一下删除，剩下几十条全跟着重放一遍，看着像闪屏
  const chips = activeLib?.chips || [];
  const fresh = freshIds(paintedFor(paintedGreetIds, activeLib?.id || ''), list.map((g) => g.id));
  let enterIndex = 0;
  const order = new Map();
  for (const g of list) if (fresh.has(g.id)) order.set(g.id, enterIndex++);

  el.poolList.innerHTML = list.length
    ? list.map((g) => `
        <div class="pool-item${fresh.has(g.id) ? ' pool-enter' : ''}" style="--i:${order.get(g.id) ?? 0}" data-id="${esc(g.id)}">
          <span class="pool-text" title="点击可修改">${esc(g.text)}</span>
          <span class="pool-meta">用过 ${g.usedCount || 0} 次</span>
          <button type="button" class="icon-btn pool-del" title="删除" aria-label="删除">✕</button>
        </div>`).join('')
    : '<p class="pool-empty">这个库还是空的。点右上角「立即学习」让 AI 生成一批，或手动添加。</p>';

  // ---- 兜底快捷提问 ----
  renderChips(chips);

  // ---- 运行日志（多个库混在一起，所以标出库名） ----
  const logs = payload?.logs || [];
  el.poolLogs.innerHTML = logs.length
    ? logs.map((l) => `
        <div class="log-row">
          <span class="log-at">${fmtAt(l.at)}</span>
          <span class="log-lib">${esc(l.libraryName || '—')}</span>
          <span class="log-add">新增 ${l.added}</span>
          <span class="log-del">淘汰 ${l.retired}</span>
          <span>库内 ${l.kept}</span>
          ${l.error ? `<span class="log-err">${esc(l.error)}</span>` : ''}
          <span class="log-at" style="margin-left:auto">${l.reason === 'manual' ? '手动' : '自动'}</span>
        </div>`).join('')
    : '<p class="pool-empty">还没有运行记录。</p>';
}

function renderChips(chips) {
  // 这组没有 id，就用文本本身当身份（同一句重复添加没有意义）
  const fresh = freshIds(paintedFor(paintedChipTexts, activeLib?.id || ''), chips);
  let enterIndex = 0;
  const order = new Map();
  for (const c of chips) if (fresh.has(c)) order.set(c, enterIndex++);

  el.chipList.innerHTML = chips.length
    ? chips.map((c, i) => `
        <div class="pool-item${fresh.has(c) ? ' pool-enter' : ''}" style="--i:${order.get(c) ?? 0}" data-idx="${i}">
          <span class="pool-text chip-text" title="点击可修改">${esc(c)}</span>
          <button type="button" class="icon-btn pool-del" title="删除" aria-label="删除">✕</button>
        </div>`).join('')
    : '<p class="pool-empty">还没有兜底提问。AI 生成不出来时，前台会退回内置的几句通用提问。</p>';
}

async function refreshPool(payload) {
  try {
    renderPool(payload || await api('/greetings'));
  } catch (err) {
    toast(err.message);
  }
}

/** 快捷提问整组保存 */
async function saveChips(chips, msg) {
  try {
    renderPool(await api('/greetings/chips', { method: 'PUT', body: libBody({ chips }) }));
    if (msg) toast(msg);
    return true; // 调用方靠它判断要不要清空输入框
  } catch (err) {
    toast(err.message);
    refreshPool();
    return false;
  }
}

// 运行时刻下拉：0-23 点
for (let h = 0; h < 24; h++) {
  const o = document.createElement('option');
  o.value = String(h);
  o.textContent = `${String(h).padStart(2, '0')}:00`;
  el.learnHour.appendChild(o);
}

// ---------------------------------------------------------------- 库：切换 / 新建 / 改名 / 删除

/** 把某个库设为「前台在用的库」——服务端会顺带把开场白方式切成「AI 学习库」 */
async function activateLibrary(id) {
  const r = await api(`/greetings/libraries/${encodeURIComponent(id)}/activate`, { method: 'POST' });
  renderPool(r);
  if (r.modeSwitched) {
    // 服务端顺手改了开场白方式，把表单同步过来，免得界面显示的还是旧值
    fillAiForm((await api('/settings')).settings);
  }
  return r;
}

el.libSelect.addEventListener('change', async () => {
  try {
    const r = await activateLibrary(el.libSelect.value);
    toast(r.modeSwitched
      ? `已切到「${activeLib?.name || ''}」，前台改用这个库的欢迎语`
      : `已切到「${activeLib?.name || ''}」`);
  } catch (err) {
    toast(err.message);
    refreshPool();
  }
});

// 「让前台用它」：方式不是「AI 学习库」时，一键把前台切到当前这个库
el.libServe.addEventListener('click', async (e) => {
  if (!e.target.closest('#libUseBtn') || !activeLib) return;
  try {
    const r = await activateLibrary(activeLib.id);
    toast(r.modeSwitched
      ? `前台已改用「${activeLib.name}」的欢迎语`
      : `前台已经在用「${activeLib.name}」`);
  } catch (err) {
    toast(err.message);
  }
});

function openLibForm(mode) {
  libFormMode = mode;
  el.libForm.classList.remove('hidden');
  el.libNameInput.value = mode === 'edit' ? (activeLib?.name || '') : '';
  el.libNoteInput.value = mode === 'edit' ? (activeLib?.note || '') : '';
  el.libNameInput.focus();
  el.libNameInput.select();
}

el.libNewBtn.addEventListener('click', () => openLibForm('new'));
el.libEditBtn.addEventListener('click', () => {
  if (!activeLib) return toast('还没有可编辑的库');
  openLibForm('edit');
});

el.libFormCancel.addEventListener('click', () => {
  el.libForm.classList.add('hidden');
  el.libNameInput.value = '';
  el.libNoteInput.value = '';
});

async function saveLibForm() {
  const name = el.libNameInput.value.trim();
  if (!name) return toast('请填写库名称');
  const note = el.libNoteInput.value.trim();
  try {
    const r = libFormMode === 'new'
      ? await api('/greetings/libraries', { method: 'POST', body: { name, note } })
      : await api(`/greetings/libraries/${encodeURIComponent(activeLib.id)}`, {
        method: 'PATCH', body: { name, note },
      });
    el.libFormCancel.click();
    renderPool(r);
    toast(libFormMode === 'new' ? `已新建「${name}」并设为当前库` : '已保存');
  } catch (err) {
    toast(err.message);
  }
}

el.libFormSave.addEventListener('click', saveLibForm);
for (const input of [el.libNameInput, el.libNoteInput]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveLibForm(); }
    if (e.key === 'Escape') el.libFormCancel.click();
  });
}

el.libDelBtn.addEventListener('click', async () => {
  if (!activeLib) return;
  const n = activeLib.greetings.length;
  if (!confirm(`确定删除库「${activeLib.name}」？里面的 ${n} 条欢迎语和 ${activeLib.chips.length} 条提问都会一起删掉，不能恢复。`)) return;
  try {
    renderPool(await api(`/greetings/libraries/${encodeURIComponent(activeLib.id)}`, { method: 'DELETE' }));
    toast('已删除');
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------- 欢迎语：学习 / 增 / 改 / 删 / 清空

el.learnNowBtn.addEventListener('click', async () => {
  if (!activeLib) return toast('还没有可学习的库');
  el.learnNowBtn.disabled = true;
  el.learnNowBtn.textContent = '学习中…';
  try {
    // 学习要真调 AI，可能连着跑几批，比一般接口慢得多，单独放宽超时
    const r = await api('/greetings/learn', { method: 'POST', body: { libraryId: activeLib.id }, timeoutMs: 180_000 });
    renderPool(r);
    toast(r.added ? `「${r.libraryName}」学会 ${r.added} 条新欢迎语` : (r.error || '没有学到新内容'));
  } catch (err) {
    toast(err.message);
  } finally {
    el.learnNowBtn.disabled = false;
    el.learnNowBtn.textContent = '立即学习';
  }
});

el.addGreetBtn.addEventListener('click', () => {
  el.poolAdd.classList.toggle('hidden');
  if (!el.poolAdd.classList.contains('hidden')) el.poolAddInput.focus();
});

el.poolAddCancel.addEventListener('click', () => {
  el.poolAdd.classList.add('hidden');
  el.poolAddInput.value = '';
});

async function addGreeting() {
  const text = el.poolAddInput.value.trim();
  if (!text) return;
  try {
    renderPool(await api('/greetings', { method: 'POST', body: libBody({ text }) }));
    el.poolAddInput.value = '';
    toast('已添加');
  } catch (err) {
    toast(err.message);
  }
}

el.poolAddSave.addEventListener('click', addGreeting);
el.poolAddInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addGreeting(); }
  if (e.key === 'Escape') el.poolAddCancel.click();
});

el.clearGreetBtn.addEventListener('click', async () => {
  const n = activeLib?.greetings.length || 0;
  if (!n) return toast('这个库本来就是空的');
  if (!confirm(`确定清空库「${activeLib.name}」？里面 ${n} 条欢迎语都会被删除。`)) return;
  try {
    renderPool(await api('/greetings/clear', { method: 'POST', body: { libraryId: activeLib.id } }));
    toast('已清空');
  } catch (err) {
    toast(err.message);
  }
});

/** 点文字就地改，点 ✕ 删 —— 欢迎语列表和提问列表共用 */
function bindInlineEdit(container, onCommit) {
  container.addEventListener('click', async (e) => {
    const item = e.target.closest('.pool-item');
    if (!item) return;

    if (e.target.closest('.pool-del')) return onCommit(item, null);

    const span = e.target.closest('.pool-text');
    if (!span) return;

    const input = document.createElement('input');
    input.className = 'pool-edit';
    input.maxLength = 60;
    input.value = span.textContent;
    span.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      if (!save || input.value.trim() === span.textContent) return refreshPool();
      onCommit(item, input.value.trim());
    };
    input.addEventListener('blur', () => commit(true));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') { done = true; refreshPool(); }
    });
  });
}

bindInlineEdit(el.poolList, async (item, text) => {
  try {
    if (text === null) {
      renderPool(await api(`/greetings/${item.dataset.id}`, {
        method: 'DELETE', body: { libraryId: activeLib?.id },
      }));
    } else {
      renderPool(await api(`/greetings/${item.dataset.id}`, {
        method: 'PATCH', body: libBody({ text }),
      }));
      toast('已修改');
    }
  } catch (err) {
    toast(err.message);
    refreshPool();
  }
});

bindInlineEdit(el.chipList, async (item, text) => {
  const chips = [...(activeLib?.chips || [])];
  const idx = Number(item.dataset.idx);
  if (text === null) chips.splice(idx, 1);
  else chips[idx] = text;
  await saveChips(chips, text === null ? '已删除' : '已修改');
});

// ---------------------------------------------------------------- 兜底快捷提问：添加

el.chipAddBtn.addEventListener('click', () => {
  el.chipAdd.classList.toggle('hidden');
  if (!el.chipAdd.classList.contains('hidden')) el.chipAddInput.focus();
});

el.chipAddCancel.addEventListener('click', () => {
  el.chipAdd.classList.add('hidden');
  el.chipAddInput.value = '';
});

async function addChip() {
  const text = el.chipAddInput.value.trim();
  if (!text) return;
  if ((activeLib?.chips.length || 0) >= 12) return toast('一个库最多 12 条兜底提问');
  // 保存成功后才清空输入框：失败时刚打的字还在，用户可以直接重试
  // （旁边的 addGreeting 就是这么做的，两边保持一致）
  if (await saveChips([...(activeLib?.chips || []), text], '已添加')) {
    el.chipAddInput.value = '';
  }
}

el.chipAddSave.addEventListener('click', addChip);
el.chipAddInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addChip(); }
  if (e.key === 'Escape') el.chipAddCancel.click();
});

// ================================================================ 秘钥管理

el.modeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-item');
  if (!btn) return;
  mode = btn.dataset.mode;
  el.modeSeg.querySelectorAll('.seg-item').forEach((b) => b.classList.toggle('active', b === btn));
  el.generatePane.classList.toggle('hidden', mode !== 'generate');
  el.customPane.classList.toggle('hidden', mode !== 'custom');
  syncSegThumbs();
});

el.expiryType.addEventListener('change', () => {
  const v = el.expiryType.value;
  el.durationFields.classList.toggle('hidden', v !== 'duration');
  el.datetimeFields.classList.toggle('hidden', v !== 'datetime');
  // 一次性：次数恒为 1，那个输入框就收起来，免得和「不限」之类的填法打架
  el.onetimeFields.classList.toggle('hidden', v !== 'onetime');
  el.maxUsesField.classList.toggle('hidden', v === 'onetime');
});

function buildKeyPayload() {
  // 一次性 = 只能登录一次，直接落成 maxUses 1（服务端本来就支持），并且不带任何到期时间
  const oneTime = el.expiryType.value === 'onetime';
  const payload = {
    mode,
    note: mode === 'custom' ? el.customNote.value : el.genNote.value,
    maxUses: oneTime ? 1 : el.maxUses.value ? Number(el.maxUses.value) : null,
  };

  if (mode === 'custom') {
    payload.code = el.customCode.value;
  } else {
    payload.count = Number(el.genCount.value) || 1;
    payload.charset = el.genCharset.value;
  }

  if (el.expiryType.value === 'duration') {
    payload.durationValue = Number(el.durationValue.value) || 0;
    payload.durationUnit = el.durationUnit.value;
  } else if (el.expiryType.value === 'datetime') {
    if (!el.expiresAt.value) throw new Error('请选择到期时间');
    payload.expiresAt = new Date(el.expiresAt.value).toISOString();
  }
  return payload;
}

el.createBtn.addEventListener('click', async () => {
  el.createBtn.disabled = true;
  try {
    const payload = buildKeyPayload();
    const r = await api('/keys', { method: 'POST', body: payload });
    hint(el.createHint, `已生成 ${r.created.length} 个 ✓`, 'ok');
    showResult(r.created, payload);
    await loadKeys();
  } catch (err) {
    hint(el.createHint, err.message, 'err');
    toast(err.message);
  } finally {
    el.createBtn.disabled = false;
  }
});

function showResult(codes, payload) {
  el.resultTitle.textContent = `成功生成 ${codes.length} 个秘钥`;
  const oneTime = payload.maxUses === 1 && !payload.expiresAt && !payload.durationValue;
  const expiry = payload.expiresAt
    ? `有效期至 ${fmtTime(payload.expiresAt)}`
    : payload.durationValue
      ? `有效期 ${payload.durationValue} ${ { day: '天', hour: '小时', minute: '分钟' }[payload.durationUnit] || '' }`
      : '长期有效';
  el.resultSub.textContent = oneTime
    ? '一次性 · 登录过一次即作废'
    : expiry + (payload.maxUses ? ` · 每个可登录 ${payload.maxUses} 次` : ' · 登录次数不限');
  // 一批秘钥逐个弹入，而不是「啪」地整块出现
  el.resultCodes.innerHTML = codes
    .map((c, i) => `<code style="--i:${i}">${esc(c)}</code>`).join('');
  el.copyResult.dataset.codes = codes.join('\n');
  openResultModal();
}

/** 关弹窗也要有退场：先播一段反向动画，动画走完再真的藏起来 */
let closeModalTimer = 0;
function closeResultModal() {
  if (el.resultModal.classList.contains('hidden')) return;
  el.resultModal.classList.add('closing');
  closeModalTimer = setTimeout(() => {
    closeModalTimer = 0;
    el.resultModal.classList.remove('closing');
    el.resultModal.classList.add('hidden');
  }, reduceMotion() ? 0 : 190);
}

/** 重新打开前必须撤掉未走完的退场定时器：否则「关闭→立刻再生成」时，
 *  旧的定时器会在 190ms 后把刚弹出来的新结果又藏回去（本地服务响应足够快）。 */
function openResultModal() {
  if (closeModalTimer) { clearTimeout(closeModalTimer); closeModalTimer = 0; }
  el.resultModal.classList.remove('closing', 'hidden');
}

el.closeModal.addEventListener('click', closeResultModal);
el.resultModal.addEventListener('click', (e) => {
  if (e.target === el.resultModal) closeResultModal();
});

el.copyResult.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el.copyResult.dataset.codes || '');
    el.copyResult.textContent = '已复制';
  } catch {
    el.copyResult.textContent = '复制失败';
  }
  setTimeout(() => { el.copyResult.textContent = '复制全部'; }, 1600);
});

async function loadKeys() {
  try {
    const r = await api('/keys');
    allKeys = r.keys;
    renderKeys();
  } catch (err) {
    toast(err.message);
  }
}

function renderKeys() {
  el.keysEmpty.classList.toggle('hidden', allKeys.length > 0);

  // 只有这次新出现的行才播入场（启停只是改了内容，id 没变，不会重播）
  const fresh = freshIds(paintedKeyIds, allKeys.map((k) => k.id));
  let enterIndex = 0;
  const order = new Map();
  for (const k of allKeys) if (fresh.has(k.id)) order.set(k.id, enterIndex++);

  el.keysBody.innerHTML = allKeys.map((k) => {
    // 没有到期时间、又只能登录一次 → 就是一次性秘钥
    const oneTime = k.maxUses === 1 && !k.expiresAt;
    const expiry = k.expiresAt
      ? `<span title="${esc(fmtTime(k.expiresAt))}">${esc(fmtTime(k.expiresAt))}</span><br><span class="muted">${esc(fromNow(k.expiresAt))}</span>`
      : oneTime
        ? '<span class="muted">一次性</span>'
        : '<span class="muted">长期有效</span>';
    const uses = k.maxUses
      ? `${k.usedCount || 0} / ${k.maxUses}`
      : `${k.usedCount || 0} 次`;

    // 刚被启停的那一行，让状态徽章脉冲一下，好知道改的是哪条
    const cls = [fresh.has(k.id) ? 'row-enter' : '', k.id === changedKeyId ? 'just-changed' : '']
      .filter(Boolean).join(' ');
    return `<tr class="${cls}" style="--i:${order.get(k.id) ?? 0}" data-id="${esc(k.id)}">
      <td class="col-check"><input type="checkbox" class="row-check" /></td>
      <td><span class="code-chip ${k.status === 'active' ? '' : 'dim'}" data-code="${esc(k.code)}" title="点击复制">${esc(k.code)}</span></td>
      <td><span class="badge ${esc(k.status)}">${esc(k.status === 'exhausted' && k.maxUses === 1 ? '已使用' : STATUS_TEXT[k.status] || k.status)}</span></td>
      <td>${expiry}</td>
      <td>${esc(uses)}</td>
      <td class="muted">${esc(k.note || '—')}</td>
      <td class="muted">${k.lastUsedAt ? esc(fmtTime(k.lastUsedAt)) : '—'}</td>
      <td class="col-actions">
        <div class="row-btns">
          <button class="icon-btn" data-act="toggle" title="${k.enabled ? '停用' : '启用'}">
            ${k.enabled
              ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>'
              : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'}
          </button>
          <button class="icon-btn" data-act="extend" title="修改有效期">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          </button>
          <button class="icon-btn" data-act="delete" title="删除">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');

  el.checkAll.checked = false;
  updateBulkButton();
  changedKeyId = null; // 脉冲只放一次，下次重绘就恢复正常
}

el.keysBody.addEventListener('click', async (e) => {
  const chip = e.target.closest('.code-chip');
  if (chip) {
    try {
      await navigator.clipboard.writeText(chip.dataset.code);
      const old = chip.textContent;
      chip.textContent = '已复制';
      chip.classList.add('copied');
      setTimeout(() => { chip.textContent = old; chip.classList.remove('copied'); }, 1000);
    } catch { toast('复制失败，请手动选择'); }
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const id = tr.dataset.id;
  const key = allKeys.find((k) => k.id === id);
  if (!key) return;

  const act = btn.dataset.act;
  try {
    if (act === 'toggle') {
      await api(`/keys/${id}`, { method: 'PATCH', body: { enabled: !key.enabled } });
      changedKeyId = id; // 让 renderKeys 给这一行的状态徽章补一个脉冲
      toast(key.enabled ? '已停用' : '已启用');
    } else if (act === 'delete') {
      if (!confirm(`确定删除秘钥 ${key.code} 吗？删除后使用该秘钥的人将无法继续对话。`)) return;
      await api(`/keys/${id}`, { method: 'DELETE' });
      toast('已删除');
    } else if (act === 'extend') {
      const input = prompt(`设置 ${key.code} 的到期时间\n格式：YYYY-MM-DD HH:MM\n留空 = 长期有效`, key.expiresAt ? fmtTime(key.expiresAt) : '');
      if (input === null) return;
      const value = input.trim();
      let expiresAt = null;
      if (value) {
        const d = new Date(value.replace(/-/g, '/'));
        if (Number.isNaN(d.getTime())) { toast('时间格式不正确'); return; }
        expiresAt = d.toISOString();
      }
      await api(`/keys/${id}`, { method: 'PATCH', body: { expiresAt } });
      toast('有效期已更新');
    }
    await loadKeys();
  } catch (err) {
    toast(err.message);
  }
});

el.checkAll.addEventListener('change', () => {
  el.keysBody.querySelectorAll('.row-check').forEach((c) => { c.checked = el.checkAll.checked; });
  updateBulkButton();
});

el.keysBody.addEventListener('change', (e) => {
  if (e.target.classList.contains('row-check')) updateBulkButton();
});

function selectedIds() {
  return [...el.keysBody.querySelectorAll('tr')]
    .filter((tr) => tr.querySelector('.row-check')?.checked)
    .map((tr) => tr.dataset.id);
}

function updateBulkButton() {
  const n = selectedIds().length;
  el.bulkDeleteBtn.disabled = n === 0;
  el.bulkDeleteBtn.textContent = n ? `删除选中 (${n})` : '删除选中';
}

el.bulkDeleteBtn.addEventListener('click', async () => {
  const ids = selectedIds();
  if (!ids.length) return;
  if (!confirm(`确定删除选中的 ${ids.length} 个秘钥吗？`)) return;
  try {
    await api('/keys/bulk-delete', { method: 'POST', body: { ids } });
    toast(`已删除 ${ids.length} 个秘钥`);
    await loadKeys();
  } catch (err) {
    toast(err.message);
  }
});

el.copyAllBtn.addEventListener('click', async () => {
  const codes = allKeys.filter((k) => k.status === 'active').map((k) => k.code);
  if (!codes.length) { toast('当前没有有效秘钥'); return; }
  try {
    await navigator.clipboard.writeText(codes.join('\n'));
    toast(`已复制 ${codes.length} 个有效秘钥`);
  } catch {
    toast('复制失败，请手动选择');
  }
});

// ================================================================ 入口与安全

/** 后台免密时，「修改密码」里的「当前密码」就没有意义了，随手藏掉 */
function syncPasswordArea(settings) {
  el.currentPwField.classList.toggle('hidden', !settings.adminRequirePassword);
}

function fillSecurityForm(settings) {
  const f = el.securityForm;
  f.elements.requireKey.checked = Boolean(settings.requireKey);
  f.elements.frontLocalOnly.checked = Boolean(settings.frontLocalOnly);
  f.elements.adminRequirePassword.checked = Boolean(settings.adminRequirePassword);
  f.elements.adminLocalOnly.checked = Boolean(settings.adminLocalOnly);
  f.elements.adminPath.value = settings.adminPath || 'admin';
  paintAdminPath(settings.adminPath);
  syncSecurityVisibility();
}

/** 「当前地址」那一行的链接：改完网址后点它就能开新地址，不用自己拼 */
function paintAdminPath(name) {
  const p = '/' + (name || 'admin');
  el.adminPathNow.textContent = p;
  el.adminPathNow.href = p;
}

function syncSecurityVisibility() {
  const f = el.securityForm;
  const requireKey = f.elements.requireKey.checked;
  const adminPw = f.elements.adminRequirePassword.checked;
  el.frontLocalRow.classList.toggle('hidden', requireKey);
  el.adminLocalRow.classList.toggle('hidden', adminPw);
  el.frontWarn.classList.toggle('hidden', requireKey);
  el.adminWarn.classList.toggle('hidden', adminPw);
  // 同一屏上的「修改密码」区也跟着变：后台免密时「当前密码」没有意义
  syncPasswordArea({ adminRequirePassword: adminPw });
}

el.securityForm.addEventListener('change', syncSecurityVisibility);

el.securityForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = el.securityForm;
  const payload = {
    requireKey: f.elements.requireKey.checked,
    frontLocalOnly: f.elements.frontLocalOnly.checked,
    adminRequirePassword: f.elements.adminRequirePassword.checked,
    adminLocalOnly: f.elements.adminLocalOnly.checked,
    adminPath: f.elements.adminPath.value,
  };
  // 这个保存按钮在 HTML 里没有 id，现场取一下；反馈和 AI 表单保持一致
  const btn = f.querySelector('button[type="submit"]');
  withSaveState(btn, async () => {
    const saved = await api('/settings', { method: 'PUT', body: payload });
    const next = String(saved?.settings?.adminPath || payload.adminPath || 'admin');
    // 网址变了的话，服务端从这一刻起就只认新地址了 —— 这一页后面的请求必须跟着换，
    // 否则下一次保存会打到老地址上（对外已经是 404）。页面上那个链接也一并指到新的。
    apiBase = '/' + next + '/api';
    paintAdminPath(next);
    if (next !== currentAdminPath) {
      currentAdminPath = next;
      hint(el.securitySaveHint, `已保存 ✓ 后台网址改成了 /${next}`, 'ok');
      toast(`后台网址已改为 /${next}，下次请从新地址进入`);
    } else {
      hint(el.securitySaveHint, '已保存 ✓', 'ok');
      toast('入口设置已保存');
    }
    previewLoaded = false; // 秘钥开关会影响前台，预览需要重载
  }).catch((err) => {
    hint(el.securitySaveHint, err.message, 'err');
    toast(err.message);
  });
});

el.passwordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (el.newPw.value.length < 6) { hint(el.pwHint, '新密码至少 6 位', 'err'); return; }
  if (el.newPw.value !== el.confirmPw.value) { hint(el.pwHint, '两次输入的新密码不一致', 'err'); return; }

  try {
    await api('/password', { method: 'POST', body: { current: el.currentPw.value, next: el.newPw.value } });
    el.currentPw.value = el.newPw.value = el.confirmPw.value = '';
    toast('密码已修改，请重新登录');
    setTimeout(() => showLogin('密码已修改，请用新密码登录。'), 900);
  } catch (err) {
    hint(el.pwHint, err.message, 'err');
  }
});

// ================================================================ 多端预览

const DEVICES = {
  375:  { w: 375,  h: 812,  cls: 'phone',   bezel: 10 },
  414:  { w: 414,  h: 896,  cls: 'phone',   bezel: 10 },
  768:  { w: 768,  h: 1024, cls: 'tablet',  bezel: 10 },
  1024: { w: 1024, h: 768,  cls: 'desktop', bezel: 6 },
  full: { w: null, h: null, cls: 'desktop', bezel: 6 },
};

let currentDevice = '375';
let landscape = false;
let previewLoaded = false;

// 舞台里真正能用的空间（不再用「窗口高度减一个猜出来的数」）
function availW() {
  const w = el.previewStage.clientWidth;
  return w ? Math.max(300, w - 8) : 320;
}
function availH() {
  const main = document.querySelector('.admin-main');
  const bottom = main ? main.getBoundingClientRect().bottom : window.innerHeight;
  const top = el.previewStage.getBoundingClientRect().top;
  const h = bottom - top - 26;
  // 舞台滚出视野时 rect 会失真，退回按窗口估算
  if (!Number.isFinite(h) || h < 220) return Math.max(360, window.innerHeight - 320);
  return Math.max(300, Math.min(h, window.innerHeight - 80));
}

function applyDevice() {
  const d = DEVICES[currentDevice] || DEVICES[375];
  const B = d.bezel;
  const rotate = landscape && d.w !== null;

  // 屏幕可视区（= iframe 视口），始终是设备真实尺寸
  let screenW, screenH;
  if (d.w === null) {
    screenW = Math.round(availW() - B * 2);
    screenH = Math.round(availH() - B * 2);
  } else {
    screenW = rotate ? d.h : d.w;
    screenH = rotate ? d.w : d.h;
  }

  const frameW = screenW + B * 2;
  const frameH = screenH + B * 2;

  // 整机等比缩小到能完整看见：视口尺寸保持真实，只是视觉上变小
  const k = d.w === null
    ? 1
    : Math.min(1, availH() / frameH, availW() / frameW);

  el.deviceFrame.className = 'device-frame ' + d.cls + (rotate ? ' landscape' : '');
  el.deviceFrame.style.width = screenW + 'px';
  el.deviceFrame.style.height = screenH + 'px';
  el.deviceFrame.style.transform = `scale(${k})`;

  // 缩放容器负责占位，这样居中和滚动条都正确
  el.deviceScaler.style.width = Math.round(frameW * k) + 'px';
  el.deviceScaler.style.height = Math.round(frameH * k) + 'px';

  el.previewSize.textContent =
    `${screenW} × ${screenH}` + (k < 0.995 ? ` · ${Math.round(k * 100)}%` : '');
}

function loadPreview(force = false) {
  if (previewLoaded && !force) return;
  previewLoaded = true;
  el.previewFrame.src = force ? `/?t=${Date.now()}` : '/';
}

/** 换设备/转屏时让外框弹一下。挪到下一帧再加，否则和尺寸过渡挤在同一帧里看不出来。
    只在用户主动切换时调 —— applyDevice() 在窗口 resize 时也会跑，那时候弹就太吵了 */
function bumpDeviceFrame() {
  el.deviceFrame.classList.remove('bump');
  requestAnimationFrame(() => el.deviceFrame.classList.add('bump'));
}

el.deviceSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-item');
  if (!btn) return;
  currentDevice = btn.dataset.device;
  landscape = false;
  el.deviceSeg.querySelectorAll('.seg-item').forEach((b) => b.classList.toggle('active', b === btn));
  applyDevice();
  bumpDeviceFrame();
});

el.previewRotate.addEventListener('click', () => {
  if (currentDevice === 'full') { toast('「桌面 自适应」模式下不支持横竖屏切换'); return; }
  landscape = !landscape;
  applyDevice();
  bumpDeviceFrame();
});

el.previewReload.addEventListener('click', () => {
  loadPreview(true);
  toast('已刷新预览');
});

let previewResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(previewResizeTimer);
  previewResizeTimer = setTimeout(() => {
    const pane = document.querySelector('section.tab[data-tab="preview"]');
    if (pane && !pane.classList.contains('hidden')) applyDevice();
  }, 140);
});

// ================================================================ 启动

async function refreshAll() {
  try {
    const { settings } = await api('/settings');
    fillAiForm(settings);
    fillSecurityForm(settings);
    syncPasswordArea(settings);
    await Promise.all([loadStats(), loadKeys(), refreshPool()]);
    // 面板已经从 hidden 切出来、布局也稳了，这时候才量得到真实位置
    moveNavThumb();
    syncSegThumbs();
  } catch (err) {
    toast(err.message);
  }
}

async function boot() {
  try {
    const res = await fetch(apiBase + '/me');
    const me = await res.json();

    if (me.localOnlyBlocked) {
      el.boot.classList.add('hidden');
      el.login.classList.remove('hidden');
      el.loginForm.classList.add('hidden');
      el.loginError.textContent = '后台已关闭密码验证，且设置为仅本机可访问。';
      document.querySelector('.login-card .gate-sub').textContent = '无法访问';
      return;
    }
    if (!me.requirePassword) {
      showPanel();
      await refreshAll();
      return;
    }
    if (me.authed) {
      showPanel();
      await refreshAll();
      return;
    }
    showLogin();
  } catch {
    showLogin('无法连接服务器。');
  }
}

// #deviceSeg 故意不绑：它在窄屏是能横向滚动的容器（.preview-bar .seg），
// 量出来的位置会失真。那边只保留按压缩放的反馈
bindSegThumb(el.modeSeg);
bindSegThumb(el.iconModeSeg);

boot();
