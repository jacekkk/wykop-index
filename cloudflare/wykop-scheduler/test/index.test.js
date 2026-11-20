import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import worker, { dispatchScheduled } from '../src/worker.js';
import { INDEX_CRON, POST_CRON, runScheduled } from '../src/scheduler.js';

const env = {
  SCHEDULER_ENABLED: 'true',
  APPWRITE_ENDPOINT: 'https://appwrite.example.test/v1/',
  APPWRITE_PROJECT_ID: 'test-project',
  APPWRITE_WYKOP_INDEX_FUNCTION_ID: 'index-id',
  APPWRITE_WYKOP_POST_FUNCTION_ID: 'post-id',
  APPWRITE_API_KEY: 'test-secret-never-log',
};
const controller = (cron = POST_CRON) => ({ cron, scheduledTime: 1_800_000_000_000 });

function harness(fetchImpl = async () => Response.json({ $id: 'execution-id', status: 'waiting' }, { status: 202 })) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    dependencies: {
      fetchImpl: async (...args) => {
        calls.push(args);
        return fetchImpl(...args);
      },
      logger: { info: (message) => logs.push(JSON.parse(message)) },
    },
  };
}

test('both crons submit the correct asynchronous Appwrite execution', async () => {
  for (const [cron, functionName, variable] of [
    [INDEX_CRON, 'wykop-index', 'APPWRITE_WYKOP_INDEX_FUNCTION_ID'],
    [POST_CRON, 'wykop-post', 'APPWRITE_WYKOP_POST_FUNCTION_ID'],
  ]) {
    const h = harness();
    const config = { ...env, [variable]: 'function/with spaces' };
    const result = await runScheduled(controller(cron), config, h.dependencies);
    assert.deepEqual(result, { functionName, executionId: 'execution-id' });
    assert.equal(h.calls.length, 1);
    const [url, request] = h.calls[0];
    assert.equal(url, 'https://appwrite.example.test/v1/functions/function%2Fwith%20spaces/executions');
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.headers, {
      'X-Appwrite-Project': env.APPWRITE_PROJECT_ID,
      'X-Appwrite-Key': env.APPWRITE_API_KEY,
      'Content-Type': 'application/json',
    });
    assert.deepEqual(JSON.parse(request.body), { async: true, body: '{}' });
    assert.equal(request.redirect, 'manual');
    assert.ok(request.signal instanceof AbortSignal);
    assert.equal(request.signal.aborted, false);
    assert.deepEqual(h.logs, [{
      event: 'appwrite_execution_submitted',
      ...result,
      cron,
      scheduledTime: controller(cron).scheduledTime,
    }]);
    assert.ok(!JSON.stringify(h.logs).includes(env.APPWRITE_API_KEY));
  }
});

test('disabled, unknown, and invalid configurations never reach Appwrite', async () => {
  const paused = harness();
  await runScheduled(controller(), { SCHEDULER_ENABLED: 'false' }, paused.dependencies);
  assert.equal(paused.calls.length, 0);
  assert.deepEqual(paused.logs, [{ event: 'scheduler_disabled', cron: POST_CRON }]);

  const h = harness();
  await assert.rejects(runScheduled(controller('0 0 * * *'), env, h.dependencies), /Unsupported scheduled cron/);
  for (const flag of [undefined, '', 'TRUE', true]) {
    await assert.rejects(runScheduled(controller(), { ...env, SCHEDULER_ENABLED: flag }, h.dependencies), /SCHEDULER_ENABLED/);
  }
  for (const variable of ['APPWRITE_ENDPOINT', 'APPWRITE_PROJECT_ID', 'APPWRITE_API_KEY', 'APPWRITE_WYKOP_POST_FUNCTION_ID']) {
    for (const value of [undefined, '', '  ']) {
      await assert.rejects(runScheduled(controller(), { ...env, [variable]: value }, h.dependencies), new RegExp(variable));
    }
  }
  await assert.rejects(runScheduled(controller(INDEX_CRON), { ...env, APPWRITE_WYKOP_INDEX_FUNCTION_ID: '' }, h.dependencies), /APPWRITE_WYKOP_INDEX_FUNCTION_ID/);
  for (const endpoint of [
    'not a URL',
    'http://appwrite.example.test/v1',
    'https://username:password@appwrite.example.test/v1',
    'https://appwrite.example.test/v1?key=secret',
    'https://appwrite.example.test/v1#fragment',
  ]) {
    await assert.rejects(runScheduled(controller(), { ...env, APPWRITE_ENDPOINT: endpoint }, h.dependencies), /HTTPS URL without credentials/);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.logs.length, 0);
});

