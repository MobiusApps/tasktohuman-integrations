// Retries, timeouts, redirects, error mapping and keeping the key out of errors.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { after, describe, test } from "node:test";
import {
  APIConnectionError,
  RateLimitError,
  ServerError,
  TaskToHumanError,
  type Task,
} from "../src/index.js";
import { API_KEY, fakeApi, fixture, type FakeApi } from "./helpers.js";

const servers: FakeApi[] = [];
async function api(...args: Parameters<typeof fakeApi>): Promise<FakeApi> {
  const server = await fakeApi(...args);
  servers.push(server);
  return server;
}
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const task = fixture("get").response.body as Task;
const id = task.id;
const ok = { status: 200, body: task };
const rateLimited = (retryAfter: string) => ({
  status: 429,
  headers: { "Retry-After": retryAfter, "Content-Type": "application/problem+json" },
  body: { title: "Too many requests.", status: 429, code: "rate_limited" },
});
const unavailable = { status: 503, body: { title: "Down.", status: 503, code: "server_error" } };

describe("retries", () => {
  test("a 429 waits Retry-After, then succeeds", async () => {
    const server = await api(rateLimited("1"), ok);
    const started = Date.now();
    const result = await server.client().getTask(id);
    assert.equal(result.id, id);
    assert.equal(server.requests.length, 2);
    assert.ok(Date.now() - started >= 950, "waited the Retry-After second");
  });

  test("a 429 that persists ends in RateLimitError with retryAfter", async () => {
    const server = await api(rateLimited("0"));
    const error = await server
      .client()
      .getTask(id)
      .catch((e: unknown) => e);
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.retryAfter, 0);
    assert.equal(error.code, "rate_limited");
    assert.equal(server.requests.length, 3, "first attempt + maxRetries 2");
  });

  test("a Retry-After over 60 s is not waited for", async () => {
    const server = await api(rateLimited("120"));
    const error = await server
      .client()
      .getTask(id)
      .catch((e: unknown) => e);
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.retryAfter, 120);
    assert.equal(server.requests.length, 1);
  });

  test("a Retry-After that is not whole seconds falls back to the backoff", async () => {
    const server = await api(rateLimited("Wed, 21 Oct 2015 07:28:00 GMT"), ok);
    const result = await server.client().getTask(id);
    assert.equal(result.id, id);
    assert.equal(server.requests.length, 2);
  });

  test("a 503 is retried, then succeeds", async () => {
    const server = await api(unavailable, ok);
    assert.equal((await server.client().getTask(id)).id, id);
    assert.equal(server.requests.length, 2);
  });

  test("maxRetries 0 sends once", async () => {
    const server = await api(unavailable);
    await assert.rejects(server.client({ maxRetries: 0 }).getTask(id), ServerError);
    assert.equal(server.requests.length, 1);
  });

  test("createTask retries a 5xx and a dropped connection with the same generated Idempotency-Key", async () => {
    const server = await api(unavailable, "drop", { status: 201, body: task });
    await server.client().createTask({ task_type: "approve_refund" });
    assert.equal(server.requests.length, 3);
    const keys = new Set(server.requests.map((r) => r.headers["idempotency-key"]));
    assert.equal(keys.size, 1);
    assert.equal(new Set(server.requests.map((r) => r.body)).size, 1, "the same body every time");
  });

  test("cancelTask is not retried on a 5xx", async () => {
    const server = await api(unavailable, ok);
    await assert.rejects(server.client().cancelTask(id), ServerError);
    assert.equal(server.requests.length, 1);
  });

  test("cancelTask is not retried on a dropped connection", async () => {
    const server = await api("drop", ok);
    await assert.rejects(server.client().cancelTask(id), APIConnectionError);
    assert.equal(server.requests.length, 1);
  });

  test("cancelTask is retried on a 429", async () => {
    const server = await api(rateLimited("0"), ok);
    await server.client().cancelTask(id);
    assert.equal(server.requests.length, 2);
  });

  test("a 4xx other than 429 is not retried", async () => {
    const server = await api({ status: 404, body: { title: "Not found.", status: 404, code: "not_found" } });
    await assert.rejects(server.client().getTask(id), { name: "NotFoundError", code: "not_found" });
    assert.equal(server.requests.length, 1);
  });

  test("an abort during the Retry-After wait stops at once", async () => {
    const server = await api(rateLimited("30"));
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled by caller")), 50);
    const started = Date.now();
    await assert.rejects(server.client().getTask(id, { signal: controller.signal }), /cancelled by caller/);
    assert.ok(Date.now() - started < 5_000);
    assert.equal(server.requests.length, 1);
  });
});

