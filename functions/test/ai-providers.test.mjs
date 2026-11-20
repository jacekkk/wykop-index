import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { generateJson as indexGenerate, DEFAULT_OPENROUTER_MODEL } from '../wykop-index/src/ai-provider.js';
import { SENTIMENT_RESPONSE_SCHEMA, parseSentimentResponse } from '../wykop-index/src/ai-response.js';
import { parseRepliesResponse } from '../wykop-post/src/ai-response.js';
import { applyCurrentQuoteGuard } from '../wykop-post/src/utils.js';

const sentiment = {
  sentiment: '35', summary: 'Przewaza ostroznosc.',
  mostDiscussed: [{ asset: 'XTB', reasoning: 'Dyskusja o wynikach.', url: 'https://wykop.pl/wpis/123' }],
  topQuotes: [{ username: 'user', sentiment: 'BEARISH', quote: 'Dokladny cytat.', url: 'https://wykop.pl/wpis/123' }],
};
const replies = [{ postId: '123', username: 'user', url: 'https://wykop.pl/wpis/123', post: 'Pytanie', reply: 'Odpowiedz.' }];
const completion = (value, extra = {}) => Response.json({ choices: [{
  message: { content: JSON.stringify(value) }, finish_reason: 'stop', ...extra,
}] });

const schema = SENTIMENT_RESPONSE_SCHEMA;
const value = sentiment;
const parse = parseSentimentResponse;

const geminiResult = { ...sentiment, summary: 'Zweryfikowany wynik Gemini.' };
const unavailable = async () => { throw new Error('private Gemini failure'); };

function harness({ generateGemini = async () => geminiResult, fetchImpl = async () => completion(value), ...options } = {}) {
  const requests = [], logs = [], events = [];
  let geminiCalls = 0;
  const args = {
    prompt: 'Polskie pytanie. Wyniki wyszukiwania: https://example.com/source',
    systemInstruction: 'Odpowiadaj po polsku. Nie wymyslaj danych.',
    responseSchema: schema,
    parseResponse: parse,
    env: { OPENROUTER_API_KEY: 'fake-private-router-key' },
    generateGemini: async () => {
      geminiCalls++;
      events.push('gemini');
      return generateGemini();
    },
    fetchImpl: async (url, request) => {
      events.push('openrouter');
      requests.push({ url, ...request });
      return fetchImpl(url, request);
    },
    log: message => logs.push(message),
    ...options,
  };
  return { args, requests, logs, events, geminiCalls: () => geminiCalls, run: () => indexGenerate(args) };
}

test('index: Gemini is primary, including with configured OpenRouter and legacy provider settings', async () => {
  for (const env of [
    {},
    { OPENROUTER_API_KEY: 'fake-key' },
    { AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'fake-key' },
    { AI_PROVIDER: 'gemini', OPENROUTER_API_KEY: 'fake-key' },
    { AI_PROVIDER: 'openrouter' },
  ]) {
    const h = harness({ env });
    assert.equal(await h.run(), geminiResult);
    assert.equal(h.geminiCalls(), 1);
    assert.equal(h.requests.length, 0);
  }
});

test('index: healthy Gemini does not depend on runtime OpenRouter model configuration', async () => {
  const h = harness({ env: { OPENROUTER_API_KEY: 'fake-key', OPENROUTER_MODEL: 'paid/model' } });
  assert.equal(await h.run(), geminiResult);
  assert.equal(h.requests.length, 0);
});

test('index: OpenRouter waits for the complete Gemini attempt sequence to fail', async () => {
  let failGemini;
  const gemini = new Promise((_resolve, reject) => { failGemini = reject; });
  const h = harness({ generateGemini: () => gemini });
  const pending = h.run();
  await Promise.resolve();
  assert.deepEqual(h.events, ['gemini']);
  assert.equal(h.requests.length, 0);
  failGemini(new Error('Gemini retries exhausted'));
  assert.deepEqual(await pending, sentiment);
  assert.deepEqual(h.events, ['gemini', 'openrouter']);
});

test('index: free OpenRouter fallback keeps Polish instructions, sources, and the JSON contract', async () => {
  const h = harness({ generateGemini: unavailable });
  assert.deepEqual(await h.run(), sentiment);
  assert.equal(h.geminiCalls(), 1);
  assert.equal(h.requests.length, 1);
  const request = h.requests[0], body = JSON.parse(request.body);
  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer fake-private-router-key');
  assert.equal(request.redirect, 'manual');
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(body.model, DEFAULT_OPENROUTER_MODEL);
  assert.deepEqual(body.messages, [{ role: 'system', content: h.args.systemInstruction }, { role: 'user', content: h.args.prompt }]);
  assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0, request: 0 });
  assert.equal(body.provider.require_parameters, true);
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema, schema);
  assert.ok(!/private/.test(JSON.stringify(h.logs)));
});

test('index: legacy AI_PROVIDER=gemini does not disable the configured OpenRouter fallback', async () => {
  const h = harness({ generateGemini: unavailable, env: { AI_PROVIDER: 'gemini', OPENROUTER_API_KEY: 'fake-key' } });
  assert.deepEqual(await h.run(), sentiment);
  assert.deepEqual(h.events, ['gemini', 'openrouter']);
});

test('index: a Gemini validation failure can use the OpenRouter fallback', async () => {
  const h = harness({ generateGemini: async () => parse('not JSON') });
  assert.deepEqual(await h.run(), sentiment);
  assert.equal(h.requests.length, 1);
});

