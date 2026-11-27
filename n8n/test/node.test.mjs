// The action node's execute() and webhook() with fake n8n contexts and a fake API (no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { credentials, fakeContext, fakeWebhook, fixture, json, load, n8nWorkflow, sign, SECRET } from './helpers.mjs';

const { TaskToHuman } = load('nodes/TaskToHuman/TaskToHuman.node.js');
const node = new TaskToHuman();
const created = fixture('api/create.json').response.body;
const resolved = fixture('api/get-resolved.json').response.body;

const createParams = (extra = {}) => ({
	operation: 'create',
	taskType: { mode: 'key', value: 'approve_refund' },
	title: 'Refund?',
	payload: '{"order_id":"4821","amount":249}',
	options: {},
	...extra,
});

test('the description: one credential, usable as a tool, the restart webhook is POST-only and declared by constant', () => {
	const d = node.description;
	assert.deepEqual(d.credentials, [{ name: 'taskToHumanApi', required: true }]);
	assert.equal(d.usableAsTool, true);
	assert.equal(d.webhooks.length, 1);
	assert.equal(d.webhooks[0].httpMethod, 'POST');
	assert.equal(d.webhooks[0].restartWebhook, true);
	const operation = d.properties.find((p) => p.name === 'operation');
	assert.deepEqual(operation.options.map((o) => o.value).sort(), ['cancel', 'create', 'get', 'getAll', 'sendAndWait']);
});

test('Create posts the body with the default Idempotency-Key and returns the task', async () => {
	const ctx = fakeContext({ params: createParams(), routes: () => json(201, created) });
	const [[item]] = await node.execute.call(ctx);
	assert.deepEqual(item, { json: created, pairedItem: { item: 0 } });
	const [call] = ctx.calls;
	assert.equal(call.method, 'POST');
	assert.equal(call.url, 'https://api.example.test/v1/tasks');
	assert.deepEqual(call.body, { task_type: 'approve_refund', payload: { order_id: '4821', amount: 249 }, title: 'Refund?' });
	assert.equal(call.headers['Idempotency-Key'], 'n8n-exec-42-node-1-0');
});

test('Create: a given Idempotency Key and Callback URL are sent; one request per item', async () => {
	const ctx = fakeContext({
		items: [{ json: {} }, { json: {} }],
		params: createParams({ options: (i) => ({ idempotencyKey: `refund-${i}`, callbackUrl: 'https://hooks.example.test/a' }) }),
		routes: () => json(201, created),
	});
	const [out] = await node.execute.call(ctx);
	assert.deepEqual(out.map((o) => o.pairedItem), [{ item: 0 }, { item: 1 }]);
	assert.deepEqual(ctx.calls.map((c) => c.headers['Idempotency-Key']), ['refund-0', 'refund-1']);
	assert.equal(ctx.calls[0].body.callback_url, 'https://hooks.example.test/a');
});

test('Create: invalid payload JSON stops before any request', async () => {
	const ctx = fakeContext({ params: createParams({ payload: '{oops' }) });
	await assert.rejects(node.execute.call(ctx), (e) => e.constructor.name === 'NodeOperationError' && /not valid JSON/.test(e.message));
	assert.equal(ctx.calls.length, 0);
});

test('Get reads one task; the ID is URL-encoded', async () => {
	const ctx = fakeContext({ params: { operation: 'get', taskId: ' a/b ' }, routes: () => json(200, resolved) });
	const [[item]] = await node.execute.call(ctx);
	assert.equal(item.json.id, resolved.id);
	assert.equal(ctx.calls[0].url, 'https://api.example.test/v1/tasks/a%2Fb');
});

