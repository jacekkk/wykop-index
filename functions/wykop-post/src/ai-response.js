import { cleanJsonResponse } from './utils.js';

const fields = ['postId', 'username', 'url', 'post', 'reply'];

export function parseRepliesResponse(text) {
  const replies = cleanJsonResponse(text);
  if (!Array.isArray(replies)) throw new Error('Mentions response should be an array.');
  for (const [index, reply] of replies.entries()) {
    if (!reply || typeof reply !== 'object' || Array.isArray(reply) || fields.some(field => !(field in reply))) {
      throw new Error(`Mentions response item ${index} is missing required fields.`);
    }
  }
  return replies;
}
