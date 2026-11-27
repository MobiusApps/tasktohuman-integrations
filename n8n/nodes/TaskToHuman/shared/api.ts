import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INode,
	IPollFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

/** The credential every node of this package uses. */
export const CREDENTIAL = 'taskToHumanApi';

export interface TaskToHumanCredentials {
	apiKey: string;
	baseUrl: string;
	signingSecret?: string;
}

type ApiContext = IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions | IWebhookFunctions;

/** A task as `/v1` returns it (PublicTaskView). Only the fields this package reads are typed. */
export interface Task extends IDataObject {
	id: string;
	state: string;
	task_type: string;
	expires_at: string | null;
	finished_at?: string | null;
	decision: (IDataObject & { action: string; automatic: boolean }) | null;
}

export interface TaskPage {
	data: Task[];
	next_cursor?: string | null;
}

export interface RawResponse {
	status: number;
	body: unknown;
	headers: Record<string, unknown>;
}

/** Why a request was refused, built from the parsed problem fields only (never headers, the key or the request). */
export interface Failure {
	status: number;
	message: string;
	description: string;
	code?: string;
}

/**
 * Trims the base URL and checks it. Returns the URL without trailing slashes, or a sentence saying what to fix.
 * https is required; http only for localhost and *.localhost (a local development stack).
 */
export function checkBaseUrl(raw: unknown): { url: string } | { refusal: string } {
	const text = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
	if (text === '') return { refusal: 'Fill in the Base URL in the TaskToHuman credential.' };
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		return { refusal: `The Base URL "${text}" is not a web address. Use https://api.tasktohuman.com.` };
	}
	const local = parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost');
	if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
		return {
			refusal: 'The Base URL must start with https:// so the API key is never sent unencrypted.',
		};
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		return { refusal: 'The Base URL must be a plain address, like https://api.tasktohuman.com.' };
	}
	if (parsed.pathname !== '/' && parsed.pathname !== '') {
		return {
			refusal: 'The Base URL must not contain a path: leave out /v1 and anything after the host name.',
		};
	}
	return { url: `${parsed.protocol}//${parsed.host}` };
}

