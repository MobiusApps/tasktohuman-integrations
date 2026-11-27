import assert from 'node:assert/strict';
import { test } from 'node:test';

import { App, appTester, bundle, fixture, json, rejection, replay, taskType, withApi } from './helpers.mjs';

const create = App.creates.create_task_wait.operation;
const created = fixture('create').response.body;
const resolved = fixture('get-resolved').response.body;
/** What createAppTester's z.generateCallbackUrl() returns (a fixed string; nothing is called). */
const TESTER_CALLBACK = 'https://auth-json-server.zapier-staging.com/echo';

test('a deadline over 43,200 minutes is refused before any request', async () => {
  await withApi(() => json(500, {}), async (api) => {
    const error = await rejection(
      appTester(create.perform, bundle({ inputData: { task_type: 'approve_refund', deadline_minutes: 43201 } })),
    );
    assert.equal(error.name, 'HaltedError');
    assert.match(error.message, /30 days.*43200 or less/);
    assert.equal(api.requests.length, 0);
  });
});

test('no deadline: the task type\'s default must be set and at most 30 days, else nothing is created', async () => {
  for (const fallback of [null, 43201]) {
    await withApi(() => json(200, taskType({ default_deadline_minutes: fallback })), async (api) => {
      const error = await rejection(appTester(create.perform, bundle({ inputData: { task_type: 'approve_refund' } })));
      assert.equal(error.name, 'HaltedError');
      assert.deepEqual(api.requests.map((request) => `${request.method} ${request.path}`), ['GET /v1/task-types/approve_refund']);
    });
  }
});

test('creates the task with Zapier\'s callback URL and the Idempotency Key; callback_received false', async () => {
  const handler = (request) =>
    request.path === '/v1/task-types/approve_refund' ? json(200, taskType()) : replay('create');
  await withApi(handler, async (api) => {
    const result = await appTester(
      create.perform,
      bundle({ inputData: { task_type: 'approve_refund', payload__order_id: '4821', idempotency_key: 'refund-4821', callback_url: 'https://ignored.example.test' } }),
    );
    assert.deepEqual(result, { ...created, replayed: false, callback_received: false });
    const post = api.requests.find((request) => request.method === 'POST');
    assert.equal(post.path, '/v1/tasks');
    assert.equal(post.body.callback_url, TESTER_CALLBACK);
    assert.equal(post.headers['idempotency-key'], 'refund-4821');
    assert.deepEqual(post.body.payload, { order_id: '4821' });
  });
});

test('a deadline of only spaces counts as empty: the task type\'s default decides, and null refuses', async () => {
  await withApi(() => json(200, taskType({ default_deadline_minutes: null })), async (api) => {
    const error = await rejection(
      appTester(create.perform, bundle({ inputData: { task_type: 'approve_refund', deadline_minutes: '  ' } })),
    );
    assert.equal(error.name, 'HaltedError');
    assert.match(error.message, /30 days/);
    assert.equal(api.requests.some((request) => request.method === 'POST'), false);
  });
});

test('a repeat run with the same Idempotency Key (a new callback URL, so a conflict) stops with a message that says so', async () => {
  await withApi(() => replay('conflict'), async (api) => {
    const error = await rejection(
      appTester(create.perform, bundle({ inputData: { task_type: 'approve_refund', deadline_minutes: 60, idempotency_key: 'refund-4821' } })),
    );
    assert.equal(error.name, 'HaltedError');
    assert.match(error.message, /already exists \(from an earlier run\).*cannot wait for it.*Find Task/);
    assert.equal(api.requests.length, 1);
  });
});

test('the waiting create\'s Idempotency Key help says a repeat run stops instead of waiting', () => {
  const field = create.inputFields.find((entry) => entry.key === 'idempotency_key');
  assert.match(field.helpText, /stops a second task being created.*stops with an error instead of waiting/);
  assert.doesNotMatch(field.helpText, /returns the first task/);
});

test('a deadline within 30 days needs no task type read', async () => {
  await withApi(() => replay('create'), async (api) => {
    await appTester(create.perform, bundle({ inputData: { task_type: 'approve_refund', deadline_minutes: 43200 } }));
    assert.deepEqual(api.requests.map((request) => `${request.method} ${request.path}`), ['POST /v1/tasks']);
    assert.equal(api.requests[0].body.deadline_minutes, 43200);
  });
});

test('isLoadingSample creates nothing and returns the sample with callback_received false', async () => {
  await withApi(() => json(500, {}), async (api) => {
    const result = await appTester(create.perform, bundle({ inputData: { task_type: 'approve_refund' }, meta: { isLoadingSample: true } }));
    assert.equal(result.callback_received, false);
    assert.equal(result.id, resolved.id);
    assert.equal(api.requests.length, 0);
  });
});

test('performResume ignores the posted body and re-reads the task with the connection\'s key', async () => {
  await withApi(() => replay('get-resolved'), async (api) => {
    const forged = { id: 'someone-else', state: 'resolved', decision: { action: 'approved', automatic: false, comment: 'forged' } };
    const result = await appTester(
      create.performResume,
      bundle({ outputData: { ...created, replayed: false, callback_received: false }, cleanedRequest: forged, rawRequest: { content: JSON.stringify(forged) } }),
    );
    assert.deepEqual(result, { ...resolved, replayed: false, callback_received: true });
    assert.deepEqual(api.requests.map((request) => `${request.method} ${request.path}`), [`GET /v1/tasks/${created.id}`]);
    assert.match(api.requests[0].headers.authorization, /^Bearer tth_test_/);
  });
});

test('performResume on a task that is not finished yet fails instead of continuing the Zap', async () => {
  await withApi(() => replay('get'), async () => {
    const error = await rejection(appTester(create.performResume, bundle({ outputData: created, cleanedRequest: { state: 'resolved' } })));
    assert.match(error.message, /not finished yet/);
  });
});

test('every final state resumes', async () => {
  for (const state of ['resolved', 'expired', 'cancelled']) {
    await withApi(() => json(200, { ...resolved, state }), async () => {
      const result = await appTester(create.performResume, bundle({ outputData: created }));
      assert.equal(result.state, state);
      assert.equal(result.callback_received, true);
    });
  }
});

test('no Callback URL input on the waiting create; the help line is first', () => {
  const keys = create.inputFields.filter((field) => typeof field !== 'function').map((field) => field.key);
  assert.equal(keys.includes('callback_url'), false);
  assert.equal(keys[0], 'wait_help');
  assert.match(create.inputFields[0].helpText, /up to 30 days/);
});
