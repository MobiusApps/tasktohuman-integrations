import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './helpers.mjs';

const { buildCreateBody, parsePayload, personRef, defaultIdempotencyKey, toInstant, InputRefusal } = load(
	'nodes/TaskToHuman/shared/body.js',
);

test('a minimal create body: task type and payload only', () => {
	assert.deepEqual(buildCreateBody({ taskType: ' approve_refund ', payload: '{"order_id":"4821"}' }), {
		task_type: 'approve_refund',
		payload: { order_id: '4821' },
	});
});

test('every option maps to its API field; empty values are left out', () => {
	const body = buildCreateBody({
		taskType: 'approve_refund',
		title: '  Refund €249?  ',
		payload: { amount: 249, gift: false },
		callbackUrl: 'https://hooks.example.test/x',
		options: { deadlineMinutes: 120, owner: ' 01a1dcba-b57a-7aa2-b6b1-05d81545c2ba ', idempotencyKey: 'ignored-here' },
	});
	assert.deepEqual(body, {
		task_type: 'approve_refund',
		payload: { amount: 249, gift: false },
		title: 'Refund €249?',
		callback_url: 'https://hooks.example.test/x',
		deadline_minutes: 120,
		owner: '01a1dcba-b57a-7aa2-b6b1-05d81545c2ba',
	});
	assert.deepEqual(buildCreateBody({ taskType: 't', title: '', callbackUrl: '', options: { deadlineMinutes: 0, owner: '' } }), {
		task_type: 't',
		payload: {},
	});
});

test('approvers: one entry per person, by ID or by email address', () => {
	const body = buildCreateBody({
		taskType: 't',
		options: {
			approvers: {
				approver: [
					{ step: 1, person: '01a1dcba-b57a-7aa2-b6b1-05d81545c2ba' },
					{ step: 2, person: ' ana@example.com ' },
				],
			},
		},
	});
	assert.deepEqual(body.approvers, [
		{ step: 1, human: '01a1dcba-b57a-7aa2-b6b1-05d81545c2ba' },
		{ step: 2, email: 'ana@example.com' },
	]);
	assert.throws(() => buildCreateBody({ taskType: 't', options: { approvers: { approver: [{ step: 0, person: 'x' }] } } }), InputRefusal);
	assert.throws(() => buildCreateBody({ taskType: 't', options: { approvers: { approver: [{ step: 1, person: ' ' }] } } }), InputRefusal);
});

test('chain: a single person, or a consensus step from comma-separated people', () => {
	const body = buildCreateBody({
		taskType: 't',
		options: {
			chain: {
				step: [
					{ people: 'ana@example.com', waitMinutes: 30, remind: true, approvalsNeeded: 0 },
					{ people: 'h-1, bea@example.com ,h-3', approvalsNeeded: 2, waitMinutes: 1.5, remind: false },
				],
			},
		},
	});
	assert.deepEqual(body.chain, [
		{ email: 'ana@example.com', wait_seconds: 1800 },
		{
			approvers: [{ human: 'h-1' }, { email: 'bea@example.com' }, { human: 'h-3' }],
			approvals_needed: 2,
			wait_seconds: 90,
			remind: false,
		},
	]);
	assert.throws(() => buildCreateBody({ taskType: 't', options: { chain: { step: [{ people: ' , ', waitMinutes: 5 }] } } }), /at least one person/);
	assert.throws(() => buildCreateBody({ taskType: 't', options: { chain: { step: [{ people: 'a@example.com', waitMinutes: 0 }] } } }), /Wait/);
});

test('the payload must be a JSON object', () => {
	assert.deepEqual(parsePayload(undefined), {});
	assert.deepEqual(parsePayload('  '), {});
	assert.deepEqual(parsePayload({ a: 1 }), { a: 1 });
	assert.throws(() => parsePayload('{not json'), /not valid JSON/);
	assert.throws(() => parsePayload('[1,2]'), /must be a JSON object/);
	assert.throws(() => parsePayload('"text"'), /must be a JSON object/);
	assert.throws(() => parsePayload([1]), /must be a JSON object/);
});

test('a task type is required', () => {
	assert.throws(() => buildCreateBody({ taskType: '  ' }), /Choose a task type/);
});

test('personRef picks email when there is an @', () => {
	assert.deepEqual(personRef('a@b.test', 'x'), { email: 'a@b.test' });
	assert.deepEqual(personRef(' id ', 'x'), { human: 'id' });
});

test('the default idempotency key is per execution, node and item', () => {
	assert.equal(defaultIdempotencyKey('exec-42', 'node-1', 3), 'n8n-exec-42-node-1-3');
});

test('dates become ISO instants', () => {
	assert.equal(toInstant('2026-11-22T10:00:00Z', 'x'), '2026-11-22T10:00:00.000Z');
	assert.equal(toInstant(new Date('2026-11-22T10:00:00Z'), 'x'), '2026-11-22T10:00:00.000Z');
	assert.equal(toInstant({ toISO: () => '2026-11-22T11:00:00+01:00' }, 'x'), '2026-11-22T10:00:00.000Z');
	assert.throws(() => toInstant('soon', 'Created After'), /Created After is not a date/);
});
