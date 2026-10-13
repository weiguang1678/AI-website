/**
 * 打包脚本：把网站本体 + 一份官方 Node 运行时 + 依赖，打成一个
 * **解压即用、不需要用户自己装 Node** 的安装包。
 *
 * 用法：
 *   node packaging/build.mjs --target win-x64
 *   node packaging/build.mjs --target linux-x64 --out dist
 *
 * 各平台产物：
 *   win-x64    AI-Website-<版本>-win-x64.zip      便携版，解压双击即用
 *              AI-Website-Setup-<版本>.exe        安装包（C# 小程序 + Windows 自带的 csc.exe 编译，
 *                                                 见下方 makeSetupExe 里为什么不用 IExpress）
 *   mac-arm64  AI-Website-<版本>-macos-arm64.tar.gz  + CI 里用 pkgbuild 包成 .pkg
 *   mac-x64    同上，x64
 *   linux-x64  AI-Website-<版本>-linux-x64.tar.gz    + CI 里用 dpkg-deb 包成 .deb
 *
 * 为什么 Node 运行时是**下载**而不是提交进仓库：单个平台解压后就 80MB 上下，
 * 四个平台一起塞进 git 历史，仓库会立刻变得没法看。所以构建时现下、并校验官方
 * SHA-256 —— 校验这一步不能省，否则等于把「官方二进制」这件事全押在 HTTPS 上。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

/**
 * 固定的 Node 版本。**不要跟「最新 LTS」自动走**：
 * 这个版本是本地实际跑通过的（v22.20.0），换个版本就换了一套 v8/网络栈行为，
 * 得重新验一遍才知道有没有踩到新坑。要升级请连着测一遍再改这里。
 */
const NODE_VERSION = 'v22.20.0';
const DIST_BASE = `https://nodejs.org/dist/${NODE_VERSION}`;

/** 打进包里的目录名。Windows/macOS 用带空格的名字（看起来正常），Linux 用连字符的短名 */
const TARGETS = {
  'win-x64': { kind: 'windows', nodeFile: `node-${NODE_VERSION}-win-x64.zip`, nodeBin: 'node.exe', dirName: 'AI Website', arch: 'x64' },
  'mac-arm64': { kind: 'macos', nodeFile: `node-${NODE_VERSION}-darwin-arm64.tar.gz`, nodeBin: 'bin/node', dirName: 'AI Website', arch: 'arm64' },
  'mac-x64': { kind: 'macos', nodeFile: `node-${NODE_VERSION}-darwin-x64.tar.gz`, nodeBin: 'bin/node', dirName: 'AI Website', arch: 'x64' },
  'linux-x64': { kind: 'linux', nodeFile: `node-${NODE_VERSION}-linux-x64.tar.gz`, nodeBin: 'bin/node', dirName: 'ai-website', arch: 'x64' },
};

/** 装进包里的程序文件（相对 ROOT） */
const APP_DIRS = ['lib', 'routes', 'public'];
const APP_FILES = ['server.js', 'package.json', 'package-lock.json', 'README.md'];

// ---------------------------------------------------------------- 小工具

const log = (msg) => console.log(`[build] ${msg}`);
const die = (msg) => { console.error(`[build] ✗ ${msg}`); process.exit(1); };

/**
 * 用哪个 tar。
 *
 * Windows 上**不能**直接叫 `tar`：Git for Windows 装的那个是 GNU tar，它会把
 * 「D:\...」里的 `D:` 当成远程主机名，报 “Cannot connect to D: resolve failed”。
 * 系统自带的 C:\Windows\System32\tar.exe 是 bsdtar，认本地路径、还能直接解 zip，
 * 所以 Windows 上写死用它的绝对路径。
 */
