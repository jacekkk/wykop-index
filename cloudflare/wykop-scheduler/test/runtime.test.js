import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { INDEX_CRON, POST_CRON } from '../src/scheduler.js';

const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const modules = await Promise.all(['index.js', 'scheduler.js', 'worker.js', 'index-run.js', 'index-retry.js'].map(async (name) => {
  const path = new URL(`../src/${name}`, import.meta.url);
  return { type: 'ESModule', path: fileURLToPath(path), contents: await readFile(path, 'utf8') };
}));

function runtime(t, respond) {
  const requests = [];
  const persistence = mkdtempSync(join(tmpdir(), 'wykop-scheduler-runtime-'));
  const options = {
    ...convertV4MiniflareOptions({
      name: 'scheduler-runtime-test',
      modules,
      modulesRoot: fileURLToPath(new URL('../', import.meta.url)),
      compatibilityDate: config.compatibility_date,
      cf: false,
      log: new Log(LogLevel.NONE),
      durableObjects: { INDEX_RETRIES: { className: 'IndexRetryCoordinator', useSQLite: true } },
      bindings: {
        ...config.vars,
        SCHEDULER_ENABLED: 'true',
        APPWRITE_ENDPOINT: 'https://appwrite.example.test/v1',
        APPWRITE_API_KEY: 'fake-runtime-test-key',
      },
      outboundService: async (request) => {
        requests.push({
          url: request.url,
          method: request.method,
          project: request.headers.get('X-Appwrite-Project'),
          key: request.headers.get('X-Appwrite-Key'),
          body: await request.text(),
        });
        return respond(request);
      },
    }),
    telemetry: { enabled: false },
    enableDevRegistry: false,
    resourcePersistencePath: persistence,
  };
  let mf = new Miniflare(options);
  t.after(async () => { await mf.dispose(); rmSync(persistence, { recursive: true, force: true }); });
  return {
    mf,
    requests,
    restart: async () => { await mf.dispose(); mf = new Miniflare(options); return mf; },
  };
}

async function waitForPolling(stub) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await snapshot(stub);
    if (state?.phase === 'polling') return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Index run did not reach polling: ${JSON.stringify(await snapshot(stub))}`);
}

async function snapshot(stub) {
  const state = await stub.getStatus();
  if (state === null) return null;
  try {
    return {
      runId: state.runId,
      attempt: state.attempt,
      phase: state.phase,
      executionId: state.executionId,
      nextActionAt: state.nextActionAt,
    };
  } finally { state[Symbol.dispose]?.(); }
}

test('Cloudflare runtime submits both scheduled jobs through its native fetch', async (t) => {
  const { mf, requests, restart } = runtime(t, () => Response.json({ $id: 'runtime-execution' }, { status: 202 }));
  const worker = await mf.getWorker();
  const scheduledTime = new Date('2026-11-17T19:10:00Z');
  for (const cron of [INDEX_CRON, POST_CRON]) {
    const result = await worker.scheduled({ cron, scheduledTime });
    assert.equal(result.outcome, 'ok');
    assert.equal(result.noRetry, true);
  }
  const bindings = await mf.getBindings();
  const stub = bindings.INDEX_RETRIES.getByName('wykop-index:2026-11-17');
  const persisted = await waitForPolling(stub);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.url).sort(), [
    `https://appwrite.example.test/v1/functions/${config.vars.APPWRITE_WYKOP_INDEX_FUNCTION_ID}/executions`,
    `https://appwrite.example.test/v1/functions/${config.vars.APPWRITE_WYKOP_POST_FUNCTION_ID}/executions`,
  ].sort());
  for (const request of requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.project, config.vars.APPWRITE_PROJECT_ID);
    assert.equal(request.key, 'fake-runtime-test-key');
    assert.deepEqual(JSON.parse(request.body), { async: true, body: '{}' });
  }
  stub[Symbol.dispose]?.();
  const restarted = await restart();
  const reloadedBindings = await restarted.getBindings();
  const reloaded = reloadedBindings.INDEX_RETRIES.getByName('wykop-index:2026-11-17');
  assert.deepEqual(await snapshot(reloaded), persisted, 'SQLite state must survive a complete runtime restart');
  reloaded[Symbol.dispose]?.();
  const restartedWorker = await restarted.getWorker();
  await restartedWorker.scheduled({ cron: INDEX_CRON, scheduledTime });
  assert.equal(requests.length, 2, 'a duplicate cron after restart must not submit another execution');
});

test('Cloudflare runtime refuses redirects without forwarding credentials', async (t) => {
  const { mf, requests } = runtime(t, () => new Response(null, {
    status: 302,
    headers: { Location: 'https://redirect.example.test/collect' },
  }));
  const worker = await mf.getWorker();
  const result = await worker.scheduled({ cron: POST_CRON });
  assert.equal(result.outcome, 'exception');
  assert.equal(result.noRetry, true);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.startsWith('https://appwrite.example.test/'));
});

test('the internal permission check reads execution access without starting a function', async (t) => {
  const { mf, requests } = runtime(t, () => new Response('private error body', { status: 403 }));
  const bindings = await mf.getBindings();
  const stub = bindings.INDEX_RETRIES.getByName('permission-check');
  const access = await stub.checkAccess();
  assert.equal(access.ok, false);
  assert.equal(access.httpStatus, 403);
  access[Symbol.dispose]?.();
  assert.equal(await stub.getStatus(), null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal((await mf.dispatchFetch('https://worker.example.test/check-access')).status, 404);
  assert.equal(requests.length, 1);
});
