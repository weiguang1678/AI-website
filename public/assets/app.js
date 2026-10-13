import { renderMarkdown } from './markdown.js';

const KEY_LEN = 5;
const STORE_KEY = 'ai_website_chat_v1';

const $ = (id) => document.getElementById(id);
const el = {
  boot: $('boot'), gate: $('gate'), app: $('app'),
  gateAvatar: $('gateAvatar'), gateTitle: $('gateTitle'), gateForm: $('gateForm'),
  codeInput: $('codeInput'), gateError: $('gateError'), gateSubmit: $('gateSubmit'),
  sideAvatar: $('sideAvatar'), sideName: $('sideName'), chatTitle: $('chatTitle'),
  history: $('history'), newChat: $('newChat'), logoutBtn: $('logoutBtn'),
  messages: $('messages'), composer: $('composer'), input: $('input'), sendBtn: $('sendBtn'),
  stopBtn: $('stopBtn'),
  clearBtn: $('clearBtn'), menuBtn: $('menuBtn'), sidebar: $('sidebar'), toast: $('toast'),
  previewBadge: $('previewBadge'), bootBadge: $('bootBadge'), backdrop: $('backdrop'),
};

const state = {
  aiName: 'AI 助手',
  welcome: '',
  conversations: [],
  activeId: null,
  streaming: false,
  controller: null,
  renderScheduled: false,
  greetingConvId: null, // 正在等待开场白的对话 id
  chips: [],            // 当前展示的快捷提问（AI 按欢迎语生成的那组）
  chipsConvId: null,    // 上面那组属于哪个对话 —— 切走之后就该重新用库里的
  libChips: [],         // 库里预设的快捷提问：进站第一帧就靠它，AI 生成好了再替换
  chipsToken: 0,        // 每开一个新对话 +1，用来丢弃过期的生成结果
  // 图标现在只有一张：/api/icon 那张 PNG。下面三个只是从 /api/session 收下备用
  // ——iconMode 决定后台表单用哪种方式编辑它，iconText 决定默认图标上画什么字，
  // 真正画出来的是后台在服务端保存时生成的那张图，前台只管显示。
  iconMode: 'default',
  iconText: '',
  iconVersion: 0,       // 换图标时服务端 +1，用来拼出不会命中旧缓存的图片地址

  // 访客令牌。**只活在这个变量里** —— 不写 localStorage、不写 sessionStorage、
  // 也不从 Cookie 来（服务端连 Set-Cookie 都不发了，见 routes/access.js 的 userToken）。
  // 刷新页面 = 一次全新的加载 = 这个变量重新变回空串 = 重新输秘钥；关掉浏览器同理。
  // 以前是服务端下发 12 小时的 Cookie，浏览器替我们一直留着，刷新和重开都还在，
  // 等于把秘钥记住了 —— 那正是不想要的。
  token: '',

  // 动画记账。消息列表和历史列表都是整块 innerHTML 重绘的，如果只按 CSS 挂动画，
  // 每重绘一次就重播一次（refreshChips、maybeGreet 收尾都会触发）。
  // 记下「见过的对象」，只有第一次见到才让入场动画上场。
  // 用 WeakSet 不用 Set：删掉的对话会被自动回收，不会一直被攥着。
  paintedMessages: new WeakSet(),
  paintedConvs: new WeakSet(),
};

// ================================================================ 工具

/**
 * 带访客令牌的 fetch。所有需要秘钥的接口都走它。
 *
 * 令牌走请求头不走 Cookie，有两个好处：一是它天然「不跨页面」——页面一刷新
 * 这个变量就没了，正是我们要的；二是跨站请求伪造带不上自定义头，
 * 比靠 Cookie 的 SameSite 更硬。
 * 没令牌时不加这个头，让服务端按「没登录」处理（启动时那次 /api/session 就是这样）。
 */
function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) headers['X-Access-Token'] = state.token;
  return fetch(url, { ...opts, headers });
}

function toast(message, ms = 2600) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('show'), ms);
}

