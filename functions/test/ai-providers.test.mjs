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

function harness(options = {}) {
  const requests = [], logs = [];
  let fallbackCalls = 0;
  const fallbackResult = { from: 'validated-gemini-fallback' };
  const args = {
    prompt: 'Polskie pytanie. Wyniki wyszukiwania: https://example.com/source',
    systemInstruction: 'Odpowiadaj po polsku. Nie wymyslaj danych.',
    responseSchema: schema,
    parseResponse: parse,
    env: { OPENROUTER_API_KEY: 'fake-private-router-key' },
    fetchImpl: async (url, request) => { requests.push({ url, ...request }); return completion(value); },
    generateGemini: async () => { fallbackCalls++; return fallbackResult; },
    log: message => logs.push(message),
    ...options,
  };
  return { args, requests, logs, fallbackResult, fallbackCalls: () => fallbackCalls, run: () => indexGenerate(args) };
}

test(`index: free OpenRouter request keeps Polish instructions, sources, and the JSON contract`, async () => {
  const h = harness();
  assert.deepEqual(await h.run(), parse(JSON.stringify(value)));
  assert.equal(h.fallbackCalls(), 0);
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
  assert.ok(!JSON.stringify(h.logs).includes('fake-private-router-key'));
});

test(`index: existing installations and explicit rollback use Gemini without OpenRouter calls`, async () => {
  for (const env of [{}, { AI_PROVIDER: 'gemini', OPENROUTER_API_KEY: 'fake-key' }]) {
    const h = harness({ env });
    assert.equal(await h.run(), h.fallbackResult);
    assert.equal(h.fallbackCalls(), 1);
    assert.equal(h.requests.length, 0);
  }
});

test(`index: the configured model value is trimmed and sent to OpenRouter`, async () => {
  const h = harness({ env: { OPENROUTER_API_KEY: 'fake-key', OPENROUTER_MODEL: ' other/model:free ' } });
  await h.run();
  assert.equal(JSON.parse(h.requests[0].body).model, 'other/model:free');
});

test(`index: HTTP failures, redirects, embedded errors, refusals, and timeouts fall back once`, async () => {
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
    let calls = 0;
    const h = harness({ fetchImpl: async () => { calls++; return fail(); } });
    assert.equal(await h.run(), h.fallbackResult);
    assert.equal(calls, 1, 'inference failure must not repeat the OpenRouter request');
    assert.equal(h.fallbackCalls(), 1);
    assert.ok(!/private|fake-private-router-key/.test(JSON.stringify(h.logs)));
  }
});

test(`index: malformed JSON and invalid task output use the validated Gemini fallback`, async () => {
  for (const content of ['not JSON', '{}', '{"sentiment":"35"}', '[null]']) {
    const h = harness({ fetchImpl: async () => Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] }) });
    assert.equal(await h.run(), h.fallbackResult);
    assert.equal(h.fallbackCalls(), 1);
  }
});

test(`index: invalid configuration fails before sending prompts or credentials`, async () => {
  for (const env of [
    { AI_PROVIDER: 'unknown' },
    { AI_PROVIDER: 'openrouter' },
    { AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'fake-key', OPENROUTER_MODEL: 'paid/model' },
  ]) {
    const h = harness({ env });
    await assert.rejects(h.run());
    assert.equal(h.requests.length, 0);
    assert.equal(h.fallbackCalls(), 0);
  }
});

test(`index: exhausted Gemini fallback propagates failure without another primary request`, async () => {
  let requests = 0;
  const h = harness({
    fetchImpl: async () => { requests++; return new Response(null, { status: 503 }); },
    generateGemini: async () => { throw new Error('Gemini unavailable'); },
  });
  await assert.rejects(h.run(), /Gemini unavailable/);
  assert.equal(requests, 1);
});

test(`index: deployed GitHub model takes precedence over an older Appwrite environment value`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wykop-deployed-model-'));
  try {
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await copyFile(new URL(`../wykop-index/src/ai-provider.js`, import.meta.url), join(dir, 'ai-provider.js'));
    await writeFile(join(dir, 'deployment-model.js'), `export default ${JSON.stringify('deployed/model:free')};\n`);
    const { generateJson } = await import(pathToFileURL(join(dir, 'ai-provider.js')).href);
    const requests = [];
    assert.deepEqual(await generateJson({
      prompt: 'Test', systemInstruction: 'Return JSON.', responseSchema: { type: 'object' },
      parseResponse: JSON.parse,
      env: { OPENROUTER_API_KEY: 'fake-key', OPENROUTER_MODEL: 'old/model:free' },
      fetchImpl: async (_url, request) => { requests.push(JSON.parse(request.body)); return completion({ ok: true }); },
      generateGemini: async () => assert.fail('unexpected fallback'),
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
