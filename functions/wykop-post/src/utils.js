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
