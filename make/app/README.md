# make/app: the component files

One folder per Make component, one file per section, in the layout of Make's own skill
(`integromat/make-apps-skill`). Make calls this layout a convention, not a format it reads: `../scripts/upload.mjs`
sends each file to its section through Make's API. `metadata.json` files are ours: they hold what the upload needs to
create the component (label, type, the connection or webhook it uses) and are never uploaded as a section.

| File | Make component and section |
| --- | --- |
| `metadata.json` | the app: name, label, version (Make's major version), `versionFull` (ours), theme colour, language, audience |
| `base.imljson` | Base: base URL, headers (the API key), error handling, log sanitizing; inherited by modules and RPCs |
| `connections/tasktohuman/api.json` | the connection's Communication (the key check; does not inherit Base) |
| `connections/tasktohuman/parameters.json` | the connection's Parameters (the API key, a password field) |
| `webhooks/taskFinished/api.json` | the webhook's Communication (what Make does with a posted request) |
| `webhooks/taskFinished/parameters.json` | the webhook's Parameters (here only the setup instructions banner) |
| `rpcs/<name>/api.json`, `parameters.json` | an RPC's Communication and Parameters |
| `modules/<name>/api.json` | a module's Communication |
| `modules/<name>/parameters.json` | Static parameters (a polling trigger's settings; empty elsewhere) |
| `modules/<name>/expect.json` | Mappable parameters (an action's or search's inputs) |
| `modules/<name>/interface.json` | Interface (the fields of one output bundle) |
| `modules/<name>/samples.json` | Samples (one output bundle: a fixture body from `fixtures/api/`) |
| `modules/watchFinishedTasks/epoch.json` | Epoch ("Choose where to start") of the polling trigger |

Module types (`typeId` in `metadata.json`, as Make's API names them): 1 polling trigger, 4 action, 9 search,
10 instant trigger, 12 universal module.

No custom IML (JavaScript) functions: they need a request to Make's helpdesk and nothing here needs them.

Change a file, run `npm test` in `make/`, then upload again (`../README.md`, "Developing").