describe("transport failures", () => {
  test("a timeout is an APIConnectionError", async () => {
    const server = await api("hang");
    const error = await server
      .client({ timeoutMs: 100, maxRetries: 0 })
      .getTask(id)
      .catch((e: unknown) => e);
    assert.ok(error instanceof APIConnectionError);
    assert.match(error.message, /did not answer within 100 ms/);
  });

  test("a dropped connection is retried, then an APIConnectionError with the cause", async () => {
    const server = await api("drop");
    const error = await server
      .client()
      .getTask(id)
      .catch((e: unknown) => e);
    assert.ok(error instanceof APIConnectionError);
    assert.ok(error.cause !== undefined);
    assert.equal(server.requests.length, 3);
  });

  test("a redirect is refused, not followed", async () => {
    const server = await api({ status: 302, headers: { Location: "https://elsewhere.example/steal" } });
    await assert.rejects(server.client().getTask(id), (error: unknown) => {
      assert.ok(error instanceof APIConnectionError);
      assert.match(error.message, /redirect \(302\)/);
      return true;
    });
    assert.equal(server.requests.length, 1);
  });

  test("a non-JSON 502 maps to server_error", async () => {
    const server = await api({ status: 502, headers: { "Content-Type": "text/html" }, body: "<html>Bad gateway</html>" });
    const error = await server
      .client({ maxRetries: 0 })
      .getTask(id)
      .catch((e: unknown) => e);
    assert.ok(error instanceof ServerError);
    assert.equal(error.code, "server_error");
    assert.equal(error.status, 502);
  });

  test("non-JSON 429 and 401 bodies map to the documented codes; others to http_<status>", async () => {
    const server = await api(
      { status: 429, body: "slow down" },
      { status: 401, body: "" },
      { status: 418, body: "teapot" },
    );
    const client = server.client({ maxRetries: 0 });
    await assert.rejects(client.getTask(id), { name: "RateLimitError", code: "rate_limited" });
    await assert.rejects(client.getTask(id), { name: "AuthenticationError", code: "unauthorized" });
    await assert.rejects(client.getTask(id), { name: "APIError", code: "http_418" });
  });

  test("a 2xx that is not JSON is a TaskToHumanError", async () => {
    const server = await api({ status: 200, body: "<html>wrong host</html>" });
    await assert.rejects(server.client().getTask(id), TaskToHumanError);
  });
});

describe("the API key never leaks", () => {
  // JSON.stringify(undefined) is undefined (an error with no cause), hence the fallback.
  const leaks = (value: unknown) => {
    for (const text of [String(value), JSON.stringify(value) ?? "", inspect(value, { depth: 10, showHidden: true })]) {
      assert.ok(!text.includes(API_KEY), `key found in: ${text.slice(0, 200)}`);
    }
  };

  test("not in a 401, a 5xx, a network failure or a timeout", async () => {
    const server = await api(
      { status: 401, body: { title: "Sign in.", status: 401, code: "unauthorized" } },
      unavailable,
      "drop",
      "hang",
    );
    const client = server.client({ maxRetries: 0, timeoutMs: 100 });
    for (let i = 0; i < 4; i++) {
      const error = await client.getTask(id).catch((e: unknown) => e);
      assert.ok(error instanceof TaskToHumanError);
      leaks(error);
      leaks((error as Error).cause);
    }
  });

  test("not in the client", async () => {
    const server = await api(ok);
    const client = server.client();
    leaks(client);
    leaks(Object.entries(client));
  });
});
