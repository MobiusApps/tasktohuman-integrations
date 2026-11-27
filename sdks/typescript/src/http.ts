import { APIConnectionError, TaskToHumanError, errorFromResponse } from "./errors.js";
import { VERSION } from "./version.js";

/**
 * Which failures a call may retry.
 * - "safe": reads, and createTask (always sent with an Idempotency-Key, so a retry returns the same task):
 *   429, 500, 502, 503, 504 and network errors or timeouts.
 * - "rate-limit-only": cancelTask. A lost success followed by a retry would come back as a misleading 409, so only
 *   a 429 (which the API refused before doing anything) is retried.
 */
export type RetryMode = "safe" | "rate-limit-only";

export interface HttpConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  fetch: typeof fetch;
}

export interface HttpRequest {
  method: "GET" | "POST";
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  headers?: Record<string, string>;
  retry: RetryMode;
  signal?: AbortSignal | undefined;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/** A Retry-After longer than this is not waited for: the error is thrown at once, with `retryAfter` set. */
const MAX_RETRY_AFTER_SECONDS = 60;

/** Sends one API call with the retry rules above and returns its JSON answer. Each attempt has its own `timeoutMs`. */
export async function send<T>(config: HttpConfig, req: HttpRequest): Promise<T> {
  const { status, value: text } = await exchange(config, req, (response) => response.text());
  const json = parseJson(text);
  if (json === undefined) throw new TaskToHumanError(`The API answered ${status} with a body that is not JSON.`);
  return json as T;
}

/** Sends one API call like `send` and returns its body as bytes, with the answer's headers (for downloads). */
export async function sendForBytes(
  config: HttpConfig,
  req: HttpRequest,
): Promise<{ content: Uint8Array; headers: Headers }> {
  const { value } = await exchange(config, req, async (response) => ({
    content: new Uint8Array(await response.arrayBuffer()),
    headers: response.headers,
  }));
  return value;
}

/** The retry loop: `read` reads a 2xx answer's body; any other status becomes the matching error. */
async function exchange<R>(
  config: HttpConfig,
  req: HttpRequest,
  read: (response: Response) => Promise<R>,
): Promise<{ status: number; value: R }> {
  const query = req.query?.toString();
  const url = `${config.baseUrl}${req.path}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/json",
    "User-Agent": `tasktohuman-js/${VERSION}`,
    ...req.headers,
  };
  let body: string | undefined;
  if (req.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(req.body);
  }

  for (let attempt = 0; ; attempt++) {
    req.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const canRetry = attempt < config.maxRetries;

    let status: number;
    let retryAfterHeader: string | null;
    let text: string;
    try {
      // "manual", not "error": Cloudflare Workers refuses "error". Any redirect is refused below, so the key is
      // never sent to another host.
      const response = await config.fetch(url, { method: req.method, headers, body, redirect: "manual", signal });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel().catch(() => undefined);
        throw new APIConnectionError(
          `The API answered with a redirect (${response.status}); the SDK does not follow redirects. Check baseUrl.`,
        );
      }
      status = response.status;
      if (status >= 200 && status < 300) return { status, value: await read(response) };
      retryAfterHeader = response.headers.get("retry-after");
      text = await response.text();
    } catch (error) {
      if (req.signal?.aborted) throw req.signal.reason;
      if (error instanceof APIConnectionError) throw error;
      const failure = timeout.aborted
        ? new APIConnectionError(`The API did not answer within ${config.timeoutMs} ms.`)
        : new APIConnectionError("The request to the API failed before an answer arrived.", { cause: error });
      if (canRetry && req.retry === "safe") {
        await sleep(backoffMs(attempt), req.signal);
        continue;
      }
      throw failure;
    }

    const retryAfter = parseRetryAfter(retryAfterHeader);
    const error = errorFromResponse(status, parseJson(text), retryAfter);
    const retryable = req.retry === "safe" ? RETRYABLE_STATUS.has(status) : status === 429;
    if (canRetry && retryable && (retryAfter === null || retryAfter <= MAX_RETRY_AFTER_SECONDS)) {
      await sleep(retryAfter === null ? backoffMs(attempt) : retryAfter * 1000, req.signal);
      continue;
    }
    throw error;
  }
}

/** 0.5 s, then 1 s, then 2 s, … */
function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt;
}

/** Retry-After in whole seconds; anything else (absent, an HTTP date, garbage) gives null and the normal backoff. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return /^\d{1,6}$/.test(trimmed) ? Number(trimmed) : null;
}

function parseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
