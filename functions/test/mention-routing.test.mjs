import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Run the real entrypoint with isolated SDK stubs and an allowlisted fetch mock.
// Every request, including Wykop writes, stays inside this test process.
async function runMentions(t, { comments = [], failures = [], idle = false, noBackupKey = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wykop-mention-routing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const file of ['main.js', 'ai-response.js', 'utils.js']) {
    await copyFile(new URL(`../wykop-post/src/${file}`, import.meta.url), join(dir, file));
  }
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries({
    'node-appwrite': `
      export class Client {
        setEndpoint() { return this; }
        setProject() { return this; }
        setKey() { return this; }
      }
      export class TablesDB {
        async listRows() { return { rows: [] }; }
      }
      export const Query = { orderDesc() {}, limit() {} };
    `,
    '@google/genai': `
      export class GoogleGenAI {
        constructor({ apiKey }) {
          this.models = { generateContent: request =>
            globalThis[Symbol.for('wykop.mention-test')].generate(apiKey, request) };
        }
      }
    `,
  })) {
    const packageDir = join(dir, 'node_modules', name);
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, 'package.json'), '{"type":"module","exports":"./index.js"}');
    await writeFile(join(packageDir, 'index.js'), source);
  }

  const fakeEnv = {
    APPWRITE_API_KEY: 'test-appwrite', WYKOP_REFRESH_TOKEN: 'test-wykop',
    AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test-openrouter', OPENROUTER_MODEL: 'other/model:free',
    GEMINI_API_KEY: 'test-primary', GEMINI_BACKUP_API_KEY: noBackupKey ? '' : 'test-backup',
    GEMINI_MODEL: 'test-primary-model', GEMINI_FALLBACK_MODEL: 'test-fallback-model',
    SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'test-search',
  };
  const previousEnv = Object.fromEntries(Object.keys(fakeEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, fakeEnv);
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // Avoid time-dependent earnings paths and keep notification freshness deterministic.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-18T12:00:00Z') });
  const requests = [], generations = [], logs = [], errors = [];
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    delays.push(delay);
    queueMicrotask(callback);
    return 0;
  });
  const stateKey = Symbol.for('wykop.mention-test');
  globalThis[stateKey] = {
    generate(apiKey, request) {
      generations.push({ apiKey, ...request });
      const failure = failures[generations.length - 1];
      if (failure) throw failure;
      return { text: '[]' };
    },
  };
  t.after(() => { delete globalThis[stateKey]; });

  const notification = {
    id: 'notification-1', type: 'new_comment_in_entry', read: 0, created_at: '2026-11-18 13:00:00',
    entry: {
      id: 123, tags: ['gielda'], content: 'Dyskusja o wynikach.',
      author: { username: 'author' }, votes: { up: 2 }, created_at: '2026-11-18 12:30:00',
    },
    comment: { content: '@KrachSmieciuchIndex co sadzisz o wynikach?', author: { username: 'user' } },
  };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url, ...options });
    if (url === 'https://wykop.pl/api/v3/refresh-token') return Response.json({ data: { token: 'test-token' } });
    if (url === 'https://wykop.pl/api/v3/notifications/entries?page=1') return Response.json({ data: idle ? [] : [notification] });
    if (url === 'https://wykop.pl/api/v3/notifications/entries?page=2') return Response.json({ data: [] });
    if (url === 'https://wykop.pl/api/v3/entries/123/comments?page=1&limit=50') return Response.json({ data: comments });
    if (url === 'https://api.tavily.com/search') return Response.json({ results: [{ title: 'Wyniki', url: 'https://example.com/results', content: 'Dane z raportu.' }] });
    if (url === 'https://example.com/chart.png') return new Response('test image bytes', { headers: { 'Content-Type': 'image/png' } });
    if (url === 'https://wykop.pl/api/v3/notifications/entries/notification-1' && options.method === 'PUT') return Response.json({});
    assert.fail(`Unexpected request: ${options.method || 'GET'} ${url}`);
  });
  const { default: main } = await import(pathToFileURL(join(dir, 'main.js')).href);
  const result = await main({
    req: {},
    res: { empty: () => ({ status: 204 }), json: (body, status) => ({ body, status }) },
    log: message => logs.push(message), error: message => errors.push(message),
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(result, { status: 204 });
  assert.ok(requests.every(request => !request.url.startsWith('https://openrouter.ai/')));
  return { generations, requests, delays, logs };
}

test('text-only mentions use Gemini even with OpenRouter explicitly configured', async t => {
  const { generations } = await runMentions(t);
  assert.equal(generations.length, 1);
  assert.equal(generations[0].apiKey, 'test-primary');
  assert.equal(generations[0].model, 'test-primary-model');
  assert.deepEqual(generations[0].config.tools, [{ urlContext: {} }]);
  const prompt = generations[0].contents.at(-1).text;
  assert.match(prompt, /Dane z raportu/);
  assert.match(prompt, /questionToAnswer/);
});

test('Gemini receives images and YouTube embeds from other comments in the same thread', async t => {
  const { generations } = await runMentions(t, { comments: [{
    id: 456, author: { username: 'another-user' }, content: 'Zalaczniki do dyskusji.',
    votes: { up: 1 }, created_at: '2026-11-18 12:45:00',
    media: { photo: { url: 'https://example.com/chart.png' }, embed: { url: 'https://www.youtube.com/watch?v=test-video' } },
  }] });
  assert.equal(generations.length, 1);
  assert.deepEqual(generations[0].contents[0], {
    inlineData: { mimeType: 'image/png', data: Buffer.from('test image bytes').toString('base64') },
  });
  assert.deepEqual(generations[0].contents[1], { fileData: { fileUri: 'https://www.youtube.com/watch?v=test-video' } });
});

test('mention retries retain the primary/backup key and model sequence', async t => {
  const { generations, delays } = await runMentions(t, { failures: Array.from({ length: 3 }, () => new Error('503 UNAVAILABLE')) });
  assert.deepEqual(generations.map(({ apiKey, model }) => [apiKey, model]), [
    ['test-primary', 'test-primary-model'], ['test-backup', 'test-primary-model'],
    ['test-primary', 'test-fallback-model'], ['test-backup', 'test-fallback-model'],
  ]);
  assert.deepEqual(delays, [5000, 5000, 5000]);
  assert.ok(generations.every(({ config }) => config.httpOptions.timeout === 45_000));
});

test('mention retries reuse the primary key when no backup key exists', async t => {
  const { generations } = await runMentions(t, { noBackupKey: true, failures: [new Error('503 UNAVAILABLE')] });
  assert.deepEqual(generations.map(({ apiKey }) => apiKey), ['test-primary', 'test-primary']);
});

test('an idle poll makes no Gemini or OpenRouter generation request', async t => {
  const { generations } = await runMentions(t, { idle: true });
  assert.equal(generations.length, 0);
});
