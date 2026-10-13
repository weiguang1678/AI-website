import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/config.js';
import { requireAdmin } from './admin.js';

/** 出厂的默认图标：管理员没配过图标时用它兜底 */
const SHIPPED_DEFAULT = path.join(ROOT, 'public', 'assets', 'icon-default.png');

/** 管理员上传/生成的图标（data/ 不进版本库） */
const ICON_FILE = 'icon.png';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DIMENSION = 4096;

/**
 * 校验一个 PNG 并读出尺寸 —— 直接解析 IHDR，不引任何依赖。
 * 结构：8 字节签名 + 4 字节块长度 + 4 字节块类型 "IHDR" + 宽 4 字节 + 高 4 字节 …
 */
function inspectPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.readUInt32BE(8) !== 13) return null;
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return { width, height };
}

/** 同一个文件反复读没必要，按「路径 + 修改时间」缓存住 */
const fileCache = new Map();
function readCached(file) {
  const key = `${file}:${fs.statSync(file).mtimeMs}`;
  let hit = fileCache.get(key);
  if (!hit) {
    hit = fs.readFileSync(file);
    fileCache.clear(); // 只留当前这一版，不占内存
    fileCache.set(key, hit);
  }
  return hit;
}

/**
 * 当前该发哪张图：管理员传过就用他的，否则用出厂的默认图。
 * 只看文件在不在，不看 iconMode —— 那张图两种模式下都是「当前生效的图标」，
 * iconMode 只决定后台表单用哪种方式编辑它。
 */
function currentIconFile(store) {
  const uploaded = path.join(store.dataDir, ICON_FILE);
  if (fs.existsSync(uploaded)) return uploaded;
  return fs.existsSync(SHIPPED_DEFAULT) ? SHIPPED_DEFAULT : null;
}

/**
 * 发图标。四种用途共用这一个地址：浏览器标签页、苹果桌面图标、
 * 前台/后台的头像、以及微信/QQ 的分享卡片（og:image）。
 *
 * 缓存策略：URL 上带对版本的 ?v=N 时给一年强缓存；对不上或没带时用 ETag 协商。
 * 换图标时服务端把 iconVersion +1，页面上的地址跟着变，Safari 和微信那种
 * 极其顽固的 favicon 缓存也就自然绕过去了。
 */
function serveIcon(ctx) {
  return (req, res) => {
    const s = ctx.settings();
    const file = currentIconFile(ctx.store);
    if (!file) return res.status(404).json({ error: '图标不存在' });

    const etag = `"icon-${s.iconVersion}-${path.basename(file)}"`;
    const versioned = req.query.v !== undefined && String(req.query.v) === String(s.iconVersion);

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    let buf;
    try {
      buf = readCached(file);
    } catch {
      return res.status(404).json({ error: '图标读取失败' });
    }
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  };
}

export function iconRoutes(ctx) {
  const router = express.Router();
  const guard = requireAdmin(ctx);

  // ---------------------------------------------------------- 读取（公开）

  router.get('/icon', serveIcon(ctx));

  // ---------------------------------------------------------- 写入（管理员）

  // 注意：全局的 express.json 只吃 application/json，这个裸 body 轮不到它，
  // 所以 4MB 的上限在这里单独设，跟那个 2MB 的全局限制互不干扰。
  const rawPng = express.raw({ type: 'image/png', limit: '4mb' });

  router.post('/admin/icon', guard, rawPng, (req, res) => {
    const buf = req.body;
    const size = inspectPng(buf);
    if (!size) {
      return res.status(400).json({ error: '图标必须是一张 4096×4096 以内的 PNG 图片。' });
    }

    const target = path.join(ctx.store.dataDir, ICON_FILE);
    const tmp = `${target}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, target);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* 没留下来就算了 */ }
      return res.status(500).json({ error: `图标保存失败：${err.message}` });
    }

    // 只存图 + 顶掉缓存；用不用它（iconMode）由「保存设置」那条路决定
    ctx.store.updateSettings({ iconVersion: (ctx.settings().iconVersion || 0) + 1 });
    const s = ctx.settings();
    res.json({ ok: true, iconMode: s.iconMode, iconVersion: s.iconVersion, width: size.width, height: size.height });
  });

  router.delete('/admin/icon', guard, (req, res) => {
    try {
      fs.unlinkSync(path.join(ctx.store.dataDir, ICON_FILE));
    } catch { /* 本来就没有 */ }

    ctx.store.updateSettings({
      iconMode: 'default',
      iconVersion: (ctx.settings().iconVersion || 0) + 1,
    });
    const s = ctx.settings();
    res.json({ ok: true, iconMode: s.iconMode, iconVersion: s.iconVersion });
  });

  return router;
}

/** GET /favicon.ico —— 浏览器会不管页面上写没写都来要一次，接到同一个处理上 */
export function faviconHandler(ctx) {
  return serveIcon(ctx);
}
