# Changelog

## 0.1.0 (2026-11-27)

- `TaskToHuman` client: `createTask`, `getTask`, `listTasks`, `cancelTask`, `getMe`, `getEntitlements`,
  `waitForDecision`.
- `verifyCallback` for signed callbacks, with secret rotation.
- Typed errors by API `code`; retries with backoff and `Retry-After`; idempotency keys on every create.
- Consensus `quorum` and `payload_sha256` on task views.
- `finished_at` on every task; `listTasks({ finished_after, cursor })` for tasks finished since a time, with
  `next_cursor` on the list.
- `listTasks` pages its default order with `cursor` / `next_cursor` too; `listAllTasks` iterates over every page.
- `urgency` on `createTask` and on every task, with the `tags` a routing rule added.
- The decision's response `fields` and `attachments`; `downloadTaskAttachment` returns a file's bytes and name.
- `urgency`, `tags` and the matched routing rule (`routing`) on `CallbackTask`.
- `fields` and `default_deadline_minutes` on every `TaskType`; `getTaskType(key)` reads one task type.
- `listTasks({ finished_after, expand: "details" })` returns each task as `getTask` does (at most 25 per page).
- `NotEnoughCreditsError` (a `LimitReachedError`) for 402 `not_enough_credits`, with `needed`, `available`,
  `held`, `reason` and `autoBuy`; never retried. `Problem` gains the same fields.
