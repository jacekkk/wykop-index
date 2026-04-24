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
 * Strip query parameters from a URL string.
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export const stripQueryParams = (url) => url ? url.split('?')[0] : null;

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
  photo_url: stripQueryParams(comment.media?.photo?.url),
  embed_url: stripQueryParams(comment.media?.embed?.url),
});
