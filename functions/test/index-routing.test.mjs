import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const sentiment = { sentiment: '50', summary: 'OpenRouter sentiment.', mostDiscussed: [], topQuotes: [] };
const geminiSentiment = { ...sentiment, summary: 'Gemini fallback sentiment.' };
const videoAnalysis = 'Analiza filmu Tomka.';
const videoUrl = 'https://www.youtube.com/watch?v=test-video';
const stateKey = Symbol.for('wykop.index-routing-test');

// Exercise the real entrypoint. All inference, Wykop writes, storage, and SDK
// calls stay inside isolated stubs and an allowlisted fetch mock.
async function runIndex(t, { routerStatus = 200, sentimentFailures = [], videoFailures = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wykop-index-routing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const file of ['main.js', 'ai-provider.js', 'ai-response.js', 'deployment-model.js', 'utils.js']) {
    await copyFile(new URL(`../wykop-index/src/${file}`, import.meta.url), join(dir, file));
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
        async createRow(row) {
          globalThis[Symbol.for('wykop.index-routing-test')].saved.push(row.data);
          return { $id: 'test-row' };
        }
      }
      export class Storage {
        async getFileDownload() { return Buffer.from('test image'); }
        async createFile() { return { $id: 'test-image' }; }
      }
      export const Query = { greaterThan() {}, orderAsc() {}, limit() {} };
      export const ID = { unique: () => 'test-id' };
    `,
    '@google/genai': `
      export class GoogleGenAI {
        constructor({ apiKey }) {
          this.models = { generateContent: request =>
            globalThis[Symbol.for('wykop.index-routing-test')].generate(apiKey, request) };
        }
      }
    `,
    '@napi-rs/canvas': `
      export const loadImage = async () => ({ width: 1433, height: 933 });
      export const createCanvas = (width, height) => ({
        width, height, getContext: () => new Proxy({}, { get: () => () => {} }),
        toBuffer: () => Buffer.from('generated test image'),
      });
    `,
  })) {
    const packageDir = join(dir, 'node_modules', name);
    await mkdir(packageDir, { recursive: true });
    const exports = name === 'node-appwrite' ? { '.': './index.js', './file': './file.js' } : './index.js';
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ type: 'module', exports }));
    await writeFile(join(packageDir, 'index.js'), source);
    if (name === 'node-appwrite') {
      await writeFile(join(packageDir, 'file.js'), 'export const InputFile = { fromBuffer: () => ({}) };');
    }
  }

  const fakeEnv = {
    APPWRITE_API_KEY: 'test-appwrite', WYKOP_API_KEY: 'test-wykop-key',
    WYKOP_API_SECRET: 'test-wykop-secret', WYKOP_REFRESH_TOKEN: 'test-refresh',
    AI_PROVIDER: 'gemini', OPENROUTER_API_KEY: 'test-router', OPENROUTER_MODEL: 'test/sentiment:free',
    GEMINI_API_KEY: 'test-gemini', GEMINI_MODEL: 'test-primary-model', GEMINI_FALLBACK_MODEL: 'test-fallback-model',
    BULLISH_VIDEO_URLS: '', BEARISH_VIDEO_URLS: '',
  };
  const previousEnv = Object.fromEntries(Object.keys(fakeEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, fakeEnv);
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-20T20:00:00Z') });
  const requests = [], sentimentGenerations = [], videoGenerations = [], saved = [], errors = [], delays = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    delays.push(delay);
    queueMicrotask(callback);
    return 0;
  });
  globalThis[stateKey] = {
    saved,
    generate(apiKey, request) {
      const isVideo = Array.isArray(request.contents);
      const generations = isVideo ? videoGenerations : sentimentGenerations;
      generations.push({ apiKey, ...request });
      const failure = (isVideo ? videoFailures : sentimentFailures)[generations.length - 1];
      if (failure) throw failure;
      return { text: isVideo ? videoAnalysis : JSON.stringify(geminiSentiment) };
    },
  };
  t.after(() => { delete globalThis[stateKey]; });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url, ...options });
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      if (routerStatus !== 200) return new Response(null, { status: routerStatus });
      return Response.json({ choices: [{ message: { content: JSON.stringify(sentiment) }, finish_reason: 'stop' }] });
    }
    if (url === 'https://www.youtube.com/feeds/videos.xml?channel_id=UCJttpsWBTN8vxv_YNUtHHWw') {
      return new Response('<feed><entry><yt:videoId>test-video</yt:videoId><title>Tomek</title><published>2026-11-20T12:00:00Z</published></entry></feed>');
    }
    if (['https://wykop.pl/api/v3/auth', 'https://wykop.pl/api/v3/refresh-token'].includes(url)) return Response.json({ data: { token: 'test-token' } });
    if (url === 'https://wykop.pl/api/v3/tags/gielda') return Response.json({ data: { followers: 100 } });
    if (url.startsWith('https://wykop.pl/api/v3/tags/gielda/stream?')) return Response.json({ data: [] });
    if (url === 'https://wykop.pl/api/v3/media/photos?type=comments') return Response.json({ data: { key: 'test-photo' } });
    if (url === 'https://wykop.pl/api/v3/entries') return Response.json({ data: { id: 999 } });
    if (url === 'https://wykop.pl/api/v3/entries/999/comments') return Response.json({ data: { id: 1000 } });
    assert.fail(`Unexpected request: ${options.method || 'GET'} ${url}`);
  });
  const { default: main } = await import(pathToFileURL(join(dir, 'main.js')).href);
  const result = await main({
    req: {}, res: { empty: () => ({ status: 204 }), json: (body, status) => ({ body, status }) },
    log() {}, error: message => errors.push(message),
  });
  assert.deepEqual(result, { status: 204 });
  assert.equal(saved.length, 1);
  const routerRequests = requests.filter(({ url }) => url === 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(routerRequests.length, 1);
  assert.equal(JSON.parse(routerRequests[0].body).model, 'test/sentiment:free');
  const posts = requests.filter(({ url, method }) => url === 'https://wykop.pl/api/v3/entries' && method === 'POST');
  assert.equal(posts.length, 1, 'provider routing must not duplicate the index post');
  return { sentimentGenerations, videoGenerations, saved: saved[0], errors, delays, post: JSON.parse(posts[0].body).data };
}

test('index uses OpenRouter sentiment and sends Tomek video directly to Gemini', async t => {
  const result = await runIndex(t);
  assert.deepEqual(result.errors, []);
  assert.equal(result.saved.summary, sentiment.summary);
  assert.equal(result.sentimentGenerations.length, 0);
  assert.equal(result.videoGenerations.length, 1);
  const video = result.videoGenerations[0];
  assert.equal(video.apiKey, 'test-gemini');
  assert.equal(video.model, 'test-primary-model');
  assert.equal(video.config.httpOptions.timeout, 60_000);
  assert.deepEqual(video.contents[0], { fileData: { fileUri: videoUrl } });
  assert.equal(JSON.parse(result.saved.tomekAnalysis).analysis, videoAnalysis);
  assert.match(result.post.content, /Analiza filmu Tomka/);
});

test('sentiment fallback retains Gemini retries and Tomek restarts with its primary model', async t => {
  const result = await runIndex(t, { routerStatus: 503, sentimentFailures: [new Error('503'), new Error('503')] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.saved.summary, geminiSentiment.summary);
  assert.deepEqual(result.sentimentGenerations.map(({ model }) => model), ['test-primary-model', 'test-primary-model', 'test-fallback-model']);
  assert.equal(result.videoGenerations[0].model, 'test-primary-model');
  assert.deepEqual(result.delays, [5000, 5000]);
});

test('Tomek retries stay on Gemini without repeating OpenRouter sentiment', async t => {
  const result = await runIndex(t, { videoFailures: [new Error('503'), new Error('503')] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.sentimentGenerations.length, 0);
  assert.deepEqual(result.videoGenerations.map(({ model }) => model), ['test-primary-model', 'test-primary-model', 'test-fallback-model']);
  assert.equal(JSON.parse(result.saved.tomekAnalysis).analysis, videoAnalysis);
  assert.deepEqual(result.delays, [5000, 5000]);
});

test('exhausted Gemini video analysis still publishes and saves the OpenRouter index', async t => {
  const result = await runIndex(t, { videoFailures: Array.from({ length: 3 }, () => new Error('503 UNAVAILABLE')) });
  assert.equal(result.saved.summary, sentiment.summary);
  assert.equal(result.saved.tomekAnalysis, null);
  assert.equal(result.sentimentGenerations.length, 0);
  assert.equal(result.videoGenerations.length, 3);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Failed to fetch\/analyze Tomek video/);
  assert.doesNotMatch(result.post.content, /Tomkowe Kreski/);
});
