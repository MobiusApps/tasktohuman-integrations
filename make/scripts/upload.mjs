#!/usr/bin/env node
// Uploads make/app/ to a Make custom app through Make's API (the calls @makehq/sdk makes, without the dependency).
//
//   MAKE_API_KEY=… MAKE_ZONE=eu2.make.com node scripts/upload.mjs           create or update the app
//   MAKE_API_KEY=… MAKE_ZONE=eu2.make.com node scripts/upload.mjs --check   read only: what an upload would do
//   node scripts/upload.mjs --dry-run                                      what would be sent, no request at all
//
// MAKE_API_KEY: a Make API token with the scopes sdk-apps:read and sdk-apps:write (Profile → API → Add token).
// MAKE_ZONE: the host of your Make organization as the address bar shows it, for example eu2.make.com or us2.make.com.
// MAKE_APP_NAME (optional): the app's name in Make. An app of yours with that name is updated; when you have none, the
//   app is created with that name. Without it the script finds the app itself (below).
//
// Finding the app: the script first lists your custom apps (GET /sdk/apps) and never guesses by asking for an app by
// name: Make answers that for an app that is not yours with 403, not 404 (seen on a first real run; the reference
// documents no 404 for it, and its status page allows 403 for "a resource you do not have access to"). It takes:
// MAKE_APP_NAME; the name remembered in make/.makeapp for this zone (untracked, written by an earlier run); the one app
// of yours labelled "TaskToHuman" or named "tasktohuman" / "tasktohuman-…". Several candidates stop the run with the
// list. No candidate: the app is created (private), and the name Make returns is used from then on and remembered.
//
// Every component is matched by its name (RPCs, modules) or label (connection, webhook): run it again after a change
// and it updates the same app. It never deletes anything, never publishes and never prints the token. On a refusal it
// prints Make's own message and code (one bounded line) and what that status means.
//
// Make's documentation behind each choice (read 2026-11-26):
// - Base URL https://{zone}/api/v2, zones such as eu1/eu2/us1/us2.make.com:
//   https://developers.make.com/api-documentation/getting-started/api-structure
// - Header "Authorization: Token <token>"; one token per zone:
//   https://developers.make.com/api-documentation/authentication
//   https://developers.make.com/api-documentation/authentication/create-authentication-token
// - Scopes: sdk-apps:read lists "all custom apps for the authenticated user", sdk-apps:write creates and changes them:
//   https://developers.make.com/api-documentation/authentication/api-scopes-overview
// - GET /sdk/apps (List Apps, sdk-apps:read): {apps: [{name, label, version, …}]}, cols[] picks the fields;
//   POST /sdk/apps (Create App, sdk-apps:write) answers {app: {name, label, version, …}}; no team or organization
//   parameter on any SDK-apps call: https://developers.make.com/api-documentation/api-reference/sdk-apps
// - App names: a unique identifier matching /^[a-z][0-9a-z-]+[0-9a-z]$/:
//   https://developers.make.com/custom-apps-documentation/create-your-first-app/create-your-app
//   Make's own lists show custom app names "suffixed with a random text string":
//   https://developers.make.com/api-documentation/api-reference/organizations
// - Errors: one schema for all, {"detail": "Access denied.", "message": "Permission denied", "code": "SC403"}; 403 =
//   "a resource you do not have access to"; 404 may be sent instead of 403, not the other way round:
//   https://developers.make.com/api-documentation/troubleshooting/http-status-codes
// - Causes of "Access denied": wrong environment (zone) or a token made for another one, token scopes:
//   https://developers.make.com/api-documentation/troubleshooting/common-issues
// - "Most Make API endpoints are reserved for our paid subscription plans and may not be accessible on the free tier":
//   https://developers.make.com/api-documentation

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('../app/', import.meta.url));
const STATE_FILE = fileURLToPath(new URL('../.makeapp', import.meta.url));
const ZONE = /^[a-z0-9-]+\.make\.(?:com|celonis\.com)$/;
const NAME = /^[a-z][0-9a-z-]+[0-9a-z]$/; // Make's documented app name pattern (see above)
const MODULE_SECTIONS = ['api', 'parameters', 'expect', 'interface', 'samples', 'epoch'];
const LIST_APPS = '/sdk/apps?cols%5B%5D=name&cols%5B%5D=label&cols%5B%5D=version';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const dirs = (path) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);

