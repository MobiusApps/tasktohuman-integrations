// The upload script against a fake of Make's API: it lists the caller's apps first (never probes an app by name),
// creates the app only when it is not there and then uses the name Make returns, the calls @makehq/sdk makes in
// dependency order, Make's own reason on a refusal, never the token in the output, nothing published or deleted.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readApp, upload } from '../scripts/upload.mjs';

const TOKEN = '00000000-0000-4000-8000-000000000000'; // shape of a Make API token (UUID v4); not a real one
const ENV = { MAKE_API_KEY: TOKEN, MAKE_ZONE: 'us2.make.com' };
const SUFFIXED = 'tasktohuman-ab12cd'; // the kind of name Make gives an app ("suffixed with a random text string")
const SC403 = { detail: 'Access denied.', message: 'Permission denied', code: 'SC403' }; // Make's documented error body

const stateFile = () => join(mkdtempSync(join(tmpdir(), 'make-upload-')), '.makeapp');

/**
 * A fake Make API. `apps`: the caller's own apps (GET /sdk/apps). An app in that list has its components already;
 * POST /sdk/apps answers with `createdName`. GET /sdk/apps/{name}/{version} answers 403, as Make does for an app that
 * is not the caller's. `refuse(method, path)` returns [status, body] to refuse a call.
 */
function fakeMake({ apps = [], createdName = SUFFIXED, refuse } = {}) {
	const calls = [];
	const owned = new Set(apps.map((a) => a.name));
	const created = new Set();
	const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const fetch = async (url, init) => {
		const u = new URL(url);
		const path = u.pathname.replace('/api/v2', '');
		calls.push({ method: init.method, path, search: u.search, headers: init.headers, body: init.body, host: u.host });
		const refused = refuse?.(init.method, path);
		if (refused) return json(...refused);
		const name = path.split('/')[3];
		const has = owned.has(name);
		if (init.method === 'GET') {
			if (path === '/sdk/apps') return json(200, { apps });
			if (/^\/sdk\/apps\/[^/]+\/\d+$/.test(path)) return has || created.has(name) ? json(200, { app: { name } }) : json(403, SC403);
			if (path.endsWith('/connections')) return json(200, { appConnections: has ? [{ name: `${name}-x1`, label: 'TaskToHuman', type: 'basic' }] : [] });
			if (path.endsWith('/webhooks')) return json(200, { appWebhooks: has ? [{ name: `${name}-w1`, label: 'TaskToHuman Task Finished', type: 'web' }] : [] });
			if (path.endsWith('/rpcs')) return json(200, { appRpcs: has ? readApp().rpcs.map((r) => ({ name: r.name })) : [] });
			if (path.endsWith('/modules')) return json(200, { appModules: has ? readApp().modules.map((m) => ({ name: m.name })) : [] });
		}
		if (init.method === 'POST' && path === '/sdk/apps') {
			created.add(createdName); // a new app: it exists now, with no components yet
			return json(200, { app: { name: createdName, label: 'TaskToHuman', version: 1, public: false } });
		}
		if (init.method === 'POST' && path.endsWith('/connections')) return json(201, { appConnection: { name: 'tasktohuman-n1' } });
		if (init.method === 'POST' && path.endsWith('/webhooks')) return json(201, { appWebhook: { name: 'tasktohuman-n2' } });
		if (init.method === 'PUT') return new Response(null, { status: 204 });
		return json(200, {});
	};
	return { calls, fetch };
}

const run = async (make, options = {}) => {
	const out = [];
	const file = options.stateFile ?? stateFile();
	const steps = await upload({ env: ENV, fetch: make.fetch, log: (l) => out.push(l), stateFile: file, ...options });
	return { out, steps, file };
};

test('the owner\'s case: no app yet; it lists first, never asks for an app by name, and creates the app', async () => {
	const make = fakeMake();
	await run(make);
	assert.equal(`${make.calls[0].method} ${make.calls[0].path}`, 'GET /sdk/apps', 'the first call is the list');
	assert.ok(!make.calls.some((c) => c.method === 'GET' && /^\/sdk\/apps\/[^/]+\/\d+$/.test(c.path)), 'no GET of an app by name (Make answers 403)');
	assert.ok(make.calls.some((c) => c.method === 'POST' && c.path === '/sdk/apps'));
});

