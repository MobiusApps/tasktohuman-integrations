# TaskToHuman for Zapier

The [TaskToHuman](https://tasktohuman.com) app for Zapier, built with Zapier's CLI (`zapier-platform`, TypeScript).
TaskToHuman sends a task to a person (by email, with a secure link) and gives your Zap their decision: approved,
rejected, edited, done or handed back, or what happened when nobody answered in time.

Status: 1.0.0, not available in Zapier yet. Not published to npm (`"private": true`).

| Operation | Key | What it does |
| --- | --- | --- |
| Trigger **Task Finished** | `task_finished` | Polls `GET /v1/tasks?finished_after=…&expand=details` (the last 30 minutes, newest first). Filters: Task Type, Outcomes, Include Automatic Outcomes. |
| Action **Create Task** | `create_task` | `POST /v1/tasks` with the chosen task type's fields, the people of its open steps, Deadline, Urgent, Callback URL and Idempotency Key. Returns at once. |
| Action **Create Task and Wait for Decision** | `create_task_wait` | Creates the task with a Zapier callback URL as its `callback_url` and pauses the Zap until the person decides (at most 30 days). When the callback arrives, the app reads the task again with `GET /v1/tasks/{id}` and never trusts the posted body. |
| Action **Cancel Task** | `cancel_task` | `POST /v1/tasks/{id}/cancel`. A task that already finished is returned as it is with `cancelled: false`. |
| Search **Find Task** | `find_task` | `GET /v1/tasks/{id}`; "nothing found" for a task of another workspace or of the other mode. |

## Connecting

The connection asks for one **API Key**: a `tth_live_…` or `tth_test_…` key from TaskToHuman → Developers → API keys.
Create one key just for Zapier so you can revoke it alone. Start with a test key: its tasks notify only you and end
quickly. The connection's label shows the workspace and whether the key is a test or a live key, for example
`Shop · Test`; every task the app returns carries `test: true` or `false`.

The key is kept by Zapier in a password field (hidden on entry, censored in Zapier's logs). This app sends it only as
the `Authorization` header to `https://api.tasktohuman.com`, never in a URL, a log line or an error message.

## Acting on a decision

- **One Zap:** **Create Task and Wait for Decision**. Zapier resumes a waiting step for at most 30 days, so the step
  refuses (before creating anything) a Deadline above 43200 minutes, or an empty Deadline when the task type's own
  deadline is missing or longer than 30 days. Its Idempotency Key only stops a second task being created: a repeat
  run with the same key stops with an error instead of waiting (each run has its own callback URL); use **Find Task**
  or the two-Zap pattern for that task.
- **Two Zaps** (decisions that may take longer, or several Zaps reacting to one task type): Zap A creates the task with
  **Create Task**, with the business id in one of the task type's fields (for example `order_id`) and the same id as
  Idempotency Key. Zap B starts with **Task Finished** (same task type; Outcomes = Approved, Edited), then a Filter
  "decision automatic is false", then the action.

Act only when `decision automatic` is false: when it is true, nobody decided (the deadline passed or the task type's
default action applied).

**Limits of Task Finished:** Zapier polls every 1 to 15 minutes depending on the Zapier plan. Each poll reads at most 8
pages of 25 finished tasks (about 200 per 30 minutes per Zap); above that, point a task type's callback URL at
**Webhooks by Zapier → Catch Hook** and confirm each task with **Find Task** before anything that matters. Tasks that
finished before the Zap was turned on are not replayed.

## Out of credits

When credits are enforced for your organization, every task holds, at creation, the most its messages could cost in
credits (texts and emails sent for it); what it does not use comes back when it ends. If the free credits cannot
cover that, TaskToHuman answers `402 not_enough_credits` and the task is **refused at creation** (nothing is created).
The step stops the Zap run with a message instead of retrying, since a retry cannot succeed: it says how many credits
the task needs, how many are free and how many open tasks hold, and why none were bought (automatic buying off, the
monthly spending cap, a failed card payment, or purchases turned off for now).

An owner or billing member buys a credit pack or turns on automatic buying in TaskToHuman (Plan > Credits); credits
held by open tasks also come back as those tasks end. Then replay the run: the same Idempotency Key still creates the
task only once. The other 402 refusals (a monthly task limit, a cap, the test task allowance) also stop the run, as
before.

## Developing

Node.js 22 (Zapier runs apps on Node.js 22). The tests run against a local fake API only, never a real TaskToHuman
host or Zapier.

```sh
cd zapier
npm ci --ignore-scripts
npm run lint         # ESLint with typescript-eslint
npm run typecheck
npm test             # builds dist/, then node:test with Zapier's createAppTester against a fake API on 127.0.0.1
npm run validate     # zapier-platform validate --without-style: Zapier's schema check, local, no login, no network
```

`TTH_BASE_URL` (for example `http://127.0.0.1:5080`) points the app at another API for tests and local
`zapier-platform invoke` runs; http is accepted only for `127.0.0.1`, `localhost` and `*.localhost`. Never set it on
the published app with `env:set`.

`zapier-platform-core` 19.3.0 is the only runtime dependency (Zapier bundles `node_modules`); the CLI is a dev
dependency, pinned exactly. Never install versions 18.0.2, 18.0.3 or 18.0.4 of any `zapier-platform-*` package (a
2025 supply-chain incident); a test checks the lockfile.

Versioning: `version` in `package.json` is the version pushed to Zapier. A breaking change (a removed field or a
changed key) needs a new major version; existing Zaps then move with `npx zapier-platform migrate` (same major only).

### What the tests cannot prove

These are checked only by an acceptance run in Zapier itself, not by the tests:

- that Zapier fills the dynamic dropdowns from the `{results, paging_token}` answer of `choices.perform`;
- that field `meta` reaches `bundle.meta.inputFields` at run time (the app uses it to send mapped numbers and booleans
  with the right type; without it, values are sent as Zapier passes them and the API names a field it refuses);
- what Zapier does with an error thrown in `performResume` (the app throws when the task is not finished yet), and
  what it answers to a second callback on a step that already resumed;
- whether Zapier's check T001 needs a live run of Create Task and Wait for Decision.

## Licence

MIT ([LICENSE](LICENSE)). The TaskToHuman name and logo are not licensed.