test('Cancel: cancelled true; a task already finished returns cancelled false (no failure)', async () => {
	const ok = fakeContext({ params: { operation: 'cancel', taskId: 'id-1' }, routes: () => json(200, { ...resolved, state: 'cancelled' }) });
	const [[first]] = await node.execute.call(ok);
	assert.equal(first.json.cancelled, true);
	assert.equal(ok.calls[0].method, 'POST');
	assert.equal(ok.calls[0].url, 'https://api.example.test/v1/tasks/id-1/cancel');

	const finished = fixture('api/cancel-finished.json').response;
	const race = fakeContext({
		params: { operation: 'cancel', taskId: 'id-1' },
		routes: (options) => (options.method === 'POST' ? json(finished.status, finished.body) : json(200, resolved)),
	});
	const [[second]] = await node.execute.call(race);
	assert.equal(second.json.cancelled, false);
	assert.equal(second.json.state, 'resolved');
	assert.deepEqual(race.calls.map((c) => c.method), ['POST', 'GET']);
});

test('Cancel: other refusals throw', async () => {
	const ctx = fakeContext({ params: { operation: 'cancel', taskId: 'x' }, routes: () => json(404, { title: 'Not found.', status: 404, code: 'not_found' }) });
	await assert.rejects(node.execute.call(ctx), (e) => e.constructor.name === 'NodeApiError' && e.httpCode === '404');
});

test('Get Many pages through next_cursor up to the limit, with the filters', async () => {
	const page = (ids, next) => json(200, { data: ids.map((id) => ({ id })), ...(next ? { next_cursor: next } : {}) });
	const ctx = fakeContext({
		params: { operation: 'getAll', returnAll: false, limit: 150, filters: { state: 'resolved', taskType: ' approve_refund ', finishedAfter: '2026-11-22T10:00:00Z' } },
		routes: (options) => (options.qs.cursor ? page(Array.from({ length: 100 }, (_, i) => `b${i}`), 'c3') : page(Array.from({ length: 100 }, (_, i) => `a${i}`), 'c2')),
	});
	const [out] = await node.execute.call(ctx);
	assert.equal(out.length, 150);
	assert.deepEqual(ctx.calls[0].qs, { state: 'resolved', task_type: 'approve_refund', finished_after: '2026-11-22T10:00:00.000Z', limit: 100 });
	assert.deepEqual(ctx.calls[1].qs, { state: 'resolved', task_type: 'approve_refund', finished_after: '2026-11-22T10:00:00.000Z', limit: 50, cursor: 'c2' });
	assert.equal(ctx.calls.length, 2);
});

test('Get Many with Return All stops on the last page', async () => {
	const ctx = fakeContext({
		params: { operation: 'getAll', returnAll: true, filters: {} },
		routes: (options) => json(200, options.qs.cursor ? { data: [{ id: 'b' }] } : { data: [{ id: 'a' }], next_cursor: 'n' }),
	});
	const [out] = await node.execute.call(ctx);
	assert.deepEqual(out.map((o) => o.json.id), ['a', 'b']);
	assert.equal(ctx.calls[0].qs.limit, 100);
});

test('continueOnFail emits message, code and status only', async () => {
	const ctx = fakeContext({
		continueOnFail: true,
		params: { operation: 'get', taskId: 'x' },
		routes: () => json(404, { title: 'Not found.', status: 404, code: 'not_found', traceId: 't' }),
	});
	const [[item]] = await node.execute.call(ctx);
	assert.deepEqual(item, { json: { error: 'Not found.', status: 404, code: 'not_found' }, pairedItem: { item: 0 } });
});

// Create and Wait for Decision

test('Wait: more than one item is refused before any request', async () => {
	const ctx = fakeContext({ items: [{ json: {} }, { json: {} }], params: createParams({ operation: 'sendAndWait' }) });
	await assert.rejects(node.execute.call(ctx), /one item per execution/);
	assert.equal(ctx.calls.length, 0);
});

test('Wait: no signing secret is refused before any request', async () => {
	const ctx = fakeContext({ params: createParams({ operation: 'sendAndWait' }), creds: credentials({ signingSecret: '' }) });
	await assert.rejects(node.execute.call(ctx), /Signing Secret/);
	assert.equal(ctx.calls.length, 0);
	assert.equal(ctx.waits.length, 0);
});