test('a first upload creates the app (private) and uses the name Make returns for every later call, and remembers it', async () => {
	const make = fakeMake();
	const { out, file } = await run(make);
	const seq = make.calls.map((c) => `${c.method} ${c.path}`);
	const app = readApp();
	assert.ok(make.calls.every((c) => c.host === 'us2.make.com'));
	assert.ok(make.calls.every((c) => c.headers.authorization === `Token ${TOKEN}`), 'Make API tokens use the Token scheme');
	const createApp = make.calls.find((c) => c.method === 'POST' && c.path === '/sdk/apps');
	assert.deepEqual(JSON.parse(createApp.body), { name: 'tasktohuman', label: 'TaskToHuman', description: app.meta.description, theme: app.meta.theme, language: 'en', audience: app.meta.audience, private: true });
	const after = make.calls.slice(make.calls.indexOf(createApp) + 1);
	assert.ok(after.every((c) => !c.path.startsWith('/sdk/apps/tasktohuman/')), 'nothing addressed by the name we asked for');
	assert.ok(seq.includes(`PUT /sdk/apps/${SUFFIXED}/1/base`));
	assert.ok(seq.includes('PUT /sdk/apps/connections/tasktohuman-n1/api'));
	assert.ok(seq.includes('PUT /sdk/apps/connections/tasktohuman-n1/parameters'));
	assert.ok(seq.includes('PUT /sdk/apps/webhooks/tasktohuman-n2/api'));
	const linkHook = make.calls.find((c) => c.method === 'PATCH' && c.path === '/sdk/apps/webhooks/tasktohuman-n2');
	assert.equal(JSON.parse(linkHook.body).connection, 'tasktohuman-n1');
	for (const r of app.rpcs) {
		assert.ok(seq.includes(`PATCH /sdk/apps/${SUFFIXED}/1/rpcs/${r.name}`), `${r.name} linked to the connection`);
		assert.ok(seq.includes(`PUT /sdk/apps/${SUFFIXED}/1/rpcs/${r.name}/api`));
	}
	for (const m of app.modules) {
		const create = make.calls.find((c) => c.method === 'POST' && c.path === `/sdk/apps/${SUFFIXED}/1/modules` && JSON.parse(c.body).name === m.name);
		assert.equal(JSON.parse(create.body).typeId, m.meta.typeId);
		for (const s of Object.keys(m.sections)) assert.ok(seq.includes(`PUT /sdk/apps/${SUFFIXED}/1/modules/${m.name}/${s}`), `${m.name}/${s}`);
	}
	const instant = make.calls.find((c) => c.method === 'POST' && c.body?.includes('watchFinishedTasksInstant'));
	assert.equal(JSON.parse(instant.body).webhook, 'tasktohuman-n2', 'the instant trigger is linked to the webhook');
	const section = make.calls.find((c) => c.path.endsWith('/modules/createTask/api'));
	assert.equal(section.headers['content-type'], 'application/jsonc');
	assert.equal(section.body, app.modules.find((m) => m.name === 'createTask').sections.api, 'the file text as it is');
	// Dependencies first: base before connections, connections before RPCs, RPCs before modules.
	const at = (needle) => seq.findIndex((s) => s.includes(needle));
	assert.ok(at('/base') < at('/connections') && at('/connections/') < at('/rpcs') && at('/rpcs') < at('/modules'));
	assert.ok(!make.calls.some((c) => c.method === 'DELETE' || c.path.endsWith('/public')), 'never deletes or publishes');
	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'us2.make.com': SUFFIXED }, 'the name is remembered per zone');
	assert.ok(out.some((l) => l.includes(`Make named it ${SUFFIXED}`)));
	assert.ok(!out.join('\n').includes(TOKEN));
	assert.match(out.at(-1), new RegExp(`name ${SUFFIXED}\\). Nothing was published`));

	// The next run finds the remembered app in the list and updates it: nothing created twice.
	const again = fakeMake({ apps: [{ name: SUFFIXED, label: 'TaskToHuman', version: 1 }] });
	await run(again, { stateFile: file });
	assert.ok(!again.calls.some((c) => c.method === 'POST'), 'nothing created twice');
	assert.ok(again.calls.some((c) => c.method === 'PATCH' && c.path === `/sdk/apps/${SUFFIXED}/1`));
});

