import { INDEX_CRON, schedulerEnabled } from './scheduler.js';

export async function dispatchScheduled(controller, env) {
  if (controller.cron !== INDEX_CRON) {
    throw new Error('Unsupported scheduled cron for the index Worker.');
  }
  if (!schedulerEnabled(controller, env)) return;
  if (!Number.isFinite(controller.scheduledTime)) throw new Error('Invalid scheduled time.');
  const runId = new Date(controller.scheduledTime).toISOString().slice(0, 10);
  const stub = env.INDEX_RETRIES.getByName(`wykop-index:${runId}`);
  const state = await stub.start(controller.scheduledTime);
  try {
    const result = { runId, attempt: state.attempt, phase: state.phase };
    console.info(JSON.stringify({ event: 'index_run_scheduled', ...result }));
    return result;
  } finally {
    state[Symbol.dispose]?.();
    stub[Symbol.dispose]?.();
  }
}

export default {
  scheduled(controller, env, ctx) {
    controller.noRetry();
    ctx.waitUntil(dispatchScheduled(controller, env));
  },
  fetch() {
    return new Response('Not found', { status: 404 });
  },
};
