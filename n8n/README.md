# n8n-nodes-tasktohuman

The [TaskToHuman](https://tasktohuman.com) community node for [n8n](https://n8n.io). TaskToHuman sends a task to a
person (by email, with a secure link) and gives your workflow their decision: approved, rejected, edited, done or
handed back, or what happened when nobody answered in time.

- **TaskToHuman** node: create a task, create one and **wait for the decision**, get a task, list tasks, cancel a task.
- **TaskToHuman Trigger**: start a workflow when a task finishes.

## Installation

**Self-hosted n8n:** **Settings → Community Nodes → Install**, enter `n8n-nodes-tasktohuman`, tick the box and
**Install**. (Or, in the n8n folder, `npm install n8n-nodes-tasktohuman` and restart n8n.) See n8n's
[community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

**n8n Cloud:** available once n8n has verified the node.

Built against n8n 2.47 (`n8n-workflow` 2.47.0). "Create and Wait for Decision" needs an n8n with signed resume URLs
(`getSignedResumeUrl`) on its default execution engine; older versions are not tested.

## Credentials

Create a **TaskToHuman API** credential:

| Field | What to enter |
| --- | --- |
| API Key | A workspace API key from the TaskToHuman app (**Settings → API keys**). A `tth_test_…` key works exactly like a `tth_live_…` key but notifies only you: start with one. |
| Base URL | Leave `https://api.tasktohuman.com`. Must be https. |
| Signing Secret | Only for "Create and Wait for Decision": the workspace signing secret `whsec_…` (**Settings → workspace → Signing secret → Reveal** or **Rotate**). It is shown once. During a rotation TaskToHuman signs with both secrets, so the old one keeps working until the rotation ends. |

The credential test calls `GET /v1/me`; it checks the key, not the signing secret (a wrong secret shows up as
decisions that never arrive: see below). Tasks created with a test key are invisible to a live key, and the other way
round; task types are shared.

## TaskToHuman node (resource: Task)

### Create

Creates a task (`POST /v1/tasks`) and continues at once with the task (its `id`, `state`, `expires_at`, …).

- **Task Type:** pick it from the list, or type its key (**By Key**). The list needs a plan that shows task types
  through the API; otherwise use By Key.
- **Title:** shown in notifications and not encrypted; keep sensitive data out of it. Empty: the task type's name.
- **Payload:** the task type's fields as a JSON object, for example `{"order_id": "4821", "amount": 249}`. Use an
  expression to map fields from earlier nodes. TaskToHuman checks the fields and says which one to fix.
- **Options:**
  - **Deadline (Minutes):** when the task type's default action applies (1 to 525600).
  - **Callback URL:** a public https URL that receives the signed decision (default: the task type's).
  - **Idempotency Key:** sending the same key and values again returns the same task. Empty: one key per execution,
    node and item, so n8n's **Retry On Fail** never asks a person twice.
  - **Owner:** the ID of a person who gets the task first.
  - **Approvers:** the person of each open step of the task type (step number + person ID or email address).
  - **Chain:** this task's own chain, for task types that allow it: each step is one person, or several separated by
    commas for a consensus step, with how long it waits.

### Create and Wait for Decision

Creates the task with n8n's signed resume URL as its callback URL, then **pauses the workflow** until TaskToHuman
sends the decision. The output is the decided task (the callback body: `id`, `state`, `decision` with `action`,
`automatic`, `comment`, edited `payload`, …) with `callback_received: true`.

Requirements:

- the credential's **Signing Secret** (the node refuses to start without it);
- n8n reachable from the internet at a **public https address**: set n8n's `WEBHOOK_URL` to it. TaskToHuman never
  calls http, private or local addresses; if it refuses n8n's address, the node says so. Without a public address,
  use **Create** plus the **TaskToHuman Trigger** instead;
- **one input item** per execution (put **Loop Over Items** with a batch size of 1 in front for several);
- one free slot in the execution's custom data (n8n allows 10): the node keeps the created task's id there.

How long it waits:

- with a deadline (the option, or the task type's): until **one hour after the deadline**. At the deadline the task's
  default action finishes it and the decision is sent, with retries well inside that hour;
- without any deadline: indefinitely. Set a deadline.
- If the wait ends without a decision, the node outputs the created task with `callback_received: false`; follow it
  with **Get** to read the task. This also happens when staff move the deadline, pause or reopen the task after the
  wait started: the node keeps the wait it computed at creation.
- If the task is already finished when it is created (a retry that replayed a task decided earlier), the node returns
  it at once with `callback_received: false`.
- `callback_received` tells how the result arrived, not whether there is a decision: branch on `decision.action`
  (and `decision.automatic`), as the example workflow does.

Security: a decision resumes the workflow only with a valid `TTH-Signature` (HMAC-SHA256 with your signing secret,
at most 5 minutes old), for the task this execution created, on n8n's own signed resume URL. Anything else (also a
signed callback of another task of the workspace) gets `401` and the workflow keeps waiting;
TaskToHuman's next retry, signed again, can still resume it. A decision that arrives after the workflow already
moved on is answered by n8n without resuming anything.

Do not use this operation from an AI agent tool call: the agent would wait as long as the person takes.

### Get

`GET /v1/tasks/{id}`: the task with its payload, its `payload_sha256` and the decision's comment and edited values.

### Get Many

`GET /v1/tasks`, newest created first, without payloads. Filters: State, Task Type Key, Created After, Created
Before, Finished After (only finished tasks, oldest finished first). **Return All** pages through every result;
otherwise **Limit** sets how many.

### Cancel

`POST /v1/tasks/{id}/cancel`. Outputs the task with `cancelled: true`; if it had already finished, the task as it is
with `cancelled: false` (a race, not a failure).

## TaskToHuman Trigger

Starts the workflow when a task finishes (decided, expired or cancelled). It polls at the interval you choose (every
minute by default), with `GET /v1/tasks?finished_after=…`.

- **Task Type** (optional), **Outcomes** (`decision.action`; empty means all), **Include Automatic Outcomes** (tasks
  nobody decided: `decision.automatic` is true).
- **Include Payload** (off by default): the task's fields, sensitive ones too. Off, each item still has the decision
  with its comment and edited values.
- On activation it starts from now: tasks that finished earlier are not replayed. **Fetch Test Event** returns the
  most recently finished of your 20 newest tasks.
- Each poll handles up to 20 new tasks (one extra request each); more come on the next poll. It re-reads the last two
  minutes each time, so a task saved slightly late is not missed, and never emits the same finish twice. A task that
  support reopens and that finishes again is emitted again.
- A revoked key makes the poll fail visibly instead of returning nothing.
- All workflows using the same API key share its rate limit (600 requests a minute).

**Push instead of polling, without this node:** give the task type a callback URL pointing at an n8n **Webhook**
node, and confirm each decision with **Get** before acting (n8n's Webhook node cannot check the signature).

## When something is refused

The node shows TaskToHuman's own message and a hint: check the API key (401), billing limits (402), a feature your
plan lacks or an inactive workspace (403), a task of another workspace or of the other key mode (404), an Idempotency
Key reused with other values (409), nobody available to take the task (422), the rate limit with `Retry-After` (429:
turn on **Retry On Fail**), or that a retry is safe (5xx). With **Continue On Fail**, the item carries `error`, `code`
and `status`.

### Out of credits

When credits are enforced for your organization, every task holds, at creation, the most its messages could cost in
credits (texts and emails sent for it); what it does not use comes back when it ends. If the free credits cannot
cover that, TaskToHuman answers `402` with the code `not_enough_credits` and the task is **refused at creation**
(nothing is created). The node's message says how many credits the task needs, how many are free and how many open
tasks hold, with the `reason` (`no_credits`, `auto_buy_off`, `spending_cap`, `top_up_failed` or
`purchases_disabled`).

**Retry On Fail** cannot help until the organization has credits. An owner or billing member buys a credit pack or
turns on automatic buying in the TaskToHuman app (Plan > Credits); credits held by open tasks also come back as those
tasks end. Then run the workflow again: the same Idempotency Key still creates the task only once.

## Privacy

n8n stores execution data, including task payloads and decisions, in its execution log. Field values marked sensitive
in TaskToHuman end up there too when you send or read them. Use n8n's workflow settings ("Save successful production
executions" and others) to limit what is kept.

## Examples

Import from [`examples/`](examples):

- `create-and-wait.json`: ask a person to approve a refund, then branch on the decision.
- `task-finished-trigger.json`: run for every approved refund.

Act only when `decision.automatic` is false: a task type's default action can finish an unanswered task as approved.

## Development

```sh
npm ci --ignore-scripts
npm run lint        # n8n's community node rules (n8n-node lint)
npm run typecheck
npm test            # builds, then node:test against fakes only: no network, no TaskToHuman host
npm run build       # dist/
npm run dev         # a local n8n with the node loaded (n8n-node dev)
```

The tests share the signature vectors with the app and the SDKs (`../fixtures/callback-signature.json`).

## Licence and security

MIT (see [LICENSE.md](LICENSE.md)). The TaskToHuman name and logo are not licensed. Report vulnerabilities to
security@tasktohuman.com.
