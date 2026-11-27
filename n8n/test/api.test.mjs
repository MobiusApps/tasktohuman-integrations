import assert from 'node:assert/strict';
import { test } from 'node:test';

import { API_KEY, credentials, fakeContext, fixture, json, load } from './helpers.mjs';

const { checkBaseUrl, describeFailure, toNodeApiError, request } = load('nodes/TaskToHuman/shared/api.js');

const raw = (status, body, headers = {}) => ({ status, body, headers });

test('base URL: https, trailing slashes trimmed', () => {
	assert.deepEqual(checkBaseUrl('https://api.tasktohuman.com'), { url: 'https://api.tasktohuman.com' });
	assert.deepEqual(checkBaseUrl(' https://api.tasktohuman.com/// '), { url: 'https://api.tasktohuman.com' });
	assert.deepEqual(checkBaseUrl('https://api.example.test:8443/'), { url: 'https://api.example.test:8443' });
});

test('base URL: http only for localhost and *.localhost', () => {
	assert.deepEqual(checkBaseUrl('http://localhost:8080'), { url: 'http://localhost:8080' });
	assert.deepEqual(checkBaseUrl('http://api.localhost'), { url: 'http://api.localhost' });
	assert.match(checkBaseUrl('http://api.tasktohuman.com').refusal, /https/);
	assert.match(checkBaseUrl('http://localhost.example.com').refusal, /https/);
	assert.match(checkBaseUrl('ftp://api.tasktohuman.com').refusal, /https/);
});

test('base URL: no path, query, fragment or credentials; must be a URL', () => {
	assert.match(checkBaseUrl('https://api.tasktohuman.com/v1').refusal, /path/);
	assert.match(checkBaseUrl('https://api.tasktohuman.com/?x=1').refusal, /plain address/);
	assert.match(checkBaseUrl('https://user:pw@api.tasktohuman.com').refusal, /plain address/);
	assert.match(checkBaseUrl('api.tasktohuman.com').refusal, /not a web address/);
	assert.match(checkBaseUrl('').refusal, /Fill in/);
	assert.match(checkBaseUrl(undefined).refusal, /Fill in/);
});

test('400 validation: the title, and one line per field', () => {
	const f = fixture('api/validation.json').response;
	const failure = describeFailure(raw(f.status, f.body));
	assert.equal(failure.message, 'Some fields need your attention.');
	assert.equal(failure.code, 'validation_failed');
	assert.match(failure.description, /payload\.amount: This value doesn't match the field's type\. \(field_invalid\)/);
});

test('hints per status and code', () => {
	const cases = [
		[401, { title: 'x', status: 401, code: 'unauthorized' }, /API key/],
		[402, { title: 'x', status: 402, code: 'task_limit_reached', reason: 'monthly_limit' }, /\(monthly_limit\).*Billing/],
		[403, { title: 'x', status: 403, code: 'feature_not_in_plan', feature: 'routing.chain_override' }, /plan does not include this \(routing\.chain_override\)/],
		[403, { title: 'x', status: 403, code: 'workspace_inactive' }, /workspace is inactive/],
		[403, { title: 'x', status: 403, code: 'organization_suspended' }, /organization/],
		[404, { title: 'x', status: 404, code: 'not_found' }, /test key/],
		[409, { title: 'x', status: 409, code: 'idempotency_conflict' }, /same Idempotency Key/],
		[409, { title: 'x', status: 409, code: 'task_already_finished', state: 'cancelled' }, /already finished[\s\S]*state: cancelled/],
		[422, { title: 'x', status: 422, code: 'no_owner_available' }, /Nobody can take/],
		[503, { title: 'x', status: 503, code: 'unavailable' }, /safe to try again/],
	];
	for (const [status, body, pattern] of cases) {
		assert.match(describeFailure(raw(status, body)).description, pattern, `HTTP ${status} ${body.code}`);
	}
});

