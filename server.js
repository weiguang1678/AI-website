import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

import { loadConfig, ROOT } from './lib/config.js';
import { Store } from './lib/store.js';
import { createSessionStore, hashPassword, isLocalRequest, verifyPassword } from './lib/auth.js';
import { startGreetingLearner } from './lib/learner.js';
import { accessRoutes } from './routes/access.js';
import { chatRoutes } from './routes/chat.js';
import { greetingRoutes } from './routes/greeting.js';
import { adminRoutes } from './routes/admin.js';
import { iconRoutes, faviconHandler } from './routes/icon.js';

const config = loadConfig();
const store = new Store(path.join(config.dataDir, 'db.json'));

// ------------------------------------------------------------ 初始化管理员密码
if (!store.settings.adminPasswordHash) {
  store.updateSettings({ adminPasswordHash: hashPassword(config.adminInitialPassword) });
  console.log(`\n  ⚠  已生成初始管理员密码：${config.adminInitialPassword}`);
  console.log('     请登录后台后到「入口与安全」里修改。\n');
}

// ------------------------------------------------------------ 运行时上下文
const ctx = {
  store,
  config,
  settings: () => store.settings,
  sessions: createSessionStore({ ttlMs: config.sessionTtlHours * 3_600_000 }),
  userTtlMs: config.sessionTtlHours * 3_600_000,
  adminTtlMs: Math.max(3_600_000, config.sessionTtlHours * 3_600_000),
};

// ------------------------------------------------------------ 应用
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);
app.use(express.json({ limit: '2mb' }));

// ------------------------------------------------------------ 安全响应头
// 没上 helmet：一共就这几个头，手写更省事，也不多一个依赖。
// 关键点：frame-ancestors / X-Frame-Options 用 SAMEORIGIN 而不是 DENY ——
// 后台「设备预览」用同源 iframe 加载前台，DENY 会把那个预览整个打死。
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",                 // 两页都只有 <script type="module" src>，无内联脚本
    "style-src 'self' 'unsafe-inline'",  // 模板里大量 inline style（--i 错峰等）
    "img-src 'self' data: blob:",        // blob: 给图标预览的 createObjectURL 用
    "font-src 'self'",
    "connect-src 'self'",                // SSE 走同源 fetch
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; '));
  next();
});

// ------------------------------------------------------------ 后台网址
// 设置项 adminPath 决定后台开在哪儿：页面在 /<adminPath>，接口在 /<adminPath>/api。
// 默认 'admin'，也就是老地址，此时下面这段一个分支都不进，行为和以前完全一致。
//
// 这里只做「外部网址 → 内部规范路径」的重写，内部照旧是 /admin 和 /api/admin ——
// 路由文件一行都不用改，也就不可能因为「藏个网址」把后台改坏。
function adminBase(s) {
  const p = String(s.adminPath || 'admin').trim();
  return '/' + (p || 'admin');
}

function adminApiBase(s) {
  return adminBase(s) + '/api';
}

app.use((req, res, next) => {
  const s = ctx.settings();
  const base = adminBase(s);
  const api = base + '/api';
  const p = req.path; // 不含查询串
  const query = req.url.slice(p.length);

  // ① 自定义网址下的请求 → 还原成规范路径，交给下面那几条没动过的路由
  if (p === api || p.startsWith(api + '/')) {
    req.url = '/api/admin' + req.url.slice(api.length);
    return next();
  }
  if (p === base || p === base + '/' || p === base + '.html') {
    req.url = '/admin' + query;
    return next();
  }

  // 没改过网址时，老地址就是新地址，下面 ② 没有存在的必要
  if (base === '/admin') return next();

  // ② 改过之后，老地址对外一律 404 —— 藏起来才有意义。
  // 但本机仍然放行：万一改完忘了新地址，人不至于被自己锁在门外（页面重定向过去，
  // 接口直接放行）。clientIp 只把同机直连算本机；走隧道来的请求带着
  // CF-Connecting-IP，一律算远端，所以这条口子公网蹭不到。
  const isOldPage = p === '/admin' || p === '/admin/' || p === '/admin.html';
  const isOldApi = p === '/api/admin' || p.startsWith('/api/admin/');
  if (!isOldPage && !isOldApi) return next();

  if (!isLocalRequest(req)) return res.status(404).type('text/plain').send('404 Not Found');
  if (isOldPage) return res.redirect(302, base);
  next();
});

app.use('/api', accessRoutes(ctx));
app.use('/api', chatRoutes(ctx));
app.use('/api', greetingRoutes(ctx));
app.use('/api', iconRoutes(ctx));
app.use('/api/admin', adminRoutes(ctx));
app.get('/favicon.ico', faviconHandler(ctx));

