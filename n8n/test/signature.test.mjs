// The shared vectors (fixtures/callback-signature.json, copied from the app) and the same cases as the app's
// verify sample check (valid, rotation with either secret, changed body, wrong secret, +/-301 s, no header).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixture, load, sign } from './helpers.mjs';

const { verifySignature } = load('nodes/TaskToHuman/shared/signature.js');
const v = fixture('callback-signature.json');

const check = (overrides = {}) =>
	verifySignature({ rawBody: Buffer.from(v.body, 'utf8'), header: v.header, secret: v.secret, nowSeconds: v.t, ...overrides });

test('the shared vector verifies, as a Buffer and as a string', () => {
	assert.deepEqual(check(), { ok: true });
	assert.deepEqual(check({ rawBody: v.body }), { ok: true });
});

test('during a rotation either secret matches one of two v1 values', () => {
	assert.deepEqual(check({ header: v.header_rotation }), { ok: true });
	assert.deepEqual(check({ header: v.header_rotation, secret: v.previous_secret }), { ok: true });
});

test('a changed body or a wrong secret is refused', () => {
	assert.deepEqual(check({ rawBody: v.body.replace('approved', 'rejected') }), { ok: false, reason: 'no_matching_signature' });
	assert.deepEqual(check({ secret: 'whsec_wrong' }), { ok: false, reason: 'no_matching_signature' });
	assert.deepEqual(check({ header: v.header, secret: v.previous_secret }), { ok: false, reason: 'no_matching_signature' });
});

test('t must be within 300 seconds', () => {
	assert.deepEqual(check({ nowSeconds: v.t + 300 }), { ok: true });
	assert.deepEqual(check({ nowSeconds: v.t - 300 }), { ok: true });
	assert.deepEqual(check({ nowSeconds: v.t + 301 }), { ok: false, reason: 'timestamp_out_of_tolerance' });
	assert.deepEqual(check({ nowSeconds: v.t - 301 }), { ok: false, reason: 'timestamp_out_of_tolerance' });
});

test('missing or malformed headers are refused', () => {
	assert.equal(check({ header: undefined }).reason, 'missing_header');
	assert.equal(check({ header: '  ' }).reason, 'missing_header');
	assert.equal(check({ header: `t=${v.t}` }).reason, 'malformed_header');
	const hex = v.header.split('v1=')[1];
	assert.equal(check({ header: `t=${v.t},v1=${hex.toUpperCase()}` }).reason, 'malformed_header');
	assert.equal(check({ header: `t=${v.t},v1=abc` }).reason, 'malformed_header');
	assert.equal(check({ header: `${v.header},t=${v.t}` }).reason, 'malformed_header');
	assert.equal(check({ header: v.header.replace(`t=${v.t}`, 't=soon') }).reason, 'malformed_header');
	assert.equal(check({ header: [v.header, v.header] }).reason, 'malformed_header');
	assert.deepEqual(check({ header: [v.header] }), { ok: true });
});

test('spaces around parts are ignored and unknown keys skipped', () => {
	const [t, v1] = v.header.split(',');
	assert.deepEqual(check({ header: ` ${t} , v0=zzz , ${v1} ` }), { ok: true });
});

test('no secret or no body is refused before any HMAC', () => {
	assert.equal(check({ secret: '' }).reason, 'missing_secret');
	assert.equal(check({ secret: undefined }).reason, 'missing_secret');
	assert.equal(check({ rawBody: undefined }).reason, 'missing_body');
});

test('a body signed now with the helper verifies (raw bytes, UTF-8)', async () => {
	const body = '{"id":"x","state":"resolved","title":"Reembolso de 249 €"}';
	const now = Math.floor(Date.now() / 1000);
	assert.deepEqual(verifySignature({ rawBody: Buffer.from(body), header: await sign(body, now), secret: 'whsec_docs_example_not_a_secret', nowSeconds: now }), { ok: true });
});