test('HTTP and network failures are not retried or logged as accepted submissions', async () => {
  for (const status of [302, 401, 403, 429, 500, 503]) {
    const h = harness(async () => new Response(env.APPWRITE_API_KEY, { status }));
    await assert.rejects(runScheduled(controller(), env, h.dependencies), (error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.match(error.message, /no automatic retry/);
      assert.ok(!error.message.includes(env.APPWRITE_API_KEY));
      return true;
    });
    assert.equal(h.calls.length, 1);
    assert.equal(h.logs.length, 0);
  }
  for (const error of [new TypeError(`Network failure: ${env.APPWRITE_API_KEY}`), new DOMException('Timed out', 'TimeoutError')]) {
    const h = harness(async () => { throw error; });
    await assert.rejects(runScheduled(controller(), env, h.dependencies), (failure) => {
      assert.match(failure.message, /submission could not be confirmed/);
      assert.ok(!failure.message.includes(env.APPWRITE_API_KEY));
      return true;
    });
    assert.equal(h.calls.length, 1);
    assert.equal(h.logs.length, 0);
  }
});

test('malformed success responses never cause a second submission', async () => {
  for (const payload of ['not JSON', '{}', 'null', '{"$id":123}', '{"$id":" "}']) {
    const h = harness(async () => new Response(payload, { status: 202 }));
    await assert.rejects(runScheduled(controller(), env, h.dependencies), /invalid JSON|no execution ID/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.logs.length, 0);
  }
});

test('the Worker tracks scheduled work and errors, disables platform retries, and rejects HTTP triggers', async (t) => {
  const requests = t.mock.method(globalThis, 'fetch', async () => Response.json({ $id: 'worker-execution' }, { status: 202 }));
  t.mock.method(console, 'info', () => {});
  const pending = [];
  let noRetryCalls = 0;
  const event = { ...controller(), noRetry: () => { noRetryCalls++; } };
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  worker.scheduled(event, env, ctx);
  assert.equal(noRetryCalls, 1);
  assert.equal(pending.length, 1);
  assert.deepEqual(await pending[0], { functionName: 'wykop-post', executionId: 'worker-execution' });
  assert.equal(requests.mock.callCount(), 1);

  worker.scheduled(event, { ...env, APPWRITE_API_KEY: '' }, ctx);
  await assert.rejects(pending[1], /APPWRITE_API_KEY/);
  assert.equal(noRetryCalls, 2);
  assert.equal(requests.mock.callCount(), 1);

  const response = await worker.fetch(new Request('https://worker.example.test/?cron=*/5'), env, ctx);
  assert.equal(response.status, 404);
  assert.equal(requests.mock.callCount(), 1);
});

test('deployment configuration matches Appwrite and GitHub workflows allow only manual runs', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const appwrite = JSON.parse(await readFile(new URL('../../../appwrite.config.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.triggers.crons, [INDEX_CRON, POST_CRON]);
  assert.equal(config.vars.APPWRITE_ENDPOINT, appwrite.endpoint);
  assert.equal(config.vars.APPWRITE_PROJECT_ID, appwrite.projectId);
  assert.equal(config.vars.APPWRITE_WYKOP_INDEX_FUNCTION_ID, appwrite.functions.find((fn) => fn.name === 'wykop-index').$id);
  assert.equal(config.vars.APPWRITE_WYKOP_POST_FUNCTION_ID, appwrite.functions.find((fn) => fn.name === 'wykop-post').$id);
  assert.ok(['true', 'false'].includes(config.vars.SCHEDULER_ENABLED));
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.durable_objects.bindings, [{ name: 'INDEX_RETRIES', class_name: 'IndexRetryCoordinator' }]);
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['IndexRetryCoordinator'] }]);
  for (const name of ['wykop-index', 'wykop-post']) {
    const workflow = await readFile(new URL(`../../../.github/workflows/run-${name}.yml`, import.meta.url), 'utf8');
    assert.match(workflow, /^  workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /^  schedule:/m);
  }
});

test('a Friday weekday cron selects one durable index run for that UTC date', async (t) => {
  const calls = [];
  t.mock.method(console, 'info', () => {});
  const config = {
    ...env,
    INDEX_RETRIES: {
      getByName(name) {
        return { start: async (scheduledTime) => { calls.push({ name, scheduledTime }); return { phase: 'ready', attempt: 0 }; } };
      },
    },
  };
  const scheduledTime = Date.parse('2026-11-20T19:10:00Z');
  // Use the external Cron Trigger expression, independent of the routing constant.
  await dispatchScheduled({ cron: '10 19 * * MON-FRI', scheduledTime }, config);
  assert.deepEqual(calls, [{ name: 'wykop-index:2026-11-20', scheduledTime }]);
  await assert.rejects(dispatchScheduled({ cron: INDEX_CRON, scheduledTime: NaN }, config), /Invalid scheduled time/);
  assert.equal(calls.length, 1);
});
