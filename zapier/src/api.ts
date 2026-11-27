// One request helper over z.request, the base URL rule and the one place that turns a refused request into the
// right Zapier error. Messages are built from the parsed problem fields only: never the key, headers or the request.
import { createRequire } from 'node:module';
import type { Bundle, HttpRequestOptions, ZObject } from 'zapier-platform-core';

const packageJson = createRequire(import.meta.url)('../package.json') as { version: string };

export const VERSION = packageJson.version;
export const USER_AGENT = `tasktohuman-zapier/${VERSION}`;
export const DEFAULT_BASE_URL = 'https://api.tasktohuman.com';

/** A task as /v1 returns it (PublicTaskView). Only the fields this app reads are typed. */
export interface Task {
  id: string;
  state: string;
  task_type: string;
  test: boolean;
  finished_at: string | null;
  decision: { action: string; automatic: boolean; [key: string]: unknown } | null;
  [key: string]: unknown;
}

export interface Page<T> {
  data: T[];
  next_cursor?: string | null;
}

/** The states after which a task never changes again. */
export const FINAL_STATES = ['resolved', 'expired', 'cancelled'];

/**
 * The API's base URL: https://api.tasktohuman.com, or TTH_BASE_URL when set (tests and local runs only; never set
 * on the published app). http is allowed only for 127.0.0.1, localhost and *.localhost.
 */
