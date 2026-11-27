// Security: the API key is sanitized in Make's logs wherever it is sent and never reaches an output, label, message
// or URL; no real key in the repository; the instant trigger never trusts a posted body.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { MAKE_DIR, TYPE, expressions, fixture, loadApp, requests, strings } from './helpers.mjs';

const app = loadApp();
const KEY_REF = /\b(?:connection|parameters|data)\.apiKey\b/;

/** Headers that carry the key, per request owner (base or connection), must be listed in that owner's log.sanitize. */
test('log.sanitize covers the authorization header in the base and in the connection (Make applies neither to the other)', () => {
	const owners = [['base', app.base], ['connection', app.get('connections', 'tasktohuman').api]];
	for (const [name, owner] of owners) {
		const sanitize = owner.log?.sanitize ?? [];
		assert.ok(sanitize.includes('request.headers.authorization'), `${name}: request.headers.authorization`);
		for (const [header, value] of Object.entries(owner.headers ?? {})) {
			if (KEY_REF.test(value)) assert.ok(sanitize.includes(`request.headers.${header}`), `${name}: the header "${header}" carries the key and must be sanitized under exactly that name`);
		}
	}
});

test('the key is sent only in the authorization header of the base and the connection check', () => {
	const allowed = new Set(['base headers.authorization', 'connections/tasktohuman/api headers.authorization']);
	const places = [];
	for (const [path, value] of strings(app.base)) if (KEY_REF.test(value)) places.push(`base ${path}`);
	for (const c of app.components) {
		for (const s of ['api', 'parameters', 'expect', 'interface', 'samples', 'epoch', 'meta']) {
			for (const [path, value] of strings(c[s] ?? null)) if (KEY_REF.test(value)) places.push(`${c.kind}/${c.name}/${s === 'meta' ? 'metadata' : s} ${path}`);
		}
	}
	assert.deepEqual(places.filter((p) => !allowed.has(p)), [], 'the key appears where it could reach an output, URL, label or message');
	assert.equal(app.base.headers.authorization, 'Bearer {{connection.apiKey}}');
	assert.equal(app.get('connections', 'tasktohuman').api.headers.authorization, 'Bearer {{parameters.apiKey}}');
});

test('the connection label and stored data hold the workspace name and mode only', () => {
	const { metadata, data } = app.get('connections', 'tasktohuman').api.response;
	assert.equal(metadata.value, "{{body.workspace.name}} · {{if(body.key.mode === 'test', 'Test', 'Live')}}");
	assert.ok(metadata.value.length <= 512);
	assert.doesNotMatch(metadata.value, /prefix|key\.id/, 'no key prefix or long id in the label');
	assert.deepEqual(data, { mode: '{{body.key.mode}}' });
});

