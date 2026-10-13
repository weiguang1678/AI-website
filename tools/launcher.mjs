#!/usr/bin/env node
/**
 * 一键启动：网站本体 + Cloudflare 隧道。
 *
 * 设计要点：
 * - 两个子进程都开在**当前这个控制台**里，所以关掉窗口两个一起结束，不会留孤儿进程；
 * - 退出时只杀**自己启动的**子进程（用 spawn 拿到的句柄），绝不按进程名批量杀，
 *   免得误伤你自己的其它 node.exe；
 * - 网站已经在跑（比如你用 start.cmd 起过）时不重复启动，只接隧道，且退出时不动它；
 * - 任一子进程意外退出 → 另一个也停掉，避免出现「半个网站」的状态。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const DOMAIN = process.env.SITE_DOMAIN || 'chat.lumewalk.dpdns.org';
const TUNNEL = process.env.TUNNEL_NAME || 'ai-website';
const STATE_FILE = path.join(ROOT, 'data', '.launcher.json');
const AUTOSTOP = Number(process.env.LAUNCHER_AUTOSTOP || 0); // 自检用：N 秒后自动收摊

// ------------------------------------------------------------------ 终端着色
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1'), dim = paint('2');
const red = paint('31'), green = paint('32'), yellow = paint('33'), cyan = paint('36');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 小工具
/** 只用来「判断」端口有没有被占，不杀任何东西 */
function portInUse() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: PORT });
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(700);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/** 端口上跑的到底是不是本站（认 /api/session 的形状），避免误判别的程序 */
function probeSite(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/session', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve(j && typeof j.aiName === 'string' ? j : null);
          } catch { resolve(null); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function findFile(candidates) {
  for (const p of candidates) {
    if (!p) continue;
    try { if (fs.existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  return null;
}

const HOME = process.env.USERPROFILE || '';
const cloudflaredBin = process.env.CLOUDFLARED || findFile([
  path.join(HOME, 'cloudflared', 'cloudflared.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
  path.join(process.env.ProgramFiles || '', 'cloudflared', 'cloudflared.exe'),
]) || 'cloudflared';

const cloudflaredConfig = process.env.CLOUDFLARED_CONFIG || findFile([
  path.join(HOME, '.cloudflared', 'config.yml'),
]);

// ------------------------------------------------------------------ 进程管理
const children = [];
let stopping = false;
let siteReady = false;
let tunnelReady = false;
let portalShown = false;

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    p.once('exit', resolve);
    p.once('error', resolve);
  });
}

async function stopAll(reason) {
  if (stopping) return;
  stopping = true;
  process.stdout.write('\n');
  console.log(yellow(`  正在停止${reason ? '（' + reason + '）' : ''}…`));
  await Promise.all(children.map((c) => killTree(c.pid)));
  try { fs.unlinkSync(STATE_FILE); } catch { /* 本来就没了 */ }
  console.log(green('  网站和隧道都已停止。'));
  console.log(dim('  可以把窗口关掉了。'));
}

// 尽早接管 Ctrl+C —— 启动过程中（最多要等 30 秒）按了也要能干净收尾
process.on('SIGINT', async () => {
  if (stopping) process.exit(0);
  await stopAll('收到 Ctrl+C');
  process.exit(0);
});
process.on('SIGTERM', async () => { await stopAll(); process.exit(0); });
// 点窗口右上角的叉时，本进程和子进程同属一个控制台，会被一起带走，不会留孤儿

/** 按行切分并加前缀；display 返回 false 的行只用于内部判断，不打印 */
function pipeLines(stream, label, color, display, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      const t = line.trim();
      if (!t) continue;
      if (onLine) onLine(t);
      if (!display || display(t)) console.log(`${color(label)} ${dim(t)}`);
    }
  });
}

// cloudflared 启动时会刷一屏健康检查，没必要全displayed出来
const TUNNEL_NOISE = /(ICMP proxy|curve preferences|does not support loading|will not automatically update|Generated Connector ID|^See https|precheck)/i;

function spawnChild(label, color, command, args, opts, display, onLine) {
  const child = spawn(command, args, opts);
  children.push(child);

  pipeLines(child.stdout, label, color, display, onLine);
  pipeLines(child.stderr, label, color, display, onLine);

  child.once('error', (err) => {
    console.log(`${red('[!!]')} ${label} 启动失败：${err.message}`);
    if (child === serverProc && err.code === 'ENOENT') {
      console.log(dim('     是不是没装依赖？先在这个目录跑一次 npm install'));
    }
  });

  child.once('exit', (code, signal) => {
    if (stopping) return;
    console.log('');
    console.log(red(`  ${label} 意外退出了（code ${code}${signal ? ', ' + signal : ''}）`));
    void stopAll(`${label}已退出`);
    setTimeout(() => process.exit(1), 300);
  });

  return child;
}

