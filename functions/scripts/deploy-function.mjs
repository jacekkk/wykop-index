import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function pushFunction(functionId) {
  return new Promise((resolve, reject) => {
    const child = spawn('appwrite', ['push', 'functions', '--function-id', functionId, '--force', '--activate=true'], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
}

export async function deployFunction({
  functionId, env = process.env, fetchImpl = fetch, runCli = pushFunction,
}) {
  const { APPWRITE_ENDPOINT: endpoint, APPWRITE_PROJECT_ID: projectId, APPWRITE_API_KEY: apiKey } = env;
  if (!endpoint || !projectId || !apiKey || !functionId) {
    throw new Error('APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY and a function ID are required.');
  }
  const base = endpoint.replace(/\/+$/, '');
  const path = `/functions/${encodeURIComponent(functionId)}`;
  const read = async suffix => {
    const response = await fetchImpl(`${base}${suffix}`, {
      redirect: 'manual', signal: AbortSignal.timeout(20_000),
      headers: { 'X-Appwrite-Project': projectId, 'X-Appwrite-Key': apiKey },
    });
    if (!response.ok) {
      await response.body?.cancel();
      // Do not include upstream bodies, function variables, or credentials.
      throw new Error(`Appwrite deployment verification failed (HTTP ${response.status}).`);
    }
    return response.json();
  };

  const before = await read(path);
  if (before.$id !== functionId || typeof before.deploymentId !== 'string') {
    throw new Error('Appwrite returned an invalid function before deployment.');
  }

  const code = await runCli(functionId);
  if (code !== 0) throw new Error(`Appwrite CLI failed for ${functionId} (exit ${code ?? 'signal'}).`);

  // CLI 28.13.3 can log push/build/activation errors and still exit zero.
  // An unchanged, previously ready deployment must not pass verification.
  const after = await read(path);
  if (after.$id !== functionId || typeof after.deploymentId !== 'string' ||
      !after.deploymentId || after.deploymentId === before.deploymentId) {
    throw new Error(`Appwrite CLI exited zero, but ${functionId} has no new active deployment. Check the CLI errors above, including missing API-key scopes.`);
  }

  const deployment = await read(`${path}/deployments/${encodeURIComponent(after.deploymentId)}`);
  if (deployment.$id !== after.deploymentId || deployment.status !== 'ready') {
    throw new Error(`The new active deployment for ${functionId} is not verified ready.`);
  }
  return after.deploymentId;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const functionId = process.argv[2];
    const deploymentId = await deployFunction({ functionId });
    console.log(`Verified ${functionId}: deployment ${deploymentId} is ready and active.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