export function baseUrl(): string {
  const raw = (process.env.TTH_BASE_URL ?? '').trim();
  if (raw === '') return DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('TTH_BASE_URL is not a web address.');
  }
  const host = parsed.hostname;
  const local = host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost');
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new Error('TTH_BASE_URL must start with https:// (http only for localhost).');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.replace(/\/+$/, '') !== '') {
    throw new Error('TTH_BASE_URL must be a plain address, like https://api.tasktohuman.com.');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/** beforeRequest: the key and the fixed headers, only on requests to the API's own base URL. */
export function addHeaders(request: HttpRequestOptions & { url: string }, _z: ZObject, bundle: Bundle) {
  if (request.url === baseUrl() || request.url.startsWith(`${baseUrl()}/`)) {
    // Zapier's request defaults carry a lower-case user-agent: drop any spelling of the headers set here first.
    const own = ['accept', 'accept-language', 'user-agent', 'authorization'];
    const kept = Object.entries(request.headers ?? {}).filter(([name]) => !own.includes(name.toLowerCase()));
    request.headers = {
      ...Object.fromEntries(kept),
      Accept: 'application/json',
      'Accept-Language': 'en',
      'User-Agent': USER_AGENT,
    };
    const key = (bundle.authData?.apiKey ?? '').trim();
    if (key !== '') request.headers.Authorization = `Bearer ${key}`;
  }
  return request;
}

export interface RawResponse {
  status: number;
  data: unknown;
  header(name: string): string | undefined;
}

export interface SendOptions {
  params?: Record<string, string | number>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** Sends one request and returns status, parsed body (or null) and headers, whatever the status. */
export async function send(z: ZObject, method: 'GET' | 'POST', path: string, options: SendOptions = {}): Promise<RawResponse> {
  const request: HttpRequestOptions & { url: string; throwForThrottlingEarly: boolean } = {
    url: `${baseUrl()}${path}`,
    method,
    params: options.params,
    headers: { ...options.headers },
    skipThrowForStatus: true,
    // 429 goes through failure() below like every other status, so the message names Retry-After the same way.
    throwForThrottlingEarly: false,
  };
  if (options.body !== undefined) {
    request.body = options.body;
    request.headers = { ...request.headers, 'Content-Type': 'application/json' };
  }
  const response = await z.request(request);
  let data: unknown = null;
  try {
    data = response.content ? JSON.parse(response.content) : null;
  } catch {
    data = null; // an edge error page: failure() gives a generic message with the status
  }
  return { status: response.status, data, header: (name) => response.getHeader(name) };
}

/** Sends one request and returns the parsed body of a 2xx answer; any other answer throws the mapped Zapier error. */
export async function call<T>(z: ZObject, method: 'GET' | 'POST', path: string, options: SendOptions = {}): Promise<T> {
  const response = await send(z, method, path, options);
  if (response.status >= 200 && response.status < 300) return response.data as T;
  throw failure(z, response);
}

/** The path segment for an id or key the user typed (never lets it change the path). */
export function segment(value: unknown, label: string, z: ZObject): string {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (text === '') throw new z.errors.HaltedError(`Fill in ${label}.`);
  return encodeURIComponent(text);
}

interface Problem {
  title?: unknown;
  code?: unknown;
  reason?: unknown;
  feature?: unknown;
  errors?: unknown;
  needed?: unknown;
  available?: unknown;
  held?: unknown;
}

/** Turns a non-2xx answer into the Zapier error for it. */
export function failure(z: ZObject, response: RawResponse): Error {
  const { status } = response;
  const problem: Problem =
    response.data !== null && typeof response.data === 'object' && !Array.isArray(response.data) ? (response.data as Problem) : {};
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
  const code = text(problem.code);
  const title = text(problem.title);
  const withCode = (message: string) => (code ? `${message} (${code})` : message);

  switch (status) {
    case 400: {
      const fields = fieldLines(problem.errors);
      const head = title ?? 'TaskToHuman refused some values.';
      return new z.errors.HaltedError(withCode(fields.length > 0 ? `${head} ${fields.join('; ')}` : head));
    }
    case 401:
      return new z.errors.ExpiredAuthError('TaskToHuman refused the API key. Reconnect with a key that is still active.');
    case 402: {
      const reason = text(problem.reason);
      if (code === 'not_enough_credits') return new z.errors.HaltedError(withCode(notEnoughCredits(problem, reason)));
      return new z.errors.HaltedError(
        `Your organization cannot create more tasks right now${reason ? ` (${limitName(reason)})` : ''}. Check Billing in TaskToHuman.`,
      );
    }
    case 403: {
      if (code === 'feature_not_in_plan') {
        const feature = text(problem.feature);
        return new z.errors.HaltedError(
          withCode(`Your TaskToHuman plan does not include this${feature ? ` (${feature})` : ''}.`),
        );
      }
      if (code === 'workspace_inactive') {
        return new z.errors.HaltedError(withCode("This API key's workspace is inactive. Reactivate it in TaskToHuman."));
      }
      return new z.errors.HaltedError(withCode(title ?? "Your organization can't do this right now. Check its status in TaskToHuman."));
    }
    case 404:
      return new z.errors.HaltedError('Not found in this workspace and mode (a test key sees only test tasks).');
    case 409:
      if (code === 'idempotency_conflict') {
        return new z.errors.HaltedError('This Idempotency Key was used with different values. Use a new key, or send the same values again.');
      }
      return new z.errors.HaltedError(withCode(title ?? 'TaskToHuman refused the request because of the task\'s state.'));
    case 422:
      if (code === 'no_owner_available') {
        return new z.errors.HaltedError(withCode("Nobody can take this task now. Check the task type's chain and its people in TaskToHuman."));
      }
      return new z.errors.HaltedError(withCode(title ?? 'TaskToHuman refused the request.'));
    case 429: {
      const seconds = Number.parseInt(response.header('retry-after') ?? '', 10);
      const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds : 60;
      return new z.errors.ThrottledError(`Too many requests for this API key: TaskToHuman asks to wait ${delay} seconds.`, delay);
    }
    default:
      if (status >= 500) {
        return new z.errors.Error(
          `TaskToHuman could not answer right now (HTTP ${status}). It is safe to try again.`,
          code,
          status,
        );
      }
      return new z.errors.HaltedError(withCode(title ?? `TaskToHuman refused the request (HTTP ${status}).`));
  }
}

const LIMITS: Record<string, string> = {
  plan_limit: "the plan's monthly task limit",
  hard_cap: 'the hard cap set by the owner',
  spend_cap: 'the spend cap set by the owner',
  test_limit: "this month's test task allowance",
  // not_enough_credits: why no credits were bought for the task.
  no_credits: 'automatic buying is not available',
  auto_buy_off: 'automatic buying is off',
  spending_cap: "automatic buying would pass the organization's monthly spending cap",
  top_up_failed: 'the automatic purchase failed: check the card',
  purchases_disabled: 'credit purchases are turned off for now',
};

function limitName(reason: string): string {
  return LIMITS[reason] ?? reason;
}

/** 402 `not_enough_credits`: halted (a retry cannot succeed), with the counts and how the organization gets credits. */
function notEnoughCredits(problem: Problem, reason: string | undefined): string {
  const count = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
  const [needed, available, held] = [count(problem.needed), count(problem.available), count(problem.held)];
  const counts =
    needed !== undefined && available !== undefined
      ? ` It needs ${needed} credits; ${available} are free${held ? ` and ${held} are held by open tasks` : ''}.`
      : '';
  return (
    `Your organization is out of credits, so the task was not created${reason ? ` (${limitName(reason)})` : ''}.${counts}` +
    ' Buy a credit pack or turn on automatic buying in TaskToHuman (Plan > Credits), then replay this Zap run.'
  );
}

/** `payload.amount: This value doesn't match the field's type. (field_invalid)` for each field the API names. */
function fieldLines(errors: unknown): string[] {
  if (errors === null || typeof errors !== 'object' || Array.isArray(errors)) return [];
  const lines: string[] = [];
  for (const [key, list] of Object.entries(errors as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const item = (entry ?? {}) as { code?: unknown; message?: unknown };
      const code = typeof item.code === 'string' ? item.code : 'invalid';
      const message = typeof item.message === 'string' ? item.message : 'Check this value.';
      lines.push(`${key}: ${message} (${code})`);
    }
  }
  return lines;
}
