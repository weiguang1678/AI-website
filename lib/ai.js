/**
 * 把用户填写的 Base URL 补全成完整的 /chat/completions 地址。
 *   https://api.deepseek.com               → https://api.deepseek.com/v1/chat/completions
 *   https://api.deepseek.com/v1            → https://api.deepseek.com/v1/chat/completions
 *   https://x.com/v1/chat/completions      → 原样使用
 *   https://x.com/v1/chat/completions/     → 去掉尾斜杠
 */
export function resolveChatUrl(baseUrl) {
  let url = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('尚未配置 AI 接口地址，请先到后台「AI 设置」里填写。');
  if (/\/chat\/completions$/i.test(url)) return url;

  try {
    const parsed = new URL(url);
    // 只填了域名、没有路径 → 补 /v1
    if (parsed.pathname === '/' || parsed.pathname === '') {
      return `${url}/v1/chat/completions`;
    }
  } catch {
    throw new Error('AI 接口地址格式不正确，请填写完整地址（例如 https://api.deepseek.com/v1）');
  }
  return `${url}/chat/completions`;
}

function buildHeaders(settings) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${settings.apiKey || ''}`,
  };
}

function buildBody(settings, messages, stream) {
  const body = {
    model: settings.model,
    messages,
    stream,
    temperature: clamp(Number(settings.temperature), 0, 2, 0.7),
  };
  const maxTokens = Number(settings.maxTokens);
  if (maxTokens > 0) body.max_tokens = Math.floor(maxTokens);
  return body;
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 发起一次对话请求，返回原始 fetch Response */
export async function requestChat({ settings, messages, stream = true, signal, timeoutMs = 120_000 }) {
  if (!settings.apiKey) throw new Error('尚未配置 API Key，请先到后台「AI 设置」里填写。');
  if (!settings.model) throw new Error('尚未配置模型名称，请先到后台「AI 设置」里填写。');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
  const onAbort = () => controller.abort(new Error('客户端已断开'));
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(resolveChatUrl(settings.baseUrl), {
      method: 'POST',
      headers: buildHeaders(settings),
      body: JSON.stringify(buildBody(settings, messages, stream)),
      signal: controller.signal,
    });
    // 超时定时器交给调用方在流结束后清理
    res._cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    return res;
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    throw err;
  }
}

/** 从上游错误响应里提取可读的错误信息 */
export async function readUpstreamError(res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      const raw = json?.error?.message ?? json?.message ?? text;
      // 上游不保证 message 一定是字符串（有返回对象/数字的），统一成字符串，
      // 否则下面的 .slice() 会抛 TypeError，把一次普通的 502 变成进程级异常。
      detail = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    } catch {
      detail = text;
    }
  } catch {
    /* ignore */
  }
  const hint =
    {
      401: 'API Key 无效或已过期',
      403: 'API Key 无权访问该模型',
      404: '接口地址或模型名称不正确',
      429: '请求过于频繁或额度不足',
    }[res.status] || '';
  return [`上游接口返回 ${res.status}${hint ? `（${hint}）` : ''}`, detail?.slice(0, 500)]
    .filter(Boolean)
    .join('：');
}

/**
 * 把上游的 SSE 流解析成纯文本增量。
 * @param {ReadableStream<Uint8Array>} body
 * @param {(delta: string, reasoning?: string) => void} onDelta
 */
export async function consumeStream(body, onDelta) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);

      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = json.choices?.[0];
      // 有些兼容接口会把错误塞进流里
      if (json.error) throw new Error(json.error.message || '上游返回错误');

      const delta = choice?.delta?.content ?? choice?.text ?? '';
      const reasoning = choice?.delta?.reasoning_content ?? '';
      if (delta || reasoning) {
        full += delta;
        onDelta(delta, reasoning);
      }
    }
  }
  return full;
}

/** 非流式的一次性调用，用于后台「测试连接」 */
export async function testConnection(settings) {
  const started = Date.now();
  const res = await requestChat({
    settings,
    messages: [
      { role: 'system', content: '你是一个测试助手。' },
      { role: 'user', content: '请只回复两个字：正常' },
    ],
    stream: false,
    timeoutMs: 30_000,
  });
  try {
    if (!res.ok) return { ok: false, error: await readUpstreamError(res) };

    const json = await res.json();
    const reply = json.choices?.[0]?.message?.content ?? '';
    return {
      ok: true,
      ms: Date.now() - started,
      model: json.model || settings.model,
      reply: String(reply).slice(0, 100),
    };
  } finally {
    res._cleanup?.();
  }
}
