// Package rules for community nodes: no runtime dependencies, n8n-workflow as the only peer, the registered files
// exist after the build, MIT, the credential's test request.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { load } from './helpers.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package.json follows the community node rules', () => {
	assert.equal(pkg.name, 'n8n-nodes-tasktohuman');
	assert.equal(pkg.license, 'MIT');
	assert.ok(pkg.keywords.includes('n8n-community-node-package'));
	assert.equal(pkg.dependencies, undefined);
	assert.deepEqual(pkg.peerDependencies, { 'n8n-workflow': '*' });
	assert.equal(pkg.overrides, undefined);
	for (const script of ['prepare', 'preinstall', 'install', 'postinstall', 'prepublish']) assert.equal(pkg.scripts[script], undefined);
	assert.deepEqual(pkg.files, ['dist', '!dist/tsconfig.tsbuildinfo']);
	assert.equal(pkg.n8n.strict, true);
});

test('every registered node and credential exists in dist', () => {
	for (const file of [...pkg.n8n.nodes, ...pkg.n8n.credentials]) {
		assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), file);
	}
	assert.ok(existsSync(new URL('../dist/icons/tasktohuman.svg', import.meta.url)));
	assert.ok(existsSync(new URL('../dist/icons/tasktohuman.dark.svg', import.meta.url)));
});

test('the credential: password fields for secrets, bearer auth, a test request on /v1/me', () => {
	const { TaskToHumanApi } = load('credentials/TaskToHumanApi.credentials.js');
	const credential = new TaskToHumanApi();
	assert.equal(credential.name, 'taskToHumanApi');
	const field = (name) => credential.properties.find((p) => p.name === name);
	assert.equal(field('apiKey').typeOptions.password, true);
	assert.equal(field('signingSecret').typeOptions.password, true);
	assert.equal(field('baseUrl').default, 'https://api.tasktohuman.com');
	assert.equal(credential.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
	assert.deepEqual(credential.test.request, { baseURL: '={{$credentials.baseUrl}}', url: '/v1/me', method: 'GET' });
});
