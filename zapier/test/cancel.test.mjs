import assert from 'node:assert/strict';
import { test } from 'node:test';

import { App, appTester, bundle, fixture, json, rejection, replay, withApi } from './helpers.mjs';

const cancel = App.creates.cancel_task.operation;
const id = fixture('cancel').request.path.split('/')[3];

test('cancels and returns the task with cancelled: true', async () => {
  await withApi(() => replay('cancel'), async (api) => {
    const result = await appTester(cancel.perform, bundle({ inputData: { task_id: id } }));
    assert.deepEqual(result, { ...fixture('cancel').response.body, cancelled: true });
    assert.deepEqual(api.requests.map((request) => `${request.method} ${request.path}`), [`POST /v1/tasks/${id}/cancel`]);
  });
});

test('409 task_already_finished → the task as it is, with cancelled: false', async () => {
  const finished = { ...fixture('get-resolved').response.body, id };
  const handler = (request) => (request.method === 'POST' ? replay('cancel-finished') : json(200, finished));
  await withApi(handler, async (api) => {
    const result = await appTester(cancel.perform, bundle({ inputData: { task_id: id } }));
    assert.deepEqual(result, { ...finished, cancelled: false });
    assert.deepEqual(api.requests.map((request) => `${request.method} ${request.path}`), [
      `POST /v1/tasks/${id}/cancel`,
      `GET /v1/tasks/${id}`,
    ]);
  });
});

test('another 409, or a 404, is an error', async () => {
  await withApi(() => json(404, { status: 404, code: 'not_found' }), async () => {
    const error = await rejection(appTester(cancel.perform, bundle({ inputData: { task_id: id } })));
    assert.equal(error.name, 'HaltedError');
    assert.match(error.message, /test key sees only test tasks/);
  });
});