test('403 api_key_paused and address_blocked: the API\'s message, and a hint that says what happened', () => {
	// Built inline: fixtures/api has no example of these (it is synced from the server).
	const paused = describeFailure(
		raw(403, {
			title: 'This API key is paused by TaskToHuman support until 2026-11-27 14:30 UTC. Contact support.',
			status: 403,
			code: 'api_key_paused',
			until: '2026-11-27 14:30 UTC',
		}),
	);
	assert.equal(paused.message, 'This API key is paused by TaskToHuman support until 2026-11-27 14:30 UTC. Contact support.');
	assert.equal(paused.code, 'api_key_paused');
	assert.match(paused.description, /paused this API key until 2026-11-27 14:30 UTC\. .*contact TaskToHuman support/);
	assert.doesNotMatch(paused.description, /organization/);
	const blocked = describeFailure(
		raw(403, {
			title: 'Access from your network is temporarily blocked. If you think this is a mistake, contact support.',
			status: 403,
			code: 'address_blocked',
		}),
	);
	assert.equal(blocked.message, 'Access from your network is temporarily blocked. If you think this is a mistake, contact support.');
	assert.match(blocked.description, /blocking requests from this n8n's network/);
});

test('429 names Retry-After and Retry On Fail', () => {
	const failure = describeFailure(raw(429, { title: 'Too many requests.', status: 429, code: 'rate_limited' }, { 'retry-after': '12' }));
	assert.match(failure.description, /wait 12 seconds.*Retry On Fail/);
});

test('a non-JSON answer (an HTML error page) gets a generic message with the status', () => {
	const failure = describeFailure(raw(502, '<html>Bad gateway</html>'));
	assert.equal(failure.message, 'TaskToHuman could not answer right now (HTTP 502)');
	assert.match(failure.description, /safe to try again/);
	assert.equal(describeFailure(raw(418, null)).message, 'TaskToHuman refused the request (HTTP 418)');
});

test('a refused callback URL on Create and Wait points at WEBHOOK_URL', () => {
	const body = {
		title: 'Some fields need your attention.',
		status: 400,
		code: 'validation_failed',
		errors: { callback_url: [{ code: 'callback_url_https_required', message: 'Use https.' }] },
	};
	assert.match(describeFailure(raw(400, body), { forWait: true }).description, /WEBHOOK_URL/);
	assert.doesNotMatch(describeFailure(raw(400, body)).description, /WEBHOOK_URL/);
});

test('402 not_enough_credits: out of credits with the counts, how to get credits, and the reason; sent once', async () => {
	const f = fixture('api/not-enough-credits.json').response;
	const failure = describeFailure(raw(f.status, f.body));
	assert.equal(failure.code, 'not_enough_credits');
	assert.equal(failure.message, 'Not enough credits for this task.');
	const held = f.body.held ? ` and ${f.body.held} are held by open tasks` : '';
	assert.ok(
		failure.description.includes(
			`out of credits, so the task was not created. It needs ${f.body.needed} credits; ${f.body.available} are free${held}.`,
		),
		failure.description,
	);
	assert.match(failure.description, /Retrying will not help.*buy a credit pack or turn on automatic buying/);
	assert.ok(failure.description.includes(`reason: ${f.body.reason}`), failure.description);
	assert.doesNotMatch(failure.description, /\berror\b|\bproblem\b/i);

	const ctx = fakeContext({ routes: () => json(f.status, f.body) });
	const error = await request.call(ctx, 'POST', '/v1/tasks', { body: { task_type: 'approve_refund' } }).then(
		() => assert.fail('expected a failure'),
		(e) => e,
	);
	assert.equal(error.constructor.name, 'NodeApiError');
	assert.equal(error.httpCode, '402');
	assert.equal(ctx.calls.length, 1);
});

test('other 402 codes keep the allowance hint', () => {
	const failure = describeFailure(raw(402, { title: 'x', status: 402, code: 'test_task_limit_reached', reason: 'test_limit' }));
	assert.match(failure.description, /cannot create more tasks right now \(test_limit\).*Billing/);
	assert.doesNotMatch(failure.description, /credits/);
});

test('messages avoid the words "error" and "problem"', () => {
	for (const status of [400, 401, 402, 403, 404, 409, 422, 429, 500, 502]) {
		const failure = describeFailure(raw(status, '<html>'));
		assert.doesNotMatch(`${failure.message} ${failure.description}`, /\berror\b|\bproblem\b/i);
	}
});

test('the NodeApiError carries no key and no headers', async () => {
	const ctx = fakeContext({
		routes: () => json(401, { title: 'Invalid API key.', status: 401, code: 'unauthorized' }, { 'www-authenticate': 'Bearer' }),
	});
	const error = await request.call(ctx, 'GET', '/v1/me').then(
		() => assert.fail('expected a failure'),
		(e) => e,
	);
	assert.equal(error.constructor.name, 'NodeApiError');
	assert.equal(error.httpCode, '401');
	assert.equal(error.message, 'Invalid API key.');
	const serialized = JSON.stringify({ ...error, message: error.message, description: error.description });
	assert.doesNotMatch(serialized, /tth_/);
	assert.doesNotMatch(serialized, /Authorization|Bearer/i);
	const direct = JSON.stringify(toNodeApiError(ctx.getNode(), describeFailure(raw(500, { title: 't', status: 500, code: 'x' }))));
	assert.doesNotMatch(direct, /tth_/);
});

test('requests go to the base URL with the credential, Accept-Language en and no manual auth header', async () => {
	const ctx = fakeContext({ routes: () => json(200, { ok: true }) });
	assert.deepEqual(await request.call(ctx, 'GET', '/v1/me', { qs: { a: 1 } }), { ok: true });
	const [call] = ctx.calls;
	assert.equal(call.credentialType, 'taskToHumanApi');
	assert.equal(call.url, 'https://api.example.test/v1/me');
	assert.deepEqual(call.qs, { a: 1 });
	assert.equal(call.headers['Accept-Language'], 'en');
	assert.equal(call.headers.Authorization, undefined);
	assert.equal(call.returnFullResponse, true);
	assert.equal(call.ignoreHttpStatusErrors, true);
	assert.equal(JSON.stringify(call).includes(API_KEY), false);
});

test('an http base URL is refused before any request', async () => {
	const ctx = fakeContext({ creds: credentials({ baseUrl: 'http://api.tasktohuman.com' }) });
	await assert.rejects(request.call(ctx, 'GET', '/v1/me'), /https/);
	assert.equal(ctx.calls.length, 0);
});
