import express from 'express';
import { generateGreeting, pickFromLibrary, generateChips } from '../lib/greetings.js';
import { requireAccess } from './access.js';

export function greetingRoutes(ctx) {
  const router = express.Router();

  /** 当前库预设的快捷提问，作为「秒出 + 兜底」的那一组（与 /api/session 下发的是同一份） */
  const libraryChips = () => ctx.store.activeChips;

  function aiReady(s) {
    return Boolean(s.apiKey && s.model && s.baseUrl);
  }

  /**
   * 用户进入对话界面时调用，返回一句本次要用的开场白，外加快捷提问。
   * - library：从当前选中的 AI 学习库里取（不调模型，秒回、不耗额度）
   * - ai：由模型现场生成，并借助历史记录保证不重样
   * - fixed：固定欢迎语
   *
   * 返回的 chips 是库里预设的那组，会立刻显示；chipsPending=true 时前端再去
   * 请求 /chips，由模型按这句欢迎语生成一组更贴合的替换掉。
   */
  router.post('/greeting', requireAccess(ctx), async (req, res) => {
    const s = ctx.settings();
    const chips = libraryChips();
    const chipsPending = aiReady(s);
    const withChips = (payload) => ({ ...payload, chips, chipsPending });

    if (s.greetingMode === 'fixed') {
      return res.json(withChips({ greeting: s.welcome || '你好！', source: 'fixed' }));
    }

    if (s.greetingMode === 'library') {
      const text = pickFromLibrary(ctx, ctx.store.activeLibrary);
      // 库还是空的时候退回实时生成，别让界面空着
      if (text) return res.json(withChips({ greeting: text, source: 'library' }));
    }

    try {
      const result = await generateGreeting(ctx, s);
      res.json(withChips(result));
    } catch (err) {
      // 兜底再兜底：任何意外都别让前端卡住
      res.json(withChips({ greeting: s.welcome || '你好！', source: 'fallback', error: err.message }));
    }
  });

  /**
   * 按刚给出的欢迎语，实时生成一组贴合的快捷提问。
   * 生成失败或接口没配好时，原样返回库里预设的那组，前端无感。
   */
  router.post('/chips', requireAccess(ctx), async (req, res) => {
    const fallback = libraryChips();
    const greeting = String(req.body?.greeting || '').slice(0, 200);

    try {
      const chips = await generateChips(ctx, ctx.settings(), {
        greeting,
        library: ctx.store.activeLibrary,
      });
      if (chips?.length) return res.json({ chips, generated: true });
    } catch { /* 落到下面的兜底 */ }

    res.json({ chips: fallback, generated: false });
  });

  return router;
}
