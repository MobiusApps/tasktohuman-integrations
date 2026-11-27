# Changelog

## 1.0.0 (unreleased)

- Authentication: API key (`tth_live_…` or `tth_test_…`), tested with `GET /v1/me`; the connection label names the
  workspace and Test or Live.
- Trigger **Task Finished** (polling): task type, outcome and automatic-outcome filters; de-duplicated on task ID and
  finish time.
- Actions **Create Task**, **Create Task and Wait for Decision** (pauses the Zap up to 30 days) and **Cancel Task**.
- Search **Find Task** by ID.
- A refusal for credits (402 `not_enough_credits`) stops the run with what the task needs, what is free and held,
  why no credits were bought and how the organization gets credits; other 402 codes keep their messages.
