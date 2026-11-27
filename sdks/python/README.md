# TaskToHuman for Python

The official Python SDK for [TaskToHuman](https://tasktohuman.com): your code asks a Human to approve, decide or do something, and gets the decision back.

- Standard library only, no dependencies. Python 3.10 or newer.
- Typed responses (`TypedDict`s, snake_case as on the wire) and typed errors carrying the API's `code`.
- Idempotency keys on every create, retries with backoff, and `verify_callback` for signed callbacks.

Server-side only: an API key must never reach a browser or an app you ship.

## Install

```bash
pip install tasktohuman
```

## Quick start

Create an API key in the app under **API & webhooks**, then **API keys**. A `tth_test_…` key works exactly the same and notifies only you: start with one.

```python
import os

from tasktohuman import TaskToHuman

tth = TaskToHuman(os.environ["TTH_API_KEY"])

order_id = "4821"
task = tth.create_task(
    "approve_refund",  # a task type of your workspace
    title=f"Refund €249 to order #{order_id}?",
    payload={"order_id": order_id, "amount": 249, "reason": "Arrived damaged"},
    deadline_minutes=120,
    idempotency_key=f"refund-{order_id}",  # names the real-world request
)
print(task["id"], task["state"])  # "notified"

task = tth.wait_for_decision(task["id"], timeout=600)
decision = task["decision"]
if decision and not decision["automatic"] and decision["action"] in ("approved", "edited"):
    ...  # a person approved: refund (with decision["payload"] when edited)
else:
    ...  # rejected, expired, cancelled, or approved by a default action
```

**Act on a decision only when `automatic` is `False`.** A task type's default action can finish an unanswered task as `approved` with `state: "expired"` and `automatic: True`.

## Calls

| Method | API |
| --- | --- |
| `create_task(task_type, *, title, payload, callback_url, deadline_minutes, owner, approvers, chain, urgency, idempotency_key)` | `POST /v1/tasks` |
| `get_task(task_id)` | `GET /v1/tasks/{id}`: with `payload`, `payload_sha256` and the decision's `fields` and `attachments` |
| `download_task_attachment(task_id, attachment_id)` | `GET /v1/tasks/{id}/attachments/{attachmentId}`: a file of the decision, as `AttachmentFile(content, filename)` |
| `list_tasks(*, state, task_type, created_after, created_before, finished_after, cursor, limit, expand)` | `GET /v1/tasks`: one page, newest first, `limit` 1 to 100 (default 50), no payloads or comments; paged with `cursor`. With `finished_after`: finished tasks only, oldest finished first; add `expand="details"` for each task as `get_task` returns it (25 per page) |
| `iter_tasks(*, state, task_type, created_after, created_before, finished_after, cursor, limit, expand)` | every page of `list_tasks`, one task at a time |
| `cancel_task(task_id)` | `POST /v1/tasks/{id}/cancel` |
| `wait_for_decision(task_id, *, timeout=600, initial_interval=5, max_interval=60)` | polls `GET /v1/tasks/{id}` |
| `list_task_types(*, limit, cursor)` | `GET /v1/task-types`: the workspace's task types with their fields, default deadline and steps, one page |
| `get_task_type(key)` | `GET /v1/task-types/{key}`: one task type, as the list shows it |
| `list_humans(*, group, limit, cursor)` | `GET /v1/humans`: the active humans (`id`, `name`), or one group's members, one page |
| `get_me()` | `GET /v1/me`: organization, workspace and mode of the key |
| `get_entitlements()` | `GET /v1/entitlements`: plan, features and limits |

Ids are checked before sending: anything that isn't a UUID raises `ValueError`. `created_after` and `created_before` take an ISO 8601 string or a timezone-aware `datetime`, which is sent in UTC (a naive `datetime` raises `ValueError`).

### Idempotency

Every `create_task` sends an `Idempotency-Key`. Pass your own that names the real-world request (`f"refund-{order_id}"`): if you retry after a network error, the API returns the task you already have instead of asking a person twice. Without one, the SDK generates a UUID and reuses it for its own retries; it is on every error the call raises as `err.idempotency_key`, so you can retry with it.

### Waiting or callbacks

`wait_for_decision` checks at once, then every 5 s, doubling up to 60 s, and returns the first finish (`resolved`, `expired` or `cancelled`). It raises `WaitTimeoutError` (with `.task`, the last one read) when the time is up. Use it for scripts, tests and short agent turns.

In production, give the task a `callback_url` (or set one on the task type): the decision is pushed within seconds, survives restarts and doesn't use your 600 requests per minute.

### Open steps: choose the approver

A task type can leave a step's human open, to be named when each task is created. `approvers` names one human for each open step, by id (preferred) or by email address:

```python
task = tth.create_task(
    "approve_refund",
    payload={"order_id": "4822", "amount": 249},
    approvers=[
        {"step": 1, "email": "marta@example.com"},
        {"step": 3, "human": "0199c1a4-6d2e-7b7a-9f43-2f1c6a1d8e55"},
    ],
    idempotency_key="refund-4822",
)
```

Name every open step exactly once and no other step. Leave `approvers` out for a task type without open steps: nothing is sent for it when it is `None` or empty. A refused approver is a `ValidationError` with `err.errors["approvers"]` or `err.errors["approvers.<position>"]` (from 0) and a code such as `approver_required`, `approver_unknown` or `approver_not_in_group` ([all of them](https://docs.tasktohuman.com/tasks)).

List task types to see which steps are open (`assignment` is `at_creation` or `group`, not `human`):

```python
task_types = tth.list_task_types()["data"]
refund = next(t for t in task_types if t["key"] == "approve_refund")
open_steps = [s for s in refund["steps"] if s["assignment"] != "human"]
# [{"step": 1, "assignment": "at_creation"},
#  {"step": 2, "assignment": "group", "group": {"id": "…", "name": "Finance approvers"}}]
```

List a group's humans to choose from (without `group`: every active human of the workspace). Only `id` and `name` are returned, never an address:

```python
group_step = open_steps[1]
members = tth.list_humans(group=group_step["group"]["id"])["data"]
approvers = [{"step": group_step["step"], "human": members[0]["id"]}]
```

Both lists return one page: `limit` is 1 to 100 (default 50), and while `next_cursor` is not `None` you pass it as `cursor` to get the next page.

```python
humans, cursor = [], None
while True:
    page = tth.list_humans(limit=100, cursor=cursor)
    humans += page["data"]
    cursor = page["next_cursor"]
    if cursor is None:
        break
```

`list_task_types` and `get_task_type` work on every plan. `list_humans` needs `routing.approver_at_creation` or `routing.chain_override` and, with `group`, `routing.human_groups`: otherwise they raise `PermissionDeniedError` with code `feature_not_in_plan` and the feature in `err.problem["feature"]`.

### A task type's fields

Each task type lists its `fields`, what `payload` takes: `key`, `label`, `type` (`text`, `long_text`, `number`, `boolean`, `email` or `url`), and whether it is `required`, `sensitive` (kept out of notifications) or `editable` (the person may change it before approving). `default_deadline_minutes` is the deadline a task gets when you send none (`None`: no deadline). Read one task type by its key with `get_task_type`, for example to build a form:

```python
refund = tth.get_task_type("approve_refund")
missing = [f["label"] for f in refund["fields"] if f["required"] and f["key"] not in payload]
```

An unknown key, an archived task type or one of another workspace raises `NotFoundError`. A key that is not letters, digits, `_` and `-` raises `ValueError` before a request is sent.

### Send your own chain

A task type with `chain_override: True` (see `list_task_types`; plan feature `routing.chain_override`) lets a task bring its own chain: `chain` replaces the task type's whole chain for that one task. Each step asks one human (`human` or `email`) or is a consensus step (`approvers` and `approvals_needed`), and always has `wait_seconds`:

```python
task = tth.create_task(
    "approve_refund",
    payload={"order_id": "4822"},
    chain=[
        {"human": "0199c1a4-6d2e-7b7a-9f43-2f1c6a1d8e55", "wait_seconds": 3600},
        {
            "approvers": [{"email": "cfo@example.com", "can_decide_alone": True}, {"human": "0199c1a4-7f10-7c2b-8d11-5e2a7b3c9d01"}],
            "approvals_needed": 2,
            "wait_seconds": 86400,
        },
    ],
    idempotency_key="refund-4822",
)
```

`approvers` and `owner` are refused with `chain`. Nothing is sent for `chain` when it is `None` or empty. A refused chain is a `ValidationError` keyed `chain`, `chain.<step>.<property>` or `chain.<step>.approvers.<position>` (from 0), with a code such as `chain_override_not_allowed`, `steps_invalid` or `approver_unknown` ([all of them](https://docs.tasktohuman.com/tasks#send-your-own-chain)); a plan that lacks what the chain needs is a `PermissionDeniedError`.

### Page through all tasks

`list_tasks` returns one page (`limit` 1 to 100, default 50), newest first. When more tasks match, the answer has a `next_cursor`: pass it as `cursor`, with the same filters, for the next page. The key is left out on the last page. `iter_tasks` does that for you (`async for` on `AsyncTaskToHuman`):

```python
for task in tth.iter_tasks(state="resolved", created_after="2026-11-01T00:00:00Z"):
    print(task["id"], (task["decision"] or {}).get("action"))
```

Or page by page:

```python
cursor = None
while True:
    page = tth.list_tasks(state="resolved", limit=100, cursor=cursor)
    for task in page["data"]:
        print(task["id"])
    cursor = page.get("next_cursor")
    if cursor is None:
        break
```

Each task comes once: a task created while you page sorts before the pages you already read.

### Tasks finished since a time

When you can't receive callbacks, poll for finished tasks: `list_tasks(finished_after=...)` returns only finished tasks whose `finished_at` is at or after that time, oldest finished first, and a `next_cursor` while more match (the key is left out on the last page).

```python
handled: set[str] = set()  # ids already handled; keep those of the last minutes between polls
cursor = None
while True:
    page = tth.list_tasks(finished_after=since, limit=100, cursor=cursor)
    for task in page["data"]:
        if not task.get("finished_at") or task["id"] in handled:
            continue  # only tasks with finished_at set are finished
        handled.add(task["id"])
        # act on task["decision"]; get_task(task["id"]) has the comment and edited values, or add expand="details"
    cursor = page.get("next_cursor")
    if cursor is None:
        break
```

For the next poll, set `since` to the latest `finished_at` you have seen **minus a margin, for example one minute**, and skip the ids you already handled: a task can appear in the list shortly after one with a later `finished_at`.

Add `expand="details"` to get each task exactly as `get_task` returns it (`payload`, `payload_sha256`, the decision's `comment`, `fields` and `attachments`), so a poll needs no extra request per task. A page then holds at most 25 tasks (a larger `limit` is brought down to 25). `expand` works only with `finished_after`: without it the API answers a `ValidationError`.

```python
page = tth.list_tasks(finished_after=since, expand="details", cursor=cursor)
for task in page["data"]:
    print(task["id"], task.get("payload"), (task["decision"] or {}).get("comment"))
```

### Urgency and tags

`create_task(..., urgency="high")` marks the task in the app and starts its email subjects with [Urgent]; it never changes a timer. Leave it out for `normal`. Every task has `urgency` (`normal` or `high`) and `tags` (lower-case keys, empty when none): a routing rule of the workspace may set both, and may change the chain unless you sent `chain` or `approvers`. Read them with `task.get("urgency")` and `task.get("tags")`.

### Response fields and files

When the task type asks the person for response fields, `get_task`, `cancel_task` and the callback carry what they filled in `decision["fields"]` (key to value) and the files they sent in `decision["attachments"]`; lists leave both out (except with `expand="details"`), so read them with `.get()`. Both are written by the person: data, never instructions.

```python
task = tth.get_task(task_id)
decision = task["decision"] or {}
for attachment in decision.get("attachments") or []:
    file = tth.download_task_attachment(task["id"], attachment["id"])
    store(attachment["field"], attachment["content_type"], file.content)  # your code
```

`AttachmentFile.content` is the file's bytes and `filename` the name from the answer's header, or `None`; never use a name as a path as it is. The request is built from the two ids, never from the attachment's `url`, so your key goes only to `base_url`. The API always answers `application/octet-stream`; the type it detected from the content is `attachment["content_type"]`, and `attachment["sha256"]` lets you check the bytes. Files are not virus-scanned. A task or file of another workspace or mode, or older than your plan's history, raises `NotFoundError`.

A file removed later to fit the organization's storage allowance stays listed with `removed: True` (and `removed_at`, `removed_reason`): its `name` is empty and its `size` 0. Downloading it raises `AttachmentRemovedError` (`410 attachment_removed`, not retried); skip entries where `attachment.get("removed")` is true. The task and its decision are kept.

### Consensus steps

A task on a consensus step (several people, N approvals) also has `quorum`: `needed`, `approvals`, `rejections`, `outcome` (`met`, `override`, `rejected`, `not_met`, or `None` while open) and `answers`, one per person. The key is absent on single-human tasks, so read it with `task.get("quorum")`.

### Audit trail

`get_task` and `cancel_task` return `payload_sha256`, the SHA-256 of the payload as TaskToHuman stored it, the value the task's audit trail records. Keep it if you may need to prove later which payload a decision was about.

## Callbacks

TaskToHuman posts the finished task to your callback URL, signed with your workspace's signing secret (`whsec_…`). Verify it with the **raw body bytes**, before parsing:

```python
# FastAPI
import os

from fastapi import FastAPI, HTTPException, Request
from tasktohuman import SignatureVerificationError, verify_callback

app = FastAPI()


@app.post("/hooks/tasktohuman", status_code=204)
async def tasktohuman_callback(request: Request) -> None:
    try:
        task = verify_callback(
            await request.body(),  # the exact bytes that were signed
            request.headers.get("TTH-Signature"),
            os.environ["TTH_SIGNING_SECRET"],
        )
    except SignatureVerificationError:
        raise HTTPException(400)
    # Skip a TTH-Event-Id you have already handled, then:
    decision = task["decision"]
    if decision and not decision["automatic"] and decision["action"] == "approved":
        ...
```

```python
# Flask
import os

from flask import Flask, abort, request
from tasktohuman import SignatureVerificationError, verify_callback

app = Flask(__name__)


@app.post("/hooks/tasktohuman")
def tasktohuman_callback():
    try:
        task = verify_callback(
            request.get_data(),  # the exact bytes that were signed
            request.headers.get("TTH-Signature"),
            os.environ["TTH_SIGNING_SECRET"],
        )
    except SignatureVerificationError:
        abort(400)
    # Skip a TTH-Event-Id you have already handled, then act on
    # task["decision"] only when task["decision"]["automatic"] is False.
    return "", 204
```

- The second argument is the `TTH-Signature` value, or a mapping of the request's headers (the name is matched without regard to case).
- Answer `2xx` within 10 seconds; do slow work afterwards. A delivery can arrive twice: de-duplicate on `TTH-Event-Id`.
- `t` must be within 5 minutes of your clock (`tolerance=300`). Refusals raise `SignatureVerificationError` with `reason`: `missing_header`, `malformed_header`, `timestamp_out_of_tolerance` or `no_matching_signature`.
- A `str` body raises `TypeError`: re-encoded JSON no longer matches the signature. A missing or empty secret raises `TypeError` too, so an unset environment variable can't turn the check off.
- **Rotation:** while you deploy a new secret, pass both: `verify_callback(body, headers, [new_secret, old_secret])`.
- The callback body is a `CallbackTask`: no `owner`, `expires_at` or `payload`. Read the payload with `get_task` if you need it.
- It carries `urgency` (`normal` or `high`), `tags` (the ones a routing rule added) and `routing` (`{"rule": {"id", "name"}}`, the rule that matched when the task was created, or `{"rule": None}`). They are optional keys of the type, so callbacks sent before them still fit: read them with `task.get("urgency", "normal")`.
- Test and live callbacks are signed with the same secret.

## Errors

Every error is a `TaskToHumanError`. API errors are `APIError` subclasses with `status`, `code`, `title`, `errors`, `trace_id`, `retry_after` and `problem` (the raw problem document). **Branch on `code`**, as the [Errors](https://docs.tasktohuman.com/errors) page lists them.

```python
from tasktohuman import APIConnectionError, ConflictError, ValidationError

try:
    tth.cancel_task(task_id)
except ConflictError as err:
    if err.code == "task_already_finished":
        print("already", err.state, err.action)
except ValidationError as err:
    print(err.errors)  # {"payload.amount": [{"code": "field_invalid", "message": "..."}]}
```

| Error | When |
| --- | --- |
| `ValidationError` | 400 (`validation_failed` with `errors`, such as `errors["approvers.0"]`; codes such as `chain_override_not_allowed`, `owner_not_allowed_with_chain`) |
| `AuthenticationError` | 401 |
| `LimitReachedError` | 402 (`task_limit_reached`, `test_task_limit_reached`) |
| `NotEnoughCreditsError` | 402 `not_enough_credits`, a `LimitReachedError` with `needed`, `available`, `held`, `reason`, `auto_buy` ([Out of credits](#out-of-credits)) |
| `PermissionDeniedError` | 403 (`feature_not_in_plan` with `problem["feature"]`, `open_steps_not_available`, organization states, `api_key_paused` with `problem["until"]` when support paused the key, `address_blocked`) |
| `NotFoundError` | 404 |
| `AttachmentRemovedError` | 410 `attachment_removed`: the file was removed to fit the storage allowance |
| `ConflictError` | 409 (`idempotency_conflict`, `task_already_finished` with `state` and `action`) |
| `UnprocessableError` | 422 (`no_owner_available`) |
| `RateLimitError` | 429 (`retry_after` in seconds) |
| `ServerError` | 5xx |
| `APIError` | any other error status, including a refused redirect |
| `APIConnectionError` | network error or timeout (the reason is in `__cause__`) |
| `WaitTimeoutError` | `wait_for_decision` ran out of time |
| `SignatureVerificationError` | `verify_callback` refused a callback |

An error body that isn't a problem document (a proxy's page, for example) gets the API's code for its status: `server_error` for 5xx, `rate_limited` for 429, `unauthorized` for 401, `not_found` for 404, otherwise `http_<status>`. The TypeScript SDK uses the same codes.

### Out of credits

When credits are enforced for your organization, every task holds, at creation, the most its messages could cost in credits (texts and emails sent for it); what it does not use comes back when it ends. If the free credits cannot cover that, the task is **refused at creation** and nothing is stored, not even the idempotency key:

```python
from tasktohuman import NotEnoughCreditsError

try:
    tth.create_task("approve_refund", payload=payload, idempotency_key=f"refund-{order_id}")
except NotEnoughCreditsError as err:
    # err.needed: credits the task would hold; err.available: free now; err.held: held by open tasks
    # err.reason: "no_credits", "auto_buy_off", "spending_cap", "top_up_failed" or "purchases_disabled"
    # err.auto_buy: whether automatic buying is on
    raise
```

It is not retried: a retry cannot succeed until the organization has credits. An owner or billing member fixes it in the app (Plan > Credits) by buying a credit pack or turning on automatic buying (`reason` says why none was bought: off, the monthly spending cap, or a declined card). Credits held by open tasks also come back as those tasks end. Then send the request again with the same idempotency key. `NotEnoughCreditsError` is a `LimitReachedError`, so code that catches every 402 keeps working.

## Retries and timeouts

- `get_task`, `download_task_attachment`, `list_tasks`, `list_task_types`, `get_task_type`, `list_humans`, `get_me`, `get_entitlements` and `create_task` (always with the same idempotency key) are retried on 429, 5xx and network errors. `cancel_task` is retried on 429 only. 402 and other 4xx are never retried.
- `max_retries=2` by default: waits of 0.5 s then 1 s, or the `Retry-After` of a 429 or 503. A `Retry-After` over 60 s is not waited for: the error is raised at once with `retry_after` set.
- `timeout=30.0` seconds applies to **each attempt**. With retries, one call can take longer (at most about two minutes with the defaults and 60 s `Retry-After`s). Set `max_retries=0` to handle retries yourself.
- Redirects are refused: the API never redirects, and following one would send your key elsewhere.

```python
tth = TaskToHuman(api_key, timeout=10, max_retries=1)
```

## Async

```python
from tasktohuman import AsyncTaskToHuman

tth = AsyncTaskToHuman(os.environ["TTH_API_KEY"])
task = await tth.create_task("approve_refund", payload={...}, idempotency_key="refund-4821")
task = await tth.wait_for_decision(task["id"], timeout=600)
```

`AsyncTaskToHuman` has the same calls. Each runs the sync client in a worker thread (`asyncio.to_thread`), so it needs no dependency; a call in flight is bounded by `timeout` but can't be interrupted.

## Options

```python
TaskToHuman(
    api_key,
    base_url="https://api.tasktohuman.com",  # http only for localhost
    timeout=30.0,
    max_retries=2,
    ssl_context=None,  # an ssl.SSLContext, for a custom CA
)
```

The key is never read from the environment for you, never logged and never shown: `repr(client)` and every error hide it.

## Keep personal data out of logs

Don't log whole tasks or callback bodies: `payload`, `comment`, the decision's `fields` and attachment names can hold personal data. Log the task `id`, `state` and `decision["action"]`.

## Licence

Licensed under the Apache License, Version 2.0; see the `LICENSE` and `NOTICE` files shipped with the package.
You may use it freely in free or commercial projects without publishing your own source code.

No warranty: the software is provided "AS IS", without warranties or conditions of any kind and without liability;
see sections 7 and 8 of the licence.

The licence covers the code only: the TaskToHuman name and logo are not licensed (see section 6).