test('an app of yours in the list (by label) is updated: same components, found by label and name', async () => {
	const make = fakeMake({ apps: [{ name: 'other-app-zz9', label: 'Something Else', version: 1 }, { name: 'tasktohuman-q7w8e9', label: 'TaskToHuman', version: 1 }] });
	const { out, file } = await run(make);
	assert.ok(!make.calls.some((c) => c.method === 'POST'), 'nothing created');
	const seq = make.calls.map((c) => `${c.method} ${c.path}`);
	assert.ok(seq.includes('PATCH /sdk/apps/tasktohuman-q7w8e9/1'));
	assert.ok(seq.includes('PUT /sdk/apps/connections/tasktohuman-q7w8e9-x1/api'));
	assert.ok(seq.includes('PUT /sdk/apps/webhooks/tasktohuman-q7w8e9-w1/parameters'));
	assert.ok(!seq.some((s) => s.includes('other-app-zz9')));
	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'us2.make.com': 'tasktohuman-q7w8e9' });
	assert.ok(out.includes('found your app tasktohuman-q7w8e9 in us2.make.com'));
});

test('several candidates stop the run with their names and labels and how to choose', async () => {
	const make = fakeMake({ apps: [{ name: 'tasktohuman-aaa111', label: 'TaskToHuman', version: 1 }, { name: 'tasktohuman-bbb222', label: 'TaskToHuman (old)', version: 1 }] });
	const file = stateFile();
	await assert.rejects(run(make, { stateFile: file }), (error) => {
		assert.match(error.message, /tasktohuman-aaa111 {2}\(label "TaskToHuman"/);
		assert.match(error.message, /tasktohuman-bbb222 {2}\(label "TaskToHuman \(old\)"/);
		assert.match(error.message, /MAKE_APP_NAME=<name>/);
		return true;
	});
	assert.equal(make.calls.length, 1, 'only the list call');
	assert.equal(existsSync(file), false);
	// MAKE_APP_NAME chooses one.
	const chosen = fakeMake({ apps: [{ name: 'tasktohuman-aaa111', label: 'TaskToHuman', version: 1 }, { name: 'tasktohuman-bbb222', label: 'TaskToHuman (old)', version: 1 }] });
	await run(chosen, { env: { ...ENV, MAKE_APP_NAME: 'tasktohuman-bbb222' } });
	assert.ok(chosen.calls.some((c) => c.method === 'PATCH' && c.path === '/sdk/apps/tasktohuman-bbb222/1'));
	assert.ok(!chosen.calls.some((c) => c.method === 'POST' && c.path === '/sdk/apps'));
});

test('a remembered name that is no longer among your apps stops the run instead of creating a duplicate', async () => {
	const file = stateFile();
	writeFileSync(file, JSON.stringify({ 'us2.make.com': 'tasktohuman-gone00' }));
	const make = fakeMake({ apps: [{ name: 'tasktohuman-new111', label: 'TaskToHuman', version: 1 }] });
	await assert.rejects(run(make, { stateFile: file }), /tasktohuman-gone00 remembered in .* is not among your apps in us2\.make\.com[\s\S]*tasktohuman-new111[\s\S]*Delete/);
	assert.equal(make.calls.length, 1);
});

test('a refused list call carries Make\'s own reason and the documented causes, most likely first, never the token', async () => {
	const make = fakeMake({ refuse: (method, path) => path === '/sdk/apps' && method === 'GET' && [403, { ...SC403, detail: `Access denied for ${TOKEN}.` }] });
	await assert.rejects(run(make), (error) => {
		const [first, ...hints] = error.message.split('\n');
		assert.equal(first, 'GET /sdk/apps: HTTP 403. Make says: "Permission denied / Access denied for [token]." (code SC403).');
		assert.match(hints[0], /^1\. .*sdk-apps:read/);
		assert.match(hints[1], /^2\. .*zone/);
		assert.match(hints[2], /^3\. .*plan/);
		assert.match(hints[3], /^4\. .*role/);
		assert.ok(!error.message.includes(TOKEN));
		return true;
	});
	const unauthorized = fakeMake({ refuse: (method, path) => path === '/sdk/apps' && [401, { message: 'Invalid token', code: 'SC401' }] });
	await assert.rejects(run(unauthorized), /HTTP 401\. Make says: "Invalid token" \(code SC401\)\.\n.*each zone needs its own token/);
});

test('a refused create says the name may be taken and how to pick another; a section refusal shows Make\'s bounded reason', async () => {
	const taken = fakeMake({ refuse: (method, path) => method === 'POST' && path === '/sdk/apps' && [400, { message: 'App with this name already exists', code: 'IM005' }] });
	await assert.rejects(run(taken), /POST \/sdk\/apps: HTTP 400\. Make says: "App with this name already exists" \(code IM005\)\.\n.*MAKE_APP_NAME/);
	const long = 'x'.repeat(5000);
	const make = fakeMake({ refuse: (method, path) => method === 'PUT' && path.endsWith('/modules/createTask/api') && [400, { message: `Invalid IML\n${long}`, detail: `echo ${TOKEN}` }] });
	await assert.rejects(run(make), (error) => {
		const first = error.message.split('\n')[0];
		assert.match(first, /HTTP 400\. Make says: "Invalid IML x+ \/ echo \[token\]"/);
		assert.ok(first.length < 400, 'bounded');
		assert.doesNotMatch(error.message, /00000000/);
		return true;
	});
});

test('--check only lists and reports what an upload would do, sends no write and writes no file', async () => {
	const make = fakeMake();
	const { out, file } = await run(make, { check: true });
	assert.deepEqual(make.calls.map((c) => `${c.method} ${c.path}`), ['GET /sdk/apps'], 'a new app: only the list');
	assert.ok(out.some((l) => l.startsWith('would POST /sdk/apps')));
	assert.ok(out.some((l) => l.includes('an upload would create app tasktohuman')));
	assert.match(out.at(-1), /Nothing was changed \(--check\)/);
	assert.equal(existsSync(file), false);

	const existing = fakeMake({ apps: [{ name: SUFFIXED, label: 'TaskToHuman', version: 1 }] });
	const checked = await run(existing, { check: true });
	assert.ok(existing.calls.every((c) => c.method === 'GET'), 'reads only');
	assert.ok(existing.calls.some((c) => c.path === `/sdk/apps/${SUFFIXED}/1/modules`), 'lists the components to compare');
	assert.ok(checked.out.some((l) => l === `would PATCH /sdk/apps/${SUFFIXED}/1`));
	assert.equal(existsSync(checked.file), false);
	assert.ok(!checked.out.join('\n').includes(TOKEN));
});

test('it refuses to run without a token, with a zone that is not a Make host, or with a bad MAKE_APP_NAME', async () => {
	const make = fakeMake();
	const opts = { fetch: make.fetch, log: () => {}, stateFile: stateFile() };
	await assert.rejects(upload({ env: { MAKE_ZONE: 'us2.make.com' }, ...opts }), /MAKE_API_KEY/);
	for (const zone of ['evil.example.com', 'us2.make.com.evil.test', 'https://us2.make.com', '']) {
		await assert.rejects(upload({ env: { MAKE_API_KEY: TOKEN, MAKE_ZONE: zone }, ...opts }), /MAKE_ZONE/);
	}
	for (const name of ['Bad Name/..', '1abc', 'abc-', 'a']) {
		await assert.rejects(upload({ env: { ...ENV, MAKE_APP_NAME: name }, ...opts }), /MAKE_APP_NAME/);
	}
	assert.equal(make.calls.length, 0);
});

test('--dry-run sends nothing, needs no token and writes no file', async () => {
	const out = [];
	let called = false;
	const file = stateFile();
	await upload({ env: {}, fetch: () => { called = true; }, log: (l) => out.push(l), dryRun: true, stateFile: file });
	assert.equal(called, false);
	assert.equal(existsSync(file), false);
	assert.ok(out.some((l) => l.includes('/sdk/apps/tasktohuman/1/base')));
	assert.match(out[0], /would GET \/sdk\/apps\?.* first/);
});