/** 用户是否要求「减少动态效果」——JS 驱动的动画得自己问一句，CSS 那边由媒体查询兜底 */
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function showView(name) {
  el.boot.classList.add('hidden');
  el.gate.classList.toggle('hidden', name !== 'gate');
  el.app.classList.toggle('hidden', name !== 'app');

  if (name === 'app') {
    // 重新挂一次让淡入重播。注意 .app-enter 只动 opacity 不动 transform ——
    // #app 一旦有 transform 就会成为 fixed 后代的包含块，移动端那个 fixed 侧边栏会被带偏
    el.app.classList.remove('app-enter');
    void el.app.offsetWidth;
    el.app.classList.add('app-enter');
  }
}

/**
 * 把一个品牌徽标画进给定的元素。
 *
 * 所有徽标都直接显示 /api/icon 那一张 PNG —— 和浏览器标签页、苹果桌面图标、
 * 后台自己的徽标、微信/QQ 分享卡片是**同一张图**。
 * 以前默认图标是前台用 CSS 重新排一遍文字、后台出图，两边字号公式和字体栈各写一份，
 * 结果就是「前台头像和标签页图标不一样」：字体栈不同必然差一点，
 * 而后台的图只在点「保存」时才重新生成，公式一改就彻底对不上。
 * 现在只有一个来源，改字号系数、换字体、改圆角都只影响生成那张图的那一处。
 *
 * 后台没配过图标时 /api/icon 会发 public/assets/icon-default.png，
 * 所以这个地址不会 404，img 不会空。
 */
function renderBadge(node) {
  if (!node) return;
  // 装了图就得撤掉底色 —— 自定义图标可能是内部透明的 logo（见 style.css 的 .has-icon）
  node.classList.add('has-icon');
  const img = document.createElement('img');
  img.src = `/api/icon?v=${state.iconVersion}`;
  img.alt = '';
  node.replaceChildren(img);
}

/**
 * 把服务端下发的站点信息（名字、欢迎语、图标、库内预设提问）装进 state。
 * /api/session 和 /api/access 返回的是同一套字段，所以两边都走这里。
 */
function applySession(data) {
  state.iconMode = data.iconMode === 'custom' ? 'custom' : 'default';
  state.iconText = String(data.iconText || '');
  state.iconVersion = Number(data.iconVersion) || 0;
  if (Array.isArray(data.chips) && data.chips.length) state.libChips = data.chips;

  state.welcome = data.welcome || '';
  applyBranding(data.aiName);
}

function applyBranding(name) {
  state.aiName = name || 'AI 助手';
  renderBadge(el.gateAvatar);
  renderBadge(el.sideAvatar);
  renderBadge(el.bootBadge);
  el.gateTitle.textContent = state.aiName;
  el.sideName.textContent = state.aiName;
  el.chatTitle.textContent = state.aiName;
  document.title = state.aiName;
}

// ================================================================ 本地存储

function loadConversations() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const list = Array.isArray(raw.conversations) ? raw.conversations : [];
    // 光 parse 成功还不够：里面可能是旧版本写的、或者被别的脚本塞进去的畸形数据，
    // 混进一条 null，下面 state.conversations[0].id 就会抛错，整个页面直接起不来。
    // 这里逐条体检，只留结构说得通的。
    state.conversations = list
      .filter((c) => c && typeof c === 'object' && typeof c.id === 'string')
      .map((c) => ({
        ...c,
        messages: Array.isArray(c.messages)
          ? c.messages
            .filter((m) => m && typeof m === 'object' && typeof m.content === 'string')
            .map((m) => ({ ...m, role: m.role === 'user' ? 'user' : 'assistant' }))
          : [],
      }));
    state.activeId = typeof raw.activeId === 'string' ? raw.activeId : null;
  } catch {
    state.conversations = [];
    state.activeId = null;
  }
  if (!state.conversations.length) createConversation({ activate: true, silent: true });
  if (!activeConversation()) state.activeId = state.conversations[0].id;
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      conversations: state.conversations.slice(0, 60),
      activeId: state.activeId,
    }));
  } catch { /* 配额满了就放弃保存 */ }
}

