# Changelog

The version of the Make app (`app/metadata.json` `versionFull`, `package.json`, the `User-Agent` it sends). Make keeps
one live definition per app, so changes are additive: new optional inputs, new modules. A breaking change becomes a
new module and the old one is hidden.

## 1.0.0 (unreleased)

- Connection with a TaskToHuman API key; its label shows the workspace and Test or Live.
- Modules: Create a Task (the task type's fields, approvers for open steps, deadline, urgency, callback URL,
  Idempotency Key), Get a Task, Cancel a Task, Search Tasks, Watch Finished Tasks (polling),
  Watch Finished Tasks (Instant), Make an API Call.
- A refusal for credits (402 `not_enough_credits`) says what the task needs, what is free and held, the reason and
  how the organization gets credits; other 402 codes keep the API's message.
