# TaskToHuman for Make

A custom app for [Make](https://www.make.com): ask a person to approve, edit or do a task from a scenario, and start
another scenario when the task is finished. Status: **1.0.0, not available in Make yet**. Licence: MIT ([LICENSE](LICENSE)).

The app is kept here as files (`app/`, layout in [app/README.md](app/README.md)); `scripts/upload.mjs` sends them to
Make. Nothing here runs on TaskToHuman's servers, and the app calls only the public API, `https://api.tasktohuman.com/v1`.

## What it offers

| Module | Type | API |
| --- | --- | --- |
| Create a Task | action | `POST /v1/tasks`: task type (a list), the type's fields, title, deadline, urgent, approvers for open steps, callback URL, Idempotency Key |
| Get a Task | action | `GET /v1/tasks/{id}` |
| Cancel a Task | action | `POST /v1/tasks/{id}/cancel`; a task that is already finished stops the run with a DataError (add an Ignore or Resume error handler if that is expected) |
| Search Tasks | search | `GET /v1/tasks`: state, task type, created after/before, Limit; follows `next_cursor` |
| Watch Finished Tasks | polling trigger | `GET /v1/tasks?finished_after=…&expand=details`: task type, Limit, "Choose where to start" (filter outcomes with a Make filter after it) |
| Watch Finished Tasks (Instant) | instant trigger | a dedicated webhook you paste as the task's callback URL; each task is read again with `GET /v1/tasks/{id}` |
| Make an API Call | universal | any path under `/v1/`, with the connection's key |

The connection takes one API key (`tth_live_…` or `tth_test_…`) and is checked with `GET /v1/me`; its label shows the
workspace and **Test** or **Live**, for example `Shop · Test`. Create one key just for Make, so you can revoke it alone.

### Out of credits

When credits are enforced for your organization, every task holds, at creation, the most its messages could cost in
credits (texts and emails sent for it); what it does not use comes back when it ends. If the free credits cannot
cover that, TaskToHuman answers `402 not_enough_credits` and the task is **refused at creation** (nothing is created).
**Create a Task** then stops with an InvalidConfigurationError (as for every 402: Make turns the scenario off, since
running it again cannot succeed) whose message says how many credits the task needs, how many are free and how many
open tasks hold, with the reason (`no_credits`, `auto_buy_off`, `spending_cap`, `top_up_failed` or
`purchases_disabled`).

An owner or billing member buys a credit pack or turns on automatic buying in TaskToHuman (Plan > Credits); credits
held by open tasks also come back as those tasks end. Then turn the scenario on again. The other 402 refusals (a
monthly task limit, a cap, the test task allowance) keep the API's own message.

### Waiting for a decision: two scenarios

A Make run cannot wait for a person (Sleep stops at 300 seconds), and a module cannot read a webhook address. So:

1. **Scenario B** starts with **Watch Finished Tasks (Instant)**. Make shows its address; turn scenario B on.
2. **Scenario A** ends with **Create a Task**, with **Callback URL** = scenario B's address (pasted once; it stays the
   same). Or paste the address into the task type's callback URL in TaskToHuman: every task of the type then reports
   there.

Put the id you need later (an order number) in one of the task type's fields: scenario B gets it back in `payload`.
Act only when `decision.automatic` is false: when it is true, nobody decided (the deadline passed or the task type's
default action applied).

**Why the instant trigger reads the task again.** Make cannot check TaskToHuman's callback signature: the webhook
body arrives already parsed, without the raw bytes the signature covers. So the webhook keeps only the task id from
the posted body, and the module fetches that task through the API with your connection and outputs the API's answer.
The module outputs only a finished task whose id is the posted one. A made-up id or another workspace's id gets a 404
and nothing enters the scenario; the id of a task that is not finished yet stops with a DataError and nothing enters
the scenario. So a forged post cannot invent a task or change its data: it can only make an already finished task of
your workspace arrive again.

Duplicates are therefore possible, from such a post or from TaskToHuman's retries (it retries a callback for 24 hours
until it gets a 2xx). For a scenario that must run once per task, check the task id in a Make Data store first.

Make turns off a webhook that no scenario has used for 5 days and then answers 410: TaskToHuman keeps retrying and
the task shows a failing callback. Keep scenario B on while tasks may still report to it.

### Polling instead

**Watch Finished Tasks** checks on scenario A's or B's schedule, oldest finished first. It starts each check 2 minutes
before the last finished time it has seen and skips the tasks it already returned. A run returns at most Limit tasks
(default 10, at most 100); the rest come in the next runs. Make stops a trigger at 3,200 records per run, so a backlog
larger than that (for example "All" on a busy workspace) never reaches the newest tasks: choose "From now on" or a
date. The trigger returns every finished task (of the chosen task type): to keep only some outcomes, add a Make filter
right after it on `decision.action`, and on `decision.automatic` = false to skip tasks nobody decided. Filtering inside
the trigger would hold back its last finished time and make every run re-read the tasks it skipped.

## Developing

```sh
cd make
npm ci --ignore-scripts
npm test               # node:test, files only: no Make account, no network
node scripts/upload.mjs --dry-run   # what an upload would send, without any request to Make
```

To try the app in your own Make account:

1. Create a Make API token in the zone you use (your profile → **API** → **Add token**), with the scopes
   `sdk-apps:read` and `sdk-apps:write`. A token works in one zone only.
2. `MAKE_ZONE` is the host in your browser's address bar when you are signed in to Make, for example `eu2.make.com`
   or `us2.make.com`.
3. See what an upload would do (reads only): `MAKE_API_KEY=<token> MAKE_ZONE=<zone> node scripts/upload.mjs --check`
4. Upload: `MAKE_API_KEY=<token> MAKE_ZONE=<zone> node scripts/upload.mjs`