function activeConversation() {
  return state.conversations.find((c) => c.id === state.activeId) || null;
}

function createConversation({ activate = true, silent = false } = {}) {
  const conv = {
    id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: '新对话',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.conversations.unshift(conv);
  if (activate) state.activeId = conv.id;
  if (!silent) {
    persist();
    renderConversation();
    renderHistory();
    el.input.focus();
    maybeGreet();
  }
  return conv;
}

// ================================================================ 侧边栏

function renderHistory() {
  const list = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  el.history.innerHTML = '';

  if (!list.length) {
    el.history.innerHTML = '<div class="hist-empty">还没有对话</div>';
    return;
  }
  const label = document.createElement('div');
  label.className = 'hist-label';
  label.textContent = '最近对话';
  el.history.appendChild(label);

  let enterIndex = 0;
  for (const conv of list) {
    const item = document.createElement('button');
    item.className = 'hist-item' + (conv.id === state.activeId ? ' active' : '');
    item.type = 'button';

    // 只有第一次见到的对话才播入场。错峰序号按「本次新增里的第几个」算，
    // 不是按它在整个列表里的名次 —— 否则新建的一条排在第 30 位，得等一秒才出现
    if (!state.paintedConvs.has(conv)) {
      state.paintedConvs.add(conv);
      item.classList.add('hist-enter');
      item.style.setProperty('--i', enterIndex++);
    }

    const text = document.createElement('span');
    text.textContent = conv.title || '新对话';
    item.appendChild(text);

    const del = document.createElement('span');
    del.className = 'del';
    del.title = '删除';
    del.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(conv.id);
    });
    item.appendChild(del);

    item.addEventListener('click', () => switchConversation(conv.id));
    el.history.appendChild(item);
  }
}

function switchConversation(id) {
  if (state.streaming) { toast('回复还在生成，可以先点停止'); return; }
  state.activeId = id;
  persist();
  renderConversation();
  renderHistory();
  closeSidebar();
  maybeGreet();
}

function deleteConversation(id) {
  if (state.streaming) { toast('回复还在生成，可以先点停止'); return; }
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.activeId === id) {
    if (!state.conversations.length) createConversation({ activate: true, silent: true });
    state.activeId = state.conversations[0].id;
  }
  persist();
  renderConversation();
  renderHistory();
}

// ================================================================ 消息渲染

function messageEl(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (msg.role === 'user' ? 'user' : 'ai');
  if (msg.error) wrap.classList.add('error');

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  if (msg.role === 'user') avatar.textContent = '我';
  else renderBadge(avatar);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  wrap.append(avatar, bubble);
  return { wrap, bubble };
}

/** 给气泡里的顶层内容块编号，交给 motion.css 的 .md-stagger 逐块铺开 */
function staggerBlocks(bubble) {
  // 只认正文那块（md-main）：带思维链的气泡里 .md 有两个，抓第一个就铺错了
  const holder = bubble.querySelector('.md-main') || bubble.querySelector('.md');
  if (!holder) return;
  const blocks = [...holder.children];
  if (blocks.length < 2) return; // 只有一段就别搞错峰了，看着像卡了一下
  holder.classList.add('md-stagger');
  blocks.forEach((node, i) => node.style.setProperty('--i', i));
}

