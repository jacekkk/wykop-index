import assert from 'node:assert/strict';
import test from 'node:test';
import { deployFunction } from '../scripts/deploy-function.mjs';

function harness({ code = 0, activeId = 'new-deployment', status = 'ready', failRead = -1, invalidBefore = false, deploymentId = activeId } = {}) {
  const requests = [], commands = [];
  const env = {
    APPWRITE_ENDPOINT: 'https://appwrite.example/v1/',
    APPWRITE_PROJECT_ID: 'test-project', APPWRITE_API_KEY: 'private-test-key',
  };
  const responses = [
    { $id: 'function-id', deploymentId: 'old-deployment' },
    { $id: 'function-id', deploymentId: activeId },
    { $id: deploymentId, status },
  ];
  if (invalidBefore) responses[0] = {};
  return {
    requests, commands,
    run: () => deployFunction({
      functionId: 'function-id', env,
      runCli: async id => { commands.push(id); return code; },
      fetchImpl: async (url, options) => {
        const index = requests.length;
        requests.push({ url, options });
        return index === failRead
          ? new Response('private upstream error', { status: 403 })
          : Response.json(responses[index]);
      },
    }),
  };
}

test('deployment success requires a new ready deployment to be active on the function', async () => {
  const h = harness();
  assert.equal(await h.run(), 'new-deployment');
  assert.deepEqual(h.commands, ['function-id']);
  assert.deepEqual(h.requests.map(({ url }) => url), [
    'https://appwrite.example/v1/functions/function-id',
    'https://appwrite.example/v1/functions/function-id',
    'https://appwrite.example/v1/functions/function-id/deployments/new-deployment',
  ]);
  assert.ok(h.requests.every(({ options }) => options.redirect === 'manual' && options.signal instanceof AbortSignal));
  assert.equal(h.requests[0].options.headers['X-Appwrite-Key'], 'private-test-key');
});

test('a zero CLI exit with the previous deployment still active fails instead of reporting success', async () => {
  const h = harness({ activeId: 'old-deployment' });
  await assert.rejects(h.run(), /exited zero.*no new active deployment/);
  assert.deepEqual(h.commands, ['function-id']);
  assert.equal(h.requests.length, 2);
});

test('a zero CLI exit without any active deployment also fails', async () => {
  const h = harness({ activeId: '' });
  await assert.rejects(h.run(), /no new active deployment/);
});

test('CLI errors and signals fail without reporting or checking activation', async () => {
  for (const code of [1, 7, null]) {
    const h = harness({ code });
    await assert.rejects(h.run(), /Appwrite CLI failed/);
    assert.equal(h.requests.length, 1);
  }
});

test('an active deployment that is failed, pending, or unrecognized cannot pass', async () => {
  for (const status of ['failed', 'waiting', 'processing', 'building', 'unknown']) {
    const h = harness({ status });
    await assert.rejects(h.run(), /not verified ready/);
  }
  await assert.rejects(harness({ deploymentId: 'different-deployment' }).run(), /not verified ready/);
});

test('permission failures during any verification read fail without leaking credentials or response bodies', async () => {
  for (const failRead of [0, 1, 2]) {
    const h = harness({ failRead });
    await assert.rejects(h.run(), error => {
      assert.match(error.message, /verification failed \(HTTP 403\)/);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    if (failRead === 0) assert.deepEqual(h.commands, []);
  }
});

test('malformed pre-deployment metadata stops the upload', async () => {
  const h = harness({ invalidBefore: true });
  await assert.rejects(h.run(), /invalid function before deployment/);
  assert.deepEqual(h.commands, []);
});

test('missing deployment credentials fail before any network or CLI call', async () => {
  await assert.rejects(deployFunction({
    functionId: 'function-id', env: {},
    fetchImpl: () => assert.fail('unexpected request'),
    runCli: () => assert.fail('unexpected deployment'),
  }), /are required/);
});
