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
 * Validate an object against a simple schema definition.
 * @param {object} data
 * @param {object} schema  Keys map to 'string' | 'array-of-objects' | { type, requiredFields }
 * @returns {string[]} List of validation error messages (empty = valid)
 */
export const validateSchema = (data, schema) => {
  const errors = [];
  for (const [key, config] of Object.entries(schema)) {
    const type = typeof config === 'string' ? config : config.type;
    const requiredFields = config.requiredFields || [];

    if (!(key in data)) {
      errors.push(`Missing field: ${key}`);
    } else if (type === 'string' && typeof data[key] !== 'string') {
      errors.push(`Field ${key} should be string, got ${typeof data[key]}`);
    } else if (type === 'array-of-objects' && !Array.isArray(data[key])) {
      errors.push(`Field ${key} should be array, got ${typeof data[key]}`);
    } else if (type === 'array-of-objects' && Array.isArray(data[key])) {
      const nonObjectElements = data[key].filter(item => typeof item !== 'object' || item === null);
      if (nonObjectElements.length > 0) {
        errors.push(`Field ${key} should be array of objects, but contains non-object elements`);
      }
      if (requiredFields.length > 0) {
        data[key].forEach((item, index) => {
          requiredFields.forEach(field => {
            if (!(field in item)) {
              errors.push(`Field ${key}[${index}] is missing required field: ${field}`);
            }
          });
        });
      }
    }
  }
  return errors;
};

/**
 * Format a Date as a UTC timestamp string: "YYYY-MM-DD HH:MM:SS UTC".
 * @param {Date} date
 * @returns {string}
 */
export const formatDateTime = (date) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
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

/**
 * Parse an array of raw Wykop entry objects into flat structures.
 * @param {object[]} posts
 * @returns {object[]}
 */
export const parsePosts = (posts) => posts.map(entry => ({
  id: entry.id,
  url: `https://wykop.pl/wpis/${entry.id}`,
  username: entry.author.username,
  created_at: entry.created_at,
  votes: entry.votes.up,
  content: entry.content,
  comments: entry.comments?.items?.map(comment => parseComment(comment, entry.id)),
  photo_url: stripQueryParams(entry.media?.photo?.url),
  embed_url: stripQueryParams(entry.media?.embed?.url),
}));

/**
 * Pick a random URL from a comma-separated list string (e.g. an env var).
 * @param {string|null|undefined} urlList
 * @returns {string|null}
 */
export const pickRandomUrl = (urlList) => {
  if (!urlList) return null;
  const urls = urlList.split('|').map(url => url.trim()).filter(url => url);
  return urls.length > 0 ? urls[Math.floor(Math.random() * urls.length)] : null;
};

/**
 * Find the single top user (or tied users) from a username→count map.
 * Returns usernames prefixed with '@', joined by ', '.
 * @param {Record<string, number>} counts
 * @returns {{ username: string, count: number }}
 */
export const getTopUser = (counts) => {
  const entries = Object.entries(counts);
  if (entries.length === 0) return { username: '', count: 0 };

  const sorted = entries.sort((a, b) => b[1] - a[1]);
  const maxCount = sorted[0][1];
  const topUsers = sorted.filter(([, count]) => count === maxCount);
  const username = topUsers.map(([user]) => `@${user}`).join(', ');

  return { username, count: maxCount };
};
