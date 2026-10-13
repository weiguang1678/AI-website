/**
 * 一个只写不读的最小 zip 写入器。存在的唯一理由：**保证文件名按 UTF-8 存**。
 *
 * 为什么不能用现成的工具打这个 zip —— 踩过一次，产物是坏的：
 *
 *   原来这里用的是 Windows 自带的 bsdtar（`tar -a -c -f x.zip`），libarchive
 *   会按**宿主代码页**转换文件名。Windows 上的启动脚本叫「启动网站.cmd」，
 *   于是：
 *     · 在中文 Windows 上（代码页 GBK）→ 存成 GBK 字节、UTF-8 标志位不置。
 *       本机解压时 .NET 也用 GBK 解，一切正常 —— **本机测试全绿**。
 *     · 在 GitHub Actions 的英文 runner 上（代码页 1252）→ 三个汉字编不出来，
 *       直接变成 `????.cmd`。而 setup.cs 里写死要找「启动网站.cmd」，
 *       装完启动会报「安装失败」，快捷方式也全是死的。
 *   tar 包（macOS / Linux）没这个问题：那边的文件名本来就是 UTF-8 字节，
 *   tar 原样搬走，不经过代码页转换。
 *
 * 所以这里不去跟 libarchive 的地域设置较劲，直接自己按规范写：
 * 名字用 UTF-8 编码，并且每个条目都把通用标志位第 11 位（0x800）置上 ——
 * 规范里这一位就是「本条目文件名是 UTF-8」的意思，置上之后，解压方
 * （.NET 的 ZipArchive、Windows 资源管理器、7-Zip、macOS 的解档工具……）
 * 就必须按 UTF-8 解，跟它自己所处的代码页再没关系。
 *
 * 不引依赖：deflate 用 Node 自带的 zlib，CRC32 也是（Node 22 起有 zlib.crc32）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** 通用标志位第 11 位：文件名是 UTF-8 —— 本文件存在的全部意义 */
const FLAG_UTF8 = 0x0800;

/** 压缩级别。9 在这个体积上只比 6 小一点点，但打包是一次性的、下载是长期的 */
const LEVEL = 9;

/** DOS 时间格式：秒只有 5 位（两秒一跳），年份从 1980 起算 */
function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** 递归收集条目。目录按名字排序再递归，这样每次打包的条目顺序都一样。 */
function walk(absDir, zipName, out) {
  const items = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const it of items) {
    const abs = path.join(absDir, it.name);
    const name = `${zipName}/${it.name}`;
    if (it.isDirectory()) {
      out.push({ name: `${name}/`, dir: true });
      walk(abs, name, out);
    } else if (it.isFile()) {
      out.push({ name, abs, dir: false });
    }
    // 符号链接一律跳过：Windows 那份产物里本来就没有，别把「链接到哪去了」这点
    // 状态悄悄塞进压缩包
  }
}

/**
 * 把 root 下的 topName 目录整个写进 outFile。
 *
 * @param {string} root     顶层目录的**父目录**
 * @param {string} topName  要打的目录名（会作为 zip 里的第一层路径）
 * @param {string} outFile  产物路径
 * @returns {number} 写了多少个条目
 */
export function writeZip(root, topName, outFile) {
  const entries = [];
  // 顶层目录自己也要占一条：解压方多半会自己把目录建出来，但少了它，
  // 空目录和某些老解压工具就会漏掉这一层
  if (fs.statSync(path.join(root, topName)).isDirectory()) entries.push({ name: `${topName}/`, dir: true });
  walk(path.join(root, topName), topName, entries);

  const { time, date } = dosDateTime(new Date());
  const fd = fs.openSync(outFile, 'w');
  const central = [];
  let offset = 0;

  const write = (buf) => { fs.writeSync(fd, buf); offset += buf.length; };

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    let raw = Buffer.alloc(0);
    let comp = Buffer.alloc(0);
    let method = 0;

    if (!e.dir) {
      raw = fs.readFileSync(e.abs);
      const deflated = zlib.deflateRawSync(raw, { level: LEVEL });
      // 压不动就存原文，别为了「走 deflate」反而变大
      if (deflated.length < raw.length) { comp = deflated; method = 8; } else { comp = raw; }
    }

    const crc = e.dir ? 0 : zlib.crc32(raw);
    const attrs = ((e.dir ? 0o40755 : 0o100644) << 16) | (e.dir ? 0x10 : 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);      // 本地文件头
    local.writeUInt16LE(20, 4);              // 需要的解压版本 2.0
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);              // 没有扩展字段

    const localOffset = offset;
    write(local);
    write(name);
    write(comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);         // 中央目录条目
    cd.writeUInt16LE((3 << 8) | 20, 4);      // 由 unix 的 2.0 写的（高字节=系统 3=unix）
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);                 // 扩展字段长度
    cd.writeUInt16LE(0, 32);                 // 注释长度
    cd.writeUInt16LE(0, 34);                 // 磁盘号
    cd.writeUInt16LE(0, 36);                 // 内部属性
    cd.writeUInt32LE(attrs >>> 0, 38);
    cd.writeUInt32LE(localOffset, 42);
    central.push(cd, name);
  }

  const cdOffset = offset;
  for (const b of central) write(b);
  const cdSize = offset - cdOffset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);         // 中央目录结尾
  eocd.writeUInt16LE(0, 4);                  // 本磁盘号
  eocd.writeUInt16LE(0, 6);                  // 中央目录所在磁盘号
  eocd.writeUInt16LE(entries.length, 8);     // 本磁盘上的条目数
  eocd.writeUInt16LE(entries.length, 10);    // 总条目数
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);                 // 没有注释
  write(eocd);

  fs.closeSync(fd);
  return entries.length;
}

/**
 * 回头读一遍刚打出来的 zip，把每个条目的名字解出来（连同「是不是 UTF-8」这个标志）。
 *
 * 给 build.mjs 做构建期自检用：这个包最要命的失败方式不是报错，而是**安安静静地
 * 把中文名换成 `????.cmd`** —— 本机是中文 Windows，解压出来一切正常，只有别人的
 * 机器上才炸，而且炸在装完之后。所以宁可每次都从产物本身验一遍。
 */
export function zipEntryNames(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const tail = Math.min(size, 256 * 1024); // 中央目录很小，从尾部读一段就够
  const buf = Buffer.alloc(tail);
  fs.readSync(fd, buf, 0, tail, size - tail);
  fs.closeSync(fd);

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${file} 里找不到中央目录结尾（EOCD）`);

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = eocd - cdSize;
  const out = [];
  while (out.length < count) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`${file} 的中央目录读到一半断了（已读 ${out.length}/${count}）`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    out.push({ name, utf8: (flags & FLAG_UTF8) !== 0 });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

