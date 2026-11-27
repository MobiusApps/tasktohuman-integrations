import assert from 'node:assert/strict';
import { test } from 'node:test';

import { App, fixture, repoFile } from './helpers.mjs';

const body = (name) => fixture(name).response.body;
const without = (object, ...keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

test('every sample equals its fixture body, plus the flags this app adds', () => {
  const { triggers, creates, searches } = App;
  assert.deepEqual(triggers.task_finished.operation.sample, body('get-resolved'));
  assert.deepEqual(searches.find_task.operation.sample, body('get-resolved'));
  assert.deepEqual(without(creates.create_task.operation.sample, 'replayed'), body('create'));
  assert.deepEqual(without(creates.create_task_wait.operation.sample, 'replayed', 'callback_received'), body('get-resolved'));
  assert.deepEqual(without(creates.cancel_task.operation.sample, 'cancelled'), body('cancel'));
});

test('every visible operation has a sample and output fields', () => {
  const operations = [...Object.values(App.triggers), ...Object.values(App.creates), ...Object.values(App.searches)];
  for (const operation of operations) {
    assert.ok(operation.operation.sample, operation.key);
    assert.ok(operation.operation.outputFields.length > 0, operation.key);
  }
});

/** Resolves a Zapier key (`decision__by__name`) against the OpenAPI schema of a task. */
function inSchema(spec, schema, path) {
  if (path.length === 0) return true;
  const resolve = (s) => (s?.$ref ? spec.components.schemas[s.$ref.split('/').pop()] : s);
  let current = resolve(schema);
  if (current?.oneOf) current = resolve(current.oneOf.find((s) => s.type !== 'null'));
  const next = current?.properties?.[path[0]];
  return next !== undefined && inSchema(spec, next, path.slice(1));
}

test('every output field key exists in the OpenAPI schema of a task (the flags this app adds aside)', () => {
  const spec = JSON.parse(repoFile('openapi/public-v1.json'));
  const task = spec.components.schemas.PublicTaskView;
  const added = ['replayed', 'callback_received', 'cancelled'];
  const operations = [...Object.values(App.triggers), ...Object.values(App.creates), ...Object.values(App.searches)];
  for (const operation of operations) {
    for (const field of operation.operation.outputFields) {
      if (added.includes(field.key)) continue;
      assert.ok(inSchema(spec, task, field.key.split('__')), `${operation.key}: ${field.key}`);
    }
  }
});

test('labels in plain English for the common paths', () => {
  const labels = Object.fromEntries(App.triggers.task_finished.operation.outputFields.map((field) => [field.key, field.label]));
  assert.equal(labels.decision__action, 'Decision');
  assert.equal(labels.decision__automatic, 'Decided Automatically');
  assert.equal(labels.decision__comment, 'Comment');
  assert.equal(labels.decision__by__name, 'Decided By');
  assert.equal(labels.finished_at, 'Finished At');
  assert.equal(labels.test, 'Test Task');
});