function renderConversation() {
  const conv = activeConversation();
  el.messages.innerHTML = '';
  if (!conv) return;

  if (!conv.messages.length) {
    renderEmptyState({ loading: state.greetingConvId === conv.id });
    return;
  }
  let enterIndex = 0;
  for (const msg of conv.messages) {
    const { wrap, bubble } = messageEl(msg);
    // 思维链要一起重绘：send() 的 finally 已经把它存进了 msg.reasoning，
    // 但这里从前只画 content，于是刷新页面/切走再切回来，生成时看得到的那段就没了
    let inner = '';
    if (msg.reasoning) inner += '<div class="reasoning md">' + renderMarkdown(msg.reasoning) + '</div>';
    // md-main 是给 staggerBlocks 认的：同一条气泡里可能有「思维链 + 正文」两个 .md，
    // 不标出来它 querySelector(".md") 会抓到思维链，错峰就铺错地方了
    inner += msg.content
      ? '<div class="md md-main">' + renderMarkdown(msg.content) + '</div>'
      : '<div class="typing"><i></i><i></i><i></i></div>';
    bubble.innerHTML = inner;

    if (!state.paintedMessages.has(msg)) {
      state.paintedMessages.add(msg);
      wrap.classList.add('msg-enter');
      wrap.style.setProperty('--i', enterIndex++);
      // 内容块瀑布式铺开。只对已完成的 AI 消息做：
      // 用户消息通常就一两段，加了看不出层次反而多一层延迟；
      // 流式中的气泡内容每帧都在换，更不能动（paint() 不挂这个类）
      if (msg.role !== 'user' && msg.content) staggerBlocks(bubble);
    }
    el.messages.appendChild(wrap);
  }
  // 对话里只有 AI 的问候时，把推荐问题一并展示
  if (conv.messages.length === 1 && conv.messages[0].role === 'assistant' && conv.messages[0].content) {
    el.messages.appendChild(chipsBlock());
  }
  scrollToBottom(true);
}

/** 最后的兜底：服务端既没给库里的提问、也没生成出来时用 */
const FALLBACK_CHIPS = [
  '你能帮我做些什么？',
  '用三句话解释什么是量子纠缠',
  '帮我写一封请假邮件',
  '把这段话翻译成英文：今天的会议改到下午三点',
];

function chipsBlock() {
  // AI 生成的那组只属于它那个对话，切走之后就先别用了
  const own = state.chipsConvId === state.activeId ? state.chips : [];
  // 三级回退：AI 按欢迎语生成的那组 → 库里预设的那组（进站第一帧就是它）→ 内置兜底
  const list = own.length ? own
    : state.libChips.length ? state.libChips
      : FALLBACK_CHIPS;
  const box = document.createElement('div');
  box.className = 'chips enter'; // .enter 让 .chip 逐条浮入，每条错开 40ms
  list.forEach((s, i) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.textContent = s;
    chip.style.setProperty('--i', i);
    chip.addEventListener('click', () => {
      el.input.value = s;
      el.input.focus();
      autoResize();
    });
    box.appendChild(chip);
  });
  return box;
}

function renderEmptyState({ loading = false } = {}) {
  const box = document.createElement('div');
  box.className = 'empty';

  const badge = document.createElement('div');
  badge.className = 'brand-badge';
  renderBadge(badge);

  const h2 = document.createElement('h2');
  h2.textContent = state.aiName;

  box.append(badge, h2);

  if (loading) {
    // 欢迎语还在路上：先给打字点，但**快捷提问照样先摆出来** ——
    // 用户一进来就有东西可点，不用干等模型。
    const dots = document.createElement('div');
    dots.className = 'typing';
    dots.innerHTML = '<i></i><i></i><i></i>';
    box.append(dots, chipsBlock());
  } else {
    const p = document.createElement('p');
    p.textContent = state.welcome || '有什么可以帮你的吗？';
    box.append(p, chipsBlock());
  }
  el.messages.appendChild(box);
}

/**
 * 进入对话界面（或新建对话）时，让 AI 主动打招呼。
 * 服务端会记录用过的问候语，保证每次都不一样。
 */
