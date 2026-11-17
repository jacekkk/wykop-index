import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { INDEX_CRON, POST_CRON } from '../src/scheduler.js';

const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const modules = await Promise.all(['index.js', 'scheduler.js'].map(async (name) => {
  const path = new URL(`../src/${name}`, import.meta.url);
  return { type: 'ESModule', path: fileURLToPath(path), contents: await readFile(path, 'utf8') };
}));

function runtime(t, respond) {
  const requests = [];
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      modules,
      modulesRoot: fileURLToPath(new URL('../', import.meta.url)),
      compatibilityDate: config.compatibility_date,
      cf: false,
      log: new Log(LogLevel.NONE),
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
        return respond();
      },
    }),
    telemetry: { enabled: false },
    enableDevRegistry: false,
  });
  t.after(() => mf.dispose());
  return { mf, requests };
}

test('Cloudflare runtime submits both scheduled jobs through its native fetch', async (t) => {
  const { mf, requests } = runtime(t, () => Response.json({ $id: 'runtime-execution' }, { status: 202 }));
  const worker = await mf.getWorker();
  for (const cron of [INDEX_CRON, POST_CRON]) {
    const result = await worker.scheduled({ cron });
    assert.equal(result.outcome, 'ok');
    assert.equal(result.noRetry, true);
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.url), [
    `https://appwrite.example.test/v1/functions/${config.vars.APPWRITE_WYKOP_INDEX_FUNCTION_ID}/executions`,
    `https://appwrite.example.test/v1/functions/${config.vars.APPWRITE_WYKOP_POST_FUNCTION_ID}/executions`,
  ]);
  for (const request of requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.project, config.vars.APPWRITE_PROJECT_ID);
    assert.equal(request.key, 'fake-runtime-test-key');
    assert.deepEqual(JSON.parse(request.body), { async: true, body: '{}' });
  }
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
