/**
 * Strip trailing markdown code fences and parse JSON.
 * @param {string} text
 * @returns {any}
 */
export const cleanJsonResponse = (text) => {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  return JSON.parse(cleaned.trim());
};

/**
 * Format a revenue value into a human-readable string with T/B/M suffix.
 * Returns null for null/undefined input so callers can conditionally render.
 * @param {number|null|undefined} val
 * @returns {string|null}
 */
export const formatRevenue = (val) => {
  if (val == null) return null;
  const n = Number(val);
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toFixed(2)}`;
};

/**
 * Format an EPS value into a human-readable string.
 * @param {number|null|undefined} val
 * @returns {string}
 */
export const formatEps = (val) => val != null ? val.toFixed(2) : 'N/A';

/**
 * Parse a raw Wykop comment object into a flat structure.
 * @param {object} comment
 * @param {number|string} entryId
 * @returns {object}
 */
export const parseComment = (comment, entryId) => ({
  id: comment.id,
  url: `https://wykop.pl/wpis/${entryId}#${comment.id}`,
  username: comment.author.username,
  created_at: comment.created_at,
  votes: comment.votes.up,
  content: comment.content,
  photo_url: comment.media?.photo?.url || null,
  embed_url: comment.media?.embed?.url || null,
});

export const isCurrentPriceQuestion = (text) => {
  if (!text) return false;
  const normalized = text.toLocaleLowerCase('pl-PL');
  const asksForPrice = /(cena|cenę|cene|kurs|notowania|ile kosztuje)/.test(normalized);
  const asksForCurrentValue = /(obecn|aktualn|teraz|dzisiaj|dziś|dzis|live|na ten moment)/.test(normalized);
  return asksForPrice && asksForCurrentValue;
};

export const buildSearchQuery = (question, requestedAt, context = '') => {
  if (!isCurrentPriceQuestion(question)) return question;
  const boundedContext = context.replace(/\s+/g, ' ').trim().slice(0, 1200);
  return [
    question,
    boundedContext ? `Conversation context: ${boundedContext}` : null,
    `ticker current live stock quote price as of ${requestedAt.toISOString()} Yahoo Finance`,
  ].filter(Boolean).join('\n');
};

export const extractTickerFromSearchResults = (results) => {
  const trustedPaths = new Map([
    ['finance.yahoo.com', /^\/quote\/([A-Z0-9.-]{1,10})(?:\/|$)/i],
    ['stockanalysis.com', /^\/stocks\/([A-Z0-9.-]{1,10})(?:\/|$)/i],
    ['marketwatch.com', /^\/investing\/stock\/([A-Z0-9.-]{1,10})(?:\/|$)/i],
    ['nasdaq.com', /^\/market-activity\/stocks\/([A-Z0-9.-]{1,10})(?:\/|$)/i],
  ]);

  for (const result of results || []) {
    try {
      const url = new URL(result.url);
      const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
      const pattern = trustedPaths.get(hostname);
      const match = pattern && url.pathname.match(pattern);
      if (match) return match[1].toUpperCase();
    } catch {
      continue;
    }
  }
  return null;
};

export const parseYahooChartQuote = (ticker, quoteJson) => {
  const chart = quoteJson.chart?.result?.[0];
  const timestamps = chart?.timestamp || [];
  const closes = chart?.indicators?.quote?.[0]?.close || [];
  let latestIndex = closes.length - 1;
  while (latestIndex >= 0 && !Number.isFinite(closes[latestIndex])) latestIndex -= 1;
  if (latestIndex < 0 || !timestamps[latestIndex]) return null;

  const symbol = chart.meta?.symbol || ticker;
  return {
    symbol,
    price: Number(closes[latestIndex].toFixed(4)),
    currency: chart.meta?.currency || '',
    observedAt: new Date(timestamps[latestIndex] * 1000).toISOString(),
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
  };
};

export const applyCurrentQuoteGuard = (replies, notifications) => replies.map((reply) => {
  const notification = notifications.find((item) =>
    String(item.post.id) === String(reply.postId) && isCurrentPriceQuestion(item.questionToAnswer)
  );

  if (!notification) return reply;

  const quote = notification.currentQuote;
  if (!quote) {
    return {
      ...reply,
      reply: 'Nie udało mi się zweryfikować aktualnej ceny na podstawie źródła z oznaczeniem czasu, więc nie będę zgadywać.',
    };
  }

  const observedAt = new Date(quote.observedAt).toLocaleString('pl-PL', {
    timeZone: 'Europe/Warsaw',
    dateStyle: 'short',
    timeStyle: 'medium',
  });
  const requestedAtMs = Date.parse(notification.searchResultsRetrievedAt);
  const observedAtMs = Date.parse(quote.observedAt);
  const isFresh = Number.isFinite(requestedAtMs) && Number.isFinite(observedAtMs)
    && observedAtMs <= requestedAtMs + 5 * 60 * 1000
    && requestedAtMs - observedAtMs <= 20 * 60 * 1000;
  const observationLabel = isFresh ? 'notowanie' : 'ostatnie dostępne notowanie';
  const formattedPrice = quote.price.toLocaleString('pl-PL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(quote.price) < 1 ? 4 : 2,
  });
  return {
    ...reply,
    reply: `${quote.symbol}: ${formattedPrice} ${quote.currency} (${observationLabel} z ${observedAt}, Yahoo Finance).`,
  };
});
