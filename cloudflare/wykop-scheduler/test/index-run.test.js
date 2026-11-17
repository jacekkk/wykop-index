import assert from 'node:assert/strict';
import test from 'node:test';
import { IndexRun, MAX_ATTEMPTS, POLL_DELAY_MS, RETRY_DELAY_MS } from '../src/index-run.js';

const scheduledTime = Date.parse('2026-11-17T19:10:00Z');

function harness(respond) {
  const values = new Map();
  const calls = [];
  const logs = [];
  const clock = { now: scheduledTime };
  const env = {
    SCHEDULER_ENABLED: 'true',
    APPWRITE_ENDPOINT: 'https://appwrite.example.test/v1',
    APPWRITE_PROJECT_ID: 'test-project',
    APPWRITE_WYKOP_INDEX_FUNCTION_ID: 'index-id',
    APPWRITE_API_KEY: 'fake-private-test-key',
  };
  const storage = {
    alarm: null,
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => { values.set(key, structuredClone(value)); },
    setAlarm: async (time) => { storage.alarm = time; },
    deleteAlarm: async () => { storage.alarm = null; },
  };
  let posts = 0;
  const dependencies = {
    now: () => clock.now,
    logger: { info: (message) => logs.push(JSON.parse(message)) },
    fetchImpl: async (url, request) => {
      calls.push({ url, ...request });
      if (request.method === 'POST') posts++;
      if (respond) return respond({ url, request, posts, env });
      return Response.json(request.method === 'POST'
        ? { $id: `execution-${posts}` }
        : { $id: `execution-${posts}`, status: 'completed', responseStatusCode: 200 }, { status: 200 });
    },
  };
  const makeRun = () => new IndexRun(storage, env, dependencies);
  const run = makeRun();
  async function fire(target = run) {
    assert.notEqual(storage.alarm, null);
    clock.now = storage.alarm;
    await target.alarm();
    return target.status();
  }
  return { run, makeRun, storage, values, calls, logs, clock, env, fire, postCount: () => posts };
}

test('index succeeds once and duplicate starts or alarms never resubmit it', async () => {
  const h = harness();
  await h.run.start(scheduledTime);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.fire()).phase, 'polling');
  assert.equal(h.storage.alarm, h.clock.now + POLL_DELAY_MS);
  assert.equal((await h.fire()).phase, 'succeeded');
  assert.equal(h.storage.alarm, null);
  await h.makeRun().start(scheduledTime);
  await h.makeRun().alarm();
  assert.equal(h.postCount(), 1);
  assert.ok(h.logs.some((log) => log.event === 'index_execution_succeeded'));
  assert.ok(!JSON.stringify([...h.values]).includes(h.env.APPWRITE_API_KEY));
});

test('index makes exactly ten retries, ten minutes after each confirmed failure', async () => {
  const h = harness(({ request, posts }) => Response.json(request.method === 'POST'
    ? { $id: `execution-${posts}` }
    : { $id: `execution-${posts}`, status: posts % 2 ? 'failed' : 'completed', responseStatusCode: 500 }));
  await h.run.start(scheduledTime);
  assert.equal(MAX_ATTEMPTS, 11);
  for (let attempt = 1; attempt <= 11; attempt++) {
    const submitted = await h.fire(h.makeRun());
    assert.equal(submitted.attempt, attempt);
    assert.equal(h.postCount(), attempt);
    const failed = await h.fire(h.makeRun());
    if (attempt < 11) {
      assert.equal(failed.phase, 'retry_wait');
      assert.equal(h.storage.alarm, h.clock.now + 600_000);
      h.clock.now = h.storage.alarm - 1;
      await h.makeRun().alarm();
      assert.equal(h.postCount(), attempt, 'an early or duplicate alarm must not bypass the ten-minute delay');
    } else {
      assert.equal(failed.phase, 'exhausted');
      assert.equal(h.storage.alarm, null);
    }
  }
  await h.makeRun().alarm();
  await h.makeRun().start(scheduledTime);
  assert.equal(h.postCount(), 11);
  assert.equal(h.logs.filter((log) => log.event === 'index_retry_scheduled').length, 10);
});

