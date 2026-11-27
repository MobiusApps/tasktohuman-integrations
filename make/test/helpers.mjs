// Shared readers for the Make app tests. Files only: no network, no Make account.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAKE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const APP_DIR = join(MAKE_DIR, 'app');
const REPO_DIR = join(MAKE_DIR, '..');

/** Removes // and block comments outside strings (Make accepts JSONC in component sections). */
export function stripComments(text) {
	let out = '';
	let inString = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (ch === '\\') {
				out += text[i + 1] ?? '';
				i += 1;
			} else if (ch === '"') inString = false;
		} else if (ch === '"') {
			inString = true;
			out += ch;
		} else if (ch === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i += 1;
			out += '\n';
		} else if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			if (end === -1) throw new SyntaxError('Unterminated block comment');
			i = end + 1;
		} else out += ch;
	}
	return out;
}

export const readJsonc = (path) => JSON.parse(stripComments(readFileSync(path, 'utf8')));

/** Every file under make/app/, relative paths with forward slashes. */
export function appFiles(dir = APP_DIR, found = []) {
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) appFiles(path, found);
		else found.push(relative(APP_DIR, path).split(sep).join('/'));
	}
	return found;
}

const dirsOf = (kind) => readdirSync(join(APP_DIR, kind), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const section = (kind, name, s) => {
	try {
		return readJsonc(join(APP_DIR, kind, name, `${s}.json`));
	} catch (error) {
		if (error.code === 'ENOENT') return undefined;
		throw error;
	}
};

/** The app as components: { kind, name, meta, api, parameters, expect, interface, samples, epoch }. */
export function loadApp() {
	const components = [];
	for (const kind of ['connections', 'webhooks', 'rpcs', 'modules']) {
		for (const name of dirsOf(kind)) {
			const c = { kind, name };
			for (const s of ['metadata', 'api', 'parameters', 'expect', 'interface', 'samples', 'epoch']) c[s === 'metadata' ? 'meta' : s] = section(kind, name, s);
			components.push(c);
		}
	}
	return {
		meta: readJsonc(join(APP_DIR, 'metadata.json')),
		base: readJsonc(join(APP_DIR, 'base.imljson')),
		components,
		of: (kind) => components.filter((c) => c.kind === kind),
		get: (kind, name) => components.find((c) => c.kind === kind && c.name === name),
	};
}

export const openapi = () => JSON.parse(readFileSync(join(REPO_DIR, 'openapi', 'public-v1.json'), 'utf8'));
export const fixture = (name) => JSON.parse(readFileSync(join(REPO_DIR, 'fixtures', 'api', `${name}.json`), 'utf8'));
export const readText = (...parts) => readFileSync(join(MAKE_DIR, ...parts), 'utf8');

/** Module type ids used by Make's API (`typeId`). */
export const TYPE = { trigger: 1, action: 4, search: 9, instant: 10, universal: 12 };

/** Every request definition of the app: module and RPC `api` and the connection check (a polling trigger's `epoch`
 * only overrides its trigger's request, so the contract test checks it with that request). */
export function requests(app) {
	const list = [];
	for (const c of app.components) {
		if (c.kind === 'webhooks' || !c.api) continue;
		for (const [i, r] of (Array.isArray(c.api) ? c.api : [c.api]).entries()) list.push({ where: `${c.kind}/${c.name}/api${Array.isArray(c.api) ? `[${i}]` : ''}`, component: c, request: r });
	}
	return list;
}

/** Every string anywhere in a JSON value, with its path. */
export function* strings(value, path = '') {
	if (typeof value === 'string') yield [path, value];
	else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i}]`);
	else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* strings(v, path ? `${path}.${k}` : k);
}

/** The IML expressions (`{{…}}`) in a string. */
export const expressions = (text) => [...text.matchAll(/\{\{(.*?)\}\}/gs)].map((m) => m[1]);
