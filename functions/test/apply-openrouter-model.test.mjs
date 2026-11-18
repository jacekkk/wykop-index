import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOpenRouterModel } from '../scripts/apply-openrouter-model.mjs';
import { DEFAULT_OPENROUTER_MODEL } from '../wykop-index/src/ai-provider.js';

const env = {
  APPWRITE_ENDPOINT: 'https://appwrite.example.test/v1/',
  APPWRITE_PROJECT_ID: 'test-project',
  APPWRITE_FUNCTIONS_API_KEY: 'fake-private-configuration-key',
  APPWRITE_WYKOP_INDEX_FUNCTION_ID: 'index-id',
  APPWRITE_WYKOP_POST_FUNCTION_ID: 'post-id',
  OPENROUTER_MODEL: ' other/model:free ',
};

function harness({ config = env, buildStatuses = ['building', 'ready'], changeActive = false, failRequest } = {}) {
  const functions = new Map(['index-id', 'post-id'].map(id => [id, {
    $id: id, deploymentId: `${id}-old`, live: true,
    vars: [{ $id: 'api-key-variable', key: 'OPENROUTER_API_KEY', value: '', secret: true }],
  }]));
  functions.get('index-id').vars.push({ $id: 'model-variable', key: 'OPENROUTER_MODEL', value: 'previous/model:free' });
  const calls = [], logs = [], polls = new Map();
  let time = 0;
  const dependencies = {
    env: config,
    log: message => logs.push(message),
    now: () => time,
    sleep: async ms => { time += ms; },
    buildTimeoutMs: 20_000,
    fetchImpl: async (url, request) => {
      const body = request.body ? JSON.parse(request.body) : undefined;
      calls.push({ url, ...request, body });
      if (failRequest) return failRequest({ url, request, body });
      assert.ok(!url.includes('/executions'), 'configuration must never invoke a function');
      assert.equal(request.headers['X-Appwrite-Key'], env.APPWRITE_FUNCTIONS_API_KEY);
      assert.equal(request.redirect, 'manual');
      const parts = new URL(url).pathname.replace(/^\/v1\//, '').split('/').map(decodeURIComponent);
      const [, id, resource, subresource] = parts;
      const fn = functions.get(id);
      assert.ok(fn);
      if (!resource && request.method === 'GET') return Response.json(fn);
      if (resource === 'variables') {
        assert.equal(body.key, 'OPENROUTER_MODEL');
        if (request.method === 'PUT') {
          assert.equal(subresource, 'model-variable');
          Object.assign(fn.vars.find(v => v.$id === subresource), body);
        } else {
          assert.equal(request.method, 'POST');
          assert.equal(body.secret, false);
          fn.vars.push({ $id: 'new-model-variable', ...body });
        }
        fn.live = false;
        return Response.json({ $id: subresource || 'new-model-variable', ...body });
      }
      if (resource === 'deployments' && subresource === 'duplicate') {
        assert.equal(request.method, 'POST');
        assert.deepEqual(body, { deploymentId: `${id}-old` });
        if (changeActive) fn.deploymentId = `${id}-someone-elses-deployment`;
        return Response.json({ $id: `${id}-new` });
      }
      if (resource === 'deployments') {
        assert.equal(request.method, 'GET');
        const count = polls.get(id) || 0;
        polls.set(id, count + 1);
        return Response.json({ $id: `${id}-new`, status: buildStatuses[Math.min(count, buildStatuses.length - 1)] });
      }
      if (resource === 'deployment') {
        assert.equal(request.method, 'PATCH');
        fn.deploymentId = body.deploymentId;
        fn.live = true;
        return Response.json(fn);
      }
      assert.fail(`Unexpected request: ${request.method} ${url}`);
    },
  };
  return { dependencies, functions, calls, logs, run: () => applyOpenRouterModel(dependencies) };
}

test('GitHub model value updates/creates only the model variable, rebuilds active code, and activates both functions', async () => {
  const h = harness();
  assert.deepEqual(await h.run(), { model: 'other/model:free', functionIds: ['index-id', 'post-id'] });
  assert.ok(h.calls.slice(0, 2).every(call => call.method === 'GET'), 'both targets must be checked before writes');
  const variableWrites = h.calls.filter(call => call.url.includes('/variables'));
  assert.deepEqual(variableWrites.map(call => call.method), ['PUT', 'POST']);
  assert.ok(variableWrites.every(call => call.body.value === 'other/model:free'));
  for (const fn of h.functions.values()) {
    assert.equal(fn.deploymentId, `${fn.$id}-new`);
    assert.equal(fn.vars.find(v => v.key === 'OPENROUTER_MODEL').value, 'other/model:free');
    assert.deepEqual(fn.vars.find(v => v.key === 'OPENROUTER_API_KEY'), { $id: 'api-key-variable', key: 'OPENROUTER_API_KEY', value: '', secret: true });
  }
  assert.equal(h.calls.filter(call => call.method === 'PATCH').length, 2);
  assert.ok(!JSON.stringify(h.logs).includes(env.APPWRITE_FUNCTIONS_API_KEY));
});

test('an unset GitHub model variable restores the shared default', async () => {
  const h = harness({ config: { ...env, OPENROUTER_MODEL: '' } });
  assert.equal((await h.run()).model, DEFAULT_OPENROUTER_MODEL);
});

test('invalid model, missing credentials, or insecure endpoint fails before any Appwrite request', async () => {
  for (const override of [
    { OPENROUTER_MODEL: 'paid/model' },
    { OPENROUTER_MODEL: 'model:free; bad-command' },
    { APPWRITE_FUNCTIONS_API_KEY: '' },
    { APPWRITE_PROJECT_ID: '' },
    { APPWRITE_WYKOP_POST_FUNCTION_ID: '' },
    { APPWRITE_ENDPOINT: 'http://appwrite.example.test/v1' },
    { APPWRITE_ENDPOINT: 'https://user:password@appwrite.example.test/v1' },
    { APPWRITE_WYKOP_POST_FUNCTION_ID: 'index-id' },
  ]) {
    const h = harness({ config: { ...env, ...override } });
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 0);
  }
});