/** Sends one request with the credential and returns status, parsed body and headers, whatever the status. */
export async function requestRaw(
	this: ApiContext,
	method: IHttpRequestMethods,
	path: string,
	options: { qs?: IDataObject; body?: IDataObject; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
	const credentials = await this.getCredentials<TaskToHumanCredentials>(CREDENTIAL);
	const base = checkBaseUrl(credentials.baseUrl);
	if ('refusal' in base) throw new NodeOperationError(this.getNode(), base.refusal);

	const response = (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, {
		method,
		url: `${base.url}${path}`,
		qs: options.qs,
		body: options.body,
		json: true,
		headers: { Accept: 'application/json', 'Accept-Language': 'en', ...options.headers },
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as { statusCode: number; body: unknown; headers?: Record<string, unknown> };

	return { status: response.statusCode, body: response.body, headers: response.headers ?? {} };
}

/** Sends one request and returns the parsed body of a 2xx answer; any other answer throws a NodeApiError. */
export async function request(
	this: ApiContext,
	method: IHttpRequestMethods,
	path: string,
	options: {
		qs?: IDataObject;
		body?: IDataObject;
		headers?: Record<string, string>;
		itemIndex?: number;
		forWait?: boolean;
	} = {},
): Promise<IDataObject> {
	const response = await requestRaw.call(this, method, path, options);
	if (response.status >= 200 && response.status < 300) return response.body as IDataObject;
	throw toNodeApiError(this.getNode(), describeFailure(response, { forWait: options.forWait }), options.itemIndex);
}

const FIELD_PROPERTIES = ['code', 'title', 'reason', 'feature', 'available_from', 'limit', 'state', 'action'];

/** Turns a non-2xx answer into a message and a hint in plain English. */
export function describeFailure(response: RawResponse, context: { forWait?: boolean } = {}): Failure {
	const { status } = response;
	const problem: IDataObject =
		response.body !== null && typeof response.body === 'object' && !Array.isArray(response.body)
			? (response.body as IDataObject)
			: {};
	const text = (key: string): string | undefined =>
		typeof problem[key] === 'string' && problem[key] !== '' ? (problem[key] as string) : undefined;
	const code = text('code');
	const fields = fieldMessages(problem.errors);

	const lines: string[] = [];
	const hint = hintFor(status, code, problem, response.headers, fields, context);
	if (hint) lines.push(hint);
	for (const field of fields) lines.push(`${field.key}: ${field.message} (${field.code})`);
	const facts = FIELD_PROPERTIES.filter((key) => key !== 'title' && text(key) !== undefined).map(
		(key) => `${key}: ${text(key)}`,
	);
	if (facts.length > 0) lines.push(facts.join(', '));

	const message =
		text('title') ??
		(status >= 500
			? `TaskToHuman could not answer right now (HTTP ${status})`
			: `TaskToHuman refused the request (HTTP ${status})`);
	return { status, code, message, description: lines.join('\n') };
}

/** The NodeApiError for a failure. Carries only the parsed problem fields, so n8n never stores the key or headers. */
export function toNodeApiError(node: INode, failure: Failure, itemIndex?: number): NodeApiError {
	const safe: JsonObject = { status: failure.status, message: failure.message };
	if (failure.code) safe.code = failure.code;
	return new NodeApiError(node, safe, {
		message: failure.message,
		description: failure.description,
		httpCode: String(failure.status),
		itemIndex,
	});
}

interface FieldMessage {
	key: string;
	code: string;
	message: string;
}

function fieldMessages(errors: unknown): FieldMessage[] {
	if (errors === null || typeof errors !== 'object' || Array.isArray(errors)) return [];
	const result: FieldMessage[] = [];
	for (const [key, list] of Object.entries(errors as Record<string, unknown>)) {
		if (!Array.isArray(list)) continue;
		for (const entry of list) {
			const item = (entry ?? {}) as { code?: unknown; message?: unknown };
			result.push({
				key,
				code: typeof item.code === 'string' ? item.code : 'invalid',
				message: typeof item.message === 'string' ? item.message : 'Check this value.',
			});
		}
	}
	return result;
}

function hintFor(
	status: number,
	code: string | undefined,
	problem: IDataObject,
	headers: Record<string, unknown>,
	fields: FieldMessage[],
	context: { forWait?: boolean },
): string | undefined {
	if (context.forWait && fields.some((field) => field.key === 'callback_url')) {
		return "TaskToHuman can only send the decision to a public https address. Set your n8n's WEBHOOK_URL to its public https address, or use Create plus the TaskToHuman Trigger instead.";
	}
	switch (status) {
		case 400:
			return 'Some values were refused: fix the fields listed below.';
		case 401:
			return 'Check the API key in the TaskToHuman credential: it may be mistyped, revoked or expired.';
		case 402:
			if (code === 'not_enough_credits') return notEnoughCreditsHint(problem);
			return `Your organization cannot create more tasks right now${
				typeof problem.reason === 'string' ? ` (${problem.reason})` : ''
			}. Check Billing in the TaskToHuman app.`;
		case 403:
			if (code === 'feature_not_in_plan') {
				return `Your plan does not include this${
					typeof problem.feature === 'string' ? ` (${problem.feature})` : ''
				}. Leave the option out, or upgrade the plan in the TaskToHuman app.`;
			}
			if (code === 'workspace_inactive') {
				return "This API key's workspace is inactive. Reactivate it in the TaskToHuman app, or use a key of another workspace.";
			}
			if (code === 'api_key_paused') {
				return `TaskToHuman support paused this API key${
					typeof problem.until === 'string' ? ` until ${problem.until}` : ''
				}. Running the node again before then will not help: contact TaskToHuman support.`;
			}
			if (code === 'address_blocked') {
				return "TaskToHuman is blocking requests from this n8n's network for a while. If you think this is a mistake, contact TaskToHuman support.";
			}
			return "Your organization can't do this right now. Check its status in the TaskToHuman app.";
		case 404:
			return "Not found in this API key's workspace. A task created with a test key is invisible to a live key, and the other way round.";
		case 409:
			if (code === 'idempotency_conflict') {
				return 'An earlier request used the same Idempotency Key with different values. Use a new key, or send the same values again.';
			}
			if (code === 'task_already_finished') return 'The task is already finished.';
			return undefined;
		case 422:
			if (code === 'no_owner_available') {
				return "Nobody can take this task now. Check the task type's chain and its people in the TaskToHuman app.";
			}
			return undefined;
		case 429: {
			const retryAfter = headerValue(headers, 'retry-after');
			return `Too many requests for this API key${
				retryAfter ? `: wait ${retryAfter} seconds` : ''
			}. Turn on "Retry On Fail" in the node's settings.`;
		}
		default:
			if (status >= 500) {
				return 'It is safe to try again: a retried create sends the same Idempotency Key, so it returns the same task instead of a second one.';
			}
			return undefined;
	}
}

/** 402 `not_enough_credits`: what the task needs against what is free, and how the organization gets credits. */
function notEnoughCreditsHint(problem: IDataObject): string {
	const number = (key: string): number | undefined =>
		typeof problem[key] === 'number' ? (problem[key] as number) : undefined;
	const [needed, available, held] = [number('needed'), number('available'), number('held')];
	const counts =
		needed !== undefined && available !== undefined
			? ` It needs ${needed} credits; ${available} are free${held ? ` and ${held} are held by open tasks` : ''}.`
			: '';
	return `Your organization is out of credits, so the task was not created.${counts} Retrying will not help until it has credits: buy a credit pack or turn on automatic buying in the TaskToHuman app (Plan > Credits), then run the node again.`;
}

function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
	const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
	const value = key === undefined ? undefined : headers[key];
	if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
	return typeof value === 'string' ? value : value === undefined ? undefined : String(value);
}
