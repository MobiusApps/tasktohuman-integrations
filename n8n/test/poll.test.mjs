import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './helpers.mjs';

const { findNew, advance, matchesFilters, withoutPayload, queryStart, seenKey, OVERLAP_MS, MAX_NEW_PER_POLL, PAGE_SIZE, MAX_PAGES_PER_POLL } = load(
	'nodes/TaskToHuman/shared/poll.js',
);

const at = (iso) => ({ id: `t-${iso}`, finished_at: iso });
const pages = (...lists) => {
	const requests = [];
	const fetch = async (finishedAfter, cursor) => {
		requests.push({ finishedAfter, cursor });
		const index = cursor ? Number(cursor) : 0;
		return { data: lists[index] ?? [], next_cursor: index + 1 < lists.length ? String(index + 1) : undefined };
	};
	return { fetch, requests };
};

test('first poll: nothing emitted, the cursor starts at now', async () => {
	const { fetch, requests } = pages([at('2026-11-22T09:00:00.000Z')]);
	assert.deepEqual(await findNew({}, fetch), { first: true });
	assert.equal(requests.length, 0);
	const now = new Date('2026-11-22T10:00:00.000Z');
	assert.deepEqual(advance({}, [], now), { cursor: '2026-11-22T10:00:00.000Z', seen: {} });
});

test('each poll starts the overlap window before the cursor', async () => {
	assert.equal(OVERLAP_MS, 120_000);
	assert.equal(queryStart('2026-11-22T10:00:00.000Z'), '2026-11-22T09:58:00.000Z');
	const { fetch, requests } = pages([]);
	await findNew({ cursor: '2026-11-22T10:00:00.000Z', seen: {} }, fetch);
	assert.deepEqual(requests, [{ finishedAfter: '2026-11-22T09:58:00.000Z', cursor: undefined }]);
});

test('the cursor advances to the latest finish time, and seen tasks are skipped next time', async () => {
	const a = at('2026-11-22T10:00:01.000Z');
	const b = at('2026-11-22T10:00:05.000Z');
	let state = { cursor: '2026-11-22T10:00:00.000Z', seen: {} };
	const first = await findNew(state, pages([a, b]).fetch);
	assert.deepEqual(first.tasks, [a, b]);
	state = advance(state, first.tasks, new Date());
	assert.equal(state.cursor, '2026-11-22T10:00:05.000Z');
	assert.deepEqual(Object.keys(state.seen).sort(), [seenKey(a), seenKey(b)].sort());
	const second = await findNew(state, pages([a, b]).fetch);
	assert.deepEqual(second.tasks, []);
});

test('a task that becomes visible late with an older finish time is still emitted', async () => {
	const a = at('2026-11-22T10:00:05.000Z');
	let state = advance({ cursor: '2026-11-22T10:00:00.000Z', seen: {} }, [a], new Date());
	const late = at('2026-11-22T10:00:03.000Z'); // committed after `a` was seen
	const result = await findNew(state, pages([late, a]).fetch);
	assert.deepEqual(result.tasks, [late]);
	state = advance(state, result.tasks, new Date());
	assert.equal(state.cursor, '2026-11-22T10:00:05.000Z', 'an older task never moves the cursor back');
});

test('two tasks with the same millisecond across a page boundary are both emitted, once', async () => {
	const time = '2026-11-22T10:00:07.000Z';
	const x = { id: 'x', finished_at: time };
	const y = { id: 'y', finished_at: time };
	const { fetch } = pages([x], [y]);
	const result = await findNew({ cursor: '2026-11-22T10:00:00.000Z', seen: {} }, fetch);
	assert.deepEqual(result.tasks, [x, y]);
	const state = advance({ cursor: '2026-11-22T10:00:00.000Z', seen: {} }, result.tasks, new Date());
	assert.deepEqual((await findNew(state, pages([x], [y]).fetch)).tasks, []);
});

test('at most MAX_NEW_PER_POLL per poll; the rest come next poll', async () => {
	const many = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, finished_at: `2026-11-22T10:00:${String(10 + i).padStart(2, '0')}.000Z` }));
	let state = { cursor: '2026-11-22T10:00:00.000Z', seen: {} };
	const first = await findNew(state, pages(many).fetch);
	assert.equal(first.tasks.length, MAX_NEW_PER_POLL);
	state = advance(state, first.tasks, new Date());
	const second = await findNew(state, pages(many).fetch);
	assert.deepEqual(second.tasks.map((t) => t.id), ['t20', 't21', 't22', 't23', 't24']);
});