// ------------------------------------------------------------------ 开屏
// 窗口标题在这里设：Node 走 SetConsoleTitleW（Unicode），不受控制台代码页影响。
// 写在 .cmd 里则会因为编码问题把批处理解析搞崩，所以标题也交给 Node。
process.title = 'AI 问答网站 · 一键启动';

console.log('');
console.log(bold('  ============================================'));
console.log(bold('     AI 问答网站  ·  一键启动'));
console.log(bold('  ============================================'));
console.log('');

// 已经在启动器里跑着？别起第二份
if (fs.existsSync(STATE_FILE)) {
  try {
    const prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (prev.pid && prev.pid !== process.pid) {
      process.kill(prev.pid, 0); // 不抛异常 = 还活着
      console.log(yellow('  已经有一个启动器在跑了，不用再开一个。'));
      console.log(dim(`  （那个窗口的进程号是 ${prev.pid}，启动于 ${prev.at || '未知时间'}）`));
      console.log('');
      process.exit(0);
    }
  } catch { /* 进程没了或文件坏了，继续 */ }
}

// ------------------------------------------------------------------ 网站本体
let serverProc = null;
const alreadyUp = (await portInUse()) && Boolean(await probeSite());

if (alreadyUp) {
  console.log(`${yellow('[--]')} 网站已经在运行了（端口 ${PORT}），不重复启动，也不归本窗口管。`);
  siteReady = true;
} else {
  if (await portInUse()) {
    console.log(red(`[!!] 端口 ${PORT} 被别的程序占用了，而且它不是本站。`));
    console.log(dim('     先把它关掉，或改 config.json 里的 port。'));
    process.exit(1);
  }
  console.log(`${cyan('[..]')} 启动网站本体…`);
  serverProc = spawnChild(
    '[网站]', cyan,
    process.execPath, ['server.js'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false },
    (line) => !/^\s*$/.test(line),
  );
}

// 记一下自己，防止被开第二份（写完就删的东西，不算数据）
try {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, at: new Date().toLocaleString('zh-CN') }));
} catch { /* 写不了就算了，不影响主流程 */ }

// ------------------------------------------------------------------ 隧道
console.log(`${cyan('[..]')} 启动 Cloudflare 隧道…`);
const tunnelArgs = [];
if (cloudflaredConfig) tunnelArgs.push('--config', cloudflaredConfig);
tunnelArgs.push('tunnel', 'run', TUNNEL);

spawnChild(
  '[隧道]', paint('35'),
  cloudflaredBin, tunnelArgs,
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false },
  (line) => /(ERR|WRN|Registered tunnel connection|Starting tunnel|failed|error)/i.test(line) && !TUNNEL_NOISE.test(line),
  (line) => {
    if (!tunnelReady && /Registered tunnel connection/.test(line)) {
      tunnelReady = true;
    }
  },
);

// ------------------------------------------------------------------ 等就绪
if (!siteReady) {
  for (let i = 0; i < 40 && !siteReady; i++) {
    await sleep(500);
    if (await probeSite()) siteReady = true;
  }
}
for (let i = 0; i < 60 && !tunnelReady; i++) await sleep(500);

// ------------------------------------------------------------------ 状态面板
function panel() {
  if (portalShown) return;
  portalShown = true;
  const ok = (s) => green(`[OK] ${s}`);
  const no = (s) => red(`[!!] ${s}`);
  console.log('');
  console.log(bold('  --------------------------------------------'));
  console.log('   ' + (siteReady ? ok('网站本体   运行中') : no('网站本体   没起来')));
  console.log('   ' + (tunnelReady ? ok('Cloudflare 隧道  已连接') : no('Cloudflare 隧道  没连上')));
  console.log(bold('  --------------------------------------------'));
  if (siteReady && tunnelReady) {
    console.log(`   ${bold('公网地址')}   https://${DOMAIN}`);
  }
  console.log(`   ${bold('本机后台')}   http://127.0.0.1:${PORT}/admin`);
  console.log(`   ${bold('本机前台')}   http://127.0.0.1:${PORT}`);
  console.log(bold('  --------------------------------------------'));
  console.log(dim('   两个都不能停：关掉这个窗口 = 两个一起停。'));
  console.log(dim('   要停：按 Ctrl+C，或者直接关窗口。'));
  console.log('');
}
panel();

// 隧道可能起得慢，等它连上再补一次面板（最多再等 90 秒，别让定时器无限跑）
if (!tunnelReady) {
  const deadline = Date.now() + 90_000;
  const timer = setInterval(() => {
    if (tunnelReady) {
      clearInterval(timer);
      portalShown = false;
      panel();
    } else if (Date.now() > deadline) {
      clearInterval(timer);
      console.log(yellow('  [!!] 隧道 90 秒还没连上，下面那行日志里应该有原因。'));
    }
  }, 1000);
}

// ------------------------------------------------------------------ 收尾
if (AUTOSTOP) {
  console.log(dim(`  （自检模式：${AUTOSTOP} 秒后自动停止）`));
  setTimeout(async () => { await stopAll('自检结束'); process.exit(0); }, AUTOSTOP * 1000);
}
