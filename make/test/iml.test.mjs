// IML cannot run outside Make. So every expression that is more than a plain path is listed in make/README.md
// ("IML expressions to check in Make"), where acceptance scenarios in Make exercise them: a new or changed
// expression fails here until the list says so.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { APP_DIR, appFiles, expressions, readText } from './helpers.mjs';
import { readFileSync } from 'node:fs';

const PLAIN = /^[A-Za-z_][\w.]*$/;

function nonTrivial() {
	const found = new Map();
	for (const file of appFiles().filter((f) => /\.(json|imljson)$/.test(f))) {
		for (const e of expressions(readFileSync(join(APP_DIR, file), 'utf8'))) {
			if (PLAIN.test(e) || e === '...') continue;
			found.set(e, [...(found.get(e) ?? []), file]);
		}
	}
	return found;
}

test('every IML expression beyond a plain path is listed in make/README.md', () => {
	const readme = readText('README.md');
	const found = nonTrivial();
	assert.ok(found.size >= 10);
	for (const [e, files] of found) assert.ok(readme.includes(`\`${e}\``), `${files.join(', ')}: \`${e}\` is not listed in make/README.md`);
});

test('expressions use the app IML syntax: commas between arguments, JavaScript operators', () => {
	for (const [e, files] of nonTrivial()) {
		assert.doesNotMatch(e, /;/, `${files}: "${e}" uses ";" (scenario syntax); app IML separates arguments with ","`);
		assert.doesNotMatch(e, /[^=!<>]=[^=]/, `${files}: "${e}" uses "=" ; app IML compares with "==="`);
	}
});
