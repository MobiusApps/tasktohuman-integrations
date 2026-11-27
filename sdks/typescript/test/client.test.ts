// The client against a local fake API answering with the recorded fixtures.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import {
  APIConnectionError,
  APIError,
  AttachmentRemovedError,
  AuthenticationError,
  ConflictError,
  LimitReachedError,
  NotEnoughCreditsError,
  NotFoundError,
  PermissionDeniedError,
  TaskToHuman,
  ValidationError,
  VERSION,
  WaitTimeoutError,
  type ChainStep,
  type Task,
  type TaskList,
  type TaskType,
} from "../src/index.js";
import { API_KEY, fakeApi, fixture, replay, type FakeApi } from "./helpers.js";

const servers: FakeApi[] = [];
async function api(...args: Parameters<typeof fakeApi>): Promise<FakeApi> {
  const server = await fakeApi(...args);
  servers.push(server);
  return server;
}
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

describe("createTask", () => {
  test("sends the recorded request and returns the task (201)", async () => {
    const f = fixture("create");
    const server = await api(replay(f));
    const task = await server.client().createTask(f.request.body as never, {
      idempotencyKey: f.request.headers?.["Idempotency-Key"],
    });
    assert.deepEqual(task, f.response.body);
    const [req] = server.requests;
    assert.equal(req?.method, "POST");
    assert.equal(req?.url, "/v1/tasks");
    assert.equal(req?.headers["idempotency-key"], "refund-4821");
    assert.equal(req?.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(req?.headers["content-type"], "application/json");
    assert.equal(req?.headers.accept, "application/json");
    assert.equal(req?.headers["user-agent"], `tasktohuman-js/${VERSION}`);
    assert.deepEqual(JSON.parse(req?.body ?? ""), f.request.body);
  });

  test("a replay (200, Idempotent-Replayed) returns the original task", async () => {
    const f = fixture("replay");
    const server = await api(replay(f));
    const task = await server.client().createTask(f.request.body as never, { idempotencyKey: "refund-4821" });
    assert.equal(task.id, "01a1e3a7-6489-7106-aa3a-c976287f9999");
  });

  test("a test key's task comes back with test: true", async () => {
    const f = fixture("create-test");
    const server = await api(replay(f));
    const task = await server.client().createTask(f.request.body as never, { idempotencyKey: "refund-test" });
    assert.equal(task.test, true);
  });

  test("generates an Idempotency-Key when none is given", async () => {
    const server = await api(replay(fixture("create")));
    await server.client().createTask({ task_type: "approve_refund" });
    assert.match(String(server.requests[0]?.headers["idempotency-key"]), /^[0-9a-f-]{36}$/);
  });

  test("an idempotency conflict is a ConflictError carrying the key", async () => {
    const f = fixture("conflict");
    const server = await api(replay(f));
    const error = await server
      .client()
      .createTask(f.request.body as never, { idempotencyKey: "refund-4821" })
      .catch((e: unknown) => e);
    assert.ok(error instanceof ConflictError);
    assert.equal(error.code, "idempotency_conflict");
    assert.equal(error.status, 409);
    assert.equal(error.idempotencyKey, "refund-4821");
    assert.equal(error.traceId, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  });

  test("a validation problem is a ValidationError with the field errors", async () => {
    const f = fixture("validation");
    const server = await api(replay(f));
    const error = await server
      .client()
      .createTask(f.request.body as never)
      .catch((e: unknown) => e);
    assert.ok(error instanceof ValidationError);
    assert.equal(error.code, "validation_failed");
    assert.deepEqual(error.errors?.["payload.amount"]?.[0]?.code, "field_invalid");
    assert.match(String(error.idempotencyKey), /^[0-9a-f-]{36}$/);
  });

  test("an unknown property is a ValidationError naming it", async () => {
    const f = fixture("unknown-property");
    const server = await api(replay(f));
    const error = await server
      .client()
      .createTask(f.request.body as never)
      .catch((e: unknown) => e);
    assert.ok(error instanceof ValidationError);
    assert.equal(error.errors?.["data"]?.[0]?.code, "unknown_property");
  });

  test("out of credits is a NotEnoughCreditsError with its fields, sent once and never retried", async () => {
    const f = fixture("not-enough-credits");
    const body = f.response.body as { needed: number; available: number; held: number; reason: string; auto_buy: boolean };
    const idempotencyKey = f.request.headers?.["Idempotency-Key"];
    assert.ok(idempotencyKey, "the fixture sends an Idempotency-Key");
    const server = await api(replay(f), replay(fixture("create")));
    const error = await server
      .client()
      .createTask(f.request.body as never, { idempotencyKey })
      .catch((e: unknown) => e);
    assert.ok(error instanceof NotEnoughCreditsError);
    assert.ok(error instanceof LimitReachedError, "still a LimitReachedError for code that catches every 402");
    assert.equal(error.status, 402);
    assert.equal(error.code, "not_enough_credits");
    assert.deepEqual(
      [error.needed, error.available, error.held, error.reason, error.autoBuy],
      [body.needed, body.available, body.held, body.reason, body.auto_buy],
    );
    assert.equal(error.idempotencyKey, idempotencyKey);
    const held = body.held ? ` and ${body.held} are held by open tasks` : "";
    assert.ok(
      error.message.includes(`It needs ${body.needed} credits; ${body.available} are free${held}.`),
      error.message,
    );
    assert.match(error.message, /buy a credit pack or turn on automatic buying/);
    assert.equal(server.requests.length, 1, "not retried");
  });

  test("other 402 codes stay a plain LimitReachedError", async () => {
    for (const code of ["task_limit_reached", "test_task_limit_reached"]) {
      const body = { title: "Used up.", status: 402, code, reason: "plan_limit", limit: "limit.tasks_month", max: 100 };
      const server = await api({ status: 402, headers: { "Content-Type": "application/problem+json" }, body });
      const error = await server
        .client()
        .createTask({ task_type: "t" })
        .catch((e: unknown) => e);
      assert.ok(error instanceof LimitReachedError, code);
      assert.ok(!(error instanceof NotEnoughCreditsError), code);
      assert.equal(error.code, code);
      assert.equal(error.problem.max, 100);
      assert.equal(server.requests.length, 1, "not retried");
    }
  });

  test("refuses an idempotency key the API would not take, before sending", async () => {
    const server = await api(replay(fixture("create")));
    const client = server.client();
    for (const key of ["", "x".repeat(256), " padded", "naïve", "line\nbreak"]) {
      await assert.rejects(client.createTask({ task_type: "t" }, { idempotencyKey: key }), TypeError);
    }
    await client.createTask({ task_type: "t" }, { idempotencyKey: "k".repeat(255) });
    assert.equal(server.requests.length, 1);
  });
});

describe("getTask, listTasks, cancelTask, getMe, getEntitlements", () => {
  test("getTask returns the task with payload and payload_sha256", async () => {
    const f = fixture("get");
    const server = await api(replay(f));
    const task = await server.client().getTask("01a1e3a7-6489-7106-aa3a-c976287f9999");
    assert.deepEqual(task, f.response.body);
    assert.equal(server.requests[0]?.method, "GET");
    assert.equal(server.requests[0]?.url, f.request.path);
    assert.equal(server.requests[0]?.headers["content-type"], undefined);
  });

  test("getTask of a resolved task has the decision", async () => {
    const server = await api(replay(fixture("get-resolved")));
    const task = await server.client().getTask("01a1e3a7-6489-7106-aa3a-c976287f9999");
    assert.equal(task.decision?.action, "approved");
    assert.equal(task.decision?.automatic, false);
    assert.equal(task.owner, null);
  });

  test("listTasks encodes the query like the recorded request", async () => {
    const f = fixture("list");
    const server = await api(replay(f));
    const list = await server.client().listTasks({ state: "notified", task_type: "approve_refund", limit: 2 });
    assert.deepEqual(list, f.response.body);
    assert.equal(server.requests[0]?.url, f.request.path);
  });

  test("listTasks turns Dates into ISO 8601 and skips missing values", async () => {
    const server = await api(replay(fixture("list")));
    await server.client().listTasks({ created_after: new Date("2026-11-01T00:00:00Z"), task_type: undefined });
    assert.equal(server.requests[0]?.url, "/v1/tasks?created_after=2026-11-01T00%3A00%3A00.000Z");
  });

  test("listTasks sends finished_after and cursor, and a null cursor is left out", async () => {
    const server = await api(replay(fixture("list")));
    const client = server.client();
    await client.listTasks({ finished_after: new Date("2026-11-16T09:00:00Z"), cursor: null, limit: 2 });
    await client.listTasks({ finished_after: "2026-11-16T09:00:00Z", cursor: "639000000000000000.01a1e3a7", limit: 2 });
    assert.equal(server.requests[0]?.url, "/v1/tasks?finished_after=2026-11-16T09%3A00%3A00.000Z&limit=2");
    assert.equal(
      server.requests[1]?.url,
      "/v1/tasks?finished_after=2026-11-16T09%3A00%3A00Z&cursor=639000000000000000.01a1e3a7&limit=2",
    );
  });

  test("a list without next_cursor is the last page; every task has finished_at", async () => {
    const f = fixture("list");
    const server = await api(replay(f));
    const list = await server.client().listTasks({ finished_after: "2026-11-16T09:00:00Z" });
    assert.equal(list.next_cursor, undefined);
    assert.ok(list.data.length > 0);
    for (const task of list.data) assert.ok("finished_at" in task);
    assert.equal((fixture("get-resolved").response.body as Task).finished_at, "2026-11-16T09:19:54.377Z");
    assert.equal((fixture("get").response.body as Task).finished_at, null);
  });

  test("listTasks with expand details returns every task as getTask does", async () => {
    const f = fixture("list-finished-details");
    const server = await api(replay(f));
    const list = await server.client().listTasks({ finished_after: "2026-11-16T09:00:00Z", expand: "details", limit: 1 });
    assert.deepEqual(list, f.response.body);
    assert.equal(decodeURIComponent(server.requests[0]?.url ?? ""), f.request.path);
    const task = list.data[0]!;
    assert.deepEqual(task.payload, { order_id: "4821", amount: 249, reason: "Arrived damaged", customer_email: "marta@example.com" });
    assert.match(task.payload_sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(task.decision?.comment, "Photos confirm the damage.");
    assert.deepEqual(task.decision?.attachments, []);
    // The same keys as a single read, plus the ones this fixture's task has and the older get-resolved one lacks.
    const single = fixture("get-resolved").response.body as Task;
    for (const key of Object.keys(single)) assert.ok(key in task, key);
    assert.equal(list.next_cursor, (f.response.body as TaskList).next_cursor);
  });

  test("two tasks finished at the same instant come once each across a page boundary", async () => {
    const base = fixture("get-resolved").response.body as Task;
    const [a, b, c] = ["a", "b", "c"].map((n) => ({ ...base, id: `01a1e3a7-6489-7106-aa3a-c976287f999${n}` }));
    const pages: Record<string, unknown> = {
      "": { data: [a, b], next_cursor: "page-2" },
      "page-2": { data: [c] },
    };
    const server = await api((req) => {
      const cursor = new URL(req.url, "http://localhost").searchParams.get("cursor") ?? "";
      return { status: 200, body: pages[cursor] };
    });
    const client = server.client();
    const seen: string[] = [];
    let cursor: string | null | undefined = null;
    do {
      const page = await client.listTasks({ finished_after: base.finished_at!, limit: 2, cursor });
      seen.push(...page.data.map((t) => t.id));
      cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(seen, [a!.id, b!.id, c!.id]);
    assert.equal(server.requests.length, 2);
    assert.match(server.requests[1]?.url ?? "", /cursor=page-2/);
  });

  test("listTasks pages the default order with cursor and next_cursor", async () => {
    const base = fixture("get").response.body as Task;
    const [a, b, c] = ["a", "b", "c"].map((n) => ({ ...base, id: `01a1e3a7-6489-7106-aa3a-c976287f999${n}` }));
    const pages: Record<string, unknown> = {
      "": { data: [a, b], next_cursor: "639000000000000000.01a1e3a7" },
      "639000000000000000.01a1e3a7": { data: [c] },
    };
    const server = await api((req) => {
      const cursor = new URL(req.url, "http://localhost").searchParams.get("cursor") ?? "";
      return { status: 200, body: pages[cursor] };
    });
    const client = server.client();
    const first = await client.listTasks({ state: "notified", limit: 2 });
    assert.equal(first.next_cursor, "639000000000000000.01a1e3a7");
    const second = await client.listTasks({ state: "notified", limit: 2, cursor: first.next_cursor });
    assert.equal(second.next_cursor, undefined);
    assert.deepEqual([...first.data, ...second.data].map((t) => t.id), [a!.id, b!.id, c!.id]);
    assert.equal(server.requests[0]?.url, "/v1/tasks?state=notified&limit=2");
    assert.equal(server.requests[1]?.url, "/v1/tasks?state=notified&limit=2&cursor=639000000000000000.01a1e3a7");
  });

  test("listAllTasks follows next_cursor to the last page with the same filters", async () => {
    const base = fixture("get").response.body as Task;
    const tasks = ["a", "b", "c", "d", "e"].map((n) => ({ ...base, id: `01a1e3a7-6489-7106-aa3a-c976287f999${n}` }));
    const pages: Record<string, unknown> = {
      "": { data: tasks.slice(0, 2), next_cursor: "page-2" },
      "page-2": { data: tasks.slice(2, 4), next_cursor: "page-3" },
      "page-3": { data: tasks.slice(4) },
    };
    const server = await api((req) => {
      const cursor = new URL(req.url, "http://localhost").searchParams.get("cursor") ?? "";
      return { status: 200, body: pages[cursor] };
    });
    const client = server.client();
    const seen: string[] = [];
    for await (const task of client.listAllTasks({ task_type: "approve_refund", limit: 2 })) seen.push(task.id);
    assert.deepEqual(seen, tasks.map((t) => t.id));
    assert.deepEqual(
      server.requests.map((r) => r.url),
      [
        "/v1/tasks?task_type=approve_refund&limit=2",
        "/v1/tasks?task_type=approve_refund&limit=2&cursor=page-2",
        "/v1/tasks?task_type=approve_refund&limit=2&cursor=page-3",
      ],
    );
  });

  test("listAllTasks asks for pages of 100, starts from a given cursor and stops when the caller breaks", async () => {
    const base = fixture("get").response.body as Task;
    const server = await api(() => ({ status: 200, body: { data: [base, base], next_cursor: "more" } }));
    const client = server.client();
    let count = 0;
    for await (const task of client.listAllTasks({ cursor: "page-2" })) {
      assert.equal(task.id, base.id);
      if (++count === 3) break;
    }
    assert.equal(count, 3);
    assert.deepEqual(
      server.requests.map((r) => r.url),
      ["/v1/tasks?cursor=page-2&limit=100", "/v1/tasks?cursor=more&limit=100"],
    );
  });

  test("listAllTasks makes one call when the list fits one page, and none before it is read", async () => {
    const server = await api(replay(fixture("list")));
    const all = server.client().listAllTasks({ finished_after: "2026-11-16T09:00:00Z" });
    assert.equal(server.requests.length, 0);
    const seen: Task[] = [];
    for await (const task of all) seen.push(task);
    assert.deepEqual(seen, (fixture("list").response.body as { data: Task[] }).data);
    assert.equal(server.requests.length, 1);
  });

  test("cancelTask posts to /cancel and returns the cancelled task", async () => {
    const f = fixture("cancel");
    const server = await api(replay(f));
    const task = await server.client().cancelTask("01a1e3a7-6cee-70ef-995d-129e212beeb0");
    assert.equal(server.requests[0]?.method, "POST");
    assert.equal(server.requests[0]?.url, f.request.path);
    assert.equal(server.requests[0]?.headers["idempotency-key"], undefined);
    assert.equal(task.state, "cancelled");
  });

  test("cancelling a finished task is a ConflictError with state and action", async () => {
    const server = await api(replay(fixture("cancel-finished")));
    const error = await server
      .client()
      .cancelTask("01a1e3a7-6cee-70ef-995d-129e212beeb0")
      .catch((e: unknown) => e);
    assert.ok(error instanceof ConflictError);
    assert.equal(error.code, "task_already_finished");
    assert.equal(error.problem.state, "cancelled");
    assert.equal(error.problem.action, "cancelled");
    assert.equal(error.idempotencyKey, undefined);
  });

  test("getMe and getEntitlements return the recorded bodies", async () => {
    const me = fixture("me-test");
    const entitlements = fixture("entitlements");
    const server = await api(replay(me), replay(entitlements));
    const client = server.client();
    assert.deepEqual(await client.getMe(), me.response.body);
    assert.deepEqual(await client.getEntitlements(), entitlements.response.body);
    assert.deepEqual(
      server.requests.map((r) => r.url),
      ["/v1/me", "/v1/entitlements"],
    );
  });

  test("a wrong key is an AuthenticationError", async () => {
    const server = await api(replay(fixture("unauthorized")));
    const error = await server
      .client()
      .getMe()
      .catch((e: unknown) => e);
    assert.ok(error instanceof AuthenticationError);
    assert.equal(error.code, "unauthorized");
  });

  test("ids that are not UUIDs are refused before anything is sent", async () => {
    const server = await api(replay(fixture("get")));
    const client = server.client();
    for (const id of ["../me", "01a1e3a7-6489-7106-aa3a-c976287f9999?x=1", "", "01a1e3a7-6489-7106-aa3a-c976287f9999/cancel"]) {
      await assert.rejects(client.getTask(id), TypeError);
      await assert.rejects(client.cancelTask(id), TypeError);
    }
    assert.equal(server.requests.length, 0);
  });
});

describe("urgency, tags, response fields and attachments", () => {
  const taskId = "01a1e3a7-6489-7106-aa3a-c976287f9999";
  const attachmentId = "0199c1a4-9a00-7b7a-9f43-2f1c6a1d8e55";
  const octet = { "Content-Type": "application/octet-stream" };

  test("createTask sends urgency, and the task has urgency and tags", async () => {
    const created = fixture("create").response.body as Task;
    const server = await api({ status: 201, body: { ...created, urgency: "high", tags: ["vip"] } });
    const task = await server.client().createTask({ task_type: "approve_refund", urgency: "high" });
    assert.deepEqual(JSON.parse(server.requests[0]?.body ?? ""), { task_type: "approve_refund", urgency: "high" });
    assert.equal(task.urgency, "high");
    assert.deepEqual(task.tags, ["vip"]);
  });

  test("getTask returns the decision's fields and attachments", async () => {
    const resolved = fixture("get-resolved").response.body as Task;
    const attachment = {
      id: attachmentId,
      field: "receipt",
      name: "receipt.pdf",
      size: 3,
      content_type: "application/pdf",
      sha256: "ab".repeat(32),
      url: `https://api.tasktohuman.com/v1/tasks/${taskId}/attachments/${attachmentId}`,
    };
    const decision = { ...resolved.decision!, fields: { note: "ok" }, attachments: [attachment] };
    const server = await api({ status: 200, body: { ...resolved, decision } });
    const task = await server.client().getTask(taskId);
    assert.deepEqual(task.decision?.fields, { note: "ok" });
    assert.deepEqual(task.decision?.attachments, [attachment]);
  });

  test("downloadTaskAttachment returns the bytes and the file name", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x00, 0xff]);
    const disposition = `attachment; filename="receipt _.pdf"; filename*=UTF-8''receipt%20%E2%82%AC.pdf`;
    const server = await api({ status: 200, headers: { ...octet, "Content-Disposition": disposition }, body: bytes });
    const file = await server.client().downloadTaskAttachment(taskId, attachmentId);
    assert.deepEqual(file, { content: bytes, filename: "receipt \u20ac.pdf" });
    const [req] = server.requests;
    assert.equal(req?.method, "GET");
    assert.equal(req?.url, `/v1/tasks/${taskId}/attachments/${attachmentId}`);
    assert.equal(req?.headers.accept, "application/octet-stream, application/problem+json");
    assert.equal(req?.headers.authorization, `Bearer ${API_KEY}`);
  });

  test("the file name falls back to filename, and is null without the header", async () => {
    const server = await api(
      { status: 200, headers: { ...octet, "Content-Disposition": 'attachment; filename="a \\"b\\".txt"' }, body: "x" },
      { status: 200, headers: { ...octet, "Content-Disposition": "attachment; filename=scan.png" }, body: "x" },
      { status: 200, headers: octet, body: "" },
    );
    const client = server.client();
    assert.equal((await client.downloadTaskAttachment(taskId, attachmentId)).filename, 'a "b".txt');
    assert.equal((await client.downloadTaskAttachment(taskId, attachmentId)).filename, "scan.png");
    assert.deepEqual(await client.downloadTaskAttachment(taskId, attachmentId), { content: new Uint8Array(), filename: null });
  });

  test("a 404, with or without a problem body, is a NotFoundError", async () => {
    const server = await api(
      { status: 404, body: { title: "Not found.", status: 404, code: "not_found" } },
      { status: 404 },
    );
    for (let i = 0; i < 2; i++) {
      await assert.rejects(server.client().downloadTaskAttachment(taskId, attachmentId), (error: unknown) => {
        assert.ok(error instanceof NotFoundError);
        assert.equal(error.code, "not_found");
        return true;
      });
    }
    assert.equal(server.requests.length, 2);
  });

  test("a removed file is listed with removed, and its download is an AttachmentRemovedError, never retried", async () => {
    const resolved = fixture("get-resolved").response.body as Task;
    const removed = {
      id: attachmentId,
      field: "receipt",
      name: "",
      size: 0,
      content_type: "application/pdf",
      sha256: "ab".repeat(32),
      url: `https://api.tasktohuman.com/v1/tasks/${taskId}/attachments/${attachmentId}`,
      removed: true,
      removed_at: "2026-11-20T10:00:00Z",
      removed_reason: "storage_allowance",
    };
    const title = "This file was removed to fit the organization's storage allowance. The task and its decision are kept.";
    const server = await api(
      { status: 200, body: { ...resolved, decision: { ...resolved.decision!, attachments: [removed] } } },
      { status: 410, body: { title, status: 410, code: "attachment_removed" } },
    );
    const client = server.client();
    const [attachment] = (await client.getTask(taskId)).decision?.attachments ?? [];
    assert.equal(attachment?.removed, true);
    assert.equal(attachment?.removed_reason, "storage_allowance");
    const error = await client.downloadTaskAttachment(taskId, attachmentId).catch((e: unknown) => e);
    assert.ok(error instanceof AttachmentRemovedError);
    assert.equal(error.status, 410);
    assert.equal(error.code, "attachment_removed");
    assert.ok(error.message.startsWith(title), error.message);
    assert.match(error.message, /Not retried/);
    assert.equal(server.requests.length, 2, "one get, one download");
  });

  test("another 410 code stays a plain APIError", async () => {
    const server = await api({ status: 410, body: { title: "Gone.", status: 410, code: "gone" } });
    const error = await server.client().downloadTaskAttachment(taskId, attachmentId).catch((e: unknown) => e);
    assert.ok(error instanceof APIError);
    assert.ok(!(error instanceof AttachmentRemovedError));
  });

  test("a 5xx is retried; a redirect is refused, not followed", async () => {
    const server = await api(
      { status: 503, body: { title: "Unavailable.", status: 503, code: "server_error" } },
      { status: 200, headers: octet, body: "ok" },
    );
    const file = await server.client().downloadTaskAttachment(taskId, attachmentId);
    assert.equal(new TextDecoder().decode(file.content), "ok");
    assert.equal(server.requests.length, 2);

    const redirect = await api({ status: 302, headers: { Location: "https://elsewhere.example/file" } });
    await assert.rejects(redirect.client().downloadTaskAttachment(taskId, attachmentId), APIConnectionError);
    assert.equal(redirect.requests.length, 1);
  });

  test("ids that are not UUIDs are refused before anything is sent", async () => {
    const server = await api({ status: 200, headers: octet, body: "x" });
    const client = server.client();
    for (const [task, attachment] of [
      [taskId, "../../me"],
      [taskId, ""],
      ["../me", attachmentId],
      [taskId, `${attachmentId}?x=1`],
    ] as const) {
      await assert.rejects(client.downloadTaskAttachment(task, attachment), TypeError);
    }
    assert.equal(server.requests.length, 0);
  });
});

describe("approvers", () => {
  const human = "0199c1a4-6d2e-7b7a-9f43-2f1c6a1d8e55";

  test("are sent by id and by email, as given", async () => {
    const server = await api(replay(fixture("create")));
    const approvers = [
      { step: 1, email: "marta@example.com" },
      { step: 3, human },
    ];
    await server.client().createTask({ task_type: "approve_refund", approvers }, { idempotencyKey: "refund-4822" });
    assert.deepEqual(JSON.parse(server.requests[0]?.body ?? ""), { task_type: "approve_refund", approvers });
  });

  test("are left out of the body when undefined, null or empty", async () => {
    const server = await api(replay(fixture("create")));
    const client = server.client();
    await client.createTask({ task_type: "approve_refund" });
    await client.createTask({ task_type: "approve_refund", approvers: undefined });
    await client.createTask({ task_type: "approve_refund", approvers: null });
    await client.createTask({ task_type: "approve_refund", approvers: [] });
    assert.equal(server.requests.length, 4);
    for (const req of server.requests) {
      assert.equal(req.body, '{"task_type":"approve_refund"}');
      assert.ok(!("approvers" in JSON.parse(req.body)));
    }
  });

  test("a value that is not a list is sent as it is, for the API to judge", async () => {
    const server = await api(replay(fixture("create")));
    const approvers = { step: 1, human };
    await server.client().createTask({ task_type: "approve_refund", approvers: approvers as never });
    assert.deepEqual(JSON.parse(server.requests[0]?.body ?? ""), { task_type: "approve_refund", approvers });
  });

  test("a refused approver is a ValidationError naming the entry", async () => {
    const server = await api({
      status: 400,
      body: {
        title: "The request is not valid.",
        status: 400,
        code: "validation_failed",
        errors: { "approvers.0": [{ code: "approver_not_in_group", message: "Step 2: not a member of the group." }] },
      },
    });
    const error = await server
      .client()
      .createTask({ task_type: "approve_refund", approvers: [{ step: 2, human }] })
      .catch((e: unknown) => e);
    assert.ok(error instanceof ValidationError);
    assert.equal(error.errors?.["approvers.0"]?.[0]?.code, "approver_not_in_group");
  });
});

describe("chain", () => {
  const human = "0199c1a4-6d2e-7b7a-9f43-2f1c6a1d8e55";

  test("a non-empty chain is sent as given", async () => {
    const server = await api(replay(fixture("create")));
    const chain: ChainStep[] = [
      { human, wait_seconds: 3600 },
      {
        approvers: [{ email: "cfo@example.com", can_decide_alone: true }, { human }],
        approvals_needed: 2,
        wait_seconds: 86400,
        remind: false,
      },
    ];
    await server.client().createTask({ task_type: "approve_refund", chain }, { idempotencyKey: "refund-4822" });
    assert.deepEqual(JSON.parse(server.requests[0]?.body ?? ""), { task_type: "approve_refund", chain });
  });

  test("is left out of the body when undefined, null or empty", async () => {
    const server = await api(replay(fixture("create")));
    const client = server.client();
    await client.createTask({ task_type: "approve_refund", chain: undefined });
    await client.createTask({ task_type: "approve_refund", chain: null });
    await client.createTask({ task_type: "approve_refund", chain: [], approvers: [] });
    assert.equal(server.requests.length, 3);
    for (const req of server.requests) assert.equal(req.body, '{"task_type":"approve_refund"}');
  });

  test("a refused override is a ValidationError with the chain code", async () => {
    const server = await api({
      status: 400,
      body: {
        title: "The request is not valid.",
        status: 400,
        code: "validation_failed",
        errors: { chain: [{ code: "chain_override_not_allowed", message: "This task type doesn't allow it." }] },
      },
    });
    const error = await server
      .client()
      .createTask({ task_type: "approve_refund", chain: [{ human, wait_seconds: 3600 }] })
      .catch((e: unknown) => e);
    assert.ok(error instanceof ValidationError);
    assert.equal(error.errors?.["chain"]?.[0]?.code, "chain_override_not_allowed");
  });
});

describe("listTaskTypes, getTaskType, listHumans", () => {
  const group = { id: "0199c1a4-7000-7b7a-9f43-2f1c6a1d8e55", name: "Finance approvers" };
  const taskTypes = {
    data: [
      {
        key: "approve_refund",
        name: "Approve a refund",
        kind: "approval",
        steps: [
          { step: 1, assignment: "at_creation" },
          { step: 2, assignment: "group", group },
          { step: 3, assignment: "human" },
          { step: 4, assignment: "at_creation", approvals_needed: 2, max_approvers: 3 },
        ],
        chain_override: false,
        fields: [{ key: "order_id", label: "Order", type: "text", required: true, sensitive: false, editable: false }],
        default_deadline_minutes: null,
      },
    ],
    next_cursor: null,
  };
  const marta = { id: "0199c1a4-6d2e-7b7a-9f43-2f1c6a1d8e55", name: "Marta" };
  const rui = { id: "0199c1a4-6d2e-7b7a-9f43-2f1c6a1d8e56", name: null };

  test("listTaskTypes returns the task types with their steps", async () => {
    const server = await api({ status: 200, body: taskTypes });
    const list = await server.client().listTaskTypes();
    assert.deepEqual(list, taskTypes);
    assert.equal(server.requests[0]?.method, "GET");
    assert.equal(server.requests[0]?.url, "/v1/task-types");
    const open = list.data[0]?.steps.filter((s) => s.assignment !== "human").map((s) => s.step);
    assert.deepEqual(open, [1, 2, 4]);
    assert.equal(list.data[0]?.steps[1]?.group?.id, group.id);
    // An open consensus step: name between approvals_needed and max_approvers people for it.
    assert.deepEqual([list.data[0]?.steps[3]?.approvals_needed, list.data[0]?.steps[3]?.max_approvers], [2, 3]);
    assert.equal(list.data[0]?.steps[0]?.approvals_needed, undefined);
  });

  test("listTaskTypes sends limit and cursor, and pages with next_cursor", async () => {
    const server = await api(
      { status: 200, body: { data: taskTypes.data, next_cursor: "c2 +/=" } },
      { status: 200, body: { data: [], next_cursor: null } },
    );
    const client = server.client();
    const keys: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await client.listTaskTypes({ limit: 1, cursor });
      keys.push(...page.data.map((t) => t.key));
      cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(keys, ["approve_refund"]);
    assert.deepEqual(
      server.requests.map((r) => r.url),
      ["/v1/task-types?limit=1", "/v1/task-types?limit=1&cursor=c2+%2B%2F%3D"],
    );
  });

  test("listTaskTypes returns the recorded page with each type's fields and default deadline", async () => {
    const f = fixture("task-types");
    const server = await api(replay(f));
    const list = await server.client().listTaskTypes({ limit: 1 });
    assert.deepEqual(list, f.response.body);
    assert.equal(server.requests[0]?.url, f.request.path);
    const refund = list.data[0]!;
    assert.deepEqual(
      refund.fields.filter((field) => field.required).map((field) => field.key),
      ["order_id", "amount", "reason"],
    );
    assert.equal(refund.default_deadline_minutes, 1440);
  });

  test("getTaskType reads one task type by key, as the list shows it", async () => {
    const f = fixture("task-type");
    const server = await api(replay(f));
    const taskType: TaskType = await server.client().getTaskType("approve_refund");
    assert.deepEqual(taskType, f.response.body);
    assert.equal(server.requests[0]?.method, "GET");
    assert.equal(server.requests[0]?.url, f.request.path);
    assert.deepEqual(taskType, (fixture("task-types").response.body as { data: TaskType[] }).data[0]);
    const email = taskType.fields.find((field) => field.type === "email");
    assert.deepEqual([email?.key, email?.sensitive, email?.required], ["customer_email", true, false]);
    assert.equal(taskType.fields.find((field) => field.key === "amount")?.editable, true);
  });

  test("getTaskType of an unknown, archived or other workspace's type is a NotFoundError", async () => {
    const server = await api({ status: 404, body: { title: "Not found.", status: 404, code: "not_found" } });
    const error = await server
      .client()
      .getTaskType("archived_type")
      .catch((e: unknown) => e);
    assert.ok(error instanceof NotFoundError);
    assert.equal(error.code, "not_found");
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]?.url, "/v1/task-types/archived_type");
  });

  test("getTaskType refuses a key that could change the request's path before anything is sent", async () => {
    const server = await api(replay(fixture("task-type")));
    const client = server.client();
    for (const key of ["", "..", "a/b", "approve_refund?x=1", "approve refund", "a%2Fb", "x".repeat(256)]) {
      await assert.rejects(client.getTaskType(key), TypeError);
    }
    assert.equal(server.requests.length, 0);
  });

  test("listHumans returns ids and names", async () => {
    const body = { data: [marta, rui], next_cursor: null };
    const server = await api({ status: 200, body });
    assert.deepEqual(await server.client().listHumans(), body);
    assert.equal(server.requests[0]?.method, "GET");
    assert.equal(server.requests[0]?.url, "/v1/humans");
  });

  test("listHumans filters by group and pages with next_cursor", async () => {
    const server = await api(
      { status: 200, body: { data: [marta], next_cursor: "next" } },
      { status: 200, body: { data: [rui], next_cursor: null } },
    );
    const client = server.client();
    const first = await client.listHumans({ group: group.id, limit: 1 });
    const second = await client.listHumans({ group: group.id, limit: 1, cursor: first.next_cursor ?? undefined });
    assert.deepEqual([...first.data, ...second.data], [marta, rui]);
    assert.equal(second.next_cursor, null);
    assert.deepEqual(
      server.requests.map((r) => r.url),
      [`/v1/humans?group=${group.id}&limit=1`, `/v1/humans?group=${group.id}&limit=1&cursor=next`],
    );
  });

  test("a plan without the feature is a PermissionDeniedError with the feature", async () => {
    const problem = {
      type: "https://docs.tasktohuman.com/errors#feature_not_in_plan",
      title: "Your plan does not include this feature.",
      status: 403,
      code: "feature_not_in_plan",
      feature: "routing.human_groups",
      available_from: "team",
      traceId: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    };
    const server = await api({ status: 403, body: problem });
    const client = server.client();
    for (const call of [() => client.listHumans({ group: group.id }), () => client.listTaskTypes()]) {
      const error = await call().catch((e: unknown) => e);
      assert.ok(error instanceof PermissionDeniedError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "feature_not_in_plan");
      assert.equal(error.title, problem.title);
      assert.equal(error.problem.feature, "routing.human_groups");
      assert.equal(error.problem.available_from, "team");
      assert.equal(error.traceId, problem.traceId);
    }
    // A 403 is never retried.
    assert.equal(server.requests.length, 2);
  });

  test("a paused key and a blocked address are PermissionDeniedErrors with the server's message, never retried", async () => {
    // Built inline: fixtures/api has no example of these (it is synced from the server).
    const paused = {
      title: "This API key is paused by TaskToHuman support until 2026-11-27 14:30 UTC. Contact support.",
      status: 403,
      code: "api_key_paused",
      until: "2026-11-27 14:30 UTC",
    };
    const blocked = {
      title: "Access from your network is temporarily blocked. If you think this is a mistake, contact support.",
      status: 403,
      code: "address_blocked",
    };
    for (const body of [paused, blocked]) {
      const server = await api({ status: 403, body });
      const error = await server
        .client()
        .getMe()
        .catch((e: unknown) => e);
      assert.ok(error instanceof PermissionDeniedError, body.code);
      assert.equal(error.code, body.code);
      assert.ok(error.message.includes(body.title), error.message);
      assert.equal((error.problem as unknown as Record<string, unknown>)["until"], "until" in body ? body.until : undefined);
      assert.equal(server.requests.length, 1, "not retried");
    }
  });

  test("open steps not switched on yet is a PermissionDeniedError", async () => {
    const server = await api({
      status: 403,
      body: { title: "Open steps are not available yet.", status: 403, code: "open_steps_not_available" },
    });
    const error = await server
      .client()
      .listTaskTypes()
      .catch((e: unknown) => e);
    assert.ok(error instanceof PermissionDeniedError);
    assert.equal(error.code, "open_steps_not_available");
  });
});

