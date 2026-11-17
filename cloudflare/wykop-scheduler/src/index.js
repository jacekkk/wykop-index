import { runScheduled } from './scheduler.js';

export default {
  scheduled(controller, env, ctx) {
    controller.noRetry();
    ctx.waitUntil(runScheduled(controller, env));
  },
  fetch() {
    return new Response('Not found', { status: 404 });
  },
};
