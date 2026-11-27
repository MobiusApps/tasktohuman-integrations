import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { App } from './helpers.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

test('zapier-platform-core is the only runtime dependency, pinned exactly; versions match', () => {
  assert.deepEqual(pkg.dependencies, { 'zapier-platform-core': '19.3.0' });
  assert.equal(pkg.devDependencies['zapier-platform-cli'], '19.3.0');
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly`);
  }
  assert.equal(App.version, pkg.version);
  assert.equal(App.platformVersion, '19.3.0');
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'MIT');
});

test('no malicious Zapier release (18.0.2 to 18.0.4) anywhere in the lockfile', () => {
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (/node_modules\/zapier-platform-(cli|core|schema)$/.test(path)) {
      assert.doesNotMatch(entry.version, /^18\.0\.[234]$/, path);
    }
  }
});

test('the app has the five designed operations and nothing else', () => {
  assert.deepEqual(Object.keys(App.triggers), ['task_finished']);
  assert.deepEqual(Object.keys(App.creates), ['create_task', 'create_task_wait', 'cancel_task']);
  assert.deepEqual(Object.keys(App.searches), ['find_task']);
  assert.equal(App.searchOrCreates, undefined);
});

test('no real key in the sources or tests (only tth_test_FAKE… values)', () => {
  const files = [
    ...readdirSync(new URL('../src/', import.meta.url), { recursive: true }).map((f) => new URL(`../src/${f}`, import.meta.url)),
    ...readdirSync(new URL('./', import.meta.url)).map((f) => new URL(`./${f}`, import.meta.url)),
  ].filter((url) => /\.(ts|mjs)$/.test(url.pathname));
  for (const url of files) {
    const text = readFileSync(url, 'utf8');
    for (const match of text.matchAll(/tth_(live|test)_[A-Za-z0-9]{8,}/g)) {
      assert.match(match[0], /^tth_test_FAKE/, url.pathname);
    }
  }
});
