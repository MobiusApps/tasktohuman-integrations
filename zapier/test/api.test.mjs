import assert from 'node:assert/strict';
import { test } from 'node:test';

import { App, appTester, bundle, fixture, json, problem, rejection, replay, withApi } from './helpers.mjs';
import { DEFAULT_BASE_URL, baseUrl, call } from '../dist/api.js';

const get = (z) => call(z, 'GET', '/v1/me');

async function failureFor(reply) {
  return withApi(() => reply, () => rejection(appTester(get, bundle())));
}

test('base URL: the production API unless TTH_BASE_URL is set', () => {
  const previous = process.env.TTH_BASE_URL;
  try {
    delete process.env.TTH_BASE_URL;
    assert.equal(baseUrl(), DEFAULT_BASE_URL);
    assert.equal(DEFAULT_BASE_URL, 'https://api.tasktohuman.com');
    process.env.TTH_BASE_URL = 'https://api.example.test/';
    assert.equal(baseUrl(), 'https://api.example.test');
    for (const local of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://api.localhost']) {
      process.env.TTH_BASE_URL = local;
      assert.equal(baseUrl(), local);
    }
    for (const refused of ['http://api.tasktohuman.com', 'http://localhost.example.com', 'ftp://localhost']) {
      process.env.TTH_BASE_URL = refused;
      assert.throws(() => baseUrl(), /https/, refused);
    }
    for (const refused of ['https://api.example.test/v1', 'https://user:pw@api.example.test', 'https://api.example.test/?a=1']) {
      process.env.TTH_BASE_URL = refused;
      assert.throws(() => baseUrl(), /plain address/, refused);
    }
    process.env.TTH_BASE_URL = 'not a url';
    assert.throws(() => baseUrl(), /not a web address/);
  } finally {
    if (previous === undefined) delete process.env.TTH_BASE_URL;
    else process.env.TTH_BASE_URL = previous;
  }
});

test('the key goes only to the API base URL', async () => {
  const request = { url: 'https://elsewhere.example.test/x', headers: {} };
  const result = App.beforeRequest[0](request, {}, bundle());
  assert.equal(result.headers.Authorization, undefined);
});

test('400 validation_failed → HaltedError listing each field and code', async () => {
  const error = await failureFor(replay('validation'));
  assert.equal(error.name, 'HaltedError');
  assert.match(error.message, /Some fields need your attention\./);
  assert.match(error.message, /payload\.amount: This value doesn't match the field's type\. \(field_invalid\)/);
});

test('400 unknown_property names the property', async () => {
  const error = await failureFor(replay('unknown-property'));
  assert.equal(error.name, 'HaltedError');
  const [key] = Object.keys(fixture('unknown-property').response.body.errors);
  assert.ok(error.message.includes(key), error.message);
});

test('each status and code of the error table → its error class and message', async () => {
  const cases = [
    [problem(401, 'unauthorized'), 'ExpiredAuthError', /Reconnect/],
    [problem(402, 'task_limit_reached', { reason: 'plan_limit' }), 'HaltedError', /monthly task limit.*Billing/],
    [problem(402, 'task_limit_reached', { reason: 'hard_cap' }), 'HaltedError', /hard cap/],
    [problem(402, 'task_limit_reached', { reason: 'spend_cap' }), 'HaltedError', /spend cap/],
    [problem(402, 'test_task_limit_reached', { reason: 'test_limit' }), 'HaltedError', /test task allowance/],
    [problem(403, 'feature_not_in_plan', { feature: 'intake.api' }), 'HaltedError', /plan does not include this \(intake\.api\).*feature_not_in_plan/],
    [problem(403, 'workspace_inactive'), 'HaltedError', /workspace is inactive/],
    [problem(403, 'organization_suspended'), 'HaltedError', /organization_suspended/],
    [problem(404, 'not_found'), 'HaltedError', /Not found in this workspace and mode \(a test key sees only test tasks\)/],
    [replay('conflict'), 'HaltedError', /Idempotency Key was used with different values/],
    [problem(409, 'task_already_finished', { state: 'resolved' }), 'HaltedError', /task_already_finished/],
    [problem(422, 'no_owner_available'), 'HaltedError', /Nobody can take this task/],
    [problem(500, 'server_error'), 'AppError', /HTTP 500.*safe to try again/],
    [problem(503, 'server_error'), 'AppError', /HTTP 503/],
  ];
  for (const [reply, name, pattern] of cases) {
    const error = await failureFor(reply);
    assert.equal(error.name, name, `${reply.status} ${reply.body.code}`);
    assert.match(error.message, pattern, `${reply.status} ${reply.body.code}`);
  }
});