async function maybeGreet() {
  const conv = activeConversation();
  if (!conv || conv.messages.length || conv.greeted || state.greetingConvId) return;

  conv.greeted = true;
  state.greetingConvId = conv.id;
  // 这里**不再清空** state.chips：清空会让按钮先消失再出现，白白跳一下。
  // 现在第一帧显示的是 state.libChips（随 /api/session 一起下发的库内预设），
  // 等下面拿到结果再整组换掉。
  state.chipsToken += 1; // 作废上一个对话还没回来的生成请求
  renderConversation();

  const settle = () => {
    state.greetingConvId = null;
    // 生成中绝对不能重绘：这块 innerHTML 一重建，send() 手里那个 bubble 引用
    // 就脱离了文档，之后每段流式文本都写进一个看不见的节点，聊天区永远停在
    // 「正在输入…」。那次重绘交给 send() 自己的 finally 去做。
    if (state.activeId === conv.id && !state.streaming) {
      renderConversation();
      autoResize();
    }
  };

  let greeting = '';
  let wantChips = false;

  try {
    const res = await apiFetch('/api/greeting', { method: 'POST' });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401) {
      state.greetingConvId = null;
      state.token = '';   // 服务端那边这份已经作废了，本地别再攥着
      toast(data.error || '登录状态已失效，请重新输入秘钥。');
      showView('gate');
      focusFirstCell();
      return;
    }
    greeting = String(data.greeting || '').trim() || state.welcome || '你好！';
    // 欢迎语要等接口，接口可能慢过用户打字 —— 这时就别再插进去了，
    // 否则它会冒在用户的消息底下，看着像 AI 答非所问。
    if (conv.messages.length === 0) {
      conv.messages.push({ role: 'assistant', content: greeting });
    }
    // 库里预设的那组立刻可用，随后再按这句欢迎语实时生成更贴合的替换掉
    if (Array.isArray(data.chips) && data.chips.length) {
      state.chips = data.chips;
      state.chipsConvId = conv.id;
    }
    wantChips = Boolean(data.chipsPending);
  } catch {
    // 请求本身失败时退回站点的欢迎语，避免界面空着
    if (conv.messages.length === 0) {
      conv.messages.push({ role: 'assistant', content: state.welcome || '你好！' });
    }
  } finally {
    conv.updatedAt = Date.now();
    persist();
    settle();
  }

  if (wantChips) refreshChips(conv.id, greeting);
}

/**
 * 按刚给出的欢迎语实时生成快捷提问，回来后就地替换掉预设的那组。
 * 只有在「还是那个对话、还停在开场白这一屏」时才替换，避免用户已经聊起来了才跳出来。
 */
async function refreshChips(convId, greeting) {
  const token = state.chipsToken;
  try {
    const res = await apiFetch('/api/chips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ greeting }),
    });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const list = Array.isArray(data.chips)
      ? data.chips.filter((c) => typeof c === 'string' && c.trim())
      : [];
    if (!list.length) return;

    if (token !== state.chipsToken) return; // 期间又开了新对话
    const conv = activeConversation();
    if (!conv || conv.id !== convId) return;  // 用户已经切走了
    if (conv.messages.length !== 1) return;   // 已经聊起来了，不再插入

    state.chips = list;
    state.chipsConvId = convId;
    renderConversation();
  } catch {
    // 生成失败就保持库里预设的那组，静默处理
  }
}

function scrollToBottom(force = false) {
  const box = el.messages;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

// ================================================================ 发送

function autoResize() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 190) + 'px';
  el.sendBtn.disabled = !el.input.value.trim() || state.streaming;
}

/**
 * 生成中把「发送」换成「停止」。
 * 两颗按钮在同一格位置互换，所以不是在输入框右边又长出一颗，
 * 窄屏也不会把 textarea 挤窄。
 */
function setStreaming(on) {
  state.streaming = on;
  el.sendBtn.classList.toggle('hidden', on);
  el.stopBtn.classList.toggle('hidden', !on);
  el.stopBtn.disabled = false; // 上一轮点过之后置的灰，这里得复位
  el.stopBtn.classList.remove('enter');
  if (on) {
    void el.stopBtn.offsetWidth; // 重挂一次，让弹出动画每轮都播
    el.stopBtn.classList.add('enter');
  }
  autoResize();
}

/** 停止生成：掐掉 fetch，剩下的收尾交给 send() 的 catch/finally */
function stopGeneration() {
  if (!state.streaming || !state.controller) return;
  el.stopBtn.disabled = true; // 防连点：abort 到 UI 复位之间有一小段空窗
  state.controller.abort();
}