// ------------------------------------------------------------ 页面
// index.html / admin.html 不直接发出去，而是现场注入 <title>、favicon 和分享卡片
// 的 meta —— 这几样都得跟着后台设置的图标和名字变，写死在文件里就定死了。
const HEAD_MARKER = '<!-- %HEAD% -->';

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 分享卡片里的 og:url / og:image 只能取自请求头的主机名，而请求头是客户端
// 自己就能写的，所以这里做两件事：
//   1) 优先用 Host —— HTTP/1.1 必然带它，cloudflared 也保留原始 Host，
//      所以 x-forwarded-host 没必要当首选，只在 Host 缺失/不合规时兜底；
//   2) 两者都过一遍格式白名单，别把任意字符串写进页面。
// 说明：这仍是「客户端可影响」的值，彻底钉死需要在设置里配公开地址。
const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

function pickHost(...candidates) {
  for (const c of candidates) {
    const h = String(c || '').split(',')[0].trim();
    if (HOST_RE.test(h)) return h;
  }
  return `127.0.0.1:${config.port}`;
}

/** 分享卡片的图片地址必须是绝对的，微信/QQ 才抓得到 */
function absoluteBase(req) {
  const rawProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = rawProto === 'https' || rawProto === 'http'
    ? rawProto
    : (req.secure ? 'https' : 'http');
  const host = pickHost(req.headers.host, req.headers['x-forwarded-host']);
  return `${proto}://${host}`;
}

function pageHead(ctx, req) {
  const s = ctx.settings();
  const v = s.iconVersion || 0;
  const base = absoluteBase(req);
  const title = escapeHtml(s.aiName || 'AI 助手');
  const desc = escapeHtml(s.welcome || '');
  const icon = escapeHtml(`${base}/api/icon?v=${v}`);
  const lines = [
    `<title>${title}</title>`,
    `<link rel="icon" type="image/png" href="/api/icon?v=${v}" />`,
    `<link rel="apple-touch-icon" href="/api/icon?v=${v}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:site_name" content="${title}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${desc}" />`,
    `<meta property="og:url" content="${escapeHtml(base + '/')}" />`,
    `<meta property="og:image" content="${icon}" />`,
    '<meta property="og:image:width" content="512" />',
    '<meta property="og:image:height" content="512" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${desc}" />`,
    `<meta name="twitter:image" content="${icon}" />`,
  ];
  return lines.join('\n');
}

function sendPage(ctx, req, res, file, extraHead = '') {
  try {
    const html = fs.readFileSync(file, 'utf8').replace(HEAD_MARKER, pageHead(ctx, req) + extraHead);    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(html);
  } catch (err) {
    res.status(500).type('text/plain').send(`页面读取失败：${err.message}`);
  }
}

const INDEX_HTML = path.join(ROOT, 'public', 'index.html');
const ADMIN_HTML = path.join(ROOT, 'public', 'admin.html');

// 后台页面多注入一行 <meta name="admin-api">：后台网址能改，admin.js 得知道
// 自己该往哪个基址发请求。**只注进后台这一页** —— 前台是公开的，把后台地址
// 写进它的 <head> 等于白藏。
function sendAdminPage(ctx, req, res) {
  sendPage(ctx, req, res, ADMIN_HTML, `\n<meta name="admin-api" content="${adminApiBase(ctx.settings())}" />`);
}

app.get('/', (req, res) => sendPage(ctx, req, res, INDEX_HTML));
app.get('/index.html', (req, res) => sendPage(ctx, req, res, INDEX_HTML));
// 注意别直接把 sendAdminPage 交给 express：那样第一个参数会被当成 req，
// ctx 就成了请求对象（第一次就是这么 500 的）。包一层。
app.get('/admin', (req, res) => sendAdminPage(ctx, req, res));
app.get('/admin.html', (req, res) => sendAdminPage(ctx, req, res));
app.use(express.static(path.join(ROOT, 'public'), { index: false, extensions: ['html'] }));

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// eslint-disable-next-line no-unused-vars -- Express 靠 4 个参数识别错误中间件
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return res.end();
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.expose ? err.message : '服务器内部错误' });
});

// ------------------------------------------------------------ 兜底
// Express 4 不会接住 async 处理器抛出的异常，而 Node 22 默认把「未处理的
// rejection」升级成致命错误直接结束进程 —— 也就是单个请求出岔子就能让整站消失。
// 这里两个都记下来继续跑：本站是单进程自用服务，挂掉整站比留个异常状态更糟。
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// ------------------------------------------------------------ 启动
// 后台定时学习欢迎语（默认关闭，在后台「AI 设置」里开）
startGreetingLearner(ctx);

const server = app.listen(config.port, config.host, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  const line = '─'.repeat(46);
  console.log(`\n┌${line}┐`);
  console.log(`  ${store.settings.aiName} · 已启动`);
  console.log(`  本机访问   http://127.0.0.1:${config.port}`);
  for (const ip of lan) console.log(`  局域网访问 http://${ip}:${config.port}`);
  console.log(`  管理后台   http://127.0.0.1:${config.port}/admin`);
  console.log(`  数据文件   ${path.join(config.dataDir, 'db.json')}`);
  console.log(`└${line}┘\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

export { app, store, verifyPassword };
