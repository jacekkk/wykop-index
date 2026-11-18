import { cleanJsonResponse, validateSchema } from './utils.js';

const string = { type: 'string' };
const objects = (properties) => ({
  type: 'array',
  items: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
});

export const SENTIMENT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    sentiment: string,
    summary: string,
    mostDiscussed: objects({ asset: string, reasoning: string, url: string }),
    topQuotes: objects({ username: string, sentiment: string, quote: string, url: string }),
  },
  required: ['sentiment', 'summary', 'mostDiscussed', 'topQuotes'],
  additionalProperties: false,
};

export function parseSentimentResponse(text) {
  const result = cleanJsonResponse(text);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Sentiment response must be an object.');
  }
  const errors = validateSchema(result, {
    sentiment: 'string',
    summary: 'string',
    mostDiscussed: { type: 'array-of-objects', requiredFields: ['asset', 'reasoning', 'url'] },
    topQuotes: { type: 'array-of-objects', requiredFields: ['username', 'sentiment', 'quote', 'url'] },
  });
  if (errors.length) throw new Error(`Invalid sentiment response: ${errors.join(', ')}`);
  return result;
}