test('a raised limit resumes an exhausted run with only its remaining retries', async () => {
  const h = harness(({ request, posts }) => Response.json(request.method === 'POST'
    ? { $id: `execution-${6 + posts}` }
    : { $id: `execution-${6 + posts}`, status: 'failed', responseStatusCode: 500 }));
  const initial = await h.run.start(scheduledTime);
  await h.storage.put('run', { ...initial, attempt: 6, phase: 'exhausted', executionId: 'execution-6', nextActionAt: null });
  await h.storage.deleteAlarm();
  h.clock.now += 2 * 60 * 60_000;

  const resumed = await h.makeRun().start(scheduledTime);
  assert.equal(resumed.attempt, 6);
  assert.equal(resumed.phase, 'polling');
  assert.equal(resumed.executionId, 'execution-6');
  assert.equal(h.calls.length, 0, 'resuming must not submit immediately');
  assert.equal((await h.fire()).phase, 'retry_wait');
  assert.equal(h.calls[0].method, 'GET');
  assert.ok(h.calls[0].url.endsWith('/execution-6'));
  assert.equal(h.storage.alarm, h.clock.now + RETRY_DELAY_MS);
  const retryAt = h.storage.alarm;
  await h.makeRun().start(scheduledTime);
  assert.equal(h.storage.alarm, retryAt, 'duplicate starts must preserve the delay');

  for (let attempt = 7; attempt <= 11; attempt++) {
    assert.equal((await h.fire(h.makeRun())).attempt, attempt);
    await h.fire(h.makeRun());
  }
  assert.equal((await h.run.status()).phase, 'exhausted');
  assert.equal(h.postCount(), 5);
  assert.equal(h.storage.alarm, null);
  await h.makeRun().start(scheduledTime);
  assert.equal(h.storage.alarm, null);
});

test('a successful retry cancels the remaining attempts', async () => {
  const h = harness(({ request, posts }) => Response.json(request.method === 'POST'
    ? { $id: `execution-${posts}` }
    : { $id: `execution-${posts}`, status: posts === 1 ? 'failed' : 'completed', responseStatusCode: posts === 1 ? 500 : 204 }));
  await h.run.start(scheduledTime);
  await h.fire(); // Initial submission.
  await h.fire(); // Confirmed failure.
  await h.fire(); // Retry after ten minutes.
  assert.equal((await h.fire()).phase, 'succeeded');
  assert.equal(h.postCount(), 2);
  assert.equal(h.storage.alarm, null);
});

test('waiting, processing, and scheduled statuses poll the same execution without using retries', async () => {
  const statuses = ['waiting', 'processing', 'scheduled', 'completed'];
  const h = harness(({ request }) => Response.json(request.method === 'POST'
    ? { $id: 'execution-1' }
    : { $id: 'execution-1', status: statuses.shift(), responseStatusCode: 200 }));
  await h.run.start(scheduledTime);
  await h.fire();
  for (let poll = 0; poll < 4; poll++) {
    await h.fire(h.makeRun());
    assert.equal(h.postCount(), 1);
  }
  assert.equal((await h.run.status()).phase, 'succeeded');
  assert.ok(h.calls.filter((call) => call.method === 'GET').every((call) => call.url.endsWith('/execution-1')));
});

test('status read errors and missing execution.read permission never create another execution', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    let fail = true;
    const h = harness(({ request }) => {
      if (request.method === 'POST') return Response.json({ $id: 'execution-1' });
      return fail ? new Response('private upstream body', { status }) : Response.json({ $id: 'execution-1', status: 'completed', responseStatusCode: 200 });
    });
    await h.run.start(scheduledTime);
    await h.fire();
    const state = await h.fire();
    assert.equal(state.phase, 'polling');
    assert.equal(state.attempt, 1);
    assert.equal(h.storage.alarm, h.clock.now + ([401, 403, 404].includes(status) ? RETRY_DELAY_MS : POLL_DELAY_MS));
    fail = false;
    assert.equal((await h.fire(h.makeRun())).phase, 'succeeded');
    assert.equal(h.postCount(), 1);
    assert.ok(!JSON.stringify(h.logs).includes('private upstream body'));
  }
});

