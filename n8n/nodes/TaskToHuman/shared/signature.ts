import { createHmac, timingSafeEqual } from 'crypto';

// Checks the TTH-Signature header of a TaskToHuman callback. A port of the SDKs' verifyCallback
// (sdks/typescript/src/verify.ts) to node:crypto, tested with the same shared vectors (fixtures/callback-signature.json)
// and the same cases as the app's verify sample.
//
// Header: t=<unix seconds>,v1=<64 lower-case hex>[,v1=…]. Signed content: t + "." + the raw body, HMAC-SHA256 keyed
// with the secret's UTF-8 bytes. Any v1 may match (a second one is sent during a secret rotation). t must be within
// 300 seconds of now.

export type SignatureRefusal =
	| 'missing_secret'
	| 'missing_body'
	| 'missing_header'
	| 'malformed_header'
	| 'timestamp_out_of_tolerance'
	| 'no_matching_signature';

export interface VerifyInput {
	/** The raw request body exactly as it arrived. */
	rawBody: Buffer | string | undefined;
	/** The TTH-Signature header as Node.js gives it (a string, or an array when it was repeated). */
	header: string | string[] | undefined;
	/** The workspace signing secret (whsec_…). */
	secret: string | undefined;
	/** Now, in Unix seconds. */
	nowSeconds: number;
	toleranceSeconds?: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function verifySignature(input: VerifyInput): { ok: true } | { ok: false; reason: SignatureRefusal } {
	const secret = input.secret ?? '';
	if (secret === '') return { ok: false, reason: 'missing_secret' };
	if (input.rawBody === undefined) return { ok: false, reason: 'missing_body' };
	if (Array.isArray(input.header) && input.header.length > 1) return { ok: false, reason: 'malformed_header' };
	const header = Array.isArray(input.header) ? input.header[0] : input.header;

	const parsed = parseHeader(header);
	if ('reason' in parsed) return { ok: false, reason: parsed.reason };
	const tolerance = input.toleranceSeconds ?? 300;
	if (!(Math.abs(input.nowSeconds - Number(parsed.t)) <= tolerance)) {
		return { ok: false, reason: 'timestamp_out_of_tolerance' };
	}

	const body = typeof input.rawBody === 'string' ? Buffer.from(input.rawBody, 'utf8') : input.rawBody;
	const expected = createHmac('sha256', Buffer.from(secret, 'utf8'))
		.update(Buffer.concat([Buffer.from(`${parsed.t}.`, 'utf8'), body]))
		.digest();
	let matched = false;
	for (const signature of parsed.signatures) {
		// Keep comparing after a match, so the time taken does not tell which value matched.
		if (timingSafeEqual(expected, Buffer.from(signature, 'hex'))) matched = true;
	}
	return matched ? { ok: true } : { ok: false, reason: 'no_matching_signature' };
}

function parseHeader(
	header: string | undefined,
): { t: string; signatures: string[] } | { reason: SignatureRefusal } {
	if (header === undefined || header.trim() === '') return { reason: 'missing_header' };
	const timestamps: string[] = [];
	const signatures: string[] = [];
	for (const part of header.split(',')) {
		const trimmed = part.trim();
		const eq = trimmed.indexOf('=');
		const key = eq < 0 ? trimmed : trimmed.slice(0, eq);
		const value = eq < 0 ? '' : trimmed.slice(eq + 1);
		if (key === 't') {
			timestamps.push(value);
		} else if (key === 'v1') {
			if (!HEX64.test(value)) return { reason: 'malformed_header' };
			signatures.push(value);
		}
	}
	const t = timestamps[0];
	if (timestamps.length !== 1 || t === undefined || !/^\d{1,15}$/.test(t) || signatures.length === 0) {
		return { reason: 'malformed_header' };
	}
	return { t, signatures };
}
