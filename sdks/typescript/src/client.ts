import { TaskToHumanError, WaitTimeoutError } from "./errors.js";
import { send, sendForBytes, sleep, type HttpConfig, type HttpRequest } from "./http.js";
import type {
  AttachmentFile,
  CreateTaskParams,
  Entitlements,
  HumanList,
  ListHumansParams,
  ListTaskTypesParams,
  ListTasksParams,
  Me,
  Task,
  TaskList,
  TaskType,
  TaskTypeList,
} from "./types.js";

export interface TaskToHumanOptions {
  /** A workspace API key: tth_live_… or tth_test_…. Keep it on the server; never ship it to a browser or an app. */
  apiKey: string;
  /** Default https://api.tasktohuman.com. Plain http is accepted only for localhost. */
  baseUrl?: string;
  /** Per attempt, not in total: a retried call can take longer (see the README). Default 30 000. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** A fetch implementation, for tests or special runtimes. Default: the global fetch. */
  fetch?: typeof fetch;
}

export interface CallOptions {
  /** Aborts the call, including any wait between retries. */
  signal?: AbortSignal;
}

export interface CreateTaskOptions extends CallOptions {
  /**
   * Identifies the real-world request, such as `refund-${order.id}`; up to 255 characters. Sending the same key
   * and body again returns the task you already have instead of asking a person twice. When left out, the SDK
   * generates one per call (so its own retries are safe) and puts it on any error as `error.idempotencyKey`.
   */
  idempotencyKey?: string;
}

export interface WaitOptions extends CallOptions {
  /** Default 600 000 (10 minutes). */
  timeoutMs?: number;
  /** The first wait between checks. Default 5 000. */
  initialIntervalMs?: number;
  /** Waits double up to this. Default 60 000. */
  maxIntervalMs?: number;
}

