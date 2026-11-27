# tasktohuman-integrations

Official integrations for [TaskToHuman](https://tasktohuman.com).

## SDKs

| Package | Folder | Status |
| --- | --- | --- |
| `@tasktohuman/sdk` (TypeScript, npm) | [`sdks/typescript`](sdks/typescript) | [0.1.0 on npm](https://www.npmjs.com/package/@tasktohuman/sdk) |
| `tasktohuman` (Python, PyPI) | [`sdks/python`](sdks/python) | [0.1.0 on PyPI](https://pypi.org/project/tasktohuman/) |

Both SDKs cover the public API `/v1` (create, get, list and cancel tasks, naming the approvers of open steps, listing
and reading task types with their fields, listing humans, polling finished tasks with their details, downloading the files of a decision, `me`, `entitlements`), waiting for a decision, and verifying signed callbacks. Neither has runtime dependencies: the TypeScript SDK uses the platform's
`fetch` and Web Crypto (Node.js 22 or later), the Python SDK uses the standard library (Python 3.10 or later).
A `tth_test_…` key works exactly like a `tth_live_…` key and notifies only you: start with one.

### TypeScript quick start

```sh
npm install @tasktohuman/sdk
```

```ts
import { TaskToHuman } from "@tasktohuman/sdk";

const tth = new TaskToHuman({ apiKey: process.env.TTH_API_KEY! }); // tth_live_… or tth_test_…

const task = await tth.createTask(
  {
    task_type: "approve_refund",
    title: "Refund €249 to order #4821?",
    payload: { order_id: "4821", amount: 249, reason: "Arrived damaged" },
    deadline_minutes: 120,
  },
  // Identifies the real-world request: sending it again returns the same task instead of asking twice.
  { idempotencyKey: "refund-4821" },
);

const done = await tth.waitForDecision(task.id, { timeoutMs: 15 * 60_000 });
if (done.decision && !done.decision.automatic && ["approved", "edited"].includes(done.decision.action)) {
  // A person approved. For "edited", the changed values are in done.decision.payload.
}
```

More, including `verifyCallback`: [sdks/typescript/README.md](sdks/typescript/README.md).

### Python quick start

```sh
pip install tasktohuman
```

```python
import os

from tasktohuman import TaskToHuman

tth = TaskToHuman(os.environ["TTH_API_KEY"])  # tth_live_… or tth_test_…

order_id = "4821"
task = tth.create_task(
    "approve_refund",  # a task type of your workspace
    title=f"Refund €249 to order #{order_id}?",
    payload={"order_id": order_id, "amount": 249, "reason": "Arrived damaged"},
    deadline_minutes=120,
    idempotency_key=f"refund-{order_id}",  # names the real-world request
)

task = tth.wait_for_decision(task["id"], timeout=600)
decision = task["decision"]
if decision and not decision["automatic"] and decision["action"] in ("approved", "edited"):
    ...  # a person approved: refund (with decision["payload"] when edited)
```

More, including `verify_callback` and `AsyncTaskToHuman`: [sdks/python/README.md](sdks/python/README.md).

In both SDKs, act on a decision only when `automatic` is false: a task type's default action can finish an
unanswered task as `approved` with state `expired`. In production, give the task a `callback_url` and verify the
signed callback instead of polling.

## n8n community node

| Package | Folder | Status |
| --- | --- | --- |
| `n8n-nodes-tasktohuman` (npm) | [`n8n`](n8n) | [0.1.0 on npm](https://www.npmjs.com/package/n8n-nodes-tasktohuman) |

A TaskToHuman node for n8n (create a task, create one and wait for the decision, get, list and cancel tasks) and a
trigger that starts a workflow when a task finishes. No runtime dependencies (n8n's rule for community nodes); it
calls `/v1` through n8n's own HTTP helpers. Install, credentials and every operation: [n8n/README.md](n8n/README.md).

## Zapier app

A Zapier CLI app in [`zapier`](zapier) (1.0.0, not available in Zapier yet; MIT): trigger Task Finished; actions
Create Task, Create Task and Wait for Decision, Cancel Task; search Find Task. Connecting, operations and development:
[zapier/README.md](zapier/README.md).

## Make app

A Make custom app in [`make`](make) (1.0.0, not available in Make yet; MIT), kept as component files with an upload
script: Create a Task, Get a Task, Cancel a Task, Search Tasks, Watch Finished Tasks (polling and instant), Make an API
Call. Modules, tests and what only Make can prove: [make/README.md](make/README.md).

## The contract they are tested against

- `openapi/public-v1.json`: the OpenAPI description of the public API `/v1`, from which the
  [API reference](https://docs.tasktohuman.com) is built. Each SDK's drift test checks its types against it.
- `fixtures/api/*.json`: the documentation's request/response examples, checked against the real API; the packages'
  unit tests replay them on a local fake server.
- `fixtures/callback-signature.json`: the callback signature test vectors, the same ones TaskToHuman's own signer is
  tested with.

The maintainers refresh these files when the API changes. The tests never call a real TaskToHuman host.

## Developing

### TypeScript (`sdks/typescript`)

```sh
cd sdks/typescript
npm ci --ignore-scripts
npm run check:edge   # no node: imports in src/, no runtime dependencies
npm run typecheck
npm test             # node:test, against a local fake API only
npm run build        # dist/
```

### n8n node (`n8n`)

```sh
cd n8n
npm ci --ignore-scripts
npm run lint         # n8n's community node rules (strict mode)
npm run typecheck
npm test             # builds, then node:test against fakes only
npm run build        # dist/
```

### Zapier app (`zapier`)

```sh
cd zapier
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test             # builds, then node:test with Zapier's app tester against a local fake API only
npm run validate     # Zapier's local schema check: no login, no network
```

### Make app (`make`)

```sh
cd make
npm ci --ignore-scripts
npm test                            # node:test on the files: Make's editor schemas, the OpenAPI contract, no network
node scripts/upload.mjs --dry-run   # what an upload to Make would send, without sending
```

### Python (`sdks/python`)

```sh
cd sdks/python
python3 -m venv .venv && .venv/bin/pip install build==1.6.1 mypy==2.4.1
.venv/bin/python -m mypy                                             # --strict, configured in pyproject.toml
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -v     # against a local fake API only
.venv/bin/python -m build --outdir dist .                            # sdist and wheel in dist/
```

## CI

`.github/workflows/sdk-ci.yml` (pushes to `main`, pull requests from this repository's own branches, manual dispatch)
has one job per SDK, one for the n8n node, one for the Zapier app and one for the Make app, and runs the steps above;
the Python job runs on Python 3.10 and 3.14 and repeats the tests against the built wheel. A check
(`.github/scripts/check-runners.py`) keeps every job on the project's self-hosted runner
(`runs-on: [self-hosted, linux, x64, tasktohuman]`), except the two jobs that upload to npm, which run on a
GitHub-hosted runner because npm accepts provenance only from one; `actionlint` reads that label from `.github/actionlint.yaml`.

Pull requests from forks skip the package jobs (the `if:` on each); a maintainer reviews the change before its checks
run. Changes to `.github/` from a fork are not accepted.

### CI and publishing

The SDKs (`@tasktohuman/sdk` on npm, `tasktohuman` on PyPI) and the n8n node (`n8n-nodes-tasktohuman` on npm) are
published by `sdk-ci`, with the very files its jobs built and tested, and trusted publishing (OIDC, no tokens): the npm
packages carry provenance, the PyPI files attestations.

A release:

1. In one commit, raise the package's version (`sdks/typescript/package.json` together with
   `sdks/typescript/src/version.ts`, `sdks/python/src/tasktohuman/_version.py`, or `n8n/package.json`) and give its
   `CHANGELOG.md` a top entry `## <version> (<YYYY-MM-DD>)`.
2. Push to `main`. The package jobs run; the `plan` job asks npm and PyPI whether each version is already there and
   writes a table to the run's summary (`@tasktohuman/sdk | 0.1.1 | not on npm: publish`,
   `tasktohuman | 0.1.0 | already on PyPI`).
3. When every package job has passed, the publish jobs upload only the packages the plan marked. A push that does not
   change a published version publishes nothing.

The plan fails, and nothing is published, when a registry gives no clean answer (after a few tries), when a version
is lower than the registry's latest, when a package to publish has no dated changelog entry for its version, or when
`src/version.ts` and `package.json` disagree. Pre-releases (`0.2.0-rc.1`, `0.2.0rc1`) are never published
automatically: a maintainer publishes them deliberately. Pull requests, other branches and forks never publish.

Each publish job uses a protected environment (`npm` or `pypi`). With a required reviewer there, every publish waits
for a maintainer's approval in GitHub (approve each publish); without one, publishing is fully automatic. The
registries add their own protection: a version can be published only once.

A run by hand on `main` chooses with its `publish` input: `no` (default: test only), `auto` (as a push does), or
`npm`, `pypi`, `both`, `n8n` (exactly those packages, without asking the registries; the changelog check still
applies).

### Releases on GitHub

When `sdk-ci` runs on `main` and every package job passes, its last job creates a GitHub Release of that commit:

- **Name:** `YYYYMMDD-xx`, the UTC date and a counter from `00` for the first release of that day (`20261120-00`,
  `20261120-01`); the tag has the same name, on the released commit. One commit gets one release: running the
  workflow again on the same commit creates no second one.
- **Notes:** the commit, the CI run, the version of each SDK (`sdks/typescript/package.json`,
  `sdks/python/src/tasktohuman/_version.py`), of the n8n node (`n8n/package.json`), of the Zapier app
  (`zapier/package.json`, not attached) and of the Make app (`make/package.json`; its files are attached as
  `make-app-<version>.zip`), and the commits since the previous release (subject lines only).
- **Attached:** the packages the jobs built and tested: the npm tarballs (`tasktohuman-sdk-<version>.tgz`,
  `n8n-nodes-tasktohuman-<version>.tgz`), the Python sdist and wheel, each with its SHA-256 in the notes. They are
  the files a publish would send; the release itself publishes nothing to npm or PyPI. The packages have no runtime
  dependencies (CI checks that), so there is no SBOM.

"Previous release" in the notes is the newest release of a commit this one descends from. If a newer run of the
workflow cancels this job halfway, at most a draft is left; a later release finishes or (after a day) deletes it.

The release number is not the SDK version: several releases can carry the same `0.1.0` until the version is raised.
The script is `.github/scripts/github_release.py` (tests: `python3 .github/scripts/github_release_test.py`); it uses
the job's `GITHUB_TOKEN` with `contents: write`.

## Contributing and security

Issues and pull requests are welcome. Before opening a pull request, run the checks of the package you changed
(above); the tests must not call a real TaskToHuman host. Report vulnerabilities privately to
security@tasktohuman.com, not in a public issue.

## Licence

The n8n node (`n8n/`) is licensed under the MIT licence ([n8n/LICENSE.md](n8n/LICENSE.md)), as n8n requires for
community nodes. The Zapier app (`zapier/`) and the Make app (`make/`) are licensed under the MIT licence too ([zapier/LICENSE](zapier/LICENSE), [make/LICENSE](make/LICENSE)). Both SDKs are licensed under the Apache License, Version 2.0 (see [LICENSE](./LICENSE), [NOTICE](./NOTICE) and
the copy inside each package). You may use them freely in free or commercial projects without publishing your own
source code.

No warranty: the software is provided "AS IS", without warranties or conditions of any kind and without liability;
see sections 7 and 8 of the licence.

The licence covers the code only: the TaskToHuman name and logo are not licensed (see section 6).