test('network failures, malformed status JSON, and mismatched IDs keep polling the original execution', async () => {
  for (const read of [
    () => { throw new Error('network failure fake-private-test-key'); },
    () => new Response('not JSON'),
    () => Response.json({ $id: 'different-id', status: 'completed', responseStatusCode: 500 }),
  ]) {
    const h = harness(({ request }) => request.method === 'POST' ? Response.json({ $id: 'execution-1' }) : read());
    await h.run.start(scheduledTime);
    await h.fire();
    await h.fire(h.makeRun());
    await h.fire(h.makeRun());
    assert.equal(h.postCount(), 1);
    assert.equal((await h.run.status()).phase, 'polling');
    assert.ok(!JSON.stringify(h.logs).includes(h.env.APPWRITE_API_KEY));
  }
});

test('ambiguous submission errors are never automatically resubmitted', async () => {
  for (const submit of [
    () => { throw new Error('lost response'); },
    () => new Response('private upstream body', { status: 500 }),
    () => new Response('not JSON', { status: 202 }),
    () => Response.json({}, { status: 202 }),
  ]) {
    const h = harness(submit);
    await h.run.start(scheduledTime);
    assert.equal((await h.fire()).phase, 'uncertain');
    assert.equal(h.storage.alarm, null);
    await h.makeRun().alarm();
    await h.makeRun().start(scheduledTime);
    assert.equal(h.postCount(), 1);
    assert.ok(!JSON.stringify(h.logs).includes('private upstream body'));
  }
});

test('a restart after an accepted POST but before saving its ID cannot submit twice', async () => {
  const h = harness();
  const put = h.storage.put;
  h.storage.put = async (key, value) => {
    if (value.phase === 'polling') throw new Error('simulated crash before persisting ID');
    return put(key, value);
  };
  await h.run.start(scheduledTime);
  await assert.rejects(h.fire(), /simulated crash/);
  assert.equal((await h.run.status()).phase, 'submitting');
  h.clock.now = (await h.run.status()).nextActionAt;
  await h.makeRun().alarm();
  assert.equal((await h.run.status()).phase, 'uncertain');
  assert.equal(h.postCount(), 1);
  assert.equal(h.storage.alarm, null);
});

test('disabling the scheduler pauses new attempts and resumes the persisted run when enabled', async () => {
  const h = harness();
  await h.run.start(scheduledTime);
  h.env.SCHEDULER_ENABLED = 'false';
  assert.equal((await h.fire()).phase, 'ready');
  assert.equal(h.postCount(), 0);
  assert.equal(h.storage.alarm, h.clock.now + RETRY_DELAY_MS);
  h.env.SCHEDULER_ENABLED = 'true';
  assert.equal((await h.fire(h.makeRun())).phase, 'polling');
  assert.equal(h.postCount(), 1);
});

test('retries keep their original function configuration but use the current secret', async () => {
  const h = harness();
  await h.run.start(scheduledTime);
  h.env.APPWRITE_ENDPOINT = 'https://different.example.test/v1';
  h.env.APPWRITE_PROJECT_ID = 'different-project';
  h.env.APPWRITE_WYKOP_INDEX_FUNCTION_ID = 'different-function';
  h.env.APPWRITE_API_KEY = 'rotated-private-key';
  await h.fire(h.makeRun());
  assert.equal(h.calls[0].url, 'https://appwrite.example.test/v1/functions/index-id/executions');
  assert.equal(h.calls[0].headers['X-Appwrite-Project'], 'test-project');
  assert.equal(h.calls[0].headers['X-Appwrite-Key'], 'rotated-private-key');
  assert.ok(!JSON.stringify([...h.values]).includes('private-key'));
});