test('402 not_enough_credits → HaltedError (no retry) with the counts, the reason and how to get credits', async () => {
  const createTask = App.creates.create_task.operation;
  const reasonInWords = {
    no_credits: 'automatic buying is not available',
    auto_buy_off: 'automatic buying is off',
    spending_cap: "automatic buying would pass the organization's monthly spending cap",
    top_up_failed: 'the automatic purchase failed: check the card',
    purchases_disabled: 'credit purchases are turned off for now',
  };
  const f = fixture('not-enough-credits');
  const { needed, available, held, reason } = f.response.body;
  const idempotencyKey = f.request.headers['Idempotency-Key'];
  assert.ok(reasonInWords[reason], `the fixture's reason "${reason}" has words in this test`);
  await withApi(() => replay('not-enough-credits'), async (api) => {
    const error = await rejection(appTester(createTask.perform, bundle({ inputData: { task_type: f.request.body.task_type, idempotency_key: idempotencyKey } })));
    assert.equal(error.name, 'HaltedError');
    assert.ok(error.message.includes(`out of credits, so the task was not created (${reasonInWords[reason]}).`), error.message);
    const heldText = held ? ` and ${held} are held by open tasks` : '';
    assert.ok(error.message.includes(`It needs ${needed} credits; ${available} are free${heldText}.`), error.message);
    assert.match(error.message, /Buy a credit pack or turn on automatic buying in TaskToHuman \(Plan > Credits\).*\(not_enough_credits\)$/);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].path, f.request.path);
    assert.equal(api.requests[0].headers['idempotency-key'], idempotencyKey);
  });
  for (const [reason, words] of Object.entries(reasonInWords)) {
    const error = await failureFor(problem(402, 'not_enough_credits', { needed: 2, available: 0, held: 0, reason, auto_buy: false }));
    assert.equal(error.name, 'HaltedError', reason);
    assert.ok(error.message.includes(`not created (${words}).`), reason);
    assert.match(error.message, /It needs 2 credits; 0 are free\. Buy/, reason);
  }
});

test('403 api_key_paused and address_blocked → HaltedError with the API\'s message and code, sent once', async () => {
  // Built inline: fixtures/api has no example of these (it is synced from the server).
  const paused = problem(403, 'api_key_paused', {
    title: 'This API key is paused by TaskToHuman support until 2026-11-27 14:30 UTC. Contact support.',
    until: '2026-11-27 14:30 UTC',
  });
  const blocked = problem(403, 'address_blocked', {
    title: 'Access from your network is temporarily blocked. If you think this is a mistake, contact support.',
  });
  for (const reply of [paused, blocked]) {
    const { error, sent } = await withApi(
      () => reply,
      async (api) => ({ error: await rejection(appTester(get, bundle())), sent: api.requests.length }),
    );
    assert.equal(error.name, 'HaltedError', reply.body.code);
    assert.ok(error.message.startsWith(`${reply.body.title} (${reply.body.code})`), error.message);
    assert.equal(sent, 1, 'not retried');
  }
});

test('429 with Retry-After → ThrottledError with that delay', async () => {
  const error = await failureFor(problem(429, 'rate_limited', {}));
  assert.equal(error.name, 'ThrottledError');
  const withHeader = await failureFor({ ...problem(429, 'rate_limited'), headers: { 'Retry-After': '12', 'Content-Type': 'application/problem+json' } });
  assert.equal(withHeader.name, 'ThrottledError');
  const parsed = JSON.parse(withHeader.message);
  assert.equal(parsed.delay, 12);
  assert.match(parsed.message, /wait 12 seconds/);
});

test('a non-JSON answer (an edge error page) gets a generic message with the status', async () => {
  const error = await failureFor({ status: 502, headers: { 'Content-Type': 'text/html' }, body: '<html>Bad gateway</html>' });
  assert.equal(error.name, 'AppError');
  assert.match(error.message, /HTTP 502/);
  const teapot = await failureFor({ status: 418, headers: { 'Content-Type': 'text/html' }, body: '<html></html>' });
  assert.equal(teapot.name, 'HaltedError');
  assert.match(teapot.message, /HTTP 418/);
});

test('no message contains the key or anything that looks like one', async () => {
  const replies = [
    replay('validation'), replay('unauthorized'), replay('conflict'), replay('cancel-finished'),
    problem(402, 'task_limit_reached', { reason: 'plan_limit' }), problem(403, 'feature_not_in_plan'),
    problem(404, 'not_found'), problem(422, 'no_owner_available'), problem(429, 'rate_limited'),
    problem(500, 'server_error'), json(502, '<html></html>'),
  ];
  for (const reply of replies) {
    const error = await failureFor(reply);
    assert.doesNotMatch(`${error.name} ${error.message} ${error.stack}`, /tth_|Bearer/, `HTTP ${reply.status}`);
  }
});
