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

// This file is also packaged inside wykop-post: Appwrite uploads each function
// directory independently. The contract tests check that both copies agree.
export async function generateJson({
  prompt,
  systemInstruction,
  responseSchema,
  parseResponse,
  generateGemini,
  requiresGemini = false,
  env = process.env,
  fetchImpl = fetch,
  log = () => {},
}) {
  const key = env.OPENROUTER_API_KEY?.trim();
  const provider = env.AI_PROVIDER || (key ? 'openrouter' : 'gemini');
  if (!['openrouter', 'gemini'].includes(provider)) {
    throw new Error('AI_PROVIDER must be openrouter or gemini.');
  }
  if (provider === 'gemini' || requiresGemini) {
    log(requiresGemini ? 'Using Gemini for media or linked-page analysis.' : 'Using Gemini for text generation.');
    return generateGemini();
  }
  if (!key) throw new Error('OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter.');

  const model = resolveOpenRouterModel(env);

  try {
    log(`Using OpenRouter model ${model}.`);
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
    // messages. A failed inference is safe to fall back; no Wykop post ran here.
    const reason = err instanceof ProviderError ? err.message : 'request or output validation failed';
    log(`OpenRouter failed (${reason}); falling back to Gemini.`);
    return generateGemini();
  }
}
