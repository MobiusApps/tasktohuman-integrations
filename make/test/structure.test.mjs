// Structure and Make's review rules: every file parses, every component has its sections, references resolve,
// lists are bounded and paged, one universal module exists, versions agree.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { APP_DIR, MAKE_DIR, TYPE, appFiles, loadApp, readJsonc, readText, strings } from './helpers.mjs';

const app = loadApp();

test('every file of make/app parses as JSON (comments allowed, as Make allows them)', () => {
	const files = appFiles();
	assert.ok(files.length > 40, `only ${files.length} files found`);
	for (const file of files) {
		if (file === 'README.md') continue;
		assert.match(file, /\.(json|imljson)$/, `${file}: only JSON component files belong in make/app`);
		assert.doesNotThrow(() => readJsonc(join(APP_DIR, file)), `${file} does not parse`);
	}
});

test('the app metadata names the app, its version and theme', () => {
	const { name, label, version, versionFull, theme, language, audience, description } = app.meta;
	assert.equal(name, 'tasktohuman');
	assert.equal(label, 'TaskToHuman');
	assert.equal(version, 1, 'Make apps have one live major version (additive changes only)');
	assert.match(versionFull, /^1\.\d+\.\d+$/);
	assert.match(theme, /^#[0-9a-f]{6}$/i);
	assert.notEqual(theme.toLowerCase(), '#ffffff');
	assert.equal(language, 'en');
	assert.equal(typeof audience, 'string');
	assert.ok(description.length > 10 && description.length <= 200);
});

test('versions agree: app metadata, package.json, CHANGELOG and the User-Agent headers', () => {
	const v = app.meta.versionFull;
	assert.equal(JSON.parse(readText('package.json')).version, v);
	assert.match(readText('CHANGELOG.md'), new RegExp(`^## ${v.replaceAll('.', '\\.')}\\b`, 'm'));
	assert.equal(app.base.headers['user-agent'], `tasktohuman-make/${v}`);
	assert.equal(app.get('connections', 'tasktohuman').api.headers['user-agent'], `tasktohuman-make/${v}`);
});

test('component names are safe for Make (letters and digits, starting with a letter)', () => {
	for (const c of app.components) assert.match(c.name, /^[a-z][A-Za-z0-9]{2,47}$/, `${c.kind}/${c.name}`);
});

test('the connection is a basic connection with one password parameter, apiKey', () => {
	const connections = app.of('connections');
	assert.deepEqual(connections.map((c) => c.name), ['tasktohuman']);
	const [c] = connections;
	assert.equal(c.meta.type, 'basic');
	assert.equal(c.meta.label, 'TaskToHuman');
	assert.deepEqual(c.parameters.map((p) => [p.name, p.type, p.required]), [['apiKey', 'password', true]]);
	assert.ok(c.api.response.valid, 'a validation request is required');
	assert.ok(c.api.response.error?.message, 'connection error handling (a review prerequisite)');
	assert.equal(c.api.response.metadata.type, 'text');
});

test('every module has metadata, api, parameters, expect, interface and samples; triggers use static parameters', () => {
	const modules = app.of('modules');
	assert.deepEqual(modules.map((m) => m.name).sort(), [
		'cancelTask', 'createTask', 'getTask', 'makeApiCall', 'searchTasks', 'watchFinishedTasks', 'watchFinishedTasksInstant',
	]);
	for (const m of modules) {
		for (const s of ['meta', 'api', 'parameters', 'expect', 'interface', 'samples']) assert.notEqual(m[s], undefined, `${m.name}: ${s} missing`);
		assert.ok(Object.values(TYPE).includes(m.meta.typeId), `${m.name}: unknown typeId ${m.meta.typeId}`);
		assert.ok(m.meta.label && m.meta.description, `${m.name}: label and description`);
		assert.ok(Array.isArray(m.interface) && m.interface.length > 0, `${m.name}: interface`);
		assert.ok(m.samples && typeof m.samples === 'object' && !Array.isArray(m.samples), `${m.name}: one sample bundle`);
		if (m.meta.typeId === TYPE.trigger) assert.deepEqual(m.expect, [], `${m.name}: a polling trigger has no mappable parameters`);
		else if (m.meta.typeId !== TYPE.instant) assert.deepEqual(m.parameters, [], `${m.name}: inputs belong in expect (mappable)`);
	}
});

test('module types are as intended', () => {
	const types = Object.fromEntries(app.of('modules').map((m) => [m.name, m.meta.typeId]));
	assert.deepEqual(types, {
		cancelTask: TYPE.action, createTask: TYPE.action, getTask: TYPE.action, makeApiCall: TYPE.universal,
		searchTasks: TYPE.search, watchFinishedTasks: TYPE.trigger, watchFinishedTasksInstant: TYPE.instant,
	});
	assert.equal(Object.values(types).filter((t) => t === TYPE.universal).length, 1, 'exactly one universal module (a review prerequisite)');
});

test('connections, webhooks and RPCs referenced anywhere exist', () => {
	const names = (kind) => new Set(app.of(kind).map((c) => c.name));
	for (const c of app.components) {
		if (c.meta.connection !== undefined) assert.ok(names('connections').has(c.meta.connection), `${c.kind}/${c.name}: connection ${c.meta.connection}`);
		if (c.meta.webhook !== undefined) assert.ok(names('webhooks').has(c.meta.webhook), `${c.kind}/${c.name}: webhook ${c.meta.webhook}`);
		for (const s of ['api', 'parameters', 'expect', 'interface', 'epoch']) {
			for (const [path, value] of strings(c[s] ?? null)) {
				for (const [, rpc] of value.matchAll(/rpc:\/\/([A-Za-z0-9]+)/g)) assert.ok(names('rpcs').has(rpc), `${c.kind}/${c.name}/${s} ${path}: rpc://${rpc} does not exist`);
			}
		}
	}
	// Every RPC is used by something, and binds the connection its callers use.
	const used = new Set(app.components.flatMap((c) => ['api', 'parameters', 'expect'].flatMap((s) => [...strings(c[s] ?? null)].flatMap(([, v]) => [...v.matchAll(/rpc:\/\/([A-Za-z0-9]+)/g)].map((m) => m[1])))));
	for (const r of app.of('rpcs')) {
		assert.ok(used.has(r.name), `rpcs/${r.name} is never used`);
		assert.equal(r.meta.connection, 'tasktohuman', `rpcs/${r.name}: binds the connection`);
	}
});

test('every module except the instant trigger binds the connection; the instant trigger gets it from its webhook', () => {
	for (const m of app.of('modules')) {
		if (m.meta.typeId === TYPE.instant) {
			assert.equal(m.meta.connection, undefined);
			assert.equal(app.get('webhooks', m.meta.webhook).meta.connection, 'tasktohuman', 'the enrichment request needs the connection');
		} else assert.equal(m.meta.connection, 'tasktohuman', m.name);
	}
});

test('the webhook is dedicated and not attached: no attach or detach, setup instructions shown', () => {
	const hooks = app.of('webhooks');
	assert.deepEqual(hooks.map((h) => h.name), ['taskFinished']);
	const [hook] = hooks;
	assert.equal(hook.meta.type, 'web', 'dedicated webhook');
	for (const s of ['attach', 'detach']) assert.ok(!appFiles().includes(`webhooks/taskFinished/${s}.json`), `${s} needs a subscription API TaskToHuman does not have`);
	const banner = hook.parameters.find((p) => p.type === 'banner');
	assert.ok(banner && /Callback URL/.test(banner.text) && /5 days/.test(banner.text), 'instructions banner (a review requirement for not-attached webhooks)');
});

test('every search, trigger and listing RPC has a limit and pagination over next_cursor', () => {
	const listing = [
		...app.of('modules').filter((m) => [TYPE.search, TYPE.trigger].includes(m.meta.typeId)),
		...app.of('rpcs').filter((r) => r.api.response?.iterate && r.name !== 'taskTypeFields'),
	];
	assert.ok(listing.length >= 4);
	for (const c of listing) {
		const where = `${c.kind}/${c.name}`;
		assert.ok(c.api.response.limit !== undefined, `${where}: response.limit`);
		assert.equal(c.api.pagination?.qs?.cursor, '{{body.next_cursor}}', `${where}: pagination.qs.cursor`);
		assert.equal(c.api.pagination?.condition, '{{body.next_cursor}}', `${where}: pagination.condition stops on the last page`);
		assert.ok(Number.isInteger(c.api.qs?.limit) && c.api.qs.limit >= 1 && c.api.qs.limit <= 100, `${where}: a page size the API accepts (1 to 100)`);
		if (c.kind === 'modules') {
			const limit = [...c.expect, ...c.parameters].find((p) => p.name === 'limit');
			assert.ok(limit?.required && limit.type === 'uinteger' && limit.validate?.max, `${where}: a required, bounded Limit input`);
			assert.equal(c.api.response.limit, '{{parameters.limit}}', `${where}: Limit wired to response.limit`);
		} else assert.ok(Number.isInteger(c.api.response.limit) && c.api.response.limit <= 500, `${where}: an options RPC returns at most 500 items`);
	}
});

test('the polling trigger is a date trigger in the API order, with a Choose-where-to-start epoch', () => {
	const t = app.get('modules', 'watchFinishedTasks');
	assert.deepEqual(t.api.response.trigger, { type: 'date', order: 'asc', id: '{{item.id}}', date: '{{parseDate(item.finished_at)}}' });
	assert.equal(t.api.qs.expand, 'details');
	assert.ok(t.api.qs.limit <= 25, 'expand=details pages hold at most 25 tasks');
	assert.match(t.api.qs.finished_after, /data\.lastDate, -2\)/, 'starts 2 minutes before the last date seen (skew window)');
	const limit = t.parameters.find((p) => p.name === 'limit');
	assert.deepEqual([limit.default, limit.validate.max], [10, 100]);
	assert.deepEqual(Object.keys(t.epoch.response.output).sort(), ['date', 'label'], 'epoch output is only label and date');
	assert.ok(t.epoch.response.limit <= 300);
	// No client-side filter: items an iterate condition drops never advance data.lastDate, so a selective filter
	// would re-read a growing backlog every run. Outcome filters are a Make filter after the trigger.
	assert.deepEqual(t.parameters.map((p) => p.name), ['task_type', 'limit']);
	assert.equal(t.api.response.iterate, '{{body.data}}', 'every finished task becomes a bundle');
});

