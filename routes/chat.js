import express from 'express';
import { consumeStream, readUpstreamError, requestChat } from '../lib/ai.js';
import { requireAccess } from './access.js';

const MAX_CONTENT_CHARS = 20_000;

/** 清洗前端传来的消息，只保留允许的字段与角色 */
function sanitizeMessages(input, historyLimit, systemPrompt) {
  const list = Array.isArray(input) ? input : [];
  const cleaned = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.trim()) continue;
    cleaned.push({ role, content: content.slice(0, MAX_CONTENT_CHARS) });
  }
  // 只带最近 N 条，避免上下文无限增长
  const trimmed = cleaned.slice(-Math.max(2, historyLimit));
  // 保证第一条是 user，避免某些接口报错
  while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
  if (systemPrompt?.trim()) trimmed.unshift({ role: 'system', content: systemPrompt.trim() });
  return trimmed;
}

export function chatRoutes(ctx) {
  const router = express.Router();

  router.post('/chat', requireAccess(ctx), async (req, res) => {
    const s = ctx.settings();
    const messages = sanitizeMessages(req.body?.messages, s.historyLimit, s.systemPrompt);

    if (!messages.some((m) => m.role === 'user')) {
      return res.status(400).json({ error: '请先输入内容。' });
    }

    // 注意：不能用 req.on('close') —— Node 16+ 在请求体读取完就会触发它，
    // 会把刚开始的上游请求立刻中断。只在响应被异常关闭（客户端真的断开）时中止。
    const controller = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (res.writableEnded) return;
      clientGone = true;
      controller.abort();
    });

    let upstream;
    try {
      upstream = await requestChat({ settings: s, messages, stream: true, signal: controller.signal });
    } catch (err) {
      const msg =
        err?.name === 'AbortError' || /aborted|超时|断开/.test(err?.message || '')
          ? '请求已被取消或超时。'
          : `无法连接 AI 接口：${err.message}`;
      return res.status(502).json({ error: msg });
    }

    if (!upstream.ok) {
      upstream._cleanup?.();
      // 读错误体本身也可能抛（连接被掐断等），别让它盖过原本的错误信息
      let detail = `上游接口返回 ${upstream.status}`;
      try {
        detail = await readUpstreamError(upstream);
      } catch { /* 用上面那句兜底 */ }
      return res.status(502).json({ error: detail });
    }

    // ---- 开始 SSE ----
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (obj) => {
      if (!clientGone) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    try {
      await consumeStream(upstream.body, (delta, reasoning) => {
        if (delta || reasoning) send({ delta, reasoning });
      });
      send({ done: true });
    } catch (err) {
      if (!clientGone) send({ error: `生成中断：${err.message}` });
    } finally {
      upstream._cleanup?.();
      if (!clientGone) res.end();
    }
  });

  return router;
}
