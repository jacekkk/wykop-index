// Cloudflare numbers Sunday as 1; names avoid GitHub/Unix weekday ambiguity.
export const INDEX_CRON = '10 19 * * MON-FRI';
export const POST_CRON = '*/5 * * * *';

const jobs = new Map([
  [INDEX_CRON, { name: 'wykop-index', variable: 'APPWRITE_WYKOP_INDEX_FUNCTION_ID' }],
  [POST_CRON, { name: 'wykop-post', variable: 'APPWRITE_WYKOP_POST_FUNCTION_ID' }],
]);

function required(env, name) {
  if (typeof env[name] !== 'string' || !env[name].trim()) {
    throw new Error(`${name} is required.`);
  }
  return env[name].trim();
}

function executionsUrl(endpoint, functionId) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('APPWRITE_ENDPOINT must be an HTTPS URL without credentials, query, or fragment.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('APPWRITE_ENDPOINT must be an HTTPS URL without credentials, query, or fragment.');
  }
  return `${url.href.replace(/\/+$/, '')}/functions/${encodeURIComponent(functionId)}/executions`;
}

export function executionRequest(env, variable) {
  return {
    url: executionsUrl(required(env, 'APPWRITE_ENDPOINT'), required(env, variable)),
    headers: {
      'X-Appwrite-Project': required(env, 'APPWRITE_PROJECT_ID'),
      'X-Appwrite-Key': required(env, 'APPWRITE_API_KEY'),
      'Content-Type': 'application/json',
    },
  };
}

export function schedulerEnabled(controller, env, logger = console) {
  if (env.SCHEDULER_ENABLED === 'false') {
    logger.info(JSON.stringify({ event: 'scheduler_disabled', cron: controller.cron }));
    return false;
  }
  if (env.SCHEDULER_ENABLED !== 'true') {
    throw new Error('SCHEDULER_ENABLED must be "true" or "false".');
  }
  return true;
}

export async function runScheduled(controller, env, { fetchImpl = fetch, logger = console } = {}) {
  const job = jobs.get(controller.cron);
  if (!job) throw new Error('Unsupported scheduled cron. Check the Worker configuration.');
  if (!schedulerEnabled(controller, env, logger)) return;

  const { url, headers } = executionRequest(env, job.variable);

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ async: true, body: '{}' }),
      // Workers supports "manual" and "follow" only. Reject 3xx below without
      // forwarding the Appwrite key to another URL.
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // A timeout or connection error does not prove Appwrite rejected the request.
    // Never resubmit automatically: these functions publish to Wykop.
    throw new Error(`${job.name}: submission could not be confirmed. Check Appwrite before retrying; no automatic retry was attempted.`);
  }

  if (!response.ok) {
    // Do not log the response body: upstream errors can contain sensitive data.
    throw new Error(`${job.name}: Appwrite returned HTTP ${response.status}. Check Appwrite before retrying; no automatic retry was attempted.`);
  }

  let execution;
  try {
    execution = await response.json();
  } catch {
    throw new Error(`${job.name}: submission returned invalid JSON. Check Appwrite before retrying.`);
  }
  if (typeof execution?.$id !== 'string' || !execution.$id.trim()) {
    throw new Error(`${job.name}: submission returned no execution ID. Check Appwrite before retrying.`);
  }

  const result = { functionName: job.name, executionId: execution.$id };
  logger.info(JSON.stringify({
    event: 'appwrite_execution_submitted',
    ...result,
    cron: controller.cron,
    scheduledTime: controller.scheduledTime,
  }));
  return result;
}
