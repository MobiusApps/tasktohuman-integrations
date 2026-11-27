import assert from 'node:assert/strict';
import { test } from 'node:test';

import { App, appTester, bundle, fixture, json, rejection, replay, withApi } from './helpers.mjs';

const createTask = App.creates.create_task.operation;
const findTask = App.searches.find_task.operation;
const choices = createTask.inputFields[0].choices.perform;

test('Create Task posts the body and returns the task; replayed from Idempotent-Replayed', async () => {
  await withApi(() => replay('create'), async (api) => {
    const result = await appTester(
      createTask.perform,
      bundle({ inputData: { task_type: 'approve_refund', title: 'Refund €249 to order #4821?', payload__order_id: '4821', deadline_minutes: 120, idempotency_key: 'refund-4821' } }),
    );
    assert.deepEqual(result, { ...fixture('create').response.body, replayed: false });
    const [request] = api.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v1/tasks');
    assert.equal(request.headers['idempotency-key'], 'refund-4821');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(request.body, {
      task_type: 'approve_refund',
      title: 'Refund €249 to order #4821?',
      payload: { order_id: '4821' },
      deadline_minutes: 120,
    });
  });
  await withApi(() => replay('replay'), async (api) => {
    const result = await appTester(createTask.perform, bundle({ inputData: { task_type: 'approve_refund', idempotency_key: 'refund-4821' } }));
    assert.equal(result.replayed, true);
    assert.equal(api.requests[0].headers['idempotency-key'], 'refund-4821');
  });
});

test('Create Task without an Idempotency Key sends no header; the callback URL when set', async () => {
  await withApi(() => replay('create'), async (api) => {
    await appTester(createTask.perform, bundle({ inputData: { task_type: 'approve_refund', callback_url: 'https://hooks.example.test/a' } }));
    assert.equal(api.requests[0].headers['idempotency-key'], undefined);
    assert.equal(api.requests[0].body.callback_url, 'https://hooks.example.test/a');
  });
});

test('Create Task: a refused body is a HaltedError naming the fields', async () => {
  await withApi(() => replay('validation'), async () => {
    const error = await rejection(appTester(createTask.perform, bundle({ inputData: { task_type: 'approve_refund' } })));
    assert.equal(error.name, 'HaltedError');
    assert.match(error.message, /payload\.amount/);
  });
});

test('the task type dropdown pages with paging_token = next_cursor', async () => {
  const page = { data: [{ key: 'approve_refund', name: 'Approve refund', kind: 'approval', steps: [], chain_override: false }], next_cursor: 'c2' };
  await withApi(() => json(200, page), async (api) => {
    const first = await appTester(choices, bundle());
    assert.deepEqual(first, { results: [{ id: 'approve_refund', label: 'Approve refund' }], paging_token: 'c2' });
    await appTester(choices, bundle({ meta: { paging_token: 'c2' } }));
    assert.equal(api.requests[0].path, '/v1/task-types');
    assert.equal(api.requests[0].query.cursor, undefined);
    assert.equal(api.requests[1].query.cursor, 'c2');
  });
});

test('Find Task returns [task], or [] when not found in this workspace and mode', async () => {
  await withApi(() => replay('get-resolved'), async (api) => {
    const result = await appTester(findTask.perform, bundle({ inputData: { task_id: ' 01a1e3a7-6489-7106-aa3a-c976287f9999 ' } }));
    assert.deepEqual(result, [fixture('get-resolved').response.body]);
    assert.equal(api.requests[0].path, '/v1/tasks/01a1e3a7-6489-7106-aa3a-c976287f9999');
  });
  await withApi(() => json(404, { title: 'Not found', status: 404, code: 'not_found' }), async () => {
    assert.deepEqual(await appTester(findTask.perform, bundle({ inputData: { task_id: 'x' } })), []);
  });
});

test('an id cannot change the request path', async () => {
  await withApi(() => json(404, { status: 404, code: 'not_found' }), async (api) => {
    await appTester(findTask.perform, bundle({ inputData: { task_id: '../task-types?x=1' } }));
    assert.equal(api.requests[0].path, '/v1/tasks/..%2Ftask-types%3Fx%3D1');
  });
});

test('an empty Task ID is refused before any request', async () => {
  await withApi(() => json(500, {}), async (api) => {
    const error = await rejection(appTester(findTask.perform, bundle({ inputData: { task_id: '  ' } })));
    assert.equal(error.name, 'HaltedError');
    assert.equal(api.requests.length, 0);
  });
});