test('no absolute URL outside the base and the connection check', () => {
	for (const { where, component, request } of requests(app)) {
		if (component.kind === 'connections') continue;
		assert.doesNotMatch(request.url, /^[a-z]+:|^\/\//i, `${where}: ${request.url}`);
		for (const [path, value] of strings(request.pagination ?? null)) assert.doesNotMatch(value, /^https?:/i, `${where} pagination.${path}`);
	}
	const hosts = new Set();
	for (const [, value] of strings(app.base)) for (const [m] of value.matchAll(/https?:\/\/[^\s/"']+/g)) hosts.add(m);
	for (const { request } of requests(app)) for (const [m] of String(request.url).matchAll(/https?:\/\/[^\s/"']+/g)) hosts.add(m);
	assert.deepEqual([...hosts], ['https://api.tasktohuman.com'], 'requests go to the production API only');
});

test('no API key in the repository files of make/, except the fixtures\' documented fakes', () => {
	const KEY = /tth_(?:live|test)_[A-Za-z0-9]{8,}/g;
	const scan = (dir, found = []) => {
		for (const name of readdirSync(dir)) {
			if (name === 'node_modules' || name === '.git') continue;
			const path = join(dir, name);
			if (statSync(path).isDirectory()) scan(path, found);
			else found.push(path);
		}
		return found;
	};
	for (const path of scan(MAKE_DIR)) {
		const text = readFileSync(path, 'utf8');
		for (const [m] of text.matchAll(KEY)) {
			assert.ok(/FAKE|not_real|3Rw7NcYb/.test(m), `${relative(MAKE_DIR, path)}: ${m.slice(0, 12)}… looks like a real key`);
		}
	}
});

test('error messages show the API\'s title and code, never a request header or the key', () => {
	const messages = [];
	const collect = (where, error) => {
		if (!error) return;
		for (const [path, value] of strings(error)) if (path.endsWith('message')) messages.push([where, value]);
	};
	collect('base', app.base.response.error);
	for (const { where, request } of requests(app)) collect(where, request.response?.error);
	assert.ok(messages.length >= 3);
	for (const [where, message] of messages) {
		assert.doesNotMatch(message, /headers|apiKey|authorization|request\./i, `${where}: ${message}`);
		assert.doesNotMatch(message, /tth_/, where);
	}
});

test('base error types are as intended and keep Make\'s 429 and 5xx defaults', () => {
	const error = app.base.response.error;
	assert.equal(error.type, undefined, 'no top-level type: it would override the 429 RateLimitError default');
	const types = Object.fromEntries(Object.entries(error).filter(([k]) => /^\d{3}$/.test(k)).map(([k, v]) => [k, v.type]));
	assert.deepEqual(types, {
		400: 'DataError', 401: 'InvalidAccessTokenError', 402: 'InvalidConfigurationError', 403: 'InvalidConfigurationError',
		404: 'DataError', 409: 'DuplicateDataError', 422: 'DataError',
	});
	assert.ok(!('429' in error) && !Object.keys(error).some((k) => /^5\d\d$/.test(k)), '429 and 5xx keep RateLimitError and ConnectionError');
	assert.equal(app.get('modules', 'cancelTask').api.response.error['409'].type, 'DataError', 'cancelling a finished task is a DataError');
});

/**
 * A stand-in for Make's evaluation of the base error messages: enough of IML (`if`, `ifempty`, `join`, `keys`, string
 * `+`) to read the text a person sees. Make itself remains the proof (README, "What only Make can prove").
 */
function render(message, statusCode, body) {
	const fns = {
		if: (condition, yes, no) => (condition ? yes : no),
		ifempty: (value, fallback) => (value === undefined || value === null || value === '' ? fallback : value),
		join: (list, separator) => list.join(separator),
		keys: (object) => Object.keys(object ?? {}), // JavaScript evaluates both branches of if_
	};
	return message.replace(/\{\{(.*?)\}\}/gs, (_, e) =>
		String(new Function('statusCode', 'body', ...Object.keys(fns).map((k) => `${k}_`), `return ${e.replace(/\b(if|ifempty|join|keys)\(/g, '$1_(')};`)(statusCode, body, ...Object.values(fns))),
	);
}

test('402 not_enough_credits: the message says the task was not created, the counts, the reason and how to get credits', () => {
	const message = app.base.response.error['402'].message;
	assert.equal(expressions(message).length, 5);
	const { status, body } = fixture('not-enough-credits').response;
	assert.equal(
		render(message, status, body),
		`[402] Your organization is out of credits, so the task was not created. It needs ${body.needed} credits, ${body.available} are free and ${body.held} are held by open tasks (reason: ${body.reason}). Buy a credit pack or turn on automatic buying in TaskToHuman (Plan > Credits), then turn the scenario on again (Make turned it off).  not_enough_credits`,
	);
	// Other 402 codes keep the API's title, exactly as every other status entry shows it.
	const limit = { title: 'This month\'s tasks are used up.', status: 402, code: 'task_limit_reached', reason: 'plan_limit' };
	assert.equal(render(message, 402, limit), "[402] This month's tasks are used up.  task_limit_reached");
	assert.equal(render(message, 402, limit), render(app.base.response.error['403'].message, 402, limit));
});

test('403 api_key_paused and address_blocked, and 410 attachment_removed, show the API\'s message and code', () => {
	// Built inline: fixtures/api has no example of these (it is synced from the server).
	const paused = { title: 'This API key is paused by TaskToHuman support until 2026-11-27 14:30 UTC. Contact support.', status: 403, code: 'api_key_paused', until: '2026-11-27 14:30 UTC' };
	const blocked = { title: 'Access from your network is temporarily blocked. If you think this is a mistake, contact support.', status: 403, code: 'address_blocked' };
	const forbidden = app.base.response.error['403'].message;
	assert.equal(render(forbidden, 403, paused), `[403] ${paused.title}  api_key_paused`);
	assert.equal(render(forbidden, 403, blocked), `[403] ${blocked.title}  address_blocked`);
	// A 410 has no entry of its own: the default message (Make API Call downloading a removed file).
	const removed = { title: 'This file was removed to fit the organization\'s storage allowance. The task and its decision are kept.', status: 410, code: 'attachment_removed' };
	assert.equal(render(app.base.response.error.message, 410, removed), `[410] ${removed.title}  attachment_removed`);
});

test('the instant trigger never trusts the posted body: the webhook passes only the id, the module re-reads the task', () => {
	const hook = app.get('webhooks', 'taskFinished').api;
	assert.deepEqual(hook.output, { id: '{{body.id}}' }, 'nothing else of the posted body enters the scenario');
	assert.equal(hook.condition, '{{body.id}}');
	const instant = app.of('modules').find((m) => m.meta.typeId === TYPE.instant);
	assert.equal(instant.api.method, 'GET');
	assert.equal(instant.api.url, '/v1/tasks/{{encodeURL(payload.id)}}', 'one enrichment GET with the connection');
	assert.equal(instant.api.response.output, '{{body}}', 'the output is the API\'s answer, not the callback body');
	assert.equal(instant.api.response.valid?.condition, '{{body.id === payload.id && !!body.finished_at}}', 'only the posted task, and only once it is finished');
	assert.equal(instant.api.response.valid.type, 'DataError');
	for (const file of [readFileSync(join(MAKE_DIR, 'README.md'), 'utf8'), JSON.stringify(app)]) {
		assert.doesNotMatch(file, /signature (?:is )?(?:verified|checked)|verifies the signature/i, 'no claim of signature verification');
	}
});

test('path inputs are URL-encoded', () => {
	for (const { where, request } of requests(app)) {
		if (request.url === '/v1/{{parameters.url}}') continue; // the universal module: the user writes the path
		for (const [, inner] of request.url.matchAll(/\{\{(.*?)\}\}/g)) assert.match(inner, /^encodeURL\(/, `${where}: ${inner}`);
	}
});
