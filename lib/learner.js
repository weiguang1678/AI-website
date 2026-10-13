import { learnGreetings } from './greetings.js';

/** 多久检查一次「今天该跑了吗」 */
const TICK_MS = 60_000;

function atHour(hour, base = new Date()) {
  const d = new Date(base);
  d.setHours(Math.max(0, Math.min(23, Number(hour) || 0)), 0, 0, 0);
  return d;
}

/** 最近一次「按理说已经跑过」的时刻（今天到点了就是今天，否则是昨天） */
export function lastDueAt(settings, now = new Date()) {
  const d = atHour(settings.greetingAutoLearnHour, now);
  if (d > now) d.setDate(d.getDate() - 1);
  return d;
}

/** 下次自动学习的时间；没开启或没配好接口时返回 null（给后台展示用） */
export function nextRunAt(settings, now = new Date()) {
  if (!settings.greetingAutoLearn) return null;
  if (!settings.apiKey || !settings.model || !settings.baseUrl) return null;
  const d = atHour(settings.greetingAutoLearnHour, now);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** 到点了但今天还没学过的那些库（「所有库都学」） */
export function dueLibraries(ctx, now = new Date()) {
  const dueAt = lastDueAt(ctx.settings(), now);
  return ctx.store.greetingLibraries.filter(
    (lib) => !lib.learn.lastRunAt || new Date(lib.learn.lastRunAt) < dueAt,
  );
}

/** 现在是否该跑了（总开关打开 + 接口配好了才算） */
export function isDue(ctx, now = new Date()) {
  const s = ctx.settings();
  if (!s.greetingAutoLearn) return false;
  // 接口没配好就静静等着，不推进 lastRunAt，配好后下一个整点就会自己补上
  if (!s.apiKey || !s.model || !s.baseUrl) return false;
  return dueLibraries(ctx, now).length > 0;
}

/**
 * 启动后台定时学习。每分钟醒一次看看到点没有，到点才真正调模型。
 * 所有库依次学习（一个库一次模型调用），单次失败不影响后面的库。
 * 定时器 unref，不会拖住进程退出。
 */
export function startGreetingLearner(ctx) {
  const state = { running: false };

  async function tick() {
    if (state.running || !isDue(ctx)) return;
    state.running = true;
    try {
      const s = ctx.settings();
      for (const lib of dueLibraries(ctx)) {
        const r = await learnGreetings(ctx, s, {
          libraryId: lib.id,
          count: s.greetingLearnBatch,
          reason: 'auto',
        });
        console.log(
          `[learner]「${lib.name}」自动学习完成：新增 ${r.added} 条，淘汰 ${r.retired} 条`
          + (r.error ? `（${r.error}）` : ''),
        );
      }
    } catch (err) {
      console.error('[learner] 自动学习失败：', err.message);
    } finally {
      state.running = false;
    }
  }

  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  // 启动 15 秒后先查一次，把「关机期间错过的」补上
  const warmup = setTimeout(tick, 15_000);
  warmup.unref?.();

  return {
    tick,
    stop() { clearInterval(timer); clearTimeout(warmup); },
  };
}