test('index: absent or blank fallback keys preserve the original Gemini error', async () => {
  for (const env of [{}, { OPENROUTER_API_KEY: ' \n ' }]) {
    const geminiError = new Error('Gemini retries exhausted');
    const h = harness({ env, generateGemini: async () => { throw geminiError; } });
    await assert.rejects(h.run(), error => error === geminiError);
    assert.equal(h.requests.length, 0);
    assert.equal(h.geminiCalls(), 1);
  }
});

test('index: the configured fallback model is trimmed and sent to OpenRouter', async () => {
  const h = harness({ generateGemini: unavailable, env: { OPENROUTER_API_KEY: 'fake-key', OPENROUTER_MODEL: ' other/model:free ' } });
  await h.run();
  assert.equal(JSON.parse(h.requests[0].body).model, 'other/model:free');
});

test('index: invalid fallback models fail without sending prompts to a paid endpoint', async () => {
  const h = harness({ generateGemini: unavailable, env: { OPENROUTER_API_KEY: 'fake-key', OPENROUTER_MODEL: 'paid/model' } });
  await assert.rejects(h.run(), /OPENROUTER_MODEL must name a free model/);
  assert.equal(h.geminiCalls(), 1);
  assert.equal(h.requests.length, 0);
});

test('index: fallback HTTP failures, redirects, errors, refusals, and timeouts fail without a provider loop', async () => {
  const failures = [
    ...[401, 402, 403, 404, 429, 500, 503].map(status => () => new Response('private upstream body', { status })),
    () => new Response(null, { status: 302, headers: { Location: 'https://untrusted.example' } }),
    () => Response.json({ error: { message: 'private upstream body' } }),
    () => completion(value, { finish_reason: 'length' }),
    () => completion(value, { finish_reason: 'content_filter' }),
    () => completion(value, { message: { content: '', refusal: 'private refusal' } }),
    () => Response.json({ choices: [] }),
    () => new Response('malformed private upstream body'),
    () => { throw new Error('network failure fake-private-router-key'); },
    () => { throw new DOMException('private timeout detail', 'TimeoutError'); },
  ];
  for (const fail of failures) {
    const h = harness({ generateGemini: unavailable, fetchImpl: async () => fail() });
    await assert.rejects(h.run(), /Gemini and OpenRouter sentiment generation failed/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.geminiCalls(), 1);
    assert.deepEqual(h.events, ['gemini', 'openrouter']);
    assert.ok(!/private/.test(JSON.stringify(h.logs)));
  }
});

test('index: malformed or invalid fallback output fails validation without retrying either provider', async () => {
  for (const content of ['not JSON', '{}', '{"sentiment":"35"}', '[null]']) {
    const h = harness({
      generateGemini: unavailable,
      fetchImpl: async () => Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
    });
    await assert.rejects(h.run(), /Gemini and OpenRouter sentiment generation failed/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.geminiCalls(), 1);
  }
});

test('index: exhausted providers preserve both errors with a safe public message', async () => {
  const geminiError = new Error('private Gemini error');
  const h = harness({
    generateGemini: async () => { throw geminiError; },
    fetchImpl: async () => new Response('private upstream body', { status: 503 }),
  });
  await assert.rejects(h.run(), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], geminiError);
    assert.match(error.errors[1].message, /HTTP 503/);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.deepEqual(h.events, ['gemini', 'openrouter']);
});

test('index: deployed GitHub fallback model takes precedence over an older Appwrite environment value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wykop-deployed-model-'));
  try {
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await copyFile(new URL('../wykop-index/src/ai-provider.js', import.meta.url), join(dir, 'ai-provider.js'));
    await writeFile(join(dir, 'deployment-model.js'), `export default ${JSON.stringify('deployed/model:free')};\n`);
    const { generateJson } = await import(pathToFileURL(join(dir, 'ai-provider.js')).href);
    const requests = [];
    assert.deepEqual(await generateJson({
      prompt: 'Test', systemInstruction: 'Return JSON.', responseSchema: { type: 'object' },
      parseResponse: JSON.parse,
      env: { OPENROUTER_API_KEY: 'fake-key', OPENROUTER_MODEL: 'old/model:free' },
      fetchImpl: async (_url, request) => { requests.push(JSON.parse(request.body)); return completion({ ok: true }); },
      generateGemini: unavailable,
    }), { ok: true });
    assert.equal(requests[0].model, 'deployed/model:free');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sentiment validation rejects missing nested fields before database or posting work', () => {
  assert.throws(() => parseSentimentResponse(JSON.stringify({ ...sentiment, topQuotes: [{ username: 'user' }] })), /Invalid sentiment/);
  assert.throws(() => parseSentimentResponse('null'), /must be an object/);
});

test('Gemini replies keep the flat array contract, including no replies', () => {
  assert.deepEqual(parseRepliesResponse(JSON.stringify(replies)), replies);
  assert.deepEqual(parseRepliesResponse('[]'), []);
  assert.throws(() => parseRepliesResponse('{"replies":[]}'), /should be an array/);
  assert.throws(() => parseRepliesResponse('[null]'), /required fields/);
});

test('Gemini replies still pass through the current-price guard', () => {
  const notifications = [{ post: { id: '123' }, replyToUsername: 'user', questionToAnswer: 'Jaka jest aktualna cena XTB?', currentQuote: null }];
  const result = parseRepliesResponse(JSON.stringify([{ ...replies[0], reply: 'Cena to 999 PLN.' }]));
  const guarded = applyCurrentQuoteGuard(result, notifications);
  assert.ok(!guarded[0].reply.includes('999'));
  assert.match(guarded[0].reply, /Nie udało mi się zweryfikować/);
});