const DEFAULT_BASE_URL = "https://api.tasktohuman.com";
const FINISHED_STATES = new Set(["resolved", "expired", "cancelled"]);
/** 1 to 255 printable ASCII characters, no space at either end (a header value; the API's limit is 255). */
const IDEMPOTENCY_KEY = /^[\x21-\x7e](?:[\x20-\x7e]{0,253}[\x21-\x7e])?$/;
const TASK_TYPE_KEY = /^[A-Za-z0-9_-]{1,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The TaskToHuman API client. Server-side only: it holds your API key. */
export class TaskToHuman {
  readonly baseUrl: string;
  readonly #config: HttpConfig;

  constructor(options: TaskToHumanOptions) {
    // Never echo the key: a real key with a stray newline would otherwise reach error text through fetch.
    const apiKey = typeof options?.apiKey === "string" ? options.apiKey.trim() : "";
    if (!/^[\x21-\x7e]+$/.test(apiKey)) {
      throw new TypeError("TaskToHuman: apiKey must be a tth_live_… or tth_test_… key (printable ASCII, no spaces).");
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxRetries = options.maxRetries ?? 2;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("TaskToHuman: timeoutMs must be > 0.");
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new TypeError("TaskToHuman: maxRetries must be a whole number >= 0.");
    }
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== "function") throw new TypeError("TaskToHuman: no fetch available; pass options.fetch.");

    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#config = { baseUrl: this.baseUrl, apiKey, timeoutMs, maxRetries, fetch: fetchImpl };
  }

  /**
   * Creates a task (POST /v1/tasks). Retries after a timeout, a 429 or a 5xx reuse the same Idempotency-Key, so a
   * person is never asked twice. Pass your own key to make your retries safe too.
   *
   * For a task type with open steps, name the human of each one in `params.approvers` (see listTaskTypes). For a task
   * type with `chain_override`, `params.chain` may replace its whole chain for this task.
   */
  async createTask(params: CreateTaskParams, options: CreateTaskOptions = {}): Promise<Task> {
    if (typeof params !== "object" || params === null) throw new TypeError("createTask: params must be an object.");
    const idempotencyKey = options.idempotencyKey ?? globalThis.crypto.randomUUID();
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new TypeError("createTask: idempotencyKey must be 1 to 255 printable ASCII characters.");
    }
    // No approvers (or chain) means no such property at all: the API reads null or [] as a different request body
    // when it compares a retry with the same Idempotency-Key. Any other value is sent as it is, for the API to judge.
    const body: Record<string, unknown> = { ...params };
    for (const key of ["approvers", "chain"] as const) {
      const value = params[key];
      if (value == null || (Array.isArray(value) && value.length === 0)) delete body[key];
    }
    try {
      return await this.#send<Task>({
        method: "POST",
        path: "/v1/tasks",
        body,
        headers: { "Idempotency-Key": idempotencyKey },
        retry: "safe",
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof TaskToHumanError) error.idempotencyKey = idempotencyKey;
      throw error;
    }
  }

  /**
   * Reads one task (GET /v1/tasks/{id}), with its payload and, once decided, the decision with its comment, response
   * `fields` and `attachments`.
   */
  async getTask(id: string, options: CallOptions = {}): Promise<Task> {
    return this.#send<Task>({ method: "GET", path: `/v1/tasks/${taskId(id)}`, retry: "safe", signal: options.signal });
  }

  /**
   * Downloads a file the person sent with their answer (GET /v1/tasks/{id}/attachments/{attachmentId}):
   * `attachmentId` is the `id` of an entry of `decision.attachments`. The request is built from the two ids, never
   * from the entry's `url`, so your key goes only to `baseUrl`. Files are not virus-scanned. A task or file of another
   * workspace or mode, or older than your plan's history, throws NotFoundError; a file removed to fit the
   * organization's storage allowance (listed with `removed: true`) throws AttachmentRemovedError.
   */
  async downloadTaskAttachment(id: string, attachmentId: string, options: CallOptions = {}): Promise<AttachmentFile> {
    const { content, headers } = await sendForBytes(this.#config, {
      method: "GET",
      path: `/v1/tasks/${taskId(id)}/attachments/${uuid(attachmentId, "An attachment id")}`,
      headers: { Accept: "application/octet-stream, application/problem+json" },
      retry: "safe",
      signal: options.signal,
    });
    return { content, filename: dispositionFilename(headers.get("content-disposition")) };
  }

  /**
   * Lists the key's tasks, newest first, without payloads or comments (GET /v1/tasks).
   *
   * One page per call (`limit` 1 to 100, default 50): while the answer has a `next_cursor`, pass it as `cursor` with
   * the same filters for the next page, or use listAllTasks. With `finished_after`: only finished tasks, oldest
   * finished first, paged the same way. Count a task as finished only when its `finished_at` is set.
   *
   * With `finished_after` and `expand: "details"`, every task comes as getTask returns it (payload, comment, response
   * `fields` and `attachments`), at most 25 per page.
   */
  listTasks(params: ListTasksParams = {}, options: CallOptions = {}): Promise<TaskList> {
    const query = queryOf(params);
    return this.#send<TaskList>({ method: "GET", path: "/v1/tasks", query, retry: "safe", signal: options.signal });
  }

  /**
   * Every task that matches, page after page: `for await (const task of tth.listAllTasks({ state: "resolved" }))`.
   * It calls listTasks with the same filters and follows `next_cursor` to the last page; `limit` is the page size
   * (default 100; the API brings it down to 25 with `expand: "details"`) and `cursor`, when given, is where it starts.
   * Each task comes once, also when tasks are created meanwhile. Stop early with `break`.
   */
  async *listAllTasks(params: ListTasksParams = {}, options: CallOptions = {}): AsyncGenerator<Task, void, undefined> {
    let cursor = params.cursor;
    do {
      const page = await this.listTasks({ ...params, limit: params.limit ?? 100, cursor }, options);
      yield* page.data;
      cursor = page.next_cursor;
    } while (cursor);
  }

  /**
   * Lists the task types of the key's workspace, by key (GET /v1/task-types), with their `fields` (what createTask's
   * `payload` takes), `default_deadline_minutes` and steps. A step whose `assignment` is `at_creation` or `group` is
   * open: createTask must name its human in `approvers`. With `chain_override`, createTask may send its own `chain`
   * instead. On every plan.
   *
   * One page per call: while `next_cursor` is not null, pass it as `cursor` for the next page.
   */
  listTaskTypes(params: ListTaskTypesParams = {}, options: CallOptions = {}): Promise<TaskTypeList> {
    const query = queryOf(params);
    return this.#send<TaskTypeList>({
      method: "GET",
      path: "/v1/task-types",
      query,
      retry: "safe",
      signal: options.signal,
    });
  }

  /**
   * Reads one task type of the key's workspace by its key (GET /v1/task-types/{key}), exactly as listTaskTypes shows
   * it. An unknown key, an archived task type or one of another workspace throws NotFoundError. A key that is not
   * letters, digits, `_` and `-` throws a TypeError before anything is sent.
   */
  async getTaskType(key: string, options: CallOptions = {}): Promise<TaskType> {
    return this.#send<TaskType>({
      method: "GET",
      path: `/v1/task-types/${taskTypeKey(key)}`,
      retry: "safe",
      signal: options.signal,
    });
  }

  /**
   * Lists the active humans of the key's workspace, `id` and `name` only (GET /v1/humans); with `group`, only that
   * group's members. Use the ids in createTask's `approvers` or `chain`.
   *
   * One page per call: while `next_cursor` is not null, pass it as `cursor` for the next page. Throws
   * PermissionDeniedError (`feature_not_in_plan`, with `problem.feature`) without `routing.approver_at_creation` or
   * `routing.chain_override`, or with `group` without `routing.human_groups`.
   */
  listHumans(params: ListHumansParams = {}, options: CallOptions = {}): Promise<HumanList> {
    const query = queryOf(params);
    return this.#send<HumanList>({ method: "GET", path: "/v1/humans", query, retry: "safe", signal: options.signal });
  }

  /**
   * Cancels an open task (POST /v1/tasks/{id}/cancel). A finished task throws ConflictError with code
   * `task_already_finished` and `problem.state` / `problem.action`.
   */
  async cancelTask(id: string, options: CallOptions = {}): Promise<Task> {
    return this.#send<Task>({
      method: "POST",
      path: `/v1/tasks/${taskId(id)}/cancel`,
      retry: "rate-limit-only",
      signal: options.signal,
    });
  }

  /** Which organization, workspace and mode the key belongs to (GET /v1/me). A good health check. */
  getMe(options: CallOptions = {}): Promise<Me> {
    return this.#send<Me>({ method: "GET", path: "/v1/me", retry: "safe", signal: options.signal });
  }

  /** The plan and every feature and limit as it applies now (GET /v1/entitlements). */
  getEntitlements(options: CallOptions = {}): Promise<Entitlements> {
    return this.#send<Entitlements>({ method: "GET", path: "/v1/entitlements", retry: "safe", signal: options.signal });
  }

  /**
   * Polls a task until it is resolved, expired or cancelled, and returns it: checks at once, then after 5 s,
   * doubling up to 60 s. Throws WaitTimeoutError (with the last task) when `timeoutMs` passes.
   *
   * For scripts, tests and short agent turns. In production use `callback_url` and verifyCallback instead.
   * Check `decision.automatic` before acting: an expired task can carry a default action such as `approved`.
   */
  async waitForDecision(id: string, options: WaitOptions = {}): Promise<Task> {
    const timeoutMs = options.timeoutMs ?? 600_000;
    const maxIntervalMs = options.maxIntervalMs ?? 60_000;
    let intervalMs = options.initialIntervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = await this.getTask(id, { signal: options.signal });
      if (FINISHED_STATES.has(task.state)) return task;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new WaitTimeoutError(task, timeoutMs);
      await sleep(Math.min(intervalMs, remainingMs), options.signal);
      intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
    }
  }

  #send<T>(req: HttpRequest): Promise<T> {
    return send<T>(this.#config, req);
  }
}

