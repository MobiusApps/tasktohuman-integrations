import type { IDataObject } from 'n8n-workflow';
import { WAIT_INDEFINITELY } from 'n8n-workflow';

import { verifySignature, type SignatureRefusal } from './signature';

/** States after which a task never changes again (unless support reopens it). */
export const FINAL_STATES = ['resolved', 'expired', 'cancelled'];

/**
 * How long n8n keeps waiting after the task's deadline. At the deadline the task's default action finishes it and
 * a callback goes out; the first four retries (30 s, 2 min, 10 min, 30 min) fit in about 43 minutes.
 */
export const CALLBACK_GRACE_MS = 60 * 60 * 1000;

export function isFinal(state: unknown): boolean {
	return typeof state === 'string' && FINAL_STATES.includes(state);
}

/** Until when "Create and Wait for Decision" waits: the deadline plus the grace period, or indefinitely. */
export function waitTill(expiresAt: unknown): Date {
	if (typeof expiresAt !== 'string') return WAIT_INDEFINITELY;
	const time = Date.parse(expiresAt);
	if (Number.isNaN(time)) return WAIT_INDEFINITELY;
	return new Date(time + CALLBACK_GRACE_MS);
}

/** Room n8n gives an execution for custom data (key-value pairs); a full store silently drops new keys. */
export const CUSTOM_DATA_LIMIT = 10;

/**
 * The execution's custom data key holding the id of the task this node created and waits for. n8n keeps custom
 * data with the waiting execution, and keys may hold only letters, digits and underscores (at most 50 characters).
 */
export function waitBindingKey(nodeId: string): string {
	return `tth_task_${nodeId.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 50);
}

export type CallbackCheck =
	| { accept: true; task: IDataObject }
	| { accept: false; status: 400 | 401; reason: SignatureRefusal | 'not_json' | 'not_final' | 'task_mismatch' };

/**
 * Checks a callback that arrived at the resume URL. Accepted only when the signature is valid, fresh, the task is
 * finished, and it is the task this execution created. Security rests on n8n's signed resume URL plus this workspace
 * HMAC and its 5-minute window: the stored callback URL is visible to every member of the workspace, so the HMAC is
 * what stops anyone resuming by hand. The secret signs every task of the workspace, so the task id check is what
 * stops a member replaying the signed callback of another task (one they decided themselves) to this URL.
 */
export function checkCallback(input: {
	rawBody: Buffer | undefined;
	header: string | string[] | undefined;
	secret: string | undefined;
	nowSeconds: number;
	expectedTaskId: string | undefined;
}): CallbackCheck {
	const verified = verifySignature(input);
	if (!verified.ok) {
		return { accept: false, status: verified.reason === 'missing_body' ? 400 : 401, reason: verified.reason };
	}
	let task: unknown;
	try {
		task = JSON.parse((input.rawBody as Buffer).toString('utf8'));
	} catch {
		return { accept: false, status: 400, reason: 'not_json' };
	}
	if (task === null || typeof task !== 'object' || Array.isArray(task)) {
		return { accept: false, status: 400, reason: 'not_json' };
	}
	if (!input.expectedTaskId || (task as IDataObject).id !== input.expectedTaskId) {
		return { accept: false, status: 401, reason: 'task_mismatch' };
	}
	if (!isFinal((task as IDataObject).state)) return { accept: false, status: 400, reason: 'not_final' };
	return { accept: true, task: task as IDataObject };
}