async function send(text) {
  const content = text.trim();
  if (!content || state.streaming) return;

  const conv = activeConversation() || createConversation();
  // 判「用户还没说过话」而不是「消息为空」：AI 的开场白已经占了 messages[0]，
  // 用长度判断的话这个条件永远不成立，标题就一直停在「新对话」。
  if (!conv.messages.some((m) => m.role === 'user')) {
    conv.title = content.slice(0, 24) + (content.length > 24 ? '…' : '');
  }

  conv.messages.push({ role: 'user', content });
  conv.updatedAt = Date.now();

  const assistant = { role: 'assistant', content: '' };
  conv.messages.push(assistant);
  persist();
  renderHistory();
  renderConversation();

  el.input.value = '';
  autoResize();

  state.controller = new AbortController();
  el.sendBtn.setAttribute('aria-busy', 'true');
  // 「发送」淡出、「停止」带着一圈脉冲弹进来，这一下就是发出去的反馈
  setStreaming(true);

  const bubble = el.messages.querySelector('.msg:last-child .bubble');
  const streamingMsg = bubble ? bubble.closest('.msg') : null;
  // 生成中：气泡顶部一条扫光，头像轻轻呼吸（规则在 motion.css 的「八、消息」）
  const markStreaming = (on) => {
    bubble?.classList.toggle('streaming', on);
    streamingMsg?.classList.toggle('streaming', on);
  };
  markStreaming(true);

  let buffer = '';
  let reasoning = '';
  let authLost = false; // 401 时置位：finally 里要把这条空气泡删掉

  const paint = () => {
    state.renderScheduled = false;
    if (!bubble) return;
    let html = '';
    if (reasoning) html += '<div class="reasoning md">' + renderMarkdown(reasoning) + '</div>';
    html += '<div class="md">' + renderMarkdown(buffer) + '</div>';
    if (state.streaming) html += '<span class="cursor"></span>';
    bubble.innerHTML = html;
    scrollToBottom();
  };
  const schedulePaint = () => {
    if (state.renderScheduled) return;
    state.renderScheduled = true;
    requestAnimationFrame(paint);
  };

  try {
    const res = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: conv.messages.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content })) }),
      signal: state.controller.signal,
    });

    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || '登录已失效'), { needAuth: true });
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `请求失败（${res.status}）`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let raw = '';

    // 把 raw 里所有「以空行结尾」的完整事件消费掉
    const drain = () => {
      let idx;
      while ((idx = raw.indexOf('\n\n')) !== -1) {
        const chunk = raw.slice(0, idx);
        raw = raw.slice(idx + 2);

        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let json;
          try { json = JSON.parse(line.slice(5).trim()); } catch { continue; }

          if (json.error) throw new Error(json.error);
          if (json.delta) buffer += json.delta;
          if (json.reasoning) reasoning += json.reasoning;
          if (json.done) continue;
          schedulePaint();
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      drain();
    }
    // 收尾必须再吐一次：TextDecoder 会把末尾「半个多字节字符」扣在手里，
    // 不等一个不带 stream 的 decode() 就永远不还 —— 最后那个汉字会凭空消失。
    raw += decoder.decode();
    drain();
  } catch (err) {
    if (err.name === 'AbortError') {
      // 已经吐出来的那段照样留下 —— 半截回答比清空重来有用；
      // 但得挂个明显的收尾标记，否则刷新页面之后这半句看着像说完了
      buffer = buffer ? buffer + '\n\n_（已停止生成）_' : '_（已停止生成）_';
      toast('已停止生成');
    } else if (err.needAuth) {
      // 登录失效时这条 AI 回复不会有内容了。下面 finally 一定会跑，
      // 所以这里只打个标记，让它在收尾时把这条空气泡摘掉。
      authLost = true;
      state.token = '';   // 服务端那边这份已经作废了，本地别再攥着
      toast(err.message);
      showView('gate');
      focusFirstCell();
      return;
    } else {
      assistant.error = true;
      buffer = buffer ? buffer + '\n\n---\n**出错了：** ' + err.message : '**出错了：** ' + err.message;
    }
  } finally {
    state.controller = null;
    setStreaming(false);
    if (authLost) {
      // 摘掉它，免得重新登录后对话里挂着一个空气泡
      conv.messages = conv.messages.filter((m) => m !== assistant);
    } else {
      assistant.content = buffer;
      if (reasoning) assistant.reasoning = reasoning;
    }
    conv.updatedAt = Date.now();
    persist();
    paint();
    markStreaming(false);
    el.sendBtn.removeAttribute('aria-busy');
    autoResize();
    el.input.focus();
  }
}

