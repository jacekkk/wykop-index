import deploymentModel from './deployment-model.js';

export const DEFAULT_OPENROUTER_MODEL = 'baidu/ernie-5.5-flash-preview:free';
export const OPENROUTER_TIMEOUT_MS = 45_000;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

class ProviderError extends Error {}

export function resolveOpenRouterModel(env = process.env) {
  const model = (deploymentModel ?? env.OPENROUTER_MODEL)?.trim() || DEFAULT_OPENROUTER_MODEL;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*:free$/.test(model)) {
    throw new Error('OPENROUTER_MODEL must name a free model ending in :free.');
  }
  return model;
}

export async function generateJson({
  prompt,
  systemInstruction,
  responseSchema,
  parseResponse,
  generateGemini,
  env = process.env,
  fetchImpl = fetch,
  log = () => {},
}) {
  log('Using Gemini for sentiment analysis.');
  let geminiError;
  try {
    // The caller runs and validates the complete Gemini retry sequence.
    return await generateGemini();
  } catch (err) {
    geminiError = err;
  }

  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    log('Gemini failed and no OpenRouter fallback key is configured.');
    throw geminiError;
  }

  const model = resolveOpenRouterModel(env);

  try {
    log(`Gemini failed; using OpenRouter fallback model ${model}.`);
    const response = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: prompt },
        ],
        stream: false,
        max_tokens: 8192,
        provider: {
          require_parameters: true,
          max_price: { prompt: 0, completion: 0, request: 0 },
        },
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'wykop_response', strict: true, schema: responseSchema },
        },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(`HTTP ${response.status}`);
    }
    const result = await response.json();
    const choice = result?.choices?.[0];
    if (result?.error || choice?.error || choice?.message?.refusal ||
        choice?.finish_reason !== 'stop' || typeof choice?.message?.content !== 'string' ||
        !choice.message.content.trim()) {
      throw new ProviderError('missing, refused, or incomplete output');
    }
    return parseResponse(choice.message.content);
  } catch (err) {
    // Do not log upstream bodies, prompts, credentials, or arbitrary exception
    // messages. Do not loop back to Gemini or repeat either provider here.
    const reason = err instanceof ProviderError ? err.message : 'request or output validation failed';
    log(`OpenRouter fallback failed (${reason}).`);
    throw new AggregateError([geminiError, err], `Gemini and OpenRouter sentiment generation failed (${reason}).`);
  }
}
