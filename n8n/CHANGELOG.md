# Changelog

## 0.1.0 (unreleased)

- Credential "TaskToHuman API": API key, base URL, signing secret; tested with `GET /v1/me`.
- TaskToHuman node, resource Task: Create, Create and Wait for Decision, Get, Get Many (with paging), Cancel.
- TaskToHuman Trigger: polls for finished tasks, with task type, outcome and automatic-outcome filters.
- A refusal for credits (402 `not_enough_credits`) explains what the task needs, what is free and held, and how the
  organization gets credits; other 402 codes keep the allowance hint.
