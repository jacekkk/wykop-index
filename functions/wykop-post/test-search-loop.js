// Quick local smoke test for the single-call grounded design used in src/main.js.
// It pre-fetches web search itself (not a Gemini request), injects the results into the
// prompt, then makes ONE generateContent call with the native urlContext tool, and asserts
// exactly one Gemini request was made (the key property for the 20 RPD budget).
//
// Run:  GEMINI_API_KEY=... node test-search-loop.js
//   Optional: SEARCH_PROVIDER=tavily TAVILY_API_KEY=...   (or SEARCH_PROVIDER=brave BRAVE_API_KEY=...)
//   With no search key set, a stub provider returns canned results so it still runs offline.

import assert from 'node:assert/strict';
import { GoogleGenAI } from '@google/genai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const dryRun = process.env.DRY_RUN === '1';
if (!GEMINI_API_KEY && !dryRun) {
  console.error('Missing GEMINI_API_KEY env var. Run: GEMINI_API_KEY=... node test-search-loop.js');
  process.exit(1);
}

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const model = process.env.TEST_MODEL || 'gemini-3.7-flash';
const fallbackModel = process.env.TEST_FALLBACK_MODEL || 'gemini-3.5-flash';
const searchProvider = (process.env.SEARCH_PROVIDER || 'tavily').toLowerCase();
const webSearchTimeoutMs = 8000;
const webSearchConcurrency = 4;

let searchCallCount = 0;

const webSearch = async (query, maxResults = 5) => {
  searchCallCount += 1;
  if (!query || !query.trim()) return { results: [] };

  const hasKey =
    (searchProvider === 'brave' && process.env.BRAVE_API_KEY) ||
    (searchProvider !== 'brave' && process.env.TAVILY_API_KEY);

  if (!hasKey) {
    console.log(`[webSearch stub] "${query}" (no ${searchProvider} key set — returning canned result)`);
    return {
      results: [
        { title: 'Stub result', url: 'https://example.com', snippet: `Canned data for: ${query}` },
      ],
    };
  }

  try {
    if (searchProvider === 'brave') {
      const braveUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
      const braveResp = await fetch(braveUrl, {
        signal: AbortSignal.timeout(webSearchTimeoutMs),
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY },
      });
      if (!braveResp.ok) throw new Error(`Brave search ${braveResp.status}`);
      const braveJson = await braveResp.json();
      const results = (braveJson.web?.results || []).slice(0, maxResults).map((r) => ({
        title: r.title, url: r.url, snippet: r.description,
      }));
      return { results };
    }

    const tavilyResp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: AbortSignal.timeout(webSearchTimeoutMs),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
    });
    if (!tavilyResp.ok) throw new Error(`Tavily search ${tavilyResp.status}`);
    const tavilyJson = await tavilyResp.json();
    const results = (tavilyJson.results || []).slice(0, maxResults).map((r) => ({
      title: r.title, url: r.url, snippet: r.content,
    }));
    return { results };
  } catch (searchErr) {
    console.log(`Web search failed for "${query}": ${searchErr.message}`);
    return { results: [], error: searchErr.message };
  }
};

const prefetchSearchResults = async (notifications, search = webSearch) => {
  for (let index = 0; index < notifications.length; index += webSearchConcurrency) {
    const batch = notifications.slice(index, index + webSearchConcurrency);
    await Promise.all(batch.map(async (notification) => {
      const { results } = await search(notification.questionToAnswer, 4);
      notification.searchResults = results;
    }));
  }
};

const runWithRetryPlan = async (fn, maxAttempts = 4) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = attempt % 2 === 1 ? 'primary' : 'backup';
    const attemptModel = attempt < 3 ? model : fallbackModel;

    try {
      return await fn({ attempt, client, model: attemptModel });
    } catch (retryError) {
      if (attempt === maxAttempts) throw retryError;
    }
  }
};

const runOfflineChecks = async () => {
  let activeSearches = 0;
  let maxActiveSearches = 0;
  const notifications = Array.from({ length: 9 }, (_, index) => ({
    questionToAnswer: `Question ${index + 1}`,
  }));

  await prefetchSearchResults(notifications, async (query) => {
    activeSearches += 1;
    maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
    await new Promise(resolve => setImmediate(resolve));
    activeSearches -= 1;
    return { results: [{ title: query, url: 'https://example.com', snippet: 'stub' }] };
  });

  assert.equal(maxActiveSearches, webSearchConcurrency);
  assert.ok(notifications.every(notification => notification.searchResults.length === 1));

  const retryAttempts = [];
  const retryResult = await runWithRetryPlan(async (attemptConfig) => {
    retryAttempts.push(attemptConfig);
    if (attemptConfig.attempt < 3) throw new Error('simulated primary-model failure');
    return 'fallback succeeded';
  });

  assert.equal(retryResult, 'fallback succeeded');
  assert.deepEqual(retryAttempts, [
    { attempt: 1, client: 'primary', model },
    { attempt: 2, client: 'backup', model },
    { attempt: 3, client: 'primary', model: fallbackModel },
  ]);
  console.log('PASS: bounded search concurrency and fallback retry plan.');
};

// Count Gemini requests to prove the single-call design fits the 20 RPD budget.
let geminiRequestCount = 0;
const generateContent = async (args) => {
  geminiRequestCount += 1;
  return ai.models.generateContent(args);
};

// --- Run the test ---
await runOfflineChecks();

if (dryRun) {
  console.log('PASS: dry run completed without network or Gemini requests.');
  process.exit(0);
}

console.log(`Model: ${model} | Search provider: ${searchProvider}`);

const question = 'Jaka jest dzisiejsza cena akcji NVIDIA (NVDA)? Podaj konkretna liczbe.';

// Pre-fetch search ourselves (NOT a Gemini request), then inject into the prompt.
const notification = { questionToAnswer: question };
await prefetchSearchResults([notification]);

const prompt = `Odpowiedz na pytanie z pola questionToAnswer. Opieraj sie na polu searchResults (aktualne wyniki wyszukiwania) i mozesz otworzyc podane URL-e, zeby doczytac szczegoly. Podaj konkretna liczbe.\n\nWpis: ${JSON.stringify(notification)}`;

// Set NO_URLCONTEXT=1 to drop the native urlContext tool (isolates whether browsing is the slow part).
const tools = process.env.NO_URLCONTEXT ? [] : [{ urlContext: {} }];
const timeoutMs = Number(process.env.TIMEOUT_MS || 120000);

let response;
try {
  response = await generateContent({
    model,
    contents: [{ text: prompt }],
    config: {
      httpOptions: { timeout: timeoutMs },
      tools,
    },
  });
} catch (err) {
  console.error(`FAIL: generateContent aborted/failed after ~${timeoutMs / 1000}s (${err.name}: ${err.message}).`);
  console.error('Try again (transient), or run with NO_URLCONTEXT=1 to check if urlContext browsing is the cause.');
  process.exit(1);
}

console.log('\n--- Final answer ---');
console.log(response.text);
console.log('\n--- Result ---');
console.log(`webSearch (pre-fetch) called ${searchCallCount} time(s); Gemini requests: ${geminiRequestCount}.`);

if (geminiRequestCount !== 1) {
  console.error(`FAIL: expected exactly 1 Gemini request, got ${geminiRequestCount}.`);
  process.exit(1);
}
console.log('PASS: single-call grounded design works (1 Gemini request).');
