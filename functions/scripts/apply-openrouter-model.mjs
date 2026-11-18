import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolveOpenRouterModel } from '../wykop-index/src/ai-provider.js';

const MODEL_KEY = 'OPENROUTER_MODEL';

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export async function applyOpenRouterModel({
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
  sleep = delay,
  now = Date.now,
  buildTimeoutMs = 300_000,
} = {}) {
  const model = resolveOpenRouterModel(env);
  const endpoint = new URL(required(env, 'APPWRITE_ENDPOINT'));
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('APPWRITE_ENDPOINT must be an HTTPS URL without credentials, query, or fragment.');
  }
  const base = endpoint.href.replace(/\/+$/, '');
  const headers = {
    'X-Appwrite-Project': required(env, 'APPWRITE_PROJECT_ID'),
    'X-Appwrite-Key': required(env, 'APPWRITE_FUNCTIONS_API_KEY'),
    'Content-Type': 'application/json',
  };
  const functionIds = ['APPWRITE_WYKOP_INDEX_FUNCTION_ID', 'APPWRITE_WYKOP_POST_FUNCTION_ID']
    .map(name => required(env, name));
  if (new Set(functionIds).size !== functionIds.length) throw new Error('The two Appwrite function IDs must be different.');

  async function request(path, method = 'GET', body) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method, headers, redirect: 'manual', signal: AbortSignal.timeout(30_000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(`Appwrite ${method} could not be confirmed. Inspect function deployments before rerunning.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Appwrite ${method} failed (HTTP ${response.status}). The configuration key needs functions.read and functions.write.`);
    }
    try { return await response.json(); }
    catch { throw new Error('Appwrite returned an invalid JSON response. Inspect function deployments before rerunning.'); }
  }

  // Preflight both targets before changing any configuration. Only use the
  // model variable's metadata; never print function variables or secret values.
  const targets = [];
  for (const id of functionIds) {
    const path = `/functions/${encodeURIComponent(id)}`;
    const fn = await request(path);
    if (fn.$id !== id || typeof fn.deploymentId !== 'string' || !fn.deploymentId || !Array.isArray(fn.vars)) {
      throw new Error(`Function ${id} must have an active deployment and readable variable metadata.`);
    }
    const variable = fn.vars.find(item => item.key === MODEL_KEY);
    if (variable && (typeof variable.$id !== 'string' || !variable.$id)) throw new Error('Invalid model variable metadata.');
    targets.push({ id, path, deploymentId: fn.deploymentId, variableId: variable?.$id });
  }

  for (const target of targets) {
    const { id, path, deploymentId, variableId } = target;
    if (variableId) {
      await request(`${path}/variables/${encodeURIComponent(variableId)}`, 'PUT', { key: MODEL_KEY, value: model });
    } else {
      await request(`${path}/variables`, 'POST', { key: MODEL_KEY, value: model, secret: false });
    }

    // Rebuild the currently active code with the new environment. This does not
    // upload a different branch's code or trigger an Appwrite execution.
    const candidate = await request(`${path}/deployments/duplicate`, 'POST', { deploymentId });
    if (typeof candidate.$id !== 'string' || !candidate.$id) throw new Error('Redeployment returned no deployment ID.');
    const candidateId = candidate.$id;
    const deadline = now() + buildTimeoutMs;
    while (true) {
      const build = await request(`${path}/deployments/${encodeURIComponent(candidateId)}`);
      if (build.$id !== candidateId) throw new Error('Appwrite returned a different deployment ID.');
      if (build.status === 'ready') break;
      if (!['waiting', 'processing', 'building'].includes(build.status)) {
        throw new Error(`Redeployment for ${id} did not succeed. The previous deployment has not been replaced by this script.`);
      }
      if (now() >= deadline) throw new Error(`Timed out waiting for ${id} to rebuild. Inspect deployments before rerunning.`);
      await sleep(10_000);
    }

    const current = await request(path);
    if (current.deploymentId !== deploymentId && current.deploymentId !== candidateId) {
      throw new Error(`Active deployment for ${id} changed during configuration; refusing to replace it.`);
    }
    if (current.vars?.find(item => item.key === MODEL_KEY)?.value !== model) {
      throw new Error(`The model variable for ${id} changed during the rebuild; refusing activation.`);
    }
    if (current.deploymentId !== candidateId) {
      await request(`${path}/deployment`, 'PATCH', { deploymentId: candidateId });
    }
    const activated = await request(path);
    if (activated.deploymentId !== candidateId || activated.live === false) {
      throw new Error(`Could not confirm the updated deployment for ${id}.`);
    }
    log(`Applied ${MODEL_KEY}=${model} to ${id}; deployment ${candidateId} is active.`);
  }
  return { model, functionIds };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await applyOpenRouterModel(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