test('seen entries older than the window before the new cursor are dropped; one exactly at its start is kept', () => {
	// New cursor 10:01:30, so the window starts at 09:59:30.
	const state = {
		cursor: '2026-11-22T10:00:00.000Z',
		seen: {
			'old|2026-11-22T09:59:00.000Z': '2026-11-22T09:59:00.000Z',
			'edge|2026-11-22T09:59:30.000Z': '2026-11-22T09:59:30.000Z',
			'recent|2026-11-22T09:59:45.000Z': '2026-11-22T09:59:45.000Z',
		},
	};
	const next = advance(state, [at('2026-11-22T10:01:30.000Z')], new Date());
	assert.equal(next.cursor, '2026-11-22T10:01:30.000Z');
	assert.deepEqual(
		Object.keys(next.seen).sort(),
		[
			'edge|2026-11-22T09:59:30.000Z',
			'recent|2026-11-22T09:59:45.000Z',
			't-2026-11-22T10:01:30.000Z|2026-11-22T10:01:30.000Z',
		].sort(),
	);
});

test('more handled tasks in the overlap window than the page cap still reach the new one', async () => {
	// 1001 tasks already handled, all at the cursor (a bulk expiry): more than MAX_PAGES_PER_POLL pages of them.
	const cursor = '2026-11-22T10:00:00.000Z';
	const handled = Array.from({ length: PAGE_SIZE * MAX_PAGES_PER_POLL + 1 }, (_, i) => ({ id: `h${i}`, finished_at: cursor }));
	const state = { cursor, seen: Object.fromEntries(handled.map((t) => [seenKey(t), t.finished_at])) };
	const fresh = { id: 'new', finished_at: cursor };
	const all = [...handled, fresh];
	const lists = [];
	for (let i = 0; i < all.length; i += PAGE_SIZE) lists.push(all.slice(i, i + PAGE_SIZE));
	const { fetch, requests } = pages(...lists);
	const result = await findNew(state, fetch);
	assert.deepEqual(result.tasks, [fresh]);
	assert.equal(requests.length, lists.length);
});

test('a reopened task that finishes again is emitted again', async () => {
	const firstFinish = { id: 'r', finished_at: '2026-11-22T10:00:01.000Z' };
	const state = advance({ cursor: '2026-11-22T10:00:00.000Z', seen: {} }, [firstFinish], new Date());
	const again = { id: 'r', finished_at: '2026-11-22T10:00:30.000Z' };
	assert.deepEqual((await findNew(state, pages([firstFinish, again]).fetch)).tasks, [again]);
});

test('unfinished rows are ignored', async () => {
	const result = await findNew({ cursor: '2026-11-22T10:00:00.000Z' }, pages([{ id: 'o', finished_at: null }]).fetch);
	assert.deepEqual(result.tasks, []);
});

test('outcome and automatic filters', () => {
	const approved = { decision: { action: 'approved', automatic: false } };
	const autoApproved = { decision: { action: 'approved', automatic: true } };
	const rejected = { decision: { action: 'rejected', automatic: false } };
	const all = { outcomes: [], includeAutomatic: true };
	assert.equal(matchesFilters(approved, all), true);
	assert.equal(matchesFilters(autoApproved, all), true);
	assert.equal(matchesFilters(autoApproved, { outcomes: [], includeAutomatic: false }), false);
	assert.equal(matchesFilters(rejected, { outcomes: ['approved', 'edited'], includeAutomatic: true }), false);
	assert.equal(matchesFilters(approved, { outcomes: ['approved', 'edited'], includeAutomatic: true }), true);
	assert.equal(matchesFilters({ decision: null }, { outcomes: ['approved'], includeAutomatic: true }), false);
});

test('withoutPayload drops only the task fields', () => {
	assert.deepEqual(withoutPayload({ id: 'a', payload: { secret: 1 }, decision: { payload: { amount: 2 } } }), {
		id: 'a',
		decision: { payload: { amount: 2 } },
	});
});