const TAR = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) die(`执行 ${cmd} 失败：${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
}

function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

/**
 * 写一个「必须纯 ASCII」的 .cmd。
 *
 * 不是洁癖：cmd.exe 按系统 OEM 代码页（中文系统是 GBK）解析批处理文件，
 * 里面混进 UTF-8 中文后字节会被错误解码，严重时把换行符一起吞掉、两行粘成一行，
 * 表现就是双击一闪而退、还没有像样的报错。这里直接断言拦住，别等用户去踩。
 */
function writeAscii(file, text) {
  const bad = [...text].find((ch) => ch.codePointAt(0) > 127);
  if (bad) die(`${path.basename(file)} 里出现了非 ASCII 字符「${bad}」，cmd.exe 会解析坏`);
  fs.writeFileSync(file, text, 'utf8');
}

/** 递归列出目录下所有文件的相对路径（写进 .deb 的文件清单要用） */
function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

// ---------------------------------------------------------------- Node 运行时

async function fetchNodeArchive(file, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const dest = path.join(cacheDir, file);
  const sidecar = `${dest}.sha256`;

  // 校验和单独存一份，命中缓存时不用再下一遍 SHASUMS256.txt
  if (fs.existsSync(dest) && fs.existsSync(sidecar)) {
    const want = fs.readFileSync(sidecar, 'utf8').trim();
    const got = sha256(dest);
    if (want === got) { log(`复用已下载的 ${file}`); return dest; }
    log(`${file} 校验和不符，重新下载`);
  }

  log(`下载 ${file} …`);
  const res = await fetch(`${DIST_BASE}/${file}`);
  if (!res.ok) die(`下载 Node 运行时失败：HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));

  log('核对官方 SHA-256 …');
  const sums = await (await fetch(`${DIST_BASE}/SHASUMS256.txt`)).text();
  const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${file}`));
  if (!line) die(`官方 SHASUMS256.txt 里没有 ${file}`);
  const want = line.trim().split(/\s+/)[0];
  const got = sha256(dest);
  if (want !== got) die(`SHA-256 对不上！官方 ${want} / 实际 ${got}，这个包不能要`);
  log(`SHA-256 通过 ${got.slice(0, 16)}…`);

  fs.writeFileSync(sidecar, got);
  return dest;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------- 组装

/**
 * 把「跑起来需要的一切」摊到一个目录里。四个平台共用这一段，
 * 差别只有 Node 二进制和几个启动脚本。
 */
async function stage(target, outDir) {
  const t = TARGETS[target];
  const work = path.join(outDir, '.work', target);
  fs.rmSync(work, { recursive: true, force: true });

  const archive = await fetchNodeArchive(t.nodeFile, path.join(outDir, '.cache'));
  log(`解压 Node 运行时（只留 node 本体，丢掉 npm / 文档 / 头文件，省 40MB）`);
  const rawRuntime = path.join(work, 'node-raw');
  fs.mkdirSync(rawRuntime, { recursive: true });
  // bsdtar（Windows 自带）能直接解 zip，GNU tar 解 tar.gz；两者参数一样
  run(TAR, ['-xf', archive, '-C', rawRuntime]);

  const appDir = path.join(outDir, 'stage', t.dirName);
  fs.rmSync(path.dirname(appDir), { recursive: true, force: true });
  fs.mkdirSync(path.join(appDir, 'runtime'), { recursive: true });

  // ① 官方包里那个顶层的 node-v… 目录
  const inner = fs.readdirSync(rawRuntime).map((n) => path.join(rawRuntime, n)).find((p) => fs.statSync(p).isDirectory());
  if (!inner) die('Node 包里没找到顶层目录');
  const nodeSrc = path.join(inner, t.nodeBin);
  if (!fs.existsSync(nodeSrc)) die(`Node 包里没找到 ${t.nodeBin}`);
  fs.copyFileSync(nodeSrc, path.join(appDir, 'runtime', path.basename(t.nodeBin)));
  if (t.kind !== 'windows') fs.chmodSync(path.join(appDir, 'runtime', 'node'), 0o755);

  // ② 程序本体
  for (const d of APP_DIRS) copyTree(path.join(ROOT, d), path.join(appDir, d));
  for (const f of APP_FILES) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(appDir, f));
  }

  // ③ 依赖。node_modules 不进仓库（.gitignore），构建前必须先 npm ci —— 这里显式拦住，
  //    否则会打出一个「装完就跑不起来」的包，而且要到用户手里才发现。
  const mods = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(path.join(mods, 'express', 'package.json'))) {
    die('没有 node_modules/express。先在项目根跑一次 `npm ci` 再打包。');
  }
  log('复制 node_modules（express 是纯 JS，跨平台通用）');
  copyTree(mods, path.join(appDir, 'node_modules'));

  // ④ 配置默认值。**不复用开发目录里那份** —— 那份带着作者自己的端口和主机设置。
  //    默认只监听 127.0.0.1：给人装的桌面程序不该一上来就对局域网开着。
  fs.writeFileSync(path.join(appDir, 'config.json'), `${JSON.stringify({
    port: 3000, host: '127.0.0.1', adminInitialPassword: 'admin123', dataDir: './data', sessionTtlHours: 12,
  }, null, 2)}\n`);

  // ⑤ 启动器 + 平台外壳
  fs.copyFileSync(path.join(HERE, 'start.mjs'), path.join(appDir, 'start.mjs'));
  writeLaunchers(appDir, t);

  log(`组装完成：${appDir}`);
  return { appDir, target, t };
}

function writeLaunchers(appDir, t) {
  if (t.kind === 'windows') {
    // 注意：这个 .cmd 里**一个非 ASCII 字符都不能有**。cmd.exe 按系统 OEM 代码页
    // 解析批处理，混进 UTF-8 中文会把后面的换行一起吞掉，双击就是一闪而退。
    // 中文提示一律写在 start.mjs 里（Node 永远按 UTF-8 读）。
    writeAscii(path.join(appDir, '启动网站.cmd'), [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'title AI Website',
      // 控制台切到 UTF-8，否则 start.mjs 打出来的中文会变成乱码
      'chcp 65001 >nul',
      '"%~dp0runtime\\node.exe" "%~dp0start.mjs"',
      'if errorlevel 1 pause',
      '',
    ].join('\r\n'));
  } else if (t.kind === 'macos') {
    // .command 是 macOS 上「双击就跑」的脚本，Finder 会开一个终端窗口
    const f = path.join(appDir, '启动网站.command');
    fs.writeFileSync(f, [
      '#!/bin/bash',
      'cd "$(dirname "$0")" || exit 1',
      'exec ./runtime/node start.mjs',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(f, 0o755);
  } else {
    const f = path.join(appDir, 'ai-website');
    fs.writeFileSync(f, [
      '#!/bin/sh',
      'cd "$(dirname "$0")" || exit 1',
      'exec ./runtime/node start.mjs',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(f, 0o755);
  }
}

// ---------------------------------------------------------------- 产物

function makeArtifacts(appDir, target, t, outDir) {
  const made = [];
  const parent = path.dirname(appDir);
  const base = `AI-Website-${VERSION}`;

  if (t.kind === 'windows') {
    const zip = path.join(outDir, `${base}-win-x64.zip`);
    fs.rmSync(zip, { force: true });
    log('打 zip（bsdtar，Windows 自带）');
    run(TAR, ['-a', '-c', '-f', zip, '-C', parent, t.dirName]);
    made.push(zip);

    if (process.platform === 'win32') made.push(makeSetupExe(zip, outDir));
    else log('跳过 .exe 安装包（要 Windows 自带的 csc.exe 才能编译，只能在 Windows 上跑）');
    return made;
  }

  const plat = t.kind === 'macos' ? `macos-${t.arch}` : `linux-${t.arch}`;
  const tgz = path.join(outDir, `${base}-${plat}.tar.gz`);
  fs.rmSync(tgz, { force: true });
  log('打 tar.gz');
  run(TAR, ['-czf', tgz, '-C', parent, t.dirName]);
  made.push(tgz);
  return made;
}

/** setup.cs 里的版本号占位符，编译前替换成 package.json 的版本 */
const SETUP_VERSION_MARKER = '__VERSION__';

/** Windows 自带的 C# 编译器。64 位系统上 Framework64 那份优先，退回到 32 位的。 */
function findCsc() {
  const windir = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) die('找不到 Windows 自带的 C# 编译器 csc.exe，没法生成 .exe 安装包（装了 .NET Framework 4.x 就有）');
  return found;
}

/**
 * Windows 安装包。
 *
 * 货 + 壳：把已经打好的便携版 zip 当资源嵌进一个小 C# 程序（packaging/setup.cs），
 * 再用 **Windows 自带**的 csc.exe 编译成单个 exe。用户双击后它自己解压、
 * 建快捷方式、写卸载入口、把网站跑起来。
 *
 * 为什么不用 Windows 自带的 IExpress（本来是首选，一个第三方工具都不用）：
 * 它在**没有交互桌面**的环境里会弹出模态框然后卡死 —— 本机实测，不管 SED 写得多标准，
 * 都是「makecab 出了 CAB，然后进程挂住」，GitHub Actions 的 runner 上只会更糟。
 * csc 是命令行工具，纯批处理环境下行为稳定，所以换成它。
 *
 * 全过程不下载任何第三方工具，这一点没变。
 */
function makeSetupExe(zip, outDir) {
  const work = path.join(outDir, '.work', 'setup-exe');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  // 把版本号烧进源码，这样「设置 → 应用」里显示的版本是对的
  const source = fs.readFileSync(path.join(HERE, 'setup.cs'), 'utf8');
  if (!source.includes(SETUP_VERSION_MARKER)) {
    die(`packaging/setup.cs 里找不到占位符 ${SETUP_VERSION_MARKER}`);
  }
  const csFile = path.join(work, 'setup.cs');
  fs.writeFileSync(csFile, source.split(SETUP_VERSION_MARKER).join(VERSION));

  const exe = path.join(outDir, `AI-Website-Setup-${VERSION}.exe`);
  fs.rmSync(exe, { force: true });

  log('编译 .exe 安装包（csc 要把 30MB 的 payload 嵌进去，慢是正常的）');
  run(findCsc(), [
    '/nologo',
    '/target:exe',
    '/platform:anycpu',
    '/optimize+',
    // setup.cs 是 UTF-8。不指定的话 csc 按系统 ANSI 代码页读，里面的中文全成乱码。
    '/codepage:65001',
    `/out:${exe}`,
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    // 便携版那个 zip 原样嵌进来，setup.cs 会自己剥掉里面的顶层目录
    `/resource:${zip},payload.zip`,
    csFile,
  ]);
  if (!fs.existsSync(exe)) die('csc 报成功但没看到 exe，产物名对不上');
  return exe;
}

// ---------------------------------------------------------------- 入口

const target = arg('target');
const outDir = path.resolve(ROOT, arg('out', 'dist'));

if (!target || !TARGETS[target]) {
  die(`--target 必填，可选：${Object.keys(TARGETS).join(' / ')}`);
}
if (!/^\d+\.\d+\.\d+/.test(VERSION)) {
  die(`package.json 里的 version 看着不像版本号：${VERSION}`);
}

const { appDir, t } = await stage(target, outDir);
const artifacts = makeArtifacts(appDir, target, t, outDir);

// 给 CI 用：把这几个路径吐到一个 json 里，省得 workflow 里再拼一遍
const manifest = path.join(outDir, `manifest-${target}.json`);
fs.writeFileSync(manifest, `${JSON.stringify({
  target, version: VERSION, node: NODE_VERSION,
  appDir, artifacts: artifacts.map((p) => ({ file: path.basename(p), bytes: fs.statSync(p).size })),
}, null, 2)}\n`);

console.log('');
log('产物：');
for (const a of artifacts) log(`  ${path.basename(a)}  ${(fs.statSync(a).size / 1048576).toFixed(1)} MB`);
log(`清单：${path.relative(ROOT, manifest)}`);
