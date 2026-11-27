import assert from 'node:assert/strict';
import { test } from 'node:test';

import { API_KEY, App, appTester, bundle, fixture, rejection, replay, withApi } from './helpers.mjs';

test('the key is a required password field; there is no base URL or signing secret field', () => {
  const { authentication } = App;
  assert.equal(authentication.type, 'custom');
  assert.deepEqual(authentication.fields.map((field) => [field.key, field.type, field.required]), [['apiKey', 'password', true]]);
  assert.match(authentication.fields[0].helpText, /tth_live_.*tth_test_/);
});

test('test calls GET /v1/me with the bearer key and the fixed headers', async () => {
  await withApi(() => replay('me-test'), async (api) => {
    const me = await appTester(App.authentication.test, bundle());
    assert.deepEqual(me, fixture('me-test').response.body);
    const [request] = api.requests;
    assert.equal(request.method, 'GET');
    assert.equal(request.path, '/v1/me');
    assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(request.headers.accept, 'application/json');
    assert.equal(request.headers['accept-language'], 'en');
    assert.match(request.headers['user-agent'], /^tasktohuman-zapier\/\d+\.\d+\.\d+$/);
  });
});

test('label: workspace name and Test or Live, never the key prefix or the organization', async () => {
  const testLabel = await appTester(App.authentication.connectionLabel, bundle({ inputData: fixture('me-test').response.body }));
  assert.equal(testLabel, 'Shop · Test');
  const liveLabel = await appTester(App.authentication.connectionLabel, bundle({ inputData: fixture('me').response.body }));
  assert.equal(liveLabel, 'Shop · Live');
  // Zapier may hand the test's answer in flattened.
  const flat = await appTester(App.authentication.connectionLabel, bundle({ inputData: { workspace__name: 'Shop', key__mode: 'test' } }));
  assert.equal(flat, 'Shop · Test');
  for (const label of [testLabel, liveLabel]) {
    assert.doesNotMatch(label, /tth_|Lumen/);
  }
});

test('401 → ExpiredAuthError asking to reconnect, without the key', async () => {
  await withApi(() => replay('unauthorized'), async () => {
    const error = await rejection(appTester(App.authentication.test, bundle()));
    assert.equal(error.name, 'ExpiredAuthError');
    assert.match(error.message, /Reconnect/);
    assert.doesNotMatch(error.message, /tth_/);
  });
});