/** The components of make/app/, as read from disk. */
export function readApp(appDir = APP_DIR) {
	const component = (kind, name, sections) => ({
		name,
		meta: readJson(join(appDir, kind, name, 'metadata.json')),
		sections: Object.fromEntries(
			sections.filter((s) => existsSync(join(appDir, kind, name, `${s}.json`))).map((s) => [s, readFileSync(join(appDir, kind, name, `${s}.json`), 'utf8')]),
		),
	});
	return {
		meta: readJson(join(appDir, 'metadata.json')),
		base: readFileSync(join(appDir, 'base.imljson'), 'utf8'),
		connections: dirs(join(appDir, 'connections')).map((n) => component('connections', n, ['api', 'parameters'])),
		webhooks: dirs(join(appDir, 'webhooks')).map((n) => component('webhooks', n, ['api', 'parameters'])),
		rpcs: dirs(join(appDir, 'rpcs')).map((n) => component('rpcs', n, ['api', 'parameters'])),
		modules: dirs(join(appDir, 'modules')).map((n) => component('modules', n, MODULE_SECTIONS)),
	};
}

class UploadError extends Error {}

// What a refused list call means, most likely first, from the pages cited above.
const LIST_REFUSED = {
	401: [
		'Make did not accept the token in this zone. Check that MAKE_API_KEY is the whole token, that it was not deleted (Profile → API), and that MAKE_ZONE is the host in the address bar where you created it: each zone needs its own token.',
	],
	403: [
		'1. The token lacks the scope sdk-apps:read (and sdk-apps:write for the upload). Profile → API shows each token\'s scopes; add a token with both ticked.',
		'2. The token belongs to another zone: MAKE_ZONE must be the host in the address bar where you created the token (each zone needs its own token).',
		'3. Your Make plan: Make reserves most API endpoints for paid plans ("may not be accessible on the free tier").',
		'4. Your role: your user may not have the rights for custom apps in this organization; ask its owner or an admin.',
	],
};

function meaning(status, method, path) {
	if (path.startsWith('/sdk/apps?') && LIST_REFUSED[status]) return LIST_REFUSED[status];
	if (method === 'POST' && path === '/sdk/apps' && [400, 403, 409, 422].includes(status)) {
		return [
			'Make refused to create the app. App names are unique in Make: when another account already has this name, set MAKE_APP_NAME to another one (lowercase letters, digits and dashes, starting with a letter), for example tasktohuman-yourcompany.',
			'If Make\'s message speaks of permission: the token needs the scope sdk-apps:write.',
		];
	}
	if (status === 401) return ['authentication refused: check the token and MAKE_ZONE (a token works in one zone only).'];
	if (status === 403) {
		return method === 'GET'
			? ['the app is not yours (Make answers 403 for an app of another account): run with --check to see your apps.']
			: ['the token lacks the scope sdk-apps:write, or the app is not yours: run with --check to see your apps.'];
	}
	if (status === 400) return ['Make refused the request as invalid (an IML or section detail the local tests cannot run).'];
	if (status === 404) return ['not found: the app or component is gone in Make; run with --check.'];
	if (status === 429) return ['rate limited: wait a minute and run again.'];
	if (status >= 500) return ['Make server error: check in Make whether the step happened, then run again.'];
	return ['unexpected answer.'];
}

const oneLine = (value, max) => String(value).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);

