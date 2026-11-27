// A local fake TaskToHuman API (node:http) and the vendored fixtures. Nothing here reaches a real host.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TaskToHuman, type TaskToHumanOptions } from "../src/index.js";

export const API_KEY = "tth_test_FAKEKEYfakekeyFAKEKEYfakekeyFAKEKEYfake12";

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Answers a request: a Reply, or "hang" (never answers), or "drop" (closes the connection). */
export type Handler = (req: Recorded, index: number) => Reply | "hang" | "drop" | Promise<Reply | "hang" | "drop">;

export interface FakeApi {
  url: string;
  requests: Recorded[];
  client(options?: Partial<TaskToHumanOptions>): TaskToHuman;
  close(): Promise<void>;
}

/** Starts a fake API on 127.0.0.1. `handlers` answer requests in order; the last one answers any extra request. */
export async function fakeApi(...handlers: (Handler | Reply | "hang" | "drop")[]): Promise<FakeApi> {
  const requests: Recorded[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const recorded: Recorded = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    const index = requests.push(recorded) - 1;
    const handler = handlers[Math.min(index, handlers.length - 1)];
    const reply = typeof handler === "function" ? await handler(recorded, index) : handler;
    if (reply === undefined || reply === "hang") return;
    if (reply === "drop") {
      req.socket.destroy();
      return;
    }
    const headers = { ...reply.headers };
    let body: string | Uint8Array = "";
    if (typeof reply.body === "string" || reply.body instanceof Uint8Array) body = reply.body;
    else if (reply.body !== undefined) {
      body = JSON.stringify(reply.body);
      headers["Content-Type"] ??= "application/json; charset=utf-8";
    }
    res.writeHead(reply.status, headers);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    client: (options = {}) => new TaskToHuman({ apiKey: API_KEY, baseUrl: url, ...options }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A file of the integrations repository, from the compiled test's location (build-test/test/…). */
export function repoFile(path: string): string {
  return readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
}

export interface Fixture {
  title: string;
  request: { method: string; path: string; headers?: Record<string, string>; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

/** One of fixtures/api/*.json: the docs' request/response examples, checked against the real API. */
export function fixture(name: string): Fixture {
  return JSON.parse(repoFile(`fixtures/api/${name}.json`)) as Fixture;
}

/** A fake API answering with a fixture's recorded response. */
export function replay(f: Fixture): Reply {
  return { status: f.response.status, headers: f.response.headers, body: f.response.body };
}