The script lists your custom apps, updates the TaskToHuman app it finds there or creates a private one, never deletes
and never publishes anything; run it again after a change. Make may give a new app another name than `tasktohuman`
(for example with a suffix): the script uses the name Make returns and remembers it, per zone, in `make/.makeapp`
(not tracked by git). If you have several candidate apps, it lists them and stops: choose one with
`MAKE_APP_NAME=<name>`. If Make refuses a call, the script prints Make's own message and code and the usual causes.

The tests check, without Make:

- every file parses and passes Make's own editor schemas (`test/editor-schemas/`, vendored, MIT);
- every request maps to an operation of `../openapi/public-v1.json`, with query parameters, headers and body
  properties that exist there (a renamed API field fails CI); `GET /v1/task-types/{key}` and `expand=details` are
  accepted ahead of the OpenAPI document (`PENDING` in `test/contract.test.mjs`);
- Make's review rules: limits and pagination on searches, triggers and listing RPCs, a universal module, samples and
  interfaces everywhere, error handling in the base and the connection;
- the key is sanitized in Make's logs (`log.sanitize` in the base and the connection) and appears nowhere else; no
  absolute URL outside the base and the connection check; no key-like string in the files;
- every sample equals a fixture body (`../fixtures/api/`), every interface names only task properties;
- the upload script against a fake of Make's API.

### What only Make can prove

IML (the `{{…}}` expressions) runs only inside Make, so the tests cannot run it. The expressions are kept small and
every one beyond a plain path is listed here, and acceptance scenarios run in Make exercise each of them. Things
Make's documentation does not settle, to confirm in those scenarios:

- the task type's fields: `taskTypeFields` returns one `payload` collection through `response.wrapper`, nested under
  Task Type (`options.nested`);
- empty inputs are left out of the request (Make's default since its platform version 2), including an empty
  Approvers list and an empty Idempotency Key header;
- the polling trigger's `data.lastDate` and the "Choose where to start" options;
- a dedicated, not attached webhook can carry the connection for the instant trigger's request (if Make refuses it,
  use **Get a Task** after the trigger instead);
- the error message lists the fields of a `validation_failed` answer;
- the 402 message of an out-of-credits refusal shows the counts as numbers in the text.

IML expressions to check in Make:

- `base.imljson` (the same message in each status entry and in Cancel a Task's error):
  `ifempty(body.title, 'TaskToHuman answered with an error.')`, `ifempty(body.detail, '')`, `ifempty(body.code, '')`,
  `if(body.errors, ' Fields: ' + join(keys(body.errors), ', '), '')`; the 402 entry puts the title in a branch for
  `not_enough_credits` (confirm that the numbers join the text, for example "It needs 468 credits, 120 are free"):
  `if(body.code === 'not_enough_credits', 'Your organization is out of credits, so the task was not created. It needs ' + body.needed + ' credits, ' + body.available + ' are free and ' + body.held + ' are held by open tasks (reason: ' + body.reason + '). Buy a credit pack or turn on automatic buying in TaskToHuman (Plan > Credits), then turn the scenario on again (Make turned it off).', ifempty(body.title, 'TaskToHuman answered with an error.'))`
- `connections/tasktohuman/api.json`: `statusCode === 200`, `if(body.key.mode === 'test', 'Test', 'Live')`,
  `ifempty(body.title, 'TaskToHuman refused the API key.')`
- `rpcs/taskTypeFields/api.json`: `encodeURL(parameters.task_type)`, `if(item.sensitive, ' (sensitive)', '')`,
  `switch(item.type, 'number', 'number', 'boolean', 'boolean', 'email', 'email', 'url', 'url', 'text')`,
  `item.type === 'long_text'`,
  `if(item.sensitive, 'Shown only on the task page, masked until revealed. Make keeps what you map here in its run history.', '')`
- `modules/createTask/api.json`: `if(parameters.urgent, 'high', undefined)`
- `modules/getTask/api.json`, `modules/cancelTask/api.json`: `encodeURL(parameters.id)`;
  cancel's 409 message: `ifempty(body.state, 'finished')`
- `modules/watchFinishedTasks/api.json`: `if(data.lastDate, addMinutes(data.lastDate, -2), '2000-01-01T00:00:00Z')`,
  `parseDate(item.finished_at)`
- `modules/watchFinishedTasks/epoch.json`: `addDays(now, -30)`, `formatDate(item.finished_at, 'YYYY-MM-DD HH:mm')`,
  `parseDate(item.finished_at)`
- `modules/watchFinishedTasksInstant/api.json`: `encodeURL(payload.id)`, and its `response.valid` (an object with
  `condition`, `message` and `type`, as Make's editor schema allows): `body.id === payload.id && !!body.finished_at`;
  confirm in an instant-trigger scenario that a valid task passes and, by posting `{"id":"<an open task's id>"}` to the address,
  that an unfinished task stops with the DataError
- `modules/makeApiCall/api.json`: `toCollection(parameters.headers, 'key', 'value')`,
  `toCollection(parameters.qs, 'key', 'value')`

Make's TypeScript SDK (`@makehq/sdk`) and CLI (`@makehq/cli`) were checked for an offline validator: neither has one
(both only call Make's API with a token). The upload script makes the same API calls as the SDK without depending on
it; the editor schemas are the offline check.

## Data and privacy

Make is a service you choose and contract with. When you connect TaskToHuman to it, it receives your tasks, including
fields marked sensitive, the decisions and the names of the people who decided, and keeps them in its run history
under its own terms. It is not a TaskToHuman sub-processor. Map only the fields you need, and use Make's
data-retention settings.