test('missing active deployment on either function prevents all writes', async () => {
  const h = harness();
  h.functions.get('post-id').deploymentId = '';
  await assert.rejects(h.run(), /active deployment/);
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('failed or stalled rebuilds stop before activation', async () => {
  for (const buildStatuses of [['failed'], ['building']]) {
    const h = harness({ buildStatuses });
    await assert.rejects(h.run(), /did not succeed|Timed out/);
    assert.ok(!h.calls.some(call => call.method === 'PATCH'));
    assert.equal(h.functions.get('index-id').deploymentId, 'index-id-old');
  }
});

test('a concurrent deployment is never replaced by the configuration workflow', async () => {
  const h = harness({ changeActive: true });
  await assert.rejects(h.run(), /changed during configuration/);
  assert.ok(!h.calls.some(call => call.method === 'PATCH'));
});

test('permission failures and redirects do not print upstream secrets and stop before writes', async () => {
  for (const status of [302, 403, 500]) {
    const h = harness({ failRequest: () => new Response(env.APPWRITE_FUNCTIONS_API_KEY, { status }) });
    await assert.rejects(h.run(), error => {
      assert.ok(error.message.includes(`HTTP ${status}`));
      assert.ok(!error.message.includes(env.APPWRITE_FUNCTIONS_API_KEY));
      return true;
    });
    assert.equal(h.calls.length, 1);
  }
});

test('an unconfirmed rebuild submission is not automatically repeated', async () => {
  const h = harness();
  const fetchImpl = h.dependencies.fetchImpl;
  let submissions = 0;
  h.dependencies.fetchImpl = async (url, request) => {
    if (url.endsWith('/deployments/duplicate')) {
      submissions++;
      throw new Error(`lost response ${env.APPWRITE_FUNCTIONS_API_KEY}`);
    }
    return fetchImpl(url, request);
  };
  await assert.rejects(h.run(), error => {
    assert.match(error.message, /could not be confirmed/);
    assert.ok(!error.message.includes(env.APPWRITE_FUNCTIONS_API_KEY));
    return true;
  });
  assert.equal(submissions, 1);
  assert.ok(!h.calls.some(call => call.method === 'PATCH'));
});

test('a concurrent model change prevents activation of the stale build', async () => {
  const h = harness({ buildStatuses: ['ready'] });
  const fetchImpl = h.dependencies.fetchImpl;
  h.dependencies.fetchImpl = async (url, request) => {
    const response = await fetchImpl(url, request);
    if (url.includes('/deployments/index-id-new')) {
      h.functions.get('index-id').vars.find(v => v.key === 'OPENROUTER_MODEL').value = 'changed/model:free';
    }
    return response;
  };
  await assert.rejects(h.run(), /model variable.*changed/);
  assert.ok(!h.calls.some(call => call.method === 'PATCH'));
});