describe("waitForDecision", () => {
  const open = fixture("get").response.body as Task;
  const resolved = fixture("get-resolved").response.body as Task;
  const id = open.id;

  test("returns at once when the task is already finished", async () => {
    const server = await api({ status: 200, body: resolved });
    const task = await server.client().waitForDecision(id);
    assert.equal(task.state, "resolved");
    assert.equal(server.requests.length, 1);
  });

  test("polls with growing waits until the task finishes", async () => {
    const server = await api({ status: 200, body: open }, { status: 200, body: open }, { status: 200, body: open }, {
      status: 200,
      body: resolved,
    });
    const times: number[] = [];
    const client = server.client();
    const started = Date.now();
    const task = await client.waitForDecision(id, { initialIntervalMs: 40, maxIntervalMs: 80 });
    times.push(Date.now() - started);
    assert.equal(task.state, "resolved");
    assert.equal(server.requests.length, 4);
    // 40 + 80 + 80 (capped) = 200 ms at least.
    assert.ok((times[0] ?? 0) >= 190, `waited ${times[0]} ms`);
  });

  for (const state of ["expired", "cancelled"]) {
    test(`stops on ${state}`, async () => {
      const server = await api({ status: 200, body: { ...open, state } });
      assert.equal((await server.client().waitForDecision(id)).state, state);
    });
  }

  test("throws WaitTimeoutError with the last task", async () => {
    const server = await api({ status: 200, body: open });
    const error = await server
      .client()
      .waitForDecision(id, { timeoutMs: 120, initialIntervalMs: 30, maxIntervalMs: 30 })
      .catch((e: unknown) => e);
    assert.ok(error instanceof WaitTimeoutError);
    assert.equal(error.task.state, "notified");
    assert.ok(server.requests.length >= 2);
  });

  test("an abort stops the wait", async () => {
    const server = await api({ status: 200, body: open });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stop")), 50);
    await assert.rejects(
      server.client().waitForDecision(id, { initialIntervalMs: 10_000, signal: controller.signal }),
      /stop/,
    );
  });
});

