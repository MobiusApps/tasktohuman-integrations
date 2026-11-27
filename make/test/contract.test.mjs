// Contract: every request the app sends maps to an operation of openapi/public-v1.json (plus the pending additions
// below, until the OpenAPI document carries them), with parameters and body properties that
// exist there. A rename in the API fails here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TYPE, loadApp, openapi, requests } from './helpers.mjs';

const app = loadApp();
const doc = openapi();
const BASE_URL = app.base.baseUrl;

/**
 * API additions the app uses ahead of openapi/public-v1.json: GET /v1/task-types/{key} (fields of one type) and
 * `expand=details` on GET /v1/tasks with finished_after. Once public-v1.json has them, the document's own definition is used and the entry is reported
 * as obsolete (remove it then).
 */
const PENDING = {
	'GET /v1/task-types/{key}': { params: [{ name: 'key', in: 'path', required: true }], responseProperties: ['key', 'name', 'kind', 'steps', 'chain_override', 'fields', 'default_deadline_minutes'] },
	'GET /v1/tasks': { params: [{ name: 'expand', in: 'query', required: false }] },
};

/** Headers every request carries from the base (or the connection check), not operation parameters. */
const COMMON_HEADERS = new Set(['authorization', 'accept', 'accept-language', 'user-agent']);

const resolve = (schema) => (schema?.$ref ? doc.components.schemas[schema.$ref.split('/').pop()] : schema);

/** The operations: "METHOD /path" → { params, body, responseProperties, pending }. */
function operations() {
	const ops = {};
	const obsolete = [];
	for (const [path, item] of Object.entries(doc.paths)) {
		for (const [method, op] of Object.entries(item)) {
			if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
			const body = resolve(op.requestBody?.content?.['application/json']?.schema);
			const ok = Object.entries(op.responses ?? {}).find(([status]) => /^2/.test(status))?.[1];
			const response = resolve(ok?.content?.['application/json']?.schema);
			ops[`${method.toUpperCase()} ${path}`] = {
				params: op.parameters ?? [],
				body,
				responseProperties: response?.properties ? Object.keys(response.properties) : undefined,
			};
		}
	}
	for (const [key, extra] of Object.entries(PENDING)) {
		const existing = ops[key];
		if (!existing) {
			ops[key] = { params: extra.params, body: undefined, responseProperties: extra.responseProperties, pending: true };
			continue;
		}
		const missing = extra.params.filter((p) => !existing.params.some((q) => q.name === p.name && q.in === p.in));
		if (missing.length === 0) obsolete.push(key);
		existing.params = [...existing.params, ...missing];
		if (missing.length) existing.pending = true;
	}
	return { ops, obsolete };
}

const { ops, obsolete } = operations();

/** "/v1/tasks/{{encodeURL(parameters.id)}}/cancel" → the OpenAPI key it matches, or undefined. */
function match(method, url) {
	const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
	const segments = path.replace(/\{\{.*?\}\}/g, '{}').split('/');
	for (const key of Object.keys(ops)) {
		const [m, p] = key.split(' ');
		if (m !== method) continue;
		const parts = p.split('/');
		if (parts.length !== segments.length) continue;
		if (parts.every((part, i) => (part.startsWith('{') ? segments[i] === '{}' : part === segments[i]))) return key;
	}
	return undefined;
}

const contracted = requests(app).filter(({ component }) => component.meta.typeId !== TYPE.universal);

test('the pending API additions are still pending (remove an entry once OpenAPI has it)', (t) => {
	for (const key of obsolete) t.diagnostic(`${key}: openapi/public-v1.json already has this; remove it from PENDING`);
	assert.ok(true);
});