test('Create a Task: task type select with nested fields, the intended inputs, no owner or chain', () => {
	const m = app.get('modules', 'createTask');
	const byName = Object.fromEntries(m.expect.map((p) => [p.name, p]));
	assert.deepEqual(Object.keys(byName), ['task_type', 'title', 'deadline_minutes', 'urgent', 'approvers', 'callback_url', 'idempotency_key']);
	assert.deepEqual(byName.task_type.options, { store: 'rpc://listTaskTypes', nested: 'rpc://taskTypeFields' });
	assert.equal(byName.task_type.required, true);
	assert.deepEqual(byName.deadline_minutes.validate, { min: 1, max: 525600 });
	assert.equal(m.api.headers['idempotency-key'], '{{parameters.idempotency_key}}');
	assert.equal(m.api.body.payload, '{{parameters.payload}}', 'the nested fields arrive as one payload collection');
	const fields = app.get('rpcs', 'taskTypeFields').api.response;
	assert.equal(fields.iterate, '{{body.fields}}');
	assert.equal(fields.wrapper[0].name, 'payload');
	assert.equal(fields.wrapper[0].type, 'collection');
});

test('the files the README promises exist, and the licence is MIT', () => {
	for (const f of ['README.md', 'CHANGELOG.md', 'LICENSE', 'package.json', 'package-lock.json', '.gitignore', 'app/README.md', 'scripts/upload.mjs']) {
		assert.doesNotThrow(() => readFileSync(join(MAKE_DIR, f)), f);
	}
	assert.match(readText('LICENSE'), /^MIT License/);
	const pkg = JSON.parse(readText('package.json'));
	assert.equal(pkg.private, true);
	assert.equal(pkg.license, 'MIT');
	assert.deepEqual(pkg.dependencies ?? {}, {}, 'nothing runs inside Make from npm');
	for (const [name, version] of Object.entries(pkg.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, `${name} pinned exactly`);
	assert.match(readText('.gitignore'), /^\.env\*$/m);
	assert.match(readText('.gitignore'), /^\.makeapp$/m, 'the upload script\'s remembered app name stays local');
});
