import { SignatureVerificationError } from "./errors.js";
import type { CallbackTask } from "./types.js";

/** Request headers in any common shape: a fetch `Headers`, or Node's `req.headers` record. */
export type HeadersLike =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

export interface VerifyCallbackOptions {
  /** The raw request body exactly as it arrived, before any JSON parsing. Parsing and serializing changes it. */
  body: string | Uint8Array | ArrayBuffer;
  /** The TTH-Signature header. Give this or `headers`. */
  signature?: string | null;
  /** The request's headers, to read TTH-Signature from. Give this or `signature`. */
  headers?: HeadersLike;
  /** The workspace's signing secret (whsec_…), or several while you deploy a rotated one: [new, old]. */
  secret: string | readonly string[];
  /** How far `t` may be from your clock, in seconds. Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** The current time in Unix seconds, for tests. Default: the clock. */
  now?: number;
}

const encoder = new TextEncoder();
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Checks a TaskToHuman callback before you act on it and returns the parsed body: the HMAC-SHA256 of `t`, a dot
 * and the raw body, keyed with the secret's UTF-8 bytes, must equal any `v1` of TTH-Signature (compared in constant
 * time by Web Crypto), and `t` must be within `toleranceSeconds` of now.
 *
 * Throws SignatureVerificationError (answer 400) when the callback is refused, and TypeError when the secret is
 * missing or empty (an HMAC keyed with nothing would accept forgeries).
 *
 * Afterwards: skip a TTH-Event-Id you already handled, and act only on `decision.automatic === false`.
 */
export async function verifyCallback(options: VerifyCallbackOptions): Promise<CallbackTask> {
  const secrets = typeof options.secret === "string" ? [options.secret] : options.secret;
  if (!Array.isArray(secrets) || secrets.length === 0 || secrets.some((s) => typeof s !== "string" || s === "")) {
    throw new TypeError("verifyCallback: secret must be a non-empty string or a non-empty list of them.");
  }
  if ((options.signature !== undefined) === (options.headers !== undefined)) {
    throw new TypeError("verifyCallback: give either signature or headers.");
  }
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? Date.now() / 1000;
  // NaN or Infinity would make the comparison below always pass and turn off the replay window.
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new TypeError("verifyCallback: toleranceSeconds must be a finite number >= 0.");
  }
  if (!Number.isFinite(now)) throw new TypeError("verifyCallback: now must be a finite number.");
  const body = toBytes(options.body);
  const header = options.headers !== undefined ? readSignatureHeader(options.headers) : options.signature;

  const { t, signatures } = parseSignature(header);
  if (Math.abs(now - Number(t)) > tolerance) throw new SignatureVerificationError("timestamp_out_of_tolerance");

  const prefix = encoder.encode(`${t}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);

  let matched = false;
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "verify",
    ]);
    for (const signature of signatures) {
      // subtle.verify compares in constant time. Keep going after a match so the time taken does not tell which one.
      if (await crypto.subtle.verify("HMAC", key, signature, signed)) matched = true;
    }
  }
  if (!matched) throw new SignatureVerificationError("no_matching_signature");

  return JSON.parse(new TextDecoder().decode(body)) as CallbackTask;
}

/** `t=<digits>,v1=<64 lower-case hex>[,v1=…]`; spaces around each part are ignored, unknown keys skipped. */
function parseSignature(header: string | null | undefined): { t: string; signatures: Uint8Array<ArrayBuffer>[] } {
  if (header === undefined || header === null || header.trim() === "") {
    throw new SignatureVerificationError("missing_header");
  }
  const timestamps: string[] = [];
  const signatures: Uint8Array<ArrayBuffer>[] = [];
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    const key = eq < 0 ? trimmed : trimmed.slice(0, eq);
    const value = eq < 0 ? "" : trimmed.slice(eq + 1);
    if (key === "t") {
      timestamps.push(value);
    } else if (key === "v1") {
      if (!HEX64.test(value)) throw new SignatureVerificationError("malformed_header");
      signatures.push(hexToBytes(value));
    }
  }
  const [t] = timestamps;
  if (timestamps.length !== 1 || t === undefined || !/^\d{1,15}$/.test(t) || signatures.length === 0) {
    throw new SignatureVerificationError("malformed_header");
  }
  return { t, signatures };
}

function readSignatureHeader(headers: HeadersLike): string | null | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get("tth-signature");
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const name = Object.keys(record).find((k) => k.toLowerCase() === "tth-signature");
  const value = name === undefined ? undefined : record[name];
  if (Array.isArray(value)) {
    if (value.length > 1) throw new SignatureVerificationError("malformed_header");
    return value[0];
  }
  return value;
}

function toBytes(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new TypeError("verifyCallback: body must be the raw body as a string, Uint8Array (a Node.js buffer is one) or ArrayBuffer.");
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