describe("constructor", () => {
  test("requires an API key", () => {
    assert.throws(() => new TaskToHuman({ apiKey: "" }), TypeError);
    assert.throws(() => new TaskToHuman({} as never), TypeError);
  });

  test("refuses a key with a newline or a non-ASCII character without echoing it", () => {
    for (const bad of [`${API_KEY}\nextra`, `${API_KEY.slice(0, 8)}\r\n${API_KEY.slice(8)}`, `${API_KEY}é`, "tth test key"]) {
      assert.throws(
        () => new TaskToHuman({ apiKey: bad }),
        (error: unknown) => {
          assert.ok(error instanceof TypeError);
          assert.ok(!String(error.message).includes(API_KEY));
          assert.ok(!String(error.message).includes(bad.trim()));
          return true;
        },
        JSON.stringify(bad),
      );
    }
  });

  test("trims spaces and a trailing newline around the key", async () => {
    const api = await fakeApi({ status: 200, body: {} });
    try {
      await new TaskToHuman({ apiKey: `  ${API_KEY}\n`, baseUrl: api.url }).getMe();
      assert.equal(api.requests[0]?.headers.authorization, `Bearer ${API_KEY}`);
    } finally {
      await api.close();
    }
  });

  test("defaults to the production API", () => {
    assert.equal(new TaskToHuman({ apiKey: API_KEY }).baseUrl, "https://api.tasktohuman.com");
  });

  test("trims trailing slashes", () => {
    assert.equal(new TaskToHuman({ apiKey: API_KEY, baseUrl: "https://api.example.com/" }).baseUrl, "https://api.example.com");
  });

  test("refuses plain http except for localhost", () => {
    assert.throws(() => new TaskToHuman({ apiKey: API_KEY, baseUrl: "http://api.example.com" }), TypeError);
    assert.throws(() => new TaskToHuman({ apiKey: API_KEY, baseUrl: "http://localhost.example.com" }), TypeError);
    assert.throws(() => new TaskToHuman({ apiKey: API_KEY, baseUrl: "ftp://localhost" }), TypeError);
    for (const ok of ["http://localhost:8080", "http://api.localhost:8080", "http://127.0.0.1:1", "http://[::1]:8080"]) {
      assert.doesNotThrow(() => new TaskToHuman({ apiKey: API_KEY, baseUrl: ok }), ok);
    }
  });

  test("refuses credentials, queries and fragments in the base URL", () => {
    for (const bad of ["https://u:p@api.example.com", "https://api.example.com?x=1", "https://api.example.com#x", "nope"]) {
      assert.throws(() => new TaskToHuman({ apiKey: API_KEY, baseUrl: bad }), TypeError, bad);
    }
  });
});
