import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FINANCE, HUMANS, OPEN_STEPS, App, appTester, bundle, json, taskType, withApi } from './helpers.mjs';
import { buildCreateBody, payloadFields } from '../dist/fields.js';

const dynamicFields = App.creates.create_task.operation.inputFields.find((field) => typeof field === 'function');

/** A fake API with one task type and the workspace's people. */
const typeApi = (type) => (request) => {
  if (request.path === `/v1/task-types/${type.key}`) return json(200, type);
  if (request.path === '/v1/humans') {
    return json(200, { data: request.query.group ? FINANCE : HUMANS, next_cursor: null });
  }
  return undefined;
};

test('every task-type field type → a Zapier field with the payload__ prefix', () => {
  const fields = payloadFields(taskType());
  assert.deepEqual(
    fields.map((field) => [field.key, field.type, field.required]),
    [
      ['payload__order_id', 'string', true],
      ['payload__note', 'text', false],
      ['payload__amount', 'number', true],
      ['payload__express', 'boolean', false],
      ['payload__customer_email', 'string', false],
      ['payload__receipt', 'string', false],
    ],
  );
  assert.equal(fields[0].label, 'Order');
});

test('a sensitive field says so in its label and help text', () => {
  const sensitive = payloadFields(taskType()).find((field) => field.key === 'payload__customer_email');
  assert.equal(sensitive.label, 'Customer email (sensitive)');
  assert.match(sensitive.helpText, /masked until revealed.*Zap history/);
  const plain = payloadFields(taskType()).find((field) => field.key === 'payload__order_id');
  assert.equal(plain.helpText, undefined);
});

test('the dynamic fields read the chosen type once, and nothing without a type', async () => {
  await withApi(typeApi(taskType()), async (api) => {
    assert.deepEqual(await appTester(dynamicFields, bundle()), []);
    assert.equal(api.requests.length, 0);
    const fields = await appTester(dynamicFields, bundle({ inputData: { task_type: 'approve_refund' } }));
    assert.equal(fields.length, 6);
    assert.deepEqual(api.requests.map((request) => request.path), ['/v1/task-types/approve_refund']);
  });
});

test('approver fields: a dropdown for an open step, the group\'s members for a group step, a list for consensus', async () => {
  await withApi(typeApi(taskType({ fields: [], steps: OPEN_STEPS })), async (api) => {
    const fields = await appTester(dynamicFields, bundle({ inputData: { task_type: 'approve_refund' } }));
    assert.deepEqual(fields.map((field) => field.key), ['approver__1', 'approver__2', 'approver__3']);

    const [single, group, consensus] = fields;
    assert.equal(single.label, 'Approver for step 1');
    assert.deepEqual(single.choices.map((choice) => [choice.value, choice.label]), HUMANS.map((h) => [h.id, h.name]));
    assert.equal(single.list, undefined);

    assert.deepEqual(group.choices.map((choice) => choice.value), FINANCE.map((h) => h.id));
    assert.match(group.helpText, /member of Finance/);

    assert.equal(consensus.list, true);
    assert.match(consensus.helpText, /Between 2 and 3 different people/);

    // The workspace's people are read once for both at_creation steps; the group's once.
    const humanCalls = api.requests.filter((request) => request.path === '/v1/humans');
    assert.deepEqual(humanCalls.map((request) => request.query.group ?? ''), ['', OPEN_STEPS[1].group.id]);
    // Names and ids only: the API never returns addresses.
    assert.doesNotMatch(JSON.stringify(fields), /@/);
  });
});

test('a group with nobody in it yet: a plain field (no empty choice list), the payload fields kept', async () => {
  const api = (request) => (request.path === '/v1/humans' ? json(200, { data: [], next_cursor: null }) : typeApi(taskType({ steps: [OPEN_STEPS[1]] }))(request));
  await withApi(api, async () => {
    const fields = await appTester(dynamicFields, bundle({ inputData: { task_type: 'approve_refund' } }));
    const group = fields.find((field) => field.key.startsWith('approver__'));
    assert.equal('choices' in group, false);
    assert.equal(group.required, true);
    assert.match(group.helpText, /map a TaskToHuman ID or email address/);
    assert.equal(fields.filter((field) => field.key.startsWith('payload__')).length, 6);
  });
});

test('no approver fields when the type has no open step', async () => {
  await withApi(typeApi(taskType()), async (api) => {
    const fields = await appTester(dynamicFields, bundle({ inputData: { task_type: 'approve_refund' } }));
    assert.equal(fields.some((field) => field.key.startsWith('approver__')), false);
    assert.equal(api.requests.some((request) => request.path === '/v1/humans'), false);
  });
});

test('body: only non-empty values; numbers and booleans converted by the field type', () => {
  const meta = { inputFields: { payload__amount: { tth_type: 'number' }, payload__express: { tth_type: 'boolean' }, payload__order_id: { tth_type: 'text' } } };
  const body = buildCreateBody({
    inputData: {
      task_type: ' approve_refund ',
      title: '  ',
      payload__order_id: '4821',
      payload__amount: '249.5',
      payload__express: 'yes',
      payload__note: '',
      payload__receipt: null,
      deadline_minutes: '120',
      urgent: 'false',
      callback_url: '',
      idempotency_key: 'refund-4821',
    },
    meta,
  });
  assert.deepEqual(body, {
    task_type: 'approve_refund',
    payload: { order_id: '4821', amount: 249.5, express: true },
    deadline_minutes: 120,
  });
});

test('body: a value that does not convert is sent as typed, for the API to name', () => {
  const body = buildCreateBody({
    inputData: { task_type: 't', payload__amount: 'lots', deadline_minutes: 'soon' },
    meta: { inputFields: { payload__amount: { tth_type: 'number' } } },
  });
  assert.equal(body.payload.amount, 'lots');
  assert.equal(body.deadline_minutes, 'soon');
});

test('body: title, urgency, callback URL and approvers by id or email, one entry per person', () => {
  const body = buildCreateBody({
    inputData: {
      task_type: 't',
      title: ' Refund €249 to order #4821? ',
      urgent: true,
      callback_url: 'https://hooks.example.test/x',
      approver__1: HUMANS[0].id,
      approver__3: [HUMANS[0].id, 'rui@example.com', ''],
    },
    meta: {},
  });
  assert.equal(body.title, 'Refund €249 to order #4821?');
  assert.equal(body.urgency, 'high');
  assert.equal(body.callback_url, 'https://hooks.example.test/x');
  assert.deepEqual(body.approvers, [
    { step: 1, human: HUMANS[0].id },
    { step: 3, human: HUMANS[0].id },
    { step: 3, email: 'rui@example.com' },
  ]);
  assert.equal('owner' in body || 'chain' in body, false);
});
