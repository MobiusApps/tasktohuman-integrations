// Samples and interfaces: each sample is a fixture body (so it cannot drift from the API), and each interface names
// only properties the API returns.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, loadApp, openapi } from './helpers.mjs';

const app = loadApp();
const schemas = openapi().components.schemas;
const body = (name) => fixture(name).response.body;

const SAMPLE_SOURCE = {
	createTask: body('create'),
	getTask: body('get-resolved'),
	cancelTask: body('cancel'),
	searchTasks: body('list').data[0],
	watchFinishedTasks: body('get-resolved'),
	watchFinishedTasksInstant: body('get-resolved'),
	makeApiCall: { body: body('me-test'), headers: { 'content-type': 'application/json; charset=utf-8' }, statusCode: 200 },
};

test('every module\'s sample equals its fixture body', () => {
	assert.deepEqual(Object.keys(SAMPLE_SOURCE).sort(), app.of('modules').map((m) => m.name).sort());
	for (const [name, expected] of Object.entries(SAMPLE_SOURCE)) assert.deepEqual(app.get('modules', name).samples, expected, `modules/${name}/samples.json`);
});

const props = (schemaName) => Object.keys(schemas[schemaName].properties);

/** Checks an interface (Make field list) against a schema: names exist, required ones are present, nested specs too. */
function checkInterface(where, fields, schemaName) {
	const schema = schemas[schemaName];
	const names = fields.map((f) => f.name);
	assert.equal(new Set(names).size, names.length, `${where}: duplicate names`);
	for (const n of names) assert.ok(n in schema.properties, `${where}: "${n}" is not a property of ${schemaName}`);
	for (const n of schema.required ?? []) assert.ok(names.includes(n), `${where}: ${schemaName}.${n} is missing`);
	const nested = { owner: 'PublicHumanRef', decision: 'PublicDecisionView', quorum: 'PublicQuorumView', by: 'PublicHumanRef' };
	for (const f of fields) {
		if (f.type === 'collection' && Array.isArray(f.spec) && nested[f.name]) checkInterface(`${where}.${f.name}`, f.spec, nested[f.name]);
		if (f.name === 'attachments') checkInterface(`${where}.attachments`, f.spec.spec, 'PublicAttachmentView');
		if (f.name === 'answers') checkInterface(`${where}.answers`, f.spec.spec, 'PublicQuorumAnswerView');
	}
}

test('every task interface names exactly the properties of a task (PublicTaskView), nested ones included', () => {
	const taskModules = app.of('modules').filter((m) => m.name !== 'makeApiCall');
	assert.equal(taskModules.length, 6);
	for (const m of taskModules) {
		checkInterface(`modules/${m.name}/interface`, m.interface, 'PublicTaskView');
		assert.deepEqual(m.interface.map((f) => f.name).sort(), props('PublicTaskView').sort(), `modules/${m.name}: every task property is mappable`);
	}
});

test('every key of a sample is in the module\'s interface', () => {
	for (const m of app.of('modules')) {
		const names = new Set(m.interface.map((f) => f.name));
		for (const key of Object.keys(m.samples)) assert.ok(names.has(key), `modules/${m.name}: sample key "${key}" is not in the interface`);
		const decision = m.interface.find((f) => f.name === 'decision');
		if (decision && m.samples.decision) {
			const inner = new Set(decision.spec.map((f) => f.name));
			for (const key of Object.keys(m.samples.decision)) assert.ok(inner.has(key), `modules/${m.name}: decision.${key}`);
		}
	}
});

test('interface types are Make types; dates are dates, flags are booleans', () => {
	const MAKE_TYPES = new Set(['any', 'array', 'boolean', 'collection', 'date', 'number', 'integer', 'uinteger', 'text', 'url', 'email', 'buffer']);
	const walk = (where, fields) => {
		for (const f of fields) {
			assert.ok(MAKE_TYPES.has(f.type), `${where}.${f.name}: ${f.type}`);
			if (/_at$|^at$/.test(f.name)) assert.equal(f.type, 'date', `${where}.${f.name}`);
			if (['test', 'automatic', 'override'].includes(f.name)) assert.equal(f.type, 'boolean', `${where}.${f.name}`);
			if (Array.isArray(f.spec)) walk(`${where}.${f.name}`, f.spec);
			else if (Array.isArray(f.spec?.spec)) walk(`${where}.${f.name}[]`, f.spec.spec);
		}
	};
	for (const m of app.of('modules')) walk(`modules/${m.name}`, m.interface);
});

test('the dynamic fields RPC maps every task-type field type to a Make type', () => {
	const out = app.get('rpcs', 'taskTypeFields').api.response.output;
	assert.equal(out.name, '{{item.key}}');
	assert.equal(out.type, "{{switch(item.type, 'number', 'number', 'boolean', 'boolean', 'email', 'email', 'url', 'url', 'text')}}");
	assert.equal(out.multiline, "{{item.type === 'long_text'}}");
	assert.equal(out.required, '{{item.required}}');
	assert.match(out.label, /item\.sensitive, ' \(sensitive\)'/);
});
