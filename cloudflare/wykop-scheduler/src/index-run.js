import { INDEX_CRON, executionRequest, runScheduled } from './scheduler.js';

export const RETRY_DELAY_MS = 10 * 60_000;
export const POLL_DELAY_MS = 30_000;
export const MAX_ATTEMPTS = 6; // Initial execution plus five retries.
const INDEX_VARIABLE = 'APPWRITE_WYKOP_INDEX_FUNCTION_ID';
const WATCHDOG_MS = 60_000;

// Kept independent of the Worker adapter so tests can advance a clock without
// waiting through an hour of real retries. Production storage is SQLite-backed.
export class IndexRun {
  constructor(storage, env, { now = Date.now, fetchImpl = fetch, logger = console } = {}) {
    this.storage = storage;
    this.env = env;
    this.now = now;
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.logger = logger;
  }

  async status() {
    return (await this.storage.get('run')) ?? null;
  }

  async save(state) {
    // No await between related writes: Durable Objects commit these atomically.
    const write = this.storage.put('run', state);
    const alarm = state.nextActionAt === null
      ? this.storage.deleteAlarm()
      : this.storage.setAlarm(state.nextActionAt);
    await Promise.all([write, alarm]);
  }

  log(event, state, extra = {}) {
    this.logger.info(JSON.stringify({
      event,
      functionName: 'wykop-index',
      runId: state.runId,
      attempt: state.attempt,
      ...(state.executionId ? { executionId: state.executionId } : {}),
      ...extra,
    }));
  }

  async finish(state, phase, event) {
    await this.save({ ...state, phase, nextActionAt: null });
    this.log(event, state);
  }

  async start(scheduledTime) {
    if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) throw new Error('Invalid scheduled time.');
    const runId = new Date(scheduledTime).toISOString().slice(0, 10);
    const previous = await this.status();
    if (previous) {
      if (previous.runId !== runId) throw new Error('Run identity does not match this coordinator.');
      return previous;
    }
    // Validate before recording a run. Pin public configuration for all retries;
    // credentials are read from the current secret and never stored in state.
    executionRequest(this.env, INDEX_VARIABLE);
    const state = {
      runId,
      scheduledTime,
      endpoint: this.env.APPWRITE_ENDPOINT,
      projectId: this.env.APPWRITE_PROJECT_ID,
      functionId: this.env[INDEX_VARIABLE],
      attempt: 0,
      phase: 'ready',
      nextActionAt: this.now(),
    };
    await this.save(state);
    return state;
  }

  environment(state) {
    return {
      ...this.env,
      APPWRITE_ENDPOINT: state.endpoint,
      APPWRITE_PROJECT_ID: state.projectId,
      [INDEX_VARIABLE]: state.functionId,
    };
  }

  async alarm() {
    const state = await this.status();
    if (!state || state.nextActionAt === null) return;
    if (this.now() < state.nextActionAt) {
      await this.storage.setAlarm(state.nextActionAt);
      return;
    }
    if (state.phase === 'submitting') {
      // Recovery after a crash between POST and saving its ID must not POST again.
      await this.finish(state, 'uncertain', 'index_submission_uncertain');
      return;
    }
    if (this.env.SCHEDULER_ENABLED !== 'true') {
      await this.save({ ...state, nextActionAt: this.now() + RETRY_DELAY_MS });
      this.log('index_run_paused', state);
      return;
    }
    if (state.phase === 'ready' || state.phase === 'retry_wait') {
      await this.submit(state);
    } else if (state.phase === 'polling') {
      await this.poll(state);
    }
  }

  async submit(state) {
    if (state.attempt >= MAX_ATTEMPTS) {
      await this.finish(state, 'exhausted', 'index_retries_exhausted');
      return;
    }
    const submitting = {
      ...state,
      attempt: state.attempt + 1,
      phase: 'submitting',
      executionId: null,
      nextActionAt: this.now() + WATCHDOG_MS,
    };
    await this.save(submitting);
    let result;
    try {
      result = await runScheduled(
        { cron: INDEX_CRON, scheduledTime: state.scheduledTime },
        this.environment(state),
        { fetchImpl: this.fetchImpl, logger: this.logger },
      );
    } catch {
      // Includes ambiguous submissions: only a known terminal execution failure
      // may cause another POST, never a lost response or an HTTP submission error.
      await this.finish(submitting, 'uncertain', 'index_submission_uncertain');
      return;
    }
    await this.save({ ...submitting, phase: 'polling', executionId: result.executionId, nextActionAt: this.now() + POLL_DELAY_MS });
  }

  async poll(state) {
    let result;
    try {
      const { url, headers } = executionRequest(this.environment(state), INDEX_VARIABLE);
      const response = await this.fetchImpl(`${url}/${encodeURIComponent(state.executionId)}`, {
        method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const error = new Error('Could not read Appwrite execution.');
        error.status = response.status;
        throw error;
      }
      result = await response.json();
      if (result?.$id !== state.executionId || typeof result.status !== 'string') throw new Error('Invalid execution status response.');
    } catch (error) {
      const delay = [401, 403, 404].includes(error.status) ? RETRY_DELAY_MS : POLL_DELAY_MS;
      await this.save({ ...state, nextActionAt: this.now() + delay });
      this.log('index_execution_read_failed', state, { httpStatus: error.status ?? null });
      return;
    }
    if (result.status === 'completed' && result.responseStatusCode >= 200 && result.responseStatusCode < 300) {
      await this.finish(state, 'succeeded', 'index_execution_succeeded');
    } else if (result.status === 'failed' || result.status === 'completed') {
      if (state.attempt >= MAX_ATTEMPTS) {
        await this.finish(state, 'exhausted', 'index_retries_exhausted');
      } else {
        const nextActionAt = this.now() + RETRY_DELAY_MS;
        await this.save({ ...state, phase: 'retry_wait', nextActionAt });
        this.log('index_retry_scheduled', state, { retry: state.attempt, nextActionAt });
      }
    } else {
      await this.save({ ...state, nextActionAt: this.now() + POLL_DELAY_MS });
      if (!['waiting', 'processing', 'scheduled'].includes(result.status)) this.log('index_execution_status_unknown', state);
    }
  }
}