test('every request is relative to the base, except the connection check (Make does not apply the base to it)', () => {
	for (const { where, component, request } of requests(app)) {
		if (component.kind === 'connections') assert.ok(request.url.startsWith(`${BASE_URL}/v1/`), `${where}: the connection check calls the production API`);
		else assert.match(request.url, /^\/v1\//, `${where}: a relative /v1 path`);
	}
	assert.equal(BASE_URL, 'https://api.tasktohuman.com');
});

test('every request maps to an operation of the public API', () => {
	assert.ok(contracted.length >= 9, `only ${contracted.length} requests`);
	for (const { where, request } of contracted) {
		assert.ok(request.method, `${where}: method`);
		assert.ok(match(request.method, request.url), `${where}: ${request.method} ${request.url} is not an operation of openapi/public-v1.json`);
	}
});

test('every query parameter and header sent exists in its operation; required ones are sent', () => {
	for (const { where, component, request } of contracted) {
		const op = ops[match(request.method, request.url)];
		const known = (_where, name, location) => op.params.some((p) => p.in === location && p.name.toLowerCase() === name.toLowerCase());
		const qs = { ...request.qs, ...request.pagination?.qs, ...(component.epoch?.qs ?? {}) };
		for (const name of Object.keys(qs)) assert.ok(known(where, name, 'query'), `${where}: query parameter "${name}" is not in the operation`);
		for (const name of Object.keys(request.headers ?? {})) {
			if (!COMMON_HEADERS.has(name.toLowerCase())) assert.ok(known(where, name, 'header'), `${where}: header "${name}" is not in the operation`);
		}
		for (const p of op.params.filter((q) => q.required && q.in === 'query')) assert.ok(p.name in (request.qs ?? {}), `${where}: required query parameter ${p.name}`);
	}
});

test('every body property sent exists in the operation, required ones are sent, and only operations with a body get one', () => {
	for (const { where, request } of contracted) {
		const op = ops[match(request.method, request.url)];
		// Make's editor wants a body on every POST, PUT and PATCH: an empty object where the operation takes none.
		const empty = request.body && typeof request.body === 'object' && Object.keys(request.body).length === 0;
		if (request.body === undefined || (empty && !op.body)) {
			assert.ok(!op.body?.required?.length, `${where}: the operation requires a body`);
			continue;
		}
		assert.ok(op.body?.properties, `${where}: the operation takes no JSON body`);
		assert.equal(typeof request.body, 'object', `${where}: body properties are listed one by one, so this test can check them`);
		for (const name of Object.keys(request.body)) assert.ok(name in op.body.properties, `${where}: body property "${name}" is not in the operation`);
		for (const name of op.body.required ?? []) assert.ok(name in request.body, `${where}: required body property "${name}"`);
	}
});

test('enumerated values sent are values the API accepts', () => {
	// urgency has no enum in the document; its description names the two values.
	const urgency = doc.components.schemas.CreateTaskBody.properties.urgency;
	assert.ok((urgency.enum ?? []).includes('high') || /\bhigh\b/.test(urgency.description), 'urgency "high"');
	assert.match(app.get('modules', 'createTask').api.body.urgency, /'high'/);
	const states = doc.components.schemas.PublicTaskView.properties.state.enum;
	assert.deepEqual(app.get('modules', 'searchTasks').expect.find((p) => p.name === 'state').options.map((o) => o.value), states);
	const op = ops['GET /v1/tasks'];
	assert.ok(op.params.some((p) => p.name === 'finished_after'), 'finished_after exists');
});

test('responses are read where the API puts them (iterated arrays and cursors)', () => {
	for (const { where, request } of contracted) {
		const op = ops[match(request.method, request.url)];
		if (!op.responseProperties) continue;
		const iterate = typeof request.response?.iterate === 'object' ? request.response.iterate.container : request.response?.iterate;
		for (const text of [iterate, request.pagination?.condition].filter(Boolean)) {
			const [, top] = /^\{\{body\.([a-z_]+)/.exec(text) ?? [];
			assert.ok(top && op.responseProperties.includes(top), `${where}: ${text} is not a property of the response`);
		}
	}
});

test('module inputs that become API values name real properties (task inputs are the API names)', () => {
	const body = doc.components.schemas.CreateTaskBody.properties;
	const create = app.get('modules', 'createTask');
	for (const p of create.expect) {
		if (['urgent', 'idempotency_key'].includes(p.name)) continue; // urgency and the Idempotency-Key header
		assert.ok(p.name in body, `createTask input ${p.name} is not a CreateTaskBody property`);
	}
	const approver = doc.components.schemas.CreateTaskBody.properties.approvers.items.properties;
	for (const p of create.expect.find((q) => q.name === 'approvers').spec.spec) assert.ok(p.name in approver, `approvers.${p.name}`);
});

test('the universal module only reaches /v1 paths of the base host, with the connection', () => {
	const universal = app.of('modules').filter((m) => m.meta.typeId === TYPE.universal);
	assert.equal(universal.length, 1);
	const [m] = universal;
	assert.equal(m.api.url, '/v1/{{parameters.url}}', 'a fixed relative prefix: no input can make the URL absolute');
	assert.equal(m.meta.connection, 'tasktohuman');
	assert.deepEqual(Object.keys(m.api.headers), ['{{...}}'], 'custom headers are merged, so the base authorization stays');
	assert.deepEqual(Object.keys(m.api.response.output).sort(), ['body', 'headers', 'statusCode']);
});
