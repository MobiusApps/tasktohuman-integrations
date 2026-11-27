// Every component file against Make's own editor schemas (vendored in editor-schemas/, see its README), offline.
// A violation is what Make's editor would underline: an unknown key, a wrong type, an error type Make does not have.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { APP_DIR, appFiles, readJsonc } from './helpers.mjs';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const SCHEMA_DIR = fileURLToPath(new URL('./editor-schemas/', import.meta.url));

// The settings Make's skill documents for these schemas: strict off (editor-only keywords), no unicode regexps.
const ajv = new Ajv({ allErrors: true, strict: false, unicodeRegExp: false });
for (const name of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith('.json'))) ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8')), name);

/** File → schema, as Make's editor maps sections. Webhook receivers and metadata have no editor schema. */
function schemaFor(file) {
	const section = file.split('/').pop().replace(/\.(imljson|json)$/, '');
	if (file === 'base.imljson') return 'base.json';
	if (section === 'api') return file.startsWith('webhooks/') ? null : 'api.json';
	return { parameters: 'parameters.json', expect: 'parameters.json', interface: 'parameters.json', samples: 'samples.json', epoch: 'epoch.json' }[section] ?? null;
}

test('every component file passes Make\'s editor schema', () => {
	let validated = 0;
	const problems = [];
	for (const file of appFiles().filter((f) => /\.(json|imljson)$/.test(f))) {
		const schema = schemaFor(file);
		if (!schema) continue;
		validated += 1;
		const validate = ajv.getSchema(schema);
		if (!validate(readJsonc(join(APP_DIR, file)))) {
			for (const e of validate.errors) problems.push(`${file} ${e.instancePath || '/'}: ${e.message} ${JSON.stringify(e.params)}`);
		}
	}
	assert.ok(validated >= 40, `only ${validated} files validated`);
	assert.deepEqual(problems, []);
});

test('the files without an editor schema are only metadata and the webhook receiver', () => {
	const unchecked = appFiles().filter((f) => /\.(json|imljson)$/.test(f) && !schemaFor(f));
	for (const f of unchecked) assert.match(f, /(^|\/)metadata\.json$|^webhooks\/[^/]+\/api\.json$/, f);
});
