# Changelog

## 0.1.0 (2026-11-27)

- First release, for API `/v1`: `create_task`, `get_task`, `list_tasks`, `cancel_task`, `wait_for_decision`, `get_me`, `get_entitlements`, and the same calls on `AsyncTaskToHuman`.
- `verify_callback` for signed callbacks, with secret rotation.
- Typed responses, including the consensus `quorum` object and `payload_sha256`.
- `finished_at` on every task; `list_tasks(finished_after=..., cursor=...)` for tasks finished since a time, with `next_cursor` on the list.
- `list_tasks` pages its default order with `cursor` / `next_cursor` too; `iter_tasks` iterates over every page.
- `urgency` on `create_task` and on every task, with the `tags` a routing rule added.
- The decision's response `fields` and `attachments`; `download_task_attachment` returns a file's bytes and name.
- `urgency`, `tags` and the matched routing rule (`routing`) on `CallbackTask`.
- `fields` and `default_deadline_minutes` on every `TaskType`; `get_task_type(key)` reads one task type.
- `list_tasks(finished_after=..., expand="details")` returns each task as `get_task` does (at most 25 per page).
- Typed errors carrying the API's `code`; retries with backoff and `Retry-After`; idempotency keys on every create.
- `NotEnoughCreditsError` (a `LimitReachedError`) for 402 `not_enough_credits`, with `needed`, `available`, `held`, `reason` and `auto_buy`; never retried. `Problem` gains the same fields.
- Standard library only, Python 3.10 or newer.
