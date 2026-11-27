// A local fake TaskToHuman API (node:http on 127.0.0.1, the SDKs' pattern), the repository's fixtures and Zapier's
// app tester around the built app (dist/). Nothing here reaches a real host: TTH_BASE_URL points at the fake.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import zapier from 'zapier-platform-core';

import App from '../dist/index.js';

export { App };
export const appTester = zapier.createAppTester(App);

/** A fake key in the fixtures' style; tests assert it never shows up in a message. */
export const API_KEY = 'tth_test_FAKEzapierKEYfakeKEYfakeKEYfakeKEY12';

/** The bundle every call gets: the connection's key, plus whatever the test adds. */
export const bundle = (extra = {}) => ({ authData: { apiKey: API_KEY }, inputData: {}, meta: {}, ...extra });

export const repoFile = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** One of fixtures/api/*.json: the docs' request/response examples, checked against the real API. */
export const fixture = (name) => JSON.parse(repoFile(`fixtures/api/${name}.json`));

/** A fake API reply with a fixture's recorded response. */
export const replay = (name) => {
  const { response } = fixture(name);
  return { status: response.status, headers: response.headers, body: response.body };
};

export const json = (status, body, headers = {}) => ({ status, body, headers });

export const problem = (status, code, extra = {}) =>
  json(status, { type: 'about:blank', title: `Title for ${code}`, status, code, ...extra }, { 'Content-Type': 'application/problem+json' });

/**
 * Starts a fake API and points TTH_BASE_URL at it. `handler(request, index)` answers each request
 * ({method, path, query, headers, body}) with {status, headers, body}. Close it with `await api.close()`.
 */
export async function fakeApi(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://127.0.0.1');
    const text = Buffer.concat(chunks).toString('utf8');
    const recorded = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    const index = requests.push(recorded) - 1;
    const reply = (await handler(recorded, index)) ?? json(500, { title: 'No route in the fake API', status: 500 });
    const headers = { ...reply.headers };
    let body = '';
    if (typeof reply.body === 'string') body = reply.body;
    else if (reply.body !== undefined) {
      body = JSON.stringify(reply.body);
      headers['Content-Type'] ??= 'application/json; charset=utf-8';
    }
    res.writeHead(reply.status, headers);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.TTH_BASE_URL;
  process.env.TTH_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    close: () =>
      new Promise((resolve) => {
        if (previous === undefined) delete process.env.TTH_BASE_URL;
        else process.env.TTH_BASE_URL = previous;
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Runs `fn` against a fake API and closes it afterwards. */
export async function withApi(handler, fn) {
  const api = await fakeApi(handler);
  try {
    return await fn(api);
  } finally {
    await api.close();
  }
}

/** The error a promise rejects with (fails the test when it resolves). */
export async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

/** A task type as GET /v1/task-types/{key} returns it with every field type and open step kind. */
export const taskType = (extra = {}) => ({
  key: 'approve_refund',
  name: 'Approve refund',
  kind: 'approval',
  chain_override: false,
  default_deadline_minutes: 120,
  fields: [
    { key: 'order_id', label: 'Order', type: 'text', required: true, sensitive: false, editable: false },
    { key: 'note', label: 'Note', type: 'long_text', required: false, sensitive: false, editable: true },
    { key: 'amount', label: 'Amount', type: 'number', required: true, sensitive: false, editable: true },
    { key: 'express', label: 'Express', type: 'boolean', required: false, sensitive: false, editable: false },
    { key: 'customer_email', label: 'Customer email', type: 'email', required: false, sensitive: true, editable: false },
    { key: 'receipt', label: 'Receipt', type: 'url', required: false, sensitive: false, editable: false },
  ],
  steps: [{ step: 1, assignment: 'human', group: null, approvals_needed: null, max_approvers: null }],
  ...extra,
});

export const OPEN_STEPS = [
  { step: 1, assignment: 'at_creation', group: null, approvals_needed: null, max_approvers: null },
  { step: 2, assignment: 'group', group: { id: '01a1dcc0-0000-7000-8000-000000000001', name: 'Finance' }, approvals_needed: null, max_approvers: null },
  { step: 3, assignment: 'at_creation', group: null, approvals_needed: 2, max_approvers: 3 },
];

export const HUMANS = [
  { id: '01a1dcba-b57a-7aa2-b6b1-05d81545c2ba', name: 'Ana' },
  { id: '01a1dcba-b57a-7aa2-b6b1-05d81545c2bb', name: 'Rui' },
];
export const FINANCE = [{ id: '01a1dcba-b57a-7aa2-b6b1-05d81545c2bc', name: 'Marta' }];
