/**
 * 安装包里的启动器。双击快捷方式 → 走这个文件。
 *
 * 它只干四件事，不碰任何网络：
 *   1. 把配置和运行数据指到一个**可写**目录（装到 /opt、Program Files 这类
 *      只读位置时，程序没法往自己目录里写 config.json，见 lib/config.js 的 HOME）；
 *   2. 起 server.js；
 *   3. 等服务真的起来了再打开浏览器 —— 直接开会有「无法访问」的空白页；
 *   4. 把两个地址和初始密码打在窗口里，关窗口 = 停服务。
 *
 * 这里**不启动 Cloudflare 隧道**：那是「把网站发布到公网」的额外一步，
 * 需要用户自己有 cloudflared 和域名，不该塞进通用安装包里。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url)); // 程序目录（可能只读）
const NODE = path.join(DIR, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');

// 程序目录可写就还用老行为（配置就在程序目录里，和直接跑 node server.js 一模一样）；
// 不可写才切到用户目录，免得把老用户的配置「搬家」到别处找不着。
const HOME = fs.existsSync(path.join(DIR, 'config.json')) && canWrite(DIR)
  ? DIR
  : path.join(os.homedir(), '.ai-website');

function canWrite(dir) {
  try {
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

fs.mkdirSync(HOME, { recursive: true });

const configFile = path.join(HOME, 'config.json');
let config = { port: 3000, host: '127.0.0.1', adminInitialPassword: 'admin123', dataDir: './data', sessionTtlHours: 12 };
if (fs.existsSync(configFile)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(configFile, 'utf8')) }; } catch { /* 坏了就按默认来，server.js 自己也会报 */ }
}
const port = Number(config.port) || 3000;
const shown = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
const base = `http://${shown}:${port}`;

const line = '─'.repeat(58);
console.log(`\n${line}`);
console.log('  AI 问答网站 —— 正在启动，请稍候…');
console.log(`${line}\n`);
console.log(`  程序目录  ${DIR}`);
console.log(`  配置数据  ${HOME}\n`);

const child = spawn(NODE, [path.join(DIR, 'server.js')], {
  cwd: DIR,
  env: { ...process.env, AI_WEBSITE_HOME: HOME },
  stdio: ['ignore', 'inherit', 'inherit'],
});

let opened = false;
const firstRun = !fs.existsSync(path.join(HOME, 'data', 'db.json'));
const openedAt = Date.now();
const poll = setInterval(async () => {
  try {
    const res = await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return;
  } catch {
    // 还没起来。15 秒还没好就放弃等待（服务自己的报错已经打在窗口里了）
    if (Date.now() - openedAt > 15_000) { clearInterval(poll); }
    return;
  }
  clearInterval(poll);
  if (opened) return;
  opened = true;

  console.log(`${line}`);
  console.log(`  网站前台  ${base}`);
  console.log(`  管理后台  ${base}/admin`);
  if (firstRun) {
    console.log(`\n  初始后台密码：${config.adminInitialPassword}`);
    console.log('  ↑ 打开后台后会提示修改，请务必改掉。');
  }
  console.log(`\n  这个窗口就是服务器的本体，**关掉它网站就停了**。`);
  console.log(`${line}\n`);

  openBrowser(base);
}, 400);

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* 打不开就算了，地址已经打在上面 */ }
}

// 关窗口 / Ctrl+C 时把子进程一起带走，别留孤儿占着 3000 端口
const stop = () => { try { child.kill(); } catch { /* 已经没了 */ } };
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
child.on('exit', (code) => {
  clearInterval(poll);
  console.log(`\n网站已停止（退出码 ${code}）。按回车关闭窗口。`);
  process.stdin.resume();
});
