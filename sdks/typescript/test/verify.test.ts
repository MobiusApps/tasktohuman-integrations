// verifyCallback against the shared test vectors (fixtures/callback-signature.json, the same vectors the backend's
// signer and the docs samples are tested with).
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { SignatureVerificationError, verifyCallback, type CallbackTask } from "../src/index.js";
import { CALLBACK_ROUTING_KEYS, CALLBACK_TASK_KEYS, ROUTING_RULE_REF_KEYS } from "./shapes.js";
import { repoFile } from "./helpers.js";

interface Vectors {
  secret: string;
  previous_secret: string;
  t: number;
  body: string;
  header: string;
  header_rotation: string;
}
const v = JSON.parse(repoFile("fixtures/callback-signature.json")) as Vectors;
const base = { body: v.body, signature: v.header, secret: v.secret, now: v.t };

function sign(t: number | string, body: string, secret = v.secret): string {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

async function refused(options: Parameters<typeof verifyCallback>[0], reason: string): Promise<void> {
  await assert.rejects(verifyCallback(options), (error: unknown) => {
    assert.ok(error instanceof SignatureVerificationError);
    assert.equal(error.reason, reason);
    return true;
  });
}

describe("verifyCallback: accepted", () => {
  test("the vector, and returns the parsed body", async () => {
    const task = await verifyCallback(base);
    assert.deepEqual(task, JSON.parse(v.body));
    assert.equal(task.decision?.by?.name, "Ana");
    assert.equal(task.urgency, "high");
    assert.deepEqual(task.tags, ["refunds"]);
    assert.equal(task.routing?.rule?.name, "Refunds over 200");
  });

  test("a task no routing rule matched, and an older body without urgency, tags or routing", async () => {
    const parsed = JSON.parse(v.body) as Record<string, unknown>;
    const unrouted = JSON.stringify({ ...parsed, urgency: "normal", tags: [], routing: { rule: null } });
    const task = await verifyCallback({ ...base, body: unrouted, signature: `t=${v.t},v1=${sign(v.t, unrouted)}` });
    assert.equal(task.routing?.rule, null);
    assert.deepEqual(task.tags, []);
    const { urgency: _u, tags: _t, routing: _r, ...older } = parsed;
    const body = JSON.stringify(older);
    const old: CallbackTask = await verifyCallback({ ...base, body, signature: `t=${v.t},v1=${sign(v.t, body)}` });
    assert.equal(old.urgency ?? "normal", "normal");
    assert.equal(old.routing?.rule ?? null, null);
  });

  test("the body as bytes (a Node Buffer) and as an ArrayBuffer", async () => {
    await verifyCallback({ ...base, body: Buffer.from(v.body, "utf8") });
    const bytes = new TextEncoder().encode(v.body);
    await verifyCallback({ ...base, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  });

  test("during a rotation, with either secret", async () => {
    await verifyCallback({ ...base, signature: v.header_rotation, secret: v.secret });
    await verifyCallback({ ...base, signature: v.header_rotation, secret: v.previous_secret });
  });

  test("a list of secrets, where any one matches", async () => {
    await verifyCallback({ ...base, secret: ["whsec_new_not_deployed_yet", v.secret] });
  });

  test("at the edge of the tolerance (±300 s)", async () => {
    await verifyCallback({ ...base, now: v.t + 300 });
    await verifyCallback({ ...base, now: v.t - 300 });
  });

  test("spaces around the parts, as a proxy may add", async () => {
    await verifyCallback({ ...base, signature: v.header.replace(",", " , ") });
  });

  test("unknown keys are skipped", async () => {
    await verifyCallback({ ...base, signature: `${v.header},v2=abc` });
  });

  test("the header read from a fetch Headers or a Node headers record", async () => {
    const { signature: _, ...rest } = base;
    await verifyCallback({ ...rest, headers: new Headers({ "TTH-Signature": v.header }) });
    await verifyCallback({ ...rest, headers: { "tth-signature": v.header, "content-type": "application/json" } });
    await verifyCallback({ ...rest, headers: { "TTH-Signature": [v.header] } });
  });

  test("a callback after a consensus step, with quorum", async () => {
    const body = JSON.stringify({
      ...JSON.parse(v.body),
      quorum: { needed: 2, approvals: 2, rejections: 0, outcome: "met", answers: [] },
    });
    const task: CallbackTask = await verifyCallback({ ...base, body, signature: `t=${v.t},v1=${sign(v.t, body)}` });
    assert.equal(task.quorum?.outcome, "met");
  });
});

describe("verifyCallback: refused", () => {
  test("a changed body", async () => {
    await refused({ ...base, body: v.body.replace("approved", "rejected") }, "no_matching_signature");
  });

  test("a wrong secret", async () => {
    await refused({ ...base, secret: "whsec_wrong" }, "no_matching_signature");
  });

  test("301 s too late or too early", async () => {
    await refused({ ...base, now: v.t + 301 }, "timestamp_out_of_tolerance");
    await refused({ ...base, now: v.t - 301 }, "timestamp_out_of_tolerance");
  });

  test("no header", async () => {
    await refused({ ...base, signature: undefined, headers: {} }, "missing_header");
    await refused({ ...base, signature: null }, "missing_header");
    await refused({ ...base, signature: "" }, "missing_header");
    const { signature: _, ...rest } = base;
    await refused({ ...rest, headers: new Headers() }, "missing_header");
  });

  test("malformed headers", async () => {
    const sig = v.header.split("v1=")[1] ?? "";
    for (const header of [
      `v1=${sig}`, // no t
      `t=${v.t}`, // no v1
      `t=${v.t},t=${v.t},v1=${sig}`, // several t
      `t=abc,v1=${sig}`, // t not digits
      `t=${v.t},v1=${sig.toUpperCase()}`, // upper-case hex
      `t=${v.t},v1=${sig.slice(0, 63)}`, // short
      `t=${v.t},v1=${sig}0`, // long
      `t=${v.t},v1=`, // empty
      "garbage",
    ]) {
      await refused({ ...base, signature: header }, "malformed_header");
    }
  });

  test("two TTH-Signature headers in a Node record", async () => {
    const { signature: _, ...rest } = base;
    await refused({ ...rest, headers: { "tth-signature": [v.header, v.header] } }, "malformed_header");
  });
});

describe("verifyCallback: misuse", () => {
  test("a missing or empty secret is a TypeError, never a pass", async () => {
    for (const secret of [undefined, "", [], [""], [v.secret, ""], null, 42]) {
      await assert.rejects(verifyCallback({ ...base, secret: secret as never }), TypeError, String(secret));
    }
  });

  test("a tolerance or now that is not a finite number is a TypeError, never a pass", async () => {
    for (const toleranceSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      await assert.rejects(verifyCallback({ ...base, now: v.t + 10_000, toleranceSeconds }), TypeError, String(toleranceSeconds));
    }
    await assert.rejects(verifyCallback({ ...base, now: Number.NaN }), TypeError);
  });

  test("both or neither of signature and headers is a TypeError", async () => {
    await assert.rejects(verifyCallback({ ...base, headers: {} }), TypeError);
    const { signature: _, ...rest } = base;
    await assert.rejects(verifyCallback(rest), TypeError);
  });

  test("a parsed body (an object) is a TypeError", async () => {
    await assert.rejects(verifyCallback({ ...base, body: JSON.parse(v.body) as never }), TypeError);
  });
});

describe("CallbackTask", () => {
  test("its keys equal the vector body's keys (the callback is not in the OpenAPI file)", () => {
    const body = JSON.parse(v.body) as Record<string, unknown>;
    // quorum is present only after a consensus step; every other key is in the body.
    assert.deepEqual(
      Object.keys(body).sort(),
      Object.keys(CALLBACK_TASK_KEYS)
        .filter((k) => k !== "quorum")
        .sort(),
    );
    // urgency, tags and routing are always sent now, but optional in the type so bodies from before them still fit.
    assert.deepEqual(
      Object.entries(CALLBACK_TASK_KEYS)
        .filter(([, [presence]]) => presence === "optional")
        .map(([k]) => k)
        .sort(),
      ["quorum", "routing", "tags", "urgency"],
    );
  });

  test("routing and its rule have the vector body's keys", () => {
    const routing = (JSON.parse(v.body) as { routing: { rule: Record<string, unknown> } }).routing;
    assert.deepEqual(Object.keys(routing).sort(), Object.keys(CALLBACK_ROUTING_KEYS).sort());
    assert.deepEqual(Object.keys(routing.rule).sort(), Object.keys(ROUTING_RULE_REF_KEYS).sort());
  });
});
