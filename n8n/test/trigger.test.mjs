// The polling trigger with a fake IPollFunctions and a fake API (no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fakeContext, json, load } from './helpers.mjs';

const { TaskToHumanTrigger } = load('nodes/TaskToHumanTrigger/TaskToHumanTrigger.node.js');
const trigger = new TaskToHumanTrigger();

const task = (id, finishedAt, action = 'approved', automatic = false) => ({
	id,
	state: 'resolved',
	finished_at: finishedAt,
	decision: { action, automatic, comment: null, payload: null },
});
const full = (listed) => ({ ...listed, payload: { order_id: '4821' }, decision: { ...listed.decision, comment: 'OK' } });

const api = (listed) => (options) => {
	if (options.url.endsWith('/v1/tasks')) return json(200, { data: listed });
	const id = decodeURIComponent(options.url.split('/').pop());
	const found = listed.find((t) => t.id === id);
	return found ? json(200, full(found)) : json(404, { title: 'Not found.', status: 404, code: 'not_found' });
};

const params = (extra = {}) => ({ taskType: { mode: 'key', value: '' }, outcomes: [], includeAutomatic: true, includePayload: false, ...extra });

test('the description: a polling trigger with no inputs and no webhooks', () => {
	const d = trigger.description;
	assert.equal(d.polling, true);
	assert.deepEqual(d.inputs, []);
	assert.equal(d.webhooks, undefined);
	assert.match(d.displayName, /Trigger/);
});

test('first activation: no request, cursor set to now, nothing emitted', async () => {
	const staticData = {};
	const ctx = fakeContext({ params: params(), staticData, routes: api([task('a', '2026-11-22T09:00:00.000Z')]) });
	assert.equal(await trigger.poll.call(ctx), null);
	assert.equal(ctx.calls.length, 0);
	assert.ok(Date.parse(staticData.cursor) <= Date.now());
});

test('later polls: query from cursor - 2 min, read each new task, strip the payload by default, move the cursor', async () => {
	const staticData = { cursor: '2026-11-22T10:00:00.000Z', seen: {} };
	const listed = [task('a', '2026-11-22T10:00:01.000Z'), task('b', '2026-11-22T10:00:02.000Z')];
	const ctx = fakeContext({ params: params({ taskType: { mode: 'key', value: 'approve_refund' } }), staticData, routes: api(listed) });
	const [items] = await trigger.poll.call(ctx);
	assert.deepEqual(items.map((i) => i.json.id), ['a', 'b']);
	assert.equal(items[0].json.decision.comment, 'OK');
	assert.equal('payload' in items[0].json, false);
	assert.deepEqual(ctx.calls[0].qs, { task_type: 'approve_refund', finished_after: '2026-11-22T09:58:00.000Z', limit: 100 });
	assert.equal(staticData.cursor, '2026-11-22T10:00:02.000Z');

	const again = fakeContext({ params: params(), staticData, routes: api(listed) });
	assert.equal(await trigger.poll.call(again), null);
	assert.equal(again.calls.length, 1, 'only the list: nothing new to read');
});

test('Include Payload keeps the task fields', async () => {
	const staticData = { cursor: '2026-11-22T10:00:00.000Z', seen: {} };
	const ctx = fakeContext({ params: params({ includePayload: true }), staticData, routes: api([task('a', '2026-11-22T10:00:01.000Z')]) });
	const [items] = await trigger.poll.call(ctx);
	assert.deepEqual(items[0].json.payload, { order_id: '4821' });
});

test('outcome and automatic filters drop tasks but still mark them handled', async () => {
	const staticData = { cursor: '2026-11-22T10:00:00.000Z', seen: {} };
	const listed = [
		task('a', '2026-11-22T10:00:01.000Z', 'approved'),
		task('r', '2026-11-22T10:00:02.000Z', 'rejected'),
		task('x', '2026-11-22T10:00:03.000Z', 'approved', true),
	];
	const ctx = fakeContext({ params: params({ outcomes: ['approved'], includeAutomatic: false }), staticData, routes: api(listed) });
	const [items] = await trigger.poll.call(ctx);
	assert.deepEqual(items.map((i) => i.json.id), ['a']);
	assert.equal(staticData.cursor, '2026-11-22T10:00:03.000Z');
	assert.equal(Object.keys(staticData.seen).length, 3);
	// Filtered on the list view: one list request and one GET, for 'a' only.
	assert.deepEqual(ctx.calls.map((c) => c.url.split('/v1/')[1]), ['tasks', 'tasks/a']);
});

test('a task gone by the time it is read (404) is emitted from the list view', async () => {
	const staticData = { cursor: '2026-11-22T10:00:00.000Z', seen: {} };
	const listed = [task('gone', '2026-11-22T10:00:01.000Z')];
	const ctx = fakeContext({
		params: params(),
		staticData,
		routes: (options) => (options.url.endsWith('/v1/tasks') ? json(200, { data: listed }) : json(404, { title: 'Not found.', status: 404, code: 'not_found' })),
	});
	const [items] = await trigger.poll.call(ctx);
	assert.equal(items[0].json.id, 'gone');
});

test('a revoked key (401) throws instead of polling quietly, and the cursor stays', async () => {
	const staticData = { cursor: '2026-11-22T10:00:00.000Z', seen: {} };
	const ctx = fakeContext({ params: params(), staticData, routes: () => json(401, { title: 'Invalid API key.', status: 401, code: 'unauthorized' }) });
	await assert.rejects(trigger.poll.call(ctx), (e) => e.constructor.name === 'NodeApiError' && e.httpCode === '401');
	assert.equal(staticData.cursor, '2026-11-22T10:00:00.000Z');
});

test('a failure while reading a task leaves the cursor, so the tasks come again next poll', async () => {
	const staticData = { cursor: '2026-11-22T10:00:00.000Z', seen: {} };
	const listed = [task('a', '2026-11-22T10:00:01.000Z')];
	const ctx = fakeContext({
		params: params(),
		staticData,
		routes: (options) => (options.url.endsWith('/v1/tasks') ? json(200, { data: listed }) : json(503, { title: 'Unavailable.', status: 503, code: 'unavailable' })),
	});
	await assert.rejects(trigger.poll.call(ctx));
	assert.deepEqual(staticData, { cursor: '2026-11-22T10:00:00.000Z', seen: {} });
});

test('manual mode returns the most recently finished task as a sample and leaves the state alone', async () => {
	const staticData = {};
	const listed = [
		{ id: 'open', state: 'notified', finished_at: null, decision: null },
		task('older', '2026-11-22T09:00:00.000Z'),
		task('newer', '2026-11-22T10:00:00.000Z'),
	];
	const ctx = fakeContext({ mode: 'manual', params: params(), staticData, routes: api(listed) });
	const [[item]] = await trigger.poll.call(ctx);
	assert.equal(item.json.id, 'newer');
	assert.equal('payload' in item.json, false);
	assert.deepEqual(ctx.calls[0].qs, { limit: 20 });
	assert.deepEqual(staticData, {});
});

test('manual mode with no finished task says what to do', async () => {
	const ctx = fakeContext({ mode: 'manual', params: params(), routes: api([]) });
	await assert.rejects(trigger.poll.call(ctx), /No finished task/);
});
