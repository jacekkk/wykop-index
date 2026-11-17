import { DurableObject } from 'cloudflare:workers';
import { IndexRun } from './index-run.js';
import { executionRequest } from './scheduler.js';

export class IndexRetryCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.run = new IndexRun(ctx.storage, env);
  }

  async start(scheduledTime) {
    return this.run.start(scheduledTime);
  }

  async getStatus() {
    return this.run.status();
  }

  async alarm() {
    await this.run.alarm();
  }

  // Internal RPC only: verify execution.read without triggering any function or
  // returning execution contents. The Worker's public HTTP handler stays 404.
  async checkAccess() {
    const { url, headers } = executionRequest(this.env, 'APPWRITE_WYKOP_INDEX_FUNCTION_ID');
    const response = await fetch(url, {
      method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    return { ok: response.ok, httpStatus: response.status };
  }
}
