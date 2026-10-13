#!/usr/bin/env node
/**
 * 生成出厂默认图标 public/assets/icon-default.png
 *
 * 管理员还没配过图标时，/api/icon 就发这一张。之后只要在后台保存过一次设置，
 * 浏览器就会用同一套画法现场生成更贴合的版本覆盖它，这张只负责「全新的站」。
 *
 * 为什么要自己写：本站只有 express 一个依赖，不想为一个占位图引 sharp/canvas。
 * PNG 本身不复杂（zlib + 几个 chunk），字形用圆头线段拼一下就够了。
 * 要换样子就改下面的常量，然后：node tools/make-default-icon.mjs
 *
 * 注意：这里画不出任意汉字（没有字体）。默认文字固定是 "AI"，
 *       中文图标交给后台的 canvas 去生成 —— 那边有浏览器，字体齐全。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'assets', 'icon-default.png');

const SIZE = 512;          // 最终边长
const SS = 4;              // 超采样倍数，靠它做抗锯齿
const N = SIZE * SS;

const RADIUS_RATIO = 16 / 56; // 与 .brand-badge 的圆角比例一致
const GRADIENT = [[0, '#6366f1'], [0.55, '#a855f7'], [1, '#ec4899']];

// ------------------------------------------------------------------ 画

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

/** 沿 (x+y) 方向的斜向渐变，和 CSS 的 135deg 一致 */
function gradientAt(t) {
  const stops = GRADIENT.map(([p, c]) => [p, hex(c)]);
  let i = 0;
  while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
  const [p0, c0] = stops[i];
  const [p1, c1] = stops[i + 1];
  const k = p1 === p0 ? 0 : Math.min(1, Math.max(0, (t - p0) / (p1 - p0)));
  return [0, 1, 2].map((j) => c0[j] + (c1[j] - c0[j]) * k);
}

function roundedRectContains(x, y) {
  const r = N * RADIUS_RATIO;
  const dx = Math.max(Math.abs(x - N / 2) - (N / 2 - r), 0);
  const dy = Math.max(Math.abs(y - N / 2) - (N / 2 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/** 点到线段的距离，用来把粗线段画成圆头胶囊 */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / len2));
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return Math.hypot(dx, dy);
}

/** 字形：把 "AI" 拆成几根圆头线段 */
function glyphStrokes() {
  const H = N * 0.44;              // 字高
  const stroke = H * 0.105;        // 笔画半径
  const wa = H * 0.72;             // A 的宽度
  const gap = H * 0.30;

  const aLeft = -wa / 2, aRight = wa / 2;
  const iX = aRight + gap;
  const top = -H / 2, bottom = H / 2;

  // 整组居中
  const left = aLeft - stroke;
  const right = iX + stroke;
  const shiftX = N / 2 - (left + right) / 2;
  const shiftY = N / 2 - (top + bottom) / 2 + H * 0.03; // 视觉重心略微上提

  const seg = (ax, ay, bx, by) => [
    ax + shiftX, ay + shiftY,
    bx + shiftX, by + shiftY,
    stroke,
  ];

  return [
    seg(aLeft, bottom, 0, top),        // A 左腿
    seg(aRight, bottom, 0, top),       // A 右腿
    seg(-H * 0.17, H * 0.20, H * 0.17, H * 0.20), // A 的横杠
    seg(iX, bottom, iX, top),          // I
  ];
}

function render() {
  const strokes = glyphStrokes();
  // 累加「预乘后的颜色」和 alpha，最后再解回来 —— 这样边缘不会发黑
  const acc = new Float64Array(SIZE * SIZE * 4);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!roundedRectContains(x + 0.5, y + 0.5)) continue;

      let r, g, b;
      [r, g, b] = gradientAt((x + y) / (2 * N - 2));

      // 笔画覆盖：取离得最近的那根，越近越白
      let glyph = 0;
      for (const [ax, ay, bx, by, sw] of strokes) {
        const d = distToSegment(x + 0.5, y + 0.5, ax, ay, bx, by);
        if (d <= sw) {
          const coverDistance = Math.min(1, (sw - d) / SS);
          if (coverDistance > glyph) glyph = coverDistance;
        }
      }

      r += (255 - r) * glyph;
      g += (255 - g) * glyph;
      b += (255 - b) * glyph;

      const i = ((y / SS) | 0) * SIZE + ((x / SS) | 0);
      acc[i * 4] += r;
      acc[i * 4 + 1] += g;
      acc[i * 4 + 2] += b;
      acc[i * 4 + 3] += 255;
    }
  }

  const samples = SS * SS;
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = acc[i * 4 + 3] / samples;          // 0..255
    const k = a > 0 ? 255 / a / samples : 0;     // 预乘解回来
    rgba[i * 4] = Math.round(Math.min(255, acc[i * 4] * k));
    rgba[i * 4 + 1] = Math.round(Math.min(255, acc[i * 4 + 1] * k));
    rgba[i * 4 + 2] = Math.round(Math.min(255, acc[i * 4 + 2] * k));
    rgba[i * 4 + 3] = Math.round(a);
  }
  return rgba;
}

// ------------------------------------------------------------------ 写 PNG

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;  // 压缩
  ihdr[11] = 0;  // 滤波
  ihdr[12] = 0;  // 非隔行

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // 每行的滤波类型：0 = None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = encodePng(render(), SIZE);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`已生成 ${OUT}（${SIZE}×${SIZE}，${(png.length / 1024).toFixed(1)} KB）`);
