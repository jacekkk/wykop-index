import { cleanJsonResponse } from './utils.js';

const fields = ['postId', 'username', 'url', 'post', 'reply'];
export const REPLIES_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    replies: {
      type: 'array',
      items: {
        type: 'object',
        properties: Object.fromEntries(fields.map(field => [field,
          field === 'postId' ? { type: ['string', 'integer'] } : { type: 'string' },
        ])),
        required: fields,
        additionalProperties: false,
      },
    },
  },
  required: ['replies'],
  additionalProperties: false,
};

export function parseRepliesResponse(text, wrapped = false) {
  const result = cleanJsonResponse(text);
  const replies = wrapped ? result?.replies : result;
  if (!Array.isArray(replies)) throw new Error('Mentions response should be an array.');
  for (const [index, reply] of replies.entries()) {
    if (!reply || typeof reply !== 'object' || Array.isArray(reply) || fields.some(field => !(field in reply))) {
      throw new Error(`Mentions response item ${index} is missing required fields.`);
    }
  }
  return replies;
}

// OpenRouter handles text with pre-fetched search results. Gemini retains its
// existing image, YouTube, and URL-context capabilities for these batches.
export function requiresGeminiContext(notifications) {
  return notifications.some(notification =>
    /https?:\/\//i.test(notification.questionToAnswer || '') ||
    [notification.post, ...(notification.comments || [])].some(item => item && (
      item.photo_url || item.embed_url || /https?:\/\//i.test(item.content || '')
    ))
  );
}
