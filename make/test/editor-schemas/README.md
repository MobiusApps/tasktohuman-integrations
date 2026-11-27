# Make editor JSON schemas (vendored)

The JSON schemas (draft-07) that Make's web editor uses to check component code. `editor-schemas.test.mjs` validates
every file of `make/app/` against them, offline, with Ajv. A violation is what the editor would show as a warning.

- Source: https://github.com/integromat/vscode-apps-sdk, directory `syntaxes/imljson/schemas/`, commit
  `6ff5f3dd9960ccbeb24de3beb1cca935de89eaa0`, as copied byte-exact into Make's own skill
  (https://github.com/integromat/make-apps-skill, `skills/make-custom-apps/references/editor-schemas/`, commit
  `98e71591a9d1d85bb2ce50c03462ec413f396ea9`, 2026-11-12).
- The 14 `*.json` files are unmodified copies; `LICENSE.md` is the source's licence (MIT-style, Celonis, Inc.).
- To refresh: copy the files again from a newer commit of either repository, update the commits above, run the tests.

Which schema checks which file (from the source package's `contributes.jsonValidation`):

| Schema | Files |
| --- | --- |
| `base.json` | `base.imljson` |
| `api.json` | `api.json` of a module, RPC or connection |
| `parameters.json` | `parameters.json`, `expect.json`, `interface.json` |
| `samples.json` | `samples.json` |
| `epoch.json` | `epoch.json` |
| none | a webhook's `api.json` (the receiver), every `metadata.json` (checked by `structure.test.mjs` instead) |
