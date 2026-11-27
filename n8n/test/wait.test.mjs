import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixture, load, n8nWorkflow, sign, SECRET } from './helpers.mjs';

const { waitTill, isFinal, checkCallback, waitBindingKey, CALLBACK_GRACE_MS } = load('nodes/TaskToHuman/shared/wait.js');
const { WAIT_INDEFINITELY } = n8nWorkflow;

test('the wait ends one hour after the deadline', () => {
	assert.equal(CALLBACK_GRACE_MS, 3_600_000);
	assert.equal(waitTill('2026-11-16T11:19:20.713Z').toISOString(), '2026-11-16T12:19:20.713Z');
});

test('no deadline (or an unreadable one) waits indefinitely', () => {
	assert.equal(waitTill(null), WAIT_INDEFINITELY);
	assert.equal(waitTill(undefined), WAIT_INDEFINITELY);
	assert.equal(waitTill('not a date'), WAIT_INDEFINITELY);
});

test('final states', () => {
	for (const state of ['resolved', 'expired', 'cancelled']) assert.equal(isFinal(state), true);
	for (const state of ['open', 'notified', 'acknowledged', undefined]) assert.equal(isFinal(state), false);
});

test('a signed final callback is accepted with its parsed body', () => {
	const v = fixture('callback-signature.json');
	const expectedTaskId = JSON.parse(v.body).id;
	const result = checkCallback({ rawBody: Buffer.from(v.body), header: v.header, secret: v.secret, nowSeconds: v.t, expectedTaskId });
	assert.equal(result.accept, true);
	assert.equal(result.task.decision.action, 'approved');
});

test('refusals: 401 for signature reasons, 400 for a missing body, non-JSON or non-final task', async () => {
	const now = Math.floor(Date.now() / 1000);
	const open = '{"id":"x","state":"notified"}';
	assert.deepEqual(checkCallback({ rawBody: Buffer.from(open), header: await sign(open, now), secret: SECRET, nowSeconds: now, expectedTaskId: 'x' }), {
		accept: false,
		status: 400,
		reason: 'not_final',
	});
	const text = 'hello';
	assert.equal(checkCallback({ rawBody: Buffer.from(text), header: await sign(text, now), secret: SECRET, nowSeconds: now, expectedTaskId: 'x' }).reason, 'not_json');
	const list = '[1]';
	assert.equal(checkCallback({ rawBody: Buffer.from(list), header: await sign(list, now), secret: SECRET, nowSeconds: now, expectedTaskId: 'x' }).reason, 'not_json');
	assert.deepEqual(checkCallback({ rawBody: undefined, header: 'x', secret: SECRET, nowSeconds: now, expectedTaskId: 'x' }), {
		accept: false,
		status: 400,
		reason: 'missing_body',
	});
	const body = '{"id":"x","state":"resolved"}';
	assert.equal(checkCallback({ rawBody: Buffer.from(body), header: await sign(body, now - 301), secret: SECRET, nowSeconds: now, expectedTaskId: 'x' }).status, 401);
	assert.equal(checkCallback({ rawBody: Buffer.from(body), header: await sign(body, now, 'whsec_other'), secret: SECRET, nowSeconds: now, expectedTaskId: 'x' }).status, 401);
	assert.equal(checkCallback({ rawBody: Buffer.from(body), header: undefined, secret: SECRET, nowSeconds: now, expectedTaskId: 'x' }).status, 401);
	assert.equal(checkCallback({ rawBody: Buffer.from(body), header: await sign(body, now), secret: '', nowSeconds: now, expectedTaskId: 'x' }).status, 401);
});

test('a validly signed final callback of another task is refused (401, task_mismatch)', async () => {
	const now = Math.floor(Date.now() / 1000);
	const other = '{"id":"task-b","state":"resolved","decision":{"action":"approved","automatic":false}}';
	const header = await sign(other, now);
	for (const expectedTaskId of ['task-a', undefined, '']) {
		assert.deepEqual(checkCallback({ rawBody: Buffer.from(other), header, secret: SECRET, nowSeconds: now, expectedTaskId }), {
			accept: false,
			status: 401,
			reason: 'task_mismatch',
		});
	}
});

test('the custom data key: letters, digits and underscores only, at most 50 characters', () => {
	assert.equal(waitBindingKey('5f0c-4b1e-9a2d'), 'tth_task_5f0c_4b1e_9a2d');
	assert.match(waitBindingKey('a'.repeat(80)), /^[A-Za-z0-9_]{50}$/);
	assert.equal(waitBindingKey('8c2b6f1e-3d4a-4b5c-9e7f-0a1b2c3d4e5f').length, 45);
});
