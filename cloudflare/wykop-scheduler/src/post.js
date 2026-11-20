import { POST_CRON, runScheduled } from './scheduler.js';

export async function dispatchPostScheduled(controller, env) {
  if (controller.cron !== POST_CRON) {
    throw new Error('Unsupported scheduled cron for the post Worker.');
  }
  return runScheduled(controller, env);
}

export default {
  scheduled(controller, env, ctx) {
    controller.noRetry();
    ctx.waitUntil(dispatchPostScheduled(controller, env));
  },
  fetch() {
    return new Response('Not found', { status: 404 });
  },
};