/** Make's own reason from an error body ({message, detail, code, suberrors}), one bounded line; '' when none. */
async function makeReason(res) {
	let body;
	try {
		body = JSON.parse(await res.text());
	} catch {
		return '';
	}
	if (!body || typeof body !== 'object') return '';
	const parts = [];
	for (const key of ['message', 'detail']) {
		const text = typeof body[key] === 'string' ? oneLine(body[key], 200) : '';
		if (text && !parts.includes(text)) parts.push(text);
	}
	if (Array.isArray(body.suberrors)) {
		for (const s of body.suberrors.slice(0, 3)) if (typeof s?.message === 'string') parts.push(oneLine(s.message, 120));
	}
	const code = ['string', 'number'].includes(typeof body.code) ? oneLine(body.code, 20) : '';
	if (!parts.length && !code) return '';
	return ` Make says: "${parts.join(' / ')}"${code ? ` (code ${code})` : ''}.`;
}

function readState(stateFile) {
	if (!existsSync(stateFile)) return {};
	try {
		const state = JSON.parse(readFileSync(stateFile, 'utf8'));
		if (state && typeof state === 'object' && !Array.isArray(state)) return state;
	} catch {}
	throw new UploadError(`${stateFile} is not valid: delete it and run again (the script finds the app among your apps).`);
}

const describe = (apps) => apps.map((a) => `  ${a.name}  (label "${a.label ?? ''}", version ${a.version ?? '?'})`).join('\n');

/** Which app to update, or that it must be created, from the list of the caller's own apps. */
function chooseApp({ apps, meta, wanted, remembered, stateFile, zone }) {
	if (wanted) {
		return apps.some((a) => a.name === wanted) ? { name: wanted, existing: true } : { name: wanted, existing: false };
	}
	if (remembered) {
		if (apps.some((a) => a.name === remembered)) return { name: remembered, existing: true };
		throw new UploadError(
			`The app ${remembered} remembered in ${stateFile} is not among your apps in ${zone} (deleted, or made with another account).` +
			(apps.length ? ` Your apps:\n${describe(apps)}\n` : ' You have no custom apps there. ') +
			`Delete ${stateFile} to create a new app, or run with MAKE_APP_NAME=<name> to choose one.`,
		);
	}
	const candidates = apps.filter((a) => a.label === meta.label || a.name === meta.name || a.name?.startsWith(`${meta.name}-`));
	if (candidates.length === 1) return { name: candidates[0].name, existing: true };
	if (candidates.length > 1) {
		throw new UploadError(`Several of your apps could be this one:\n${describe(candidates)}\nChoose one: run again with MAKE_APP_NAME=<name>.`);
	}
	return { name: meta.name, existing: false };
}

/**
 * Runs the upload. `fetch`, `log` and `stateFile` are injectable for the tests. Returns the list of steps done.
 * `dryRun`: no request at all. `check`: only reads (lists), reports what an upload would change, writes nothing.
 */