// ================================================================ 秘钥验证

const cells = [...el.codeInput.querySelectorAll('.code-cell')];

function codeValue() {
  return cells.map((c) => c.value).join('').toUpperCase();
}

function clearCells() {
  cells.forEach((c) => { c.value = ''; c.classList.remove('filled'); });
}

function focusFirstCell() {
  clearTimeout(focusFirstCell._t);
  focusFirstCell._t = setTimeout(() => cells[0]?.focus(), 60);
}

function focusCell(i) {
  const target = cells[Math.max(0, Math.min(cells.length - 1, i))];
  target?.focus();
  target?.select();
}

cells.forEach((cell, i) => {
  cell.addEventListener('input', () => {
    const clean = cell.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    cell.value = clean.slice(-1);
    cell.classList.toggle('filled', Boolean(cell.value));
    el.gateError.textContent = '';
    if (cell.value && i < cells.length - 1) focusCell(i + 1);
    if (codeValue().length === KEY_LEN) submitCode();
  });

  cell.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !cell.value && i > 0) {
      e.preventDefault();
      cells[i - 1].value = '';
      cells[i - 1].classList.remove('filled');
      focusCell(i - 1);
    } else if (e.key === 'ArrowLeft' && i > 0) {
      e.preventDefault(); focusCell(i - 1);
    } else if (e.key === 'ArrowRight' && i < cells.length - 1) {
      e.preventDefault(); focusCell(i + 1);
    } else if (e.key === 'Enter') {
      e.preventDefault(); submitCode();
    }
  });

  cell.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData?.getData('text') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!text) return;
    for (let k = 0; k < cells.length; k++) {
      const ch = text[k] || '';
      cells[k].value = ch;
      cells[k].classList.toggle('filled', Boolean(ch));
    }
    focusedIndexReset();
    if (codeValue().length === KEY_LEN) submitCode();
  });

  cell.addEventListener('focus', () => cell.select());
});

function focusedIndexReset() {
  const idx = cells.findIndex((c) => !c.value);
  focusCell(idx === -1 ? cells.length - 1 : idx);
}

function shakeGate() {
  el.codeInput.classList.remove('shake');
  void el.codeInput.offsetWidth;
  el.codeInput.classList.add('shake');
}

let submitting = false;

async function submitCode() {
  const code = codeValue();
  if (submitting || code.length !== KEY_LEN) return;

  submitting = true;
  el.gateError.textContent = '';
  el.gateSubmit.disabled = true;
  el.gateSubmit.textContent = '验证中…';

  let ok = false;
  try {
    const res = await apiFetch('/api/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      el.gateError.textContent = data.error || '验证失败，请重试。';
      shakeGate();
      clearCells();
      focusFirstCell();
      return;
    }

    ok = true;
    // 令牌从响应体里收下，只放内存。之后每个需要秘钥的接口都靠它（见 apiFetch）
    state.token = String(data.token || '');
    applySession(data);
    // 先让格子转绿、按钮打个勾再切页。切页是瞬间的，这一下成功反馈
    // 不放慢一点就会被一起吞掉
    el.codeInput.classList.add('ok');
    el.gateSubmit.classList.add('ok');
    el.gateSubmit.textContent = '✓ 进入中';
  } catch {
    el.gateError.textContent = '网络异常，请稍后重试。';
    shakeGate();
  } finally {
    // 失败/网络异常才在这里收尾；成功那条路要等下面的停顿走完
    if (!ok) {
      submitting = false;
      el.gateSubmit.disabled = false;
      el.gateSubmit.textContent = '进入';
    }
  }

  await sleep(reduceMotion() ? 0 : 320);
  el.codeInput.classList.remove('ok');
  el.gateSubmit.classList.remove('ok');
  el.gateSubmit.disabled = false;
  el.gateSubmit.textContent = '进入';
  submitting = false;
  enterApp();
}

