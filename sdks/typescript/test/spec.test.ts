// Drift check: the SDK types (through test/shapes.ts) against the vendored openapi/public-v1.json. When the API
// changes and the file is refreshed, this test names what the types must follow.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { VERSION } from "../src/index.js";
import { repoFile } from "./helpers.js";
import * as shapes from "./shapes.js";

interface Schema {
  type?: string | string[];
  oneOf?: Schema[];
  $ref?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
}
interface Parameter {
  name: string;
  in: string;
  required?: boolean;
}
interface Spec {
  paths: Record<string, Record<string, { operationId?: string; parameters?: Parameter[] }>>;
  components: { schemas: Record<string, Schema> };
}

const spec = JSON.parse(repoFile("openapi/public-v1.json")) as Spec;

function nullable(schema: Schema): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.includes("null") || (schema.oneOf ?? []).some((s) => s.type === "null");
}

/** The schema as a shape record: every property with its presence and nullability. */
function schemaShape(name: string): Record<string, readonly [string, string]> {
  const schema = spec.components.schemas[name];
  assert.ok(schema?.properties, `schema ${name} is in the spec`);
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(schema.properties).map(([key, prop]) => [
      key,
      [required.has(key) ? "required" : "optional", nullable(prop) ? "nullable" : "non-null"] as const,
    ]),
  );
}

const pairs: [string, Record<string, readonly [string, string]>, Record<string, readonly [string, string]>?][] = [
  ["PublicTaskView", shapes.TASK_KEYS],
  ["PublicDecisionView", shapes.DECISION_KEYS],
  ["PublicAttachmentView", shapes.ATTACHMENT_KEYS],
  ["PublicHumanRef", shapes.HUMAN_REF_KEYS],
  ["PublicQuorumView", shapes.QUORUM_KEYS],
  ["PublicQuorumAnswerView", shapes.QUORUM_ANSWER_KEYS],
  ["PublicTaskList", shapes.TASK_LIST_KEYS],
  ["PublicTaskTypeList", shapes.TASK_TYPE_LIST_KEYS],
  ["PublicTaskTypeView", shapes.TASK_TYPE_KEYS],
  ["PublicTaskTypeField", shapes.TASK_TYPE_FIELD_KEYS],
  ["PublicStepView", shapes.TASK_TYPE_STEP_KEYS],
  ["PublicGroupRef", shapes.GROUP_REF_KEYS],
  ["PublicHumanList", shapes.HUMAN_LIST_KEYS],
  // task_type is required but typed nullable in the spec; the SDK asks for a string (null is a validation error).
  ["CreateTaskBody", shapes.CREATE_TASK_KEYS, { task_type: ["required", "nullable"] }],
  ["PublicProblem", shapes.PROBLEM_KEYS],
  ["PublicFieldMessage", shapes.FIELD_MESSAGE_KEYS],
  ["ApiKeyMeResponse", shapes.ME_KEYS],
  ["NamedRef", shapes.NAMED_REF_KEYS],
  ["ApiKeyRef", shapes.API_KEY_REF_KEYS],
  ["PublicEntitlementsResponse", shapes.ENTITLEMENTS_KEYS],
];

describe("SDK types match openapi/public-v1.json", () => {
  for (const [name, sdk, exceptions] of pairs) {
    test(name, () => {
      assert.deepEqual({ ...sdk, ...exceptions }, schemaShape(name));
    });
  }

  // cursor also takes null in the SDK (it is then left out of the query), so a page's next_cursor can be passed on
  // as it is.
  const cursorTakesNull = { cursor: ["optional", "nullable"] } as const;
  const lists: [string, string, Record<string, readonly [string, string]>, Record<string, readonly [string, string]>?][] =
    [
      ["ListTasksParams", "/v1/tasks", shapes.LIST_TASKS_KEYS, cursorTakesNull],
      ["ListTaskTypesParams", "/v1/task-types", shapes.LIST_TASK_TYPES_KEYS, cursorTakesNull],
      ["ListHumansParams", "/v1/humans", shapes.LIST_HUMANS_KEYS, cursorTakesNull],
    ];
  for (const [name, path, sdk, sdkOnly] of lists) {
    test(`${name} matches the query parameters of GET ${path}`, () => {
      const params = spec.paths[path]?.["get"]?.parameters ?? [];
      const query = Object.fromEntries(
        params.filter((p) => p.in === "query").map((p) => [p.name, [p.required ? "required" : "optional", "non-null"]]),
      );
      assert.ok(Object.keys(sdkOnly ?? {}).every((key) => key in query));
      assert.deepEqual({ ...sdk }, { ...query, ...sdkOnly });
    });
  }

  test("Approver has the keys of an approvers entry", () => {
    const entry = spec.components.schemas["CreateTaskBody"]?.properties?.["approvers"]?.items;
    assert.deepEqual([...shapes.APPROVER_KEYS].sort(), Object.keys(entry?.properties ?? {}).sort());
    assert.deepEqual(entry?.required, ["step"]);
  });

  // A nested schema may be written in place or as a $ref to a component, maybe as a oneOf with null.
  const resolve = (schema: Schema | undefined): Schema | undefined => {
    const one = schema?.oneOf?.find((s) => s.type !== "null") ?? schema;
    return one?.$ref ? spec.components.schemas[one.$ref.replace("#/components/schemas/", "")] : one;
  };

  test("ChainStep and ChainApprover have the keys of a chain entry", () => {
    const step = resolve(spec.components.schemas["CreateTaskBody"]?.properties?.["chain"]?.items);
    assert.deepEqual([...shapes.CHAIN_STEP_KEYS].sort(), Object.keys(step?.properties ?? {}).sort());
    const approver = resolve(step?.properties?.["approvers"]?.items);
    assert.deepEqual([...shapes.CHAIN_APPROVER_KEYS].sort(), Object.keys(approver?.properties ?? {}).sort());
  });

  test("the client covers every operation that takes an API key", () => {
    const operations = Object.values(spec.paths)
      .flatMap((ops) => Object.values(ops).map((op) => op.operationId))
      .sort();
    // createTaskFromWebhook is the no-code door (a secret URL, no API key): not part of this SDK.
    assert.deepEqual(operations, [
      "cancelTask",
      "createTask",
      "createTaskFromWebhook",
      "downloadTaskAttachment",
      "getEntitlements",
      "getMe",
      "getTask",
      "getTaskType",
      "listHumans",
      "listTaskTypes",
      "listTasks",
    ]);
  });
});

test("VERSION equals package.json's version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});

test("package.json has what a public npm release needs", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const repo = "https://github.com/MobiusApps/tasktohuman-integrations";
  assert.equal(pkg.name, "@tasktohuman/sdk");
  assert.equal(pkg.license, "Apache-2.0");
  // A scoped package is private by default: without this, a publish fails or needs --access public.
  assert.deepEqual(pkg.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
  // npm provenance checks that the repository matches the GitHub repository the workflow runs in.
  assert.deepEqual(pkg.repository, { type: "git", url: `git+${repo}.git`, directory: "sdks/typescript" });
  assert.deepEqual(pkg.bugs, { url: `${repo}/issues` });
  assert.ok(String(pkg.homepage).startsWith(repo), String(pkg.homepage));
  assert.deepEqual(pkg.files, ["dist", "CHANGELOG.md", "LICENSE", "NOTICE"]);
  assert.deepEqual(pkg.exports, { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } });
  assert.deepEqual(pkg.engines, { node: ">=22" });
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  assert.ok(String(pkg.description).length > 20);
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes("tasktohuman"));
});