/** The query string of a list call: values that are not set are left out, a Date is sent as ISO 8601. */
function queryOf(params: object): URLSearchParams {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.set(name, value instanceof Date ? value.toISOString() : String(value));
  }
  return query;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("TaskToHuman: baseUrl is not a valid URL.");
  }
  const host = url.hostname;
  const local = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new TypeError("TaskToHuman: baseUrl must use https (plain http only for localhost).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("TaskToHuman: baseUrl must not contain credentials, a query or a fragment.");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Task ids are UUIDs; anything else is refused before it can change the request's path. Callers are async
 * methods, so the TypeError surfaces as a rejected promise, never a synchronous throw.
 */
function taskId(id: string): string {
  return uuid(id, "A task id");
}

/** Task type keys are letters, digits, `_` and `-`; anything else is refused before it can change the request's path. */
function taskTypeKey(key: string): string {
  if (typeof key !== "string" || !TASK_TYPE_KEY.test(key)) {
    throw new TypeError("A task type key is letters, digits, _ and - (such as approve_refund).");
  }
  return key;
}

function uuid(id: string, what: string): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new TypeError(`${what} is a UUID.`);
  return id;
}

/** The file name of a Content-Disposition header: `filename*` (RFC 6266, UTF-8) first, then `filename`; else null. */
function dispositionFilename(header: string | null): string | null {
  if (header === null) return null;
  const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1]);
    } catch {
      // Not valid percent-encoding: fall back to the plain name.
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/i.exec(header);
  if (!plain) return null;
  return plain[1] !== undefined ? plain[1].replace(/\\(.)/g, "$1") : (plain[2] ?? null);
}
