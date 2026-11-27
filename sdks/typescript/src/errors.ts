import type { FieldMessage, Problem, Task } from "./types.js";

// Every error the SDK throws extends TaskToHumanError. None of them carries the request, its headers or the API key.

export class TaskToHumanError extends Error {
  /**
   * On errors thrown by createTask: the Idempotency-Key that was sent. Retry with the same key (pass it as
   * `idempotencyKey`) and you can never create the task twice.
   */
  idempotencyKey?: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The API answered with an error. Branch on `code` (see https://docs.tasktohuman.com/errors). */
export class APIError extends TaskToHumanError {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  /** Validation problems: each field (`payload.<key>` for payload fields) with its `{code, message}` list. */
  readonly errors: Record<string, FieldMessage[]> | null;
  readonly traceId: string | null;
  /** Seconds from the Retry-After header, when there was one. */
  readonly retryAfter: number | null;
  /** The whole problem document, with extra data such as `feature`, `reason`, `limit`, `max`, `state`, `action`. */
  readonly problem: Problem;

  constructor(problem: Problem, retryAfter: number | null) {
    super(`${problem.title} (${problem.status} ${problem.code})`);
    this.status = problem.status;
    this.code = problem.code;
    this.title = problem.title;
    this.errors = problem.errors ?? null;
    this.traceId = problem.traceId ?? null;
    this.retryAfter = retryAfter;
    this.problem = problem;
  }
}

/** 400: fix the request and send it again. */
export class ValidationError extends APIError {}
/** 401: the API key is missing, malformed, unknown or revoked. */
export class AuthenticationError extends APIError {}
/** 402: a monthly allowance or a cap is reached, or (as NotEnoughCreditsError) the organization is out of credits. */
export class LimitReachedError extends APIError {}

/** Why the credits could not be topped up: the `reason` of a `not_enough_credits` refusal. */
export type NotEnoughCreditsReason =
  | "no_credits"
  | "auto_buy_off"
  | "spending_cap"
  | "top_up_failed"
  | "purchases_disabled";

/**
 * 402 `not_enough_credits`: the organization's credits cannot cover the most this task could cost, so it was not
 * created (nothing is stored, not even the idempotency key). Not retried: a retry cannot succeed until someone in the
 * organization buys a credit pack or turns on automatic buying in the app (Plan > Credits). Then retry with the same
 * `idempotencyKey`.
 */
export class NotEnoughCreditsError extends LimitReachedError {
  /** The credits the task would hold (the most it could cost). */
  readonly needed: number | null;
  /** The organization's free credits now. */
  readonly available: number | null;
  /** The credits open tasks hold now; they come back as those tasks end. */
  readonly held: number | null;
  /**
   * Why no credits were bought for it: `no_credits` (automatic buying is not possible), `auto_buy_off`,
   * `spending_cap` (the monthly cap would be passed), `top_up_failed` (the card was declined or needs authentication)
   * or `purchases_disabled`. Other values may be added later.
   */
  readonly reason: NotEnoughCreditsReason | (string & {}) | null;
  /** Whether automatic buying is on for the organization. */
  readonly autoBuy: boolean | null;

  constructor(problem: Problem, retryAfter: number | null) {
    super(problem, retryAfter);
    this.needed = problem.needed ?? null;
    this.available = problem.available ?? null;
    this.held = problem.held ?? null;
    this.reason = problem.reason ?? null;
    this.autoBuy = problem.auto_buy ?? null;
    const counts =
      this.needed !== null && this.available !== null
        ? ` It needs ${this.needed} credits; ${this.available} are free${this.held ? ` and ${this.held} are held by open tasks` : ""}.`
        : "";
    this.message =
      `${problem.title} (${problem.status} ${problem.code})${counts} Not retried: buy a credit pack or turn on ` +
      "automatic buying in the app (Plan > Credits), then retry with the same idempotency key.";
  }
}
/**
 * 403: the plan or the organization's status does not allow this. Never retried. Among the codes: `api_key_paused`
 * (TaskToHuman support paused this key; the message says until when, from the problem's `until`) and `address_blocked`
 * (requests from your network are blocked for a while). Both last until the rule ends: contact support.
 */
export class PermissionDeniedError extends APIError {}
/** 404: no such task for this key. */
export class NotFoundError extends APIError {}
/**
 * 410 `attachment_removed`: the file was removed to fit the organization's storage allowance. It stays listed on its
 * task with `removed: true`; the task and its decision are kept. Not retried: the file cannot come back.
 */
export class AttachmentRemovedError extends APIError {
  constructor(problem: Problem, retryAfter: number | null) {
    super(problem, retryAfter);
    this.message = `${problem.title} (${problem.status} ${problem.code}) Not retried: the file cannot be downloaded any more.`;
  }
}
/** 409: `idempotency_conflict`, or `task_already_finished` (with `problem.state` and `problem.action`). */
export class ConflictError extends APIError {}
/** 422: `no_owner_available`. */
export class UnprocessableError extends APIError {}
/** 429: too many requests; `retryAfter` says how many seconds to wait. */
export class RateLimitError extends APIError {}
/** 5xx: something failed on the API's side. */
export class ServerError extends APIError {}

/** The request did not get an answer: a network failure, a timeout or a refused redirect. `cause` has the detail. */
export class APIConnectionError extends TaskToHumanError {}

/** waitForDecision ran out of time. `task` is the last state seen. */
export class WaitTimeoutError extends TaskToHumanError {
  readonly task: Task;

  constructor(task: Task, timeoutMs: number) {
    super(`Task ${task.id} was not finished after ${timeoutMs} ms (state: ${task.state}).`);
    this.task = task;
  }
}

export type SignatureFailure =
  | "missing_header"
  | "malformed_header"
  | "timestamp_out_of_tolerance"
  | "no_matching_signature";

/** verifyCallback refused the callback. Answer it with 400 and do not act on it. */
export class SignatureVerificationError extends TaskToHumanError {
  readonly reason: SignatureFailure;

  constructor(reason: SignatureFailure) {
    super(`The callback's TTH-Signature was refused: ${reason}.`);
    this.reason = reason;
  }
}

/** The documented codes, used when an error answer has no JSON problem body (a proxy's HTML page, for example). */
function fallbackCode(status: number): string {
  if (status >= 500) return "server_error";
  if (status === 429) return "rate_limited";
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  return `http_${status}`;
}

function classFor(status: number): typeof APIError {
  switch (status) {
    case 400:
      return ValidationError;
    case 401:
      return AuthenticationError;
    case 402:
      return LimitReachedError;
    case 403:
      return PermissionDeniedError;
    case 404:
      return NotFoundError;
    case 409:
      return ConflictError;
    case 422:
      return UnprocessableError;
    case 429:
      return RateLimitError;
    default:
      return status >= 500 ? ServerError : APIError;
  }
}

/** Builds the error for a non-2xx answer. `body` is the parsed JSON, or undefined when it was not JSON. */
export function errorFromResponse(status: number, body: unknown, retryAfter: number | null): APIError {
  const isProblem =
    typeof body === "object" && body !== null && typeof (body as { code?: unknown }).code === "string";
  const problem: Problem = isProblem
    ? { ...(body as Problem), status }
    : { title: `The API answered ${status} without a problem document.`, status, code: fallbackCode(status) };
  if (typeof problem.title !== "string") problem.title = `The API answered ${status}.`;
  const ErrorClass =
    status === 402 && problem.code === "not_enough_credits"
      ? NotEnoughCreditsError
      : status === 410 && problem.code === "attachment_removed"
        ? AttachmentRemovedError
        : classFor(status);
  return new ErrorClass(problem, retryAfter);
}