test('Wait: creates with the signed resume URL as callback_url and waits until deadline + 1 h', async () => {
	const ctx = fakeContext({
		params: createParams({ operation: 'sendAndWait', options: { callbackUrl: 'https://ignored.example.test' } }),
		routes: () => json(201, created),
	});
	const [[item]] = await node.execute.call(ctx);
	assert.equal(ctx.calls[0].body.callback_url, 'https://n8n.example.test/webhook-waiting/exec-42/node-1?signature=abc');
	assert.equal(ctx.calls[0].headers['Idempotency-Key'], 'n8n-exec-42-node-1-0');
	assert.equal(ctx.waits.length, 1);
	assert.equal(ctx.waits[0].getTime(), Date.parse(created.expires_at) + 3_600_000);
	assert.deepEqual(item, { json: { ...created, callback_received: false }, pairedItem: { item: 0 } });
	// The created task's id is kept with the execution, for webhook() to compare.
	assert.deepEqual(ctx.customData.store, { tth_task_node_1: created.id });
});

test('Wait: no free custom data slot is refused before any request', async () => {
	const full = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 'v']));
	const ctx = fakeContext({ params: createParams({ operation: 'sendAndWait' }), customData: full, routes: () => json(201, created) });
	await assert.rejects(node.execute.call(ctx), /no room left for custom data/);
	assert.equal(ctx.calls.length, 0);
	assert.equal(ctx.waits.length, 0);
});

test('Wait: no deadline waits indefinitely', async () => {
	const ctx = fakeContext({ params: createParams({ operation: 'sendAndWait' }), routes: () => json(201, { ...created, expires_at: null }) });
	await node.execute.call(ctx);
	assert.equal(ctx.waits[0], n8nWorkflow.WAIT_INDEFINITELY);
});

test('Wait: a task already finished (idempotent replay) is returned at once, without waiting', async () => {
	const ctx = fakeContext({ params: createParams({ operation: 'sendAndWait' }), routes: () => json(200, resolved, { 'idempotent-replayed': 'true' }) });
	const [[item]] = await node.execute.call(ctx);
	assert.equal(ctx.waits.length, 0);
	assert.equal(item.json.state, 'resolved');
	assert.equal(item.json.callback_received, false);
});

test('Wait: a refused callback URL gets the WEBHOOK_URL hint', async () => {
	const ctx = fakeContext({
		params: createParams({ operation: 'sendAndWait' }),
		routes: () =>
			json(400, {
				title: 'Some fields need your attention.',
				status: 400,
				code: 'validation_failed',
				errors: { callback_url: [{ code: 'callback_url_blocked', message: 'This address cannot receive callbacks.' }] },
			}),
	});
	await assert.rejects(node.execute.call(ctx), (e) => /WEBHOOK_URL/.test(e.description));
	assert.equal(ctx.waits.length, 0);
});

test('webhook: a valid signed decision resumes the execution', async () => {
	const v = fixture('callback-signature.json');
	const now = Math.floor(Date.now() / 1000);
	const ctx = fakeWebhook({
		rawBody: Buffer.from(v.body),
		headers: { 'tth-signature': await sign(v.body, now, v.secret) },
		waitingFor: JSON.parse(v.body).id,
	});
	const result = await node.webhook.call(ctx);
	assert.equal(result.workflowData[0][0].json.callback_received, true);
	assert.equal(result.workflowData[0][0].json.decision.action, 'approved');
	assert.equal(ctx.response.ended, false);
});

