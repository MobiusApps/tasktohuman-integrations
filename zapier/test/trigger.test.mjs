import assert from 'node:assert/strict';
import { test } from 'node:test';

import { App, appTester, bundle, fixture, json, rejection, withApi } from './helpers.mjs';
import { LOOK_BACK_MS, MAX_PAGES, MAX_RESULTS, SAMPLE_WINDOWS_MS } from '../dist/triggers/taskFinished.js';

const trigger = App.triggers.task_finished;
const perform = trigger.operation.perform;
const detailed = fixture('get-resolved').response.body;

/** A finished task as an expand=details item: the single read's shape with its own id, time and decision. */
const finished = (n, decision = {}) => ({
  ...detailed,
  id: `01a1e3a7-6489-7106-aa3a-${String(n).padStart(12, '0')}`,
  finished_at: new Date(Date.UTC(2026, 10, 16, 9, 0, n)).toISOString(),
  decision: { ...detailed.decision, ...decision },
});

/** Pages of `perPage` tasks, oldest first, as the API answers finished_after. */
const pagedApi = (tasks, perPage = 25) => (request) => {
  const start = Number(request.query.cursor ?? 0);
  const next = start + perPage < tasks.length ? String(start + perPage) : undefined;
  return json(200, { data: tasks.slice(start, start + perPage), ...(next ? { next_cursor: next } : {}) });
};

test('id and finished_at are the primary output fields (composite de-duplication key)', () => {
  const primary = trigger.operation.outputFields.filter((field) => field.primary).map((field) => field.key);
  assert.deepEqual(primary.sort(), ['finished_at', 'id']);
  assert.equal(trigger.operation.type, 'polling');
});

test('one request: finished in the last 30 minutes, with details, 25 per page, the type filter', async () => {
  await withApi(pagedApi([finished(1)]), async (api) => {
    const before = Date.now();
    await appTester(perform, bundle({ inputData: { task_type: 'approve_refund' } }));
    const [request] = api.requests;
    assert.equal(api.requests.length, 1);
    assert.equal(request.path, '/v1/tasks');
    assert.equal(request.query.expand, 'details');
    assert.equal(request.query.limit, '25');
    assert.equal(request.query.task_type, 'approve_refund');
    const since = Date.parse(request.query.finished_after);
    assert.ok(Math.abs(before - LOOK_BACK_MS - since) < 5000, request.query.finished_after);
  });
});

test('newest first, each with id and finished_at at the top level, details kept', async () => {
  const tasks = [finished(1), finished(2), finished(3)];
  await withApi(pagedApi(tasks), async () => {
    const result = await appTester(perform, bundle());
    assert.deepEqual(result.map((task) => task.id), [tasks[2].id, tasks[1].id, tasks[0].id]);
    for (const task of result) {
      assert.ok(task.id && task.finished_at);
      assert.equal(task.decision.comment, detailed.decision.comment);
      assert.deepEqual(task.payload, detailed.payload);
    }
  });
});

test('outcome and automatic filters', async () => {
  const tasks = [
    finished(1, { action: 'approved' }),
    finished(2, { action: 'rejected' }),
    finished(3, { action: 'expired', automatic: true }),
    finished(4, { action: 'approved', automatic: true }),
  ];
  await withApi(pagedApi(tasks), async () => {
    const approved = await appTester(perform, bundle({ inputData: { outcomes: ['approved'] } }));
    assert.deepEqual(approved.map((task) => task.id), [tasks[3].id, tasks[0].id]);

    const people = await appTester(perform, bundle({ inputData: { outcomes: ['approved', 'expired'], include_automatic: false } }));
    assert.deepEqual(people.map((task) => task.id), [tasks[0].id]);

    const asText = await appTester(perform, bundle({ inputData: { include_automatic: 'false' } }));
    assert.deepEqual(asText.map((task) => task.id), [tasks[1].id, tasks[0].id]);

    const all = await appTester(perform, bundle({ inputData: { outcomes: [] } }));
    assert.equal(all.length, 4);
  });
});

test('page cap: at most 8 pages per poll, at most 100 results, newest of those read', async () => {
  const tasks = Array.from({ length: 300 }, (_, i) => finished(i + 1));
  await withApi(pagedApi(tasks), async (api) => {
    const result = await appTester(perform, bundle());
    assert.equal(api.requests.length, MAX_PAGES);
    assert.equal(result.length, MAX_RESULTS);
    assert.equal(result[0].id, tasks[MAX_PAGES * 25 - 1].id);
    assert.equal(api.requests[1].query.cursor, '25');
    assert.equal(api.requests[1].query.finished_after, api.requests[0].query.finished_after);
  });
});

test('isPopulatingDedupe (Zap turned on): the same call, so only what is already finished is marked seen', async () => {
  const tasks = [finished(1), finished(2)];
  await withApi(pagedApi(tasks), async (api) => {
    const normal = await appTester(perform, bundle());
    const populating = await appTester(perform, bundle({ meta: { isPopulatingDedupe: true } }));
    assert.deepEqual(populating, normal);
    assert.equal(api.requests[1].query.expand, 'details');
    assert.equal(api.requests[1].query.limit, '25');
  });
});

test('isLoadingSample: the 3 most recently finished tasks of the last hour, in one window read to its last page', async () => {
  const tasks = Array.from({ length: 30 }, (_, i) => finished(i + 1));
  await withApi(pagedApi(tasks), async (api) => {
    const before = Date.now();
    const result = await appTester(perform, bundle({ meta: { isLoadingSample: true } }));
    assert.deepEqual(result.map((task) => task.id), [tasks[29].id, tasks[28].id, tasks[27].id]);
    const since = Date.parse(api.requests[0].query.finished_after);
    assert.ok(Math.abs(before - 60 * 60 * 1000 - since) < 5000, api.requests[0].query.finished_after);
    assert.equal(api.requests.length, 2); // read to the last page of the hour
    assert.equal(api.requests[1].query.finished_after, api.requests[0].query.finished_after);
  });
});

test('isLoadingSample widens to the last day, then the last 30 days, only while a window is empty', async () => {
  const old = finished(1);
  // Nothing in the last hour or day; one task in the 30-day window.
  const handler = (request) => {
    const since = Date.parse(request.query.finished_after);
    return json(200, { data: Date.now() - since > 2 * 24 * 60 * 60 * 1000 ? [old] : [] });
  };
  await withApi(handler, async (api) => {
    const before = Date.now();
    const result = await appTester(perform, bundle({ meta: { isLoadingSample: true } }));
    assert.deepEqual(result.map((task) => task.id), [old.id]);
    assert.equal(api.requests.length, SAMPLE_WINDOWS_MS.length);
    api.requests.forEach((request, i) => {
      assert.ok(Math.abs(before - SAMPLE_WINDOWS_MS[i] - Date.parse(request.query.finished_after)) < 5000);
    });
  });
});

test('an answer without details (an older API release) fails the poll, so Zapier marks nothing as seen', async () => {
  const { payload, payload_sha256, ...summary } = finished(2);
  assert.ok(payload && payload_sha256);
  for (const meta of [{}, { isLoadingSample: true }]) {
    await withApi(pagedApi([finished(1), summary]), async () => {
      const error = await rejection(appTester(perform, bundle({ meta })));
      assert.match(error.message, /without task details; the next poll tries again/);
    });
  }
});

test('an empty window returns nothing', async () => {
  await withApi(() => json(200, { data: [] }), async () => {
    assert.deepEqual(await appTester(perform, bundle()), []);
  });
});