export async function upload({ env = process.env, fetch = globalThis.fetch, log = console.log, dryRun = false, check = false, appDir = APP_DIR, stateFile = STATE_FILE } = {}) {
	const app = readApp(appDir);
	const version = app.meta.version;
	const wanted = env.MAKE_APP_NAME;
	if (wanted !== undefined && !NAME.test(wanted)) throw new UploadError('MAKE_APP_NAME must be lowercase letters, digits and dashes, start with a letter and end with a letter or digit.');
	const steps = [];
	const done = (text) => {
		steps.push(text);
		log(text);
	};

	const token = env.MAKE_API_KEY;
	const zone = env.MAKE_ZONE;
	const writes = !dryRun && !check;
	let call;
	let target;
	if (dryRun) {
		call = async (method, path) => {
			done(`would ${method} ${path}`);
			return method === 'GET' ? null : {};
		};
		const remembered = zone ? readState(stateFile)[zone] : undefined;
		target = { name: wanted || remembered || app.meta.name, existing: false };
		done(`would GET ${LIST_APPS} first, update the app found there, or create it (Make may give it another name than ${target.name})`);
	} else {
		if (!token) throw new UploadError('Set MAKE_API_KEY (a Make API token with sdk-apps:read and sdk-apps:write).');
		if (!zone || !ZONE.test(zone)) throw new UploadError('Set MAKE_ZONE to your zone host, for example eu2.make.com.');
		const send = async (method, path, body, contentType = 'application/json') => {
			const res = await fetch(`https://${zone}/api/v2${path}`, {
				method,
				headers: {
					authorization: `Token ${token}`,
					'user-agent': 'tasktohuman-make-upload',
					...(body === undefined ? {} : { 'content-type': contentType }),
				},
				body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
			});
			if (res.status >= 400) {
				const shown = path.split('?')[0];
				const text = `${method} ${shown}: HTTP ${res.status}.${await makeReason(res)}\n${meaning(res.status, method, path).join('\n')}`;
				throw new UploadError(text.split(token).join('[token]'));
			}
			const type = res.headers.get('content-type') ?? '';
			return type.includes('json') ? res.json() : {};
		};
		call = check
			? async (method, path, body) => {
				if (method !== 'GET') {
					done(`would ${method} ${path}`);
					return {};
				}
				// A new app has no components to list yet.
				return target && !target.existing && path.startsWith(`/sdk/apps/${encodeURIComponent(target.name)}/`) ? null : send(method, path, body);
			}
			: send;

		// Discover: the caller's own apps first, then pick ours among them.
		const apps = ((await send('GET', LIST_APPS))?.apps ?? []).filter((a) => a && typeof a.name === 'string');
		const state = readState(stateFile);
		target = chooseApp({ apps, meta: app.meta, wanted, remembered: state[zone], stateFile, zone });
		done(target.existing ? `found your app ${target.name} in ${zone}` : `no TaskToHuman app among your ${apps.length} app(s) in ${zone}: ${check ? 'an upload would create' : 'creating'} one`);
		if (writes && target.existing && state[zone] !== target.name) {
			writeFileSync(stateFile, `${JSON.stringify({ ...state, [zone]: target.name }, null, 2)}\n`);
			done(`remembered the app name ${target.name} in ${stateFile}`);
		}
	}
	const setSection = (path, text) => call('PUT', path, text, 'application/jsonc');

	// The app (private until it is published in Make), then its base.
	const { label, description, theme, language, audience } = app.meta;
	if (target.existing) {
		await call('PATCH', `/sdk/apps/${encodeURIComponent(target.name)}/${version}`, { label, description, theme, language, audience });
		done(`updated app ${target.name} (version ${version})`);
	} else {
		const created = await call('POST', '/sdk/apps', { name: target.name, label, description, theme, language, audience, private: true });
		if (writes) {
			const name = created?.app?.name;
			if (typeof name !== 'string' || !name) throw new UploadError('Make created the app but its answer named none: run with --check to find it, then run again with MAKE_APP_NAME=<its name>.');
			target = { name, existing: true };
			writeFileSync(stateFile, `${JSON.stringify({ ...readState(stateFile), [zone]: name }, null, 2)}\n`);
			done(`created app ${name} (version ${version}, private)${name === app.meta.name ? '' : `: Make named it ${name}`}; remembered in ${stateFile}`);
		} else {
			done(`${dryRun ? 'would create' : 'an upload would create'} app ${target.name} (version ${version}, private; Make may give it another name)`);
		}
	}
	const appName = encodeURIComponent(target.name);
	const appPath = `/sdk/apps/${appName}/${version}`;
	await setSection(`${appPath}/base`, app.base);
	done('updated base');

	// Connections and webhooks get their names from Make: find them by label, remember the remote names.
	const remote = { connections: {}, webhooks: {} };
	for (const kind of ['connections', 'webhooks']) {
		const listKey = kind === 'connections' ? 'appConnections' : 'appWebhooks';
		const one = kind === 'connections' ? 'appConnection' : 'appWebhook';
		const existing = (await call('GET', `/sdk/apps/${appName}/${kind}`))?.[listKey] ?? [];
		for (const c of app[kind]) {
			let name = existing.find((e) => e.label === c.meta.label)?.name;
			if (!name) {
				const created = await call('POST', `/sdk/apps/${appName}/${kind}`, { type: c.meta.type, label: c.meta.label });
				name = created?.[one]?.name ?? `<new ${c.name}>`;
				done(`created ${kind.slice(0, -1)} ${c.name} (name in Make: ${name})`);
			}
			remote[kind][c.name] = name;
			for (const [section, text] of Object.entries(c.sections)) await setSection(`/sdk/apps/${kind}/${name}/${section}`, text);
			done(`updated ${kind.slice(0, -1)} ${c.name}: ${Object.keys(c.sections).join(', ')}`);
			if (kind === 'webhooks' && c.meta.connection) {
				// Make's documented webhook update takes only a label; linking a connection this way is not documented.
				try {
					await call('PATCH', `/sdk/apps/webhooks/${name}`, { label: c.meta.label, connection: remote.connections[c.meta.connection] });
					done(`linked webhook ${c.name} to connection ${c.meta.connection}`);
				} catch (error) {
					if (!(error instanceof UploadError)) throw error;
					done(`could not link webhook ${c.name} to its connection (${error.message.split('\n')[0]}) In Make, open Webhooks → ${c.meta.label} and choose the connection ${app.connections.find((x) => x.name === c.meta.connection)?.meta.label} by hand.`);
				}
			}
		}
	}

	// RPCs, then modules: created by name when missing, linked to the connection, every section uploaded.
	for (const kind of ['rpcs', 'modules']) {
		const listKey = kind === 'rpcs' ? 'appRpcs' : 'appModules';
		const existing = new Set(((await call('GET', `${appPath}/${kind}`))?.[listKey] ?? []).map((e) => e.name));
		for (const c of app[kind]) {
			const path = `${appPath}/${kind}/${c.name}`;
			const connection = c.meta.connection ? remote.connections[c.meta.connection] : undefined;
			if (!existing.has(c.name)) {
				const body = kind === 'rpcs'
					? { name: c.name, label: c.meta.label }
					: { name: c.name, typeId: c.meta.typeId, label: c.meta.label, description: c.meta.description, moduleInitMode: 'blank', ...(c.meta.webhook ? { webhook: remote.webhooks[c.meta.webhook] } : {}) };
				await call('POST', `${appPath}/${kind}`, body);
				done(`created ${kind.slice(0, -1)} ${c.name}`);
			}
			const update = kind === 'rpcs' ? { label: c.meta.label } : { label: c.meta.label, description: c.meta.description };
			if (connection || !c.meta.webhook) await call('PATCH', path, { ...update, ...(connection ? { connection } : {}) });
			for (const [section, text] of Object.entries(c.sections)) await setSection(`${path}/${section}`, text);
			done(`updated ${kind.slice(0, -1)} ${c.name}: ${Object.keys(c.sections).join(', ')}`);
		}
	}
	done(writes
		? `Done. Open Make → Custom apps → ${app.meta.label} (name ${target.name}). Nothing was published.`
		: `Nothing was changed (${dryRun ? '--dry-run' : '--check'}).`);
	return steps;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = process.argv.slice(2);
	const unknown = args.filter((a) => !['--dry-run', '--check'].includes(a));
	if (unknown.length || args.length > 1) {
		console.error('Usage: node scripts/upload.mjs [--check | --dry-run]');
		process.exitCode = 2;
	} else {
		upload({ dryRun: args.includes('--dry-run'), check: args.includes('--check') }).catch((error) => {
			console.error(error instanceof UploadError ? error.message : `Upload stopped: ${error?.name ?? 'error'} (no response from Make; check your network and MAKE_ZONE).`);
			process.exitCode = 1;
		});
	}
}