test('webhook: a validly signed callback of another task of the workspace answers 401 and keeps waiting', async () => {
	const other = '{"id":"task-b","state":"resolved","decision":{"action":"approved","automatic":false}}';
	for (const waitingFor of ['task-a', undefined]) {
		const ctx = fakeWebhook({ rawBody: Buffer.from(other), headers: { 'tth-signature': await sign(other) }, waitingFor });
		assert.deepEqual(await node.webhook.call(ctx), { noWebhookResponse: true });
		assert.equal(ctx.response.statusCode, 401);
		assert.equal(ctx.response.ended, true);
		assert.deepEqual(ctx.warnings, ['TaskToHuman: refused a callback (task_mismatch)']);
	}
});

test('webhook: a bad, stale or missing signature answers 401 and keeps waiting', async () => {
	const body = '{"id":"x","state":"resolved","decision":{"action":"approved","automatic":false}}';
	const now = Math.floor(Date.now() / 1000);
	for (const header of [await sign(body, now, 'whsec_wrong'), await sign(body, now - 301), undefined]) {
		const ctx = fakeWebhook({ rawBody: Buffer.from(body), headers: header ? { 'tth-signature': header } : {}, waitingFor: 'x' });
		assert.deepEqual(await node.webhook.call(ctx), { noWebhookResponse: true });
		assert.equal(ctx.response.statusCode, 401);
		assert.equal(ctx.response.ended, true);
		assert.equal(ctx.warnings.length, 1);
		assert.doesNotMatch(ctx.warnings[0], /resolved|whsec|v1=/);
	}
});

test('webhook: no raw body answers 400; a missing secret 401', async () => {
	const noBody = fakeWebhook({ rawBody: undefined, headers: { 'tth-signature': 't=1,v1=' + 'a'.repeat(64) } });
	assert.deepEqual(await node.webhook.call(noBody), { noWebhookResponse: true });
	assert.equal(noBody.response.statusCode, 400);

	const body = '{"id":"x","state":"resolved"}';
	const noSecret = fakeWebhook({ rawBody: Buffer.from(body), headers: { 'tth-signature': await sign(body) }, creds: credentials({ signingSecret: '' }) });
	assert.deepEqual(await node.webhook.call(noSecret), { noWebhookResponse: true });
	assert.equal(noSecret.response.statusCode, 401);
	assert.ok(SECRET.startsWith('whsec_'));
});

// Task Type "From List"

const { searchTaskTypes } = load('nodes/TaskToHuman/shared/listSearch.js');
const typesApi = (pageCount) => (options) => {
	const index = options.qs.cursor ? Number(options.qs.cursor) : 0;
	const data = Array.from({ length: 100 }, (_, i) => ({ key: `type_${index}_${i}`, name: `Type ${index}-${i}` }));
	if (index === 2) data[5] = { key: 'approve_refund', name: 'Approve refund' };
	return json(200, { data, next_cursor: index + 1 < pageCount ? String(index + 1) : null });
};

test('From List: without a search, one page and its cursor', async () => {
	const ctx = fakeContext({ routes: typesApi(5) });
	const result = await searchTaskTypes.call(ctx);
	assert.equal(result.results.length, 100);
	assert.equal(result.paginationToken, '1');
	assert.equal(ctx.calls.length, 1);
});

test('From List: a search reads on until a page has a match, and returns the next cursor', async () => {
	const ctx = fakeContext({ routes: typesApi(5) });
	const result = await searchTaskTypes.call(ctx, 'refund');
	assert.deepEqual(result.results, [{ name: 'Approve refund (approve_refund)', value: 'approve_refund' }]);
	assert.equal(result.paginationToken, '3');
	assert.equal(ctx.calls.length, 3);
});

test('From List: a search with no match stops on the last page, or after 10 pages', async () => {
	const short = fakeContext({ routes: typesApi(4) });
	assert.deepEqual(await searchTaskTypes.call(short, 'nothing'), { results: [], paginationToken: undefined });
	assert.equal(short.calls.length, 4);
	const long = fakeContext({ routes: typesApi(50) });
	assert.deepEqual(await searchTaskTypes.call(long, 'nothing'), { results: [], paginationToken: '10' });
	assert.equal(long.calls.length, 10);
});
