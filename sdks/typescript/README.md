# @tasktohuman/sdk

The official TypeScript SDK for the [TaskToHuman API](https://docs.tasktohuman.com): create a task for a person,
wait for (or receive) their decision, and verify the signed callback. Small, typed, and with **no runtime
dependencies**: it uses the platform's `fetch` and Web Crypto.

- ESM with type declarations, for Node.js 22 or later. The code uses only Web APIs (no `node:` imports, checked in
  CI), so it is written to run on Deno, Bun and Cloudflare Workers too; those runtimes are not yet tested in CI.
- **Server-side only.** The client holds your API key: never ship it in a web page or an app.
- Covers `/v1`: create, get, list and cancel tasks, list task types and humans, `GET /v1/me`,
  `GET /v1/entitlements`, plus `waitForDecision` and `verifyCallback`.

```sh
npm install @tasktohuman/sdk
```

## Quick start

```ts
import { TaskToHuman } from "@tasktohuman/sdk";

const tth = new TaskToHuman({ apiKey: process.env.TTH_API_KEY! }); // tth_live_… or tth_test_…

const task = await tth.createTask(
  {
    task_type: "approve_refund",
    title: "Refund €249 to order #4821?",
    payload: { order_id: "4821", amount: 249, reason: "Arrived damaged" },
    deadline_minutes: 120,
  },
  // Identifies the real-world request: sending it again returns the same task instead of asking twice.
  { idempotencyKey: "refund-4821" },
);

const done = await tth.waitForDecision(task.id, { timeoutMs: 15 * 60_000 });
if (done.decision && !done.decision.automatic && ["approved", "edited"].includes(done.decision.action)) {
  // A person approved. For "edited", the changed values are in done.decision.payload.
}
```

Act on a decision only when `decision.automatic` is `false`. A task type's default action can finish an unanswered
task as `approved`; its state is then `expired` and `automatic` is `true`.

`waitForDecision` checks at once, then after 5 s, doubling up to 60 s, and throws `WaitTimeoutError` (with the last
`task`) when its time is up. It is meant for scripts, tests and short agent turns. **In production, give the task a
`callback_url` and verify the callback** (below): the decision is pushed within seconds, survives restarts and does
not spend your request allowance. A task that support reopens can finish again later; `waitForDecision` returns
the first finish.

## The client

```ts
new TaskToHuman({
  apiKey,                 // required
  baseUrl,                // default "https://api.tasktohuman.com"; plain http only for localhost
  timeoutMs,              // default 30_000, per attempt
  maxRetries,             // default 2
  fetch,                  // optional fetch implementation
});

await tth.createTask(params, { idempotencyKey?, signal? });   // Task
await tth.getTask(id, { signal? });                           // Task, with payload and payload_sha256
await tth.downloadTaskAttachment(id, attachmentId);           // { content: Uint8Array, filename }
await tth.listTasks({ state?, task_type?, created_after?, created_before?, cursor?, limit? }); // { data: Task[], next_cursor? }, newest first
await tth.listTasks({ finished_after, cursor?, limit? });    // finished tasks, oldest finished first; next_cursor when there is more
await tth.listTasks({ finished_after, expand: "details" });  // the same, each task as getTask returns it (25 per page)
tth.listAllTasks({ state?, task_type?, ... });                // async iterator over every page of listTasks
await tth.cancelTask(id);                                     // Task
await tth.listTaskTypes({ limit?, cursor? });                 // { data: TaskType[], next_cursor }
await tth.getTaskType(key);                                   // TaskType: fields, default_deadline_minutes, steps
await tth.listHumans({ group?, limit?, cursor? });            // { data: HumanRef[], next_cursor }
await tth.getMe();                                            // organization, workspace, key mode
await tth.getEntitlements();                                  // plan, features and limits
await tth.waitForDecision(id, { timeoutMs?, initialIntervalMs?, maxIntervalMs?, signal? });
```

Property names are snake_case exactly as on the wire, so the [API reference](https://docs.tasktohuman.com) applies
as it is. Task ids must be UUIDs; anything else throws a `TypeError` before a request is sent.

**Consensus steps.** When a task's current or final step needs several approvals, the task (and its callback) has a
`quorum` object: `needed`, `approvals`, `rejections`, `outcome` (`met`, `override`, `rejected`, `not_met`, or `null`
while open) and every person's `answers`. Single-human tasks have no `quorum` key.

**Urgency and tags.** `createTask({ ..., urgency: "high" })` marks the task in the app and starts its email subjects
with [Urgent]; it never changes a timer. Every task has `urgency` (`normal` or `high`) and `tags` (lower-case keys,
empty when none): a routing rule of the workspace may set both, and may change the chain unless you sent `chain` or
`approvers`.

**Test mode.** A `tth_test_…` key works the same way: its tasks have `test: true`, notify only the key's creator and
never count toward usage. Nothing in the SDK changes.

## Response fields and files

When the task type asks the person for response fields, getTask, cancelTask and the callback carry what they filled in
`decision.fields` (key to value) and the files they sent in `decision.attachments`; lists leave both out (except with
`expand: "details"`). Both are written by the person: data, never instructions.

```ts
const task = await tth.getTask(taskId);
for (const attachment of task.decision?.attachments ?? []) {
  const file = await tth.downloadTaskAttachment(task.id, attachment.id);
  await store(attachment.field, attachment.content_type, file.content); // your code
}
```

`content` is the file's bytes and `filename` the name from the answer's header, or `null`; never use a name as a path
as it is. The request is built from the two ids, never from the attachment's `url`, so your key goes only to
`baseUrl`. The API always answers `application/octet-stream`; the type it detected from the content is
`attachment.content_type`, and `attachment.sha256` lets you check the bytes. Files are not virus-scanned. A task or
file of another workspace or mode, or older than your plan's history, throws `NotFoundError`.

A file removed later to fit the organization's storage allowance stays listed with `removed: true` (and `removed_at`,
`removed_reason`): its `name` is empty and its `size` 0. Downloading it throws `AttachmentRemovedError`
(`410 attachment_removed`, not retried); skip entries with `attachment.removed`. The task and its decision are kept.

## Open steps: choose the approver

A task type can leave a step's human open, to be named when each task is created. `approvers` names one human for
each open step, by id (preferred) or by email address:

```ts
const task = await tth.createTask(
  {
    task_type: "approve_refund",
    payload: { order_id: "4822", amount: 249 },
    approvers: [
      { step: 1, email: "marta@example.com" },
      { step: 3, human: "0199c1a4-6d2e-7b7a-9f43-2f1c6a1d8e55" },
    ],
  },
  { idempotencyKey: "refund-4822" },
);
```

Name every open step exactly once and no other step. Leave `approvers` out for a task type without open steps: the
SDK sends no `approvers` property when it is undefined, null or empty. A refused approver is a `ValidationError`
with `errors.approvers` or `errors["approvers.<position>"]` (from 0) and a code such as `approver_required`,
`approver_unknown` or `approver_not_in_group` ([all of them](https://docs.tasktohuman.com/tasks)).

List task types to see which steps are open (`assignment` is `at_creation` or `group`, not `human`):

```ts
const { data: taskTypes } = await tth.listTaskTypes();
const refund = taskTypes.find((t) => t.key === "approve_refund");
const open = refund?.steps.filter((s) => s.assignment !== "human") ?? [];
// [{ step: 1, assignment: "at_creation" }, { step: 2, assignment: "group", group: { id: "…", name: "Finance approvers" } }]
```

List a group's humans to choose from (without `group`: every active human of the workspace). Only `id` and `name`
are returned, never an address:

```ts
const approvers: Approver[] = []; // import type { Approver } from "@tasktohuman/sdk"
const groupStep = open.find((s) => s.assignment === "group");
if (groupStep?.group) {
  const { data: members } = await tth.listHumans({ group: groupStep.group.id });
  const first = members[0];
  if (first) approvers.push({ step: groupStep.step, human: first.id });
}
```

Both lists return one page: `limit` is 1 to 100 (default 50), and while `next_cursor` is not null you pass it as
`cursor` to get the next page.

```ts
const humans: HumanRef[] = []; // import type { HumanRef } from "@tasktohuman/sdk"
let cursor: string | null = null;
do {
  const page = await tth.listHumans({ limit: 100, cursor });
  humans.push(...page.data);
  cursor = page.next_cursor;
} while (cursor);
```

`listTaskTypes` and `getTaskType` work on every plan. `listHumans` needs `routing.approver_at_creation` or `routing.chain_override` and, with `group`,
`routing.human_groups`: otherwise they throw `PermissionDeniedError` with code `feature_not_in_plan` and the feature
in `error.problem.feature`.

## A task type's fields

Each task type lists its `fields`, what `payload` takes: `key`, `label`, `type` (`text`, `long_text`, `number`,
`boolean`, `email` or `url`), and whether it is `required`, `sensitive` (kept out of notifications) or `editable` (the
person may change it before approving). `default_deadline_minutes` is the deadline a task gets when you send none
(`null`: no deadline). Read one task type by its key with `getTaskType`, for example to build a form:

```ts
const refund = await tth.getTaskType("approve_refund");
const missing = refund.fields.filter((f) => f.required && !(f.key in payload)).map((f) => f.label);
```

An unknown key, an archived task type or one of another workspace throws `NotFoundError`. A key that is not letters,
digits, `_` and `-` throws a `TypeError` before a request is sent.

## Send your own chain

A task type with `chain_override: true` (see listTaskTypes; plan feature `routing.chain_override`) lets a task bring
its own chain: `chain` replaces the task type's whole chain for that one task. Each step asks one human (`human` or
`email`) or is a consensus step (`approvers` and `approvals_needed`), and always has `wait_seconds`:

```ts
const chain: ChainStep[] = [ // import type { ChainStep } from "@tasktohuman/sdk"
  { human: "0199c1a4-6d2e-7b7a-9f43-2f1c6a1d8e55", wait_seconds: 3600 },
  {
    approvers: [{ email: "cfo@example.com", can_decide_alone: true }, { human: "0199c1a4-7f10-7c2b-8d11-5e2a7b3c9d01" }],
    approvals_needed: 2,
    wait_seconds: 86400,
  },
];
await tth.createTask({ task_type: "approve_refund", payload: { order_id: "4822" }, chain }, { idempotencyKey: "refund-4822" });
```

`approvers` and `owner` are refused with `chain`. The SDK sends no `chain` property when it is undefined, null or
empty. A refused chain is a `ValidationError` keyed `chain`, `chain.<step>.<property>` or
`chain.<step>.approvers.<position>` (from 0), with a code such as `chain_override_not_allowed`, `steps_invalid` or
`approver_unknown` ([all of them](https://docs.tasktohuman.com/tasks#send-your-own-chain)); a plan that lacks what
the chain needs is a `PermissionDeniedError`.

## Page through all tasks

`listTasks` returns one page (`limit` 1 to 100, default 50), newest first. When more tasks match, the answer has a
`next_cursor`: pass it as `cursor`, with the same filters, for the next page. It is left out on the last page.
`listAllTasks` does that for you:

```ts
for await (const task of tth.listAllTasks({ state: "resolved", created_after: "2026-11-01T00:00:00Z" })) {
  console.log(task.id, task.decision?.action);
}
```

Or page by page:

```ts
let cursor: string | null | undefined = null;
do {
  const page = await tth.listTasks({ state: "resolved", limit: 100, cursor });
  for (const task of page.data) console.log(task.id);
  cursor = page.next_cursor;
} while (cursor);
```

Each task comes once: a task created while you page sorts before the pages you already read.

## Tasks finished since a time

When you can't receive callbacks, poll for finished tasks: `listTasks({ finished_after })` returns only finished tasks
whose `finished_at` is at or after that time, oldest finished first, and a `next_cursor` while more match.

```ts
const handled = new Set<string>(); // ids already handled; keep those of the last minutes between polls
let cursor: string | null | undefined = null;
do {
  const page = await tth.listTasks({ finished_after: since, limit: 100, cursor });
  for (const task of page.data) {
    if (!task.finished_at || handled.has(task.id)) continue; // only tasks with finished_at set are finished
    handled.add(task.id);
    // act on task.decision; getTask(task.id) has the comment and edited values, or add expand: "details"
  }
  cursor = page.next_cursor;
} while (cursor);
```

For the next poll, set `since` to the latest `finished_at` you have seen **minus a margin, for example one minute**,
and skip the ids you already handled: a task can appear in the list shortly after one with a later `finished_at`.

Add `expand: "details"` to get each task exactly as `getTask` returns it (`payload`, `payload_sha256`, the decision's
`comment`, `fields` and `attachments`), so a poll needs no extra request per task. A page then holds at most 25 tasks
(a larger `limit` is brought down to 25). `expand` works only with `finished_after`: without it the API answers a
`ValidationError`.

```ts
const page = await tth.listTasks({ finished_after: since, expand: "details", cursor });
for (const task of page.data) console.log(task.id, task.payload, task.decision?.comment);
```

## Callbacks

When a task finishes, TaskToHuman posts it to the callback URL, signed with your workspace's signing secret
(`whsec_…`). `verifyCallback` checks the `TTH-Signature` header against the **raw body** (HMAC-SHA256 of
`t + "." + body`, compared in constant time, `t` within 5 minutes) and returns the parsed body. It throws
`SignatureVerificationError` (`reason`: `missing_header`, `malformed_header`, `timestamp_out_of_tolerance` or
`no_matching_signature`) when the callback must be refused, and a `TypeError` if the secret is missing or empty.

The body is a `CallbackTask`: `id`, `state`, `task_type`, `title`, `test`, `decision`, `urgency`, `tags`,
`routing`, `escalations`, `created_at`, and `quorum` after a consensus step. `routing.rule` is the routing rule that
matched when the task was created (`{ id, name }`, the name as it was then), or `null`. `urgency`, `tags` and `routing`
are optional in the type so callbacks sent before they existed still fit; treat a missing `urgency` as `normal`. It has
no owner, deadline or payload; read those with `getTask`.

Express:

```ts
import express from "express";
import { SignatureVerificationError, verifyCallback } from "@tasktohuman/sdk";

const app = express();

// express.raw keeps the exact bytes that were signed.
app.post("/hooks/tasktohuman", express.raw({ type: "application/json" }), async (req, res) => {
  let task;
  try {
    task = await verifyCallback({ body: req.body, headers: req.headers, secret: process.env.TTH_SIGNING_SECRET! });
  } catch (error) {
    if (error instanceof SignatureVerificationError) return res.sendStatus(400);
    throw error;
  }
  // Skip a TTH-Event-Id you already handled (a delivery can arrive twice), answer within 10 seconds,
  // and act only on a person's decision: task.decision?.automatic === false.
  res.sendStatus(204);
});
```

Next.js route handler, or any runtime with `Request` (Workers, Deno, Bun):

```ts
import { verifyCallback } from "@tasktohuman/sdk";

export async function POST(req: Request) {
  const task = await verifyCallback({
    body: new Uint8Array(await req.arrayBuffer()), // the raw bytes, untouched
    signature: req.headers.get("tth-signature"),
    secret: process.env.TTH_SIGNING_SECRET!,
  }).catch(() => null);
  if (!task) return new Response(null, { status: 400 });
  return new Response(null, { status: 204 });
}
```

**Rotation.** While a rotated secret overlaps, callbacks carry two `v1` values, so a receiver holding either secret
keeps working. To cover your own deploy window, pass both: `secret: [newSecret, oldSecret]`.

Never log a full callback body or task: `comment` and `payload` can hold personal data.

## Errors

Every error extends `TaskToHumanError`. API errors are `APIError` subclasses with `status`, `code`, `title`,
`errors` (per field, for validation problems), `traceId`, `retryAfter` and the whole `problem` document. **Branch on
`code`**, as the [errors page](https://docs.tasktohuman.com/errors) lists them.

| Class | Status | Examples of `code` |
| --- | --- | --- |
| `ValidationError` | 400 | `validation_failed` (see `errors["payload.order_id"]`, `errors["approvers.0"]`; codes such as `chain_override_not_allowed`, `owner_not_allowed_with_chain`), `bad_request` |
| `AuthenticationError` | 401 | `unauthorized` |
| `LimitReachedError` | 402 | `task_limit_reached`, `test_task_limit_reached` |
| `NotEnoughCreditsError` (a `LimitReachedError`) | 402 | `not_enough_credits`, with `needed`, `available`, `held`, `reason`, `autoBuy` ([Out of credits](#out-of-credits)) |
| `PermissionDeniedError` | 403 | `feature_not_in_plan` (with `problem.feature`), `open_steps_not_available`, `organization_on_hold`, `api_key_paused` (support paused the key; the message says until when), `address_blocked` |
| `NotFoundError` | 404 | `not_found` |
| `AttachmentRemovedError` | 410 | `attachment_removed`: the file was removed to fit the storage allowance |
| `ConflictError` | 409 | `idempotency_conflict`, `task_already_finished` (with `problem.state`, `problem.action`) |
| `UnprocessableError` | 422 | `no_owner_available` |
| `RateLimitError` | 429 | `rate_limited` |
| `ServerError` | 5xx | `server_error` |
| `APIConnectionError` | none | a network failure, a timeout, or a redirect (refused, so the key never goes elsewhere) |
| `WaitTimeoutError` | none | `waitForDecision` ran out of time; `task` is the last state seen |
| `SignatureVerificationError` | none | `verifyCallback` refused the callback; see `reason` |

An error answer without a JSON body (a proxy's error page) gets the documented code for its status:
`server_error` (5xx), `rate_limited` (429), `unauthorized` (401) or `not_found` (404), otherwise `http_<status>`. Errors never contain your API key.

### Out of credits

When credits are enforced for your organization, every task holds, at creation, the most its messages could cost in
credits (texts and emails sent for it); what it does not use comes back when it ends. If the free credits cannot
cover that, the task is **refused at creation** and nothing is stored, not even the idempotency key:

```ts
import { NotEnoughCreditsError } from "@tasktohuman/sdk";

try {
  await tth.createTask(params, { idempotencyKey: `refund-${order.id}` });
} catch (error) {
  if (error instanceof NotEnoughCreditsError) {
    // error.needed: credits the task would hold; error.available: free now; error.held: held by open tasks
    // error.reason: "no_credits" | "auto_buy_off" | "spending_cap" | "top_up_failed" | "purchases_disabled"
    // error.autoBuy: whether automatic buying is on
  }
  throw error;
}
```

It is not retried: a retry cannot succeed until the organization has credits. An owner or billing member fixes it in
the app (Plan > Credits) by buying a credit pack or turning on automatic buying (`reason` says why none was bought:
off, the monthly spending cap, or a declined card). Credits held by open tasks also come back as those tasks end.
Then send the request again with the same idempotency key. `NotEnoughCreditsError` extends `LimitReachedError`, so
code that catches every 402 keeps working.

## Retries and timeouts

- **Reads and `createTask`** are retried up to `maxRetries` times on 429, 500, 502, 503, 504, network errors and
  timeouts. A 402 (`LimitReachedError`, `NotEnoughCreditsError`), a 403 and the other 4xx are never retried. `createTask` always sends an `Idempotency-Key` (a generated UUID if you give none), and its retries
  reuse it, so a retry returns the same task.
- **`cancelTask`** is retried only on 429: a cancel that succeeded but whose answer was lost would otherwise come
  back as a confusing `409 task_already_finished`.
- A 429 or 503 waits the seconds in `Retry-After` (if it is more than 60, the error is thrown at once with
  `retryAfter` set). Otherwise the waits are 0.5 s, then 1 s.
- `timeoutMs` applies **per attempt**. With the defaults and a 60 s `Retry-After`, a call can take about two
  minutes. Pass a `signal` to bound the whole call: aborting it also stops a wait between retries.
- **Your own retries.** If you catch an error from `createTask` and try again, reuse its key so the person is still
  asked only once: `tth.createTask(params, { idempotencyKey: error.idempotencyKey })`. Better: always pass a key
  that names the real-world request, such as `refund-${order.id}`.

## Not in this version

- Task-type webhook URLs (`POST /v1/hooks/{token}`) are for no-code tools and take no API key; they are not wrapped.

## Licence

Licensed under the Apache License, Version 2.0; see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). You may use it
freely in free or commercial projects without publishing your own source code.

No warranty: the software is provided "AS IS", without warranties or conditions of any kind and without liability;
see sections 7 and 8 of the licence.

The licence covers the code only: the TaskToHuman name and logo are not licensed (see section 6).