el.gateForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitCode();
});

// ================================================================ 进入 / 退出

function enterApp() {
  showView('app');
  el.messages.innerHTML = '';
  renderHistory();
  renderConversation();
  autoResize();
  setTimeout(() => el.input.focus(), 80);
  maybeGreet();
}

async function doLogout() {
  if (state.streaming) { toast('回复还在生成，可以先点停止'); return; }
  await apiFetch('/api/logout', { method: 'POST' }).catch(() => {});
  state.token = '';   // 服务端那头的会话已经销毁，本地这份也立刻作废
  localStorage.removeItem(STORE_KEY);
  state.conversations = [];
  state.activeId = null;
  createConversation({ activate: true, silent: true });
  clearCells();
  el.gateError.textContent = '';
  showView('gate');
  focusFirstCell();
}

// ================================================================ 事件绑定

el.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  send(el.input.value);
});

el.stopBtn.addEventListener('click', stopGeneration);

el.input.addEventListener('input', autoResize);
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(el.input.value);
  } else if (e.key === 'Escape' && state.streaming) {
    // 光标通常就在输入框里，别让想停下的人还要跑去够按钮
    e.preventDefault();
    stopGeneration();
  }
});

el.newChat.addEventListener('click', () => {
  if (state.streaming) { toast('回复还在生成，可以先点停止'); return; }
  createConversation();
  closeSidebar();
});

el.clearBtn.addEventListener('click', () => {
  if (state.streaming) { toast('回复还在生成，可以先点停止'); return; }
  const conv = activeConversation();
  if (!conv || !conv.messages.length) return;
  conv.messages = [];
  conv.title = '新对话';
  conv.updatedAt = Date.now();
  persist();
  renderConversation();
  renderHistory();
  toast('已清空当前对话');
});

el.logoutBtn.addEventListener('click', doLogout);

// 复制代码块
el.messages.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const code = btn.closest('.code-block')?.querySelector('pre code')?.innerText ?? '';
  try {
    await navigator.clipboard.writeText(code);
    btn.textContent = '已复制';
    btn.classList.add('copied');
  } catch {
    btn.textContent = '复制失败';
  }
  setTimeout(() => {
    btn.textContent = '复制';
    btn.classList.remove('copied');
  }, 1600);
});

// 移动端侧边栏：遮罩是 index.html 里的常驻元素，只切类，
// 这样关闭时也能淡出（以前是每次开关都新建/删除 DOM，只能硬切）
function openSidebar() {
  el.sidebar.classList.add('open');
  el.backdrop.classList.add('show');
}
function closeSidebar() {
  el.sidebar.classList.remove('open');
  el.backdrop.classList.remove('show');
}
el.menuBtn.addEventListener('click', openSidebar);
el.backdrop.addEventListener('click', closeSidebar);

// ================================================================ 启动

async function boot() {
  try {
    const res = await apiFetch('/api/session');
    const data = await res.json();

    applySession(data);
    el.previewBadge.classList.toggle('hidden', !data.preview);

    if (data.localOnlyBlocked) {
      el.boot.classList.add('hidden');
      el.gate.classList.remove('hidden');
      el.gateTitle.textContent = '无法访问';
      el.gateForm.classList.add('hidden');
      el.gateError.textContent = '本站已关闭秘钥验证，且仅允许从本机访问。';
      document.querySelector('.gate-foot').textContent = '';
      return;
    }

    if (data.authed) {
      loadConversations();
      enterApp();
    } else {
      showView('gate');
      focusFirstCell();
    }
  } catch {
    el.boot.classList.add('hidden');
    el.gate.classList.remove('hidden');
    el.gateForm.classList.add('hidden');
    el.gateError.textContent = '无法连接服务器，请确认服务已启动。';
  }
}

boot();
