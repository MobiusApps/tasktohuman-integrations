import type { IDataObject } from 'n8n-workflow';

/** A value the user typed that cannot be sent. The node turns it into a NodeOperationError for the item. */
export class InputRefusal extends Error {}

/** The node's Create parameters, as n8n hands them over. */
export interface CreateInput {
	taskType: string;
	title?: string;
	payload?: unknown;
	callbackUrl?: string;
	options?: {
		deadlineMinutes?: number;
		idempotencyKey?: string;
		owner?: string;
		approvers?: { approver?: Array<{ step?: number; person?: string }> };
		chain?: {
			step?: Array<{ people?: string; approvalsNeeded?: number; waitMinutes?: number; remind?: boolean }>;
		};
	};
}

/** Builds the POST /v1/tasks body. Empty values are left out; the API checks the rest. */
export function buildCreateBody(input: CreateInput): IDataObject {
	const taskType = (input.taskType ?? '').trim();
	if (taskType === '') throw new InputRefusal('Choose a task type.');
	const body: IDataObject = { task_type: taskType, payload: parsePayload(input.payload) };

	const title = (input.title ?? '').trim();
	if (title !== '') body.title = title;
	if (input.callbackUrl) body.callback_url = input.callbackUrl;

	const options = input.options ?? {};
	if (typeof options.deadlineMinutes === 'number' && options.deadlineMinutes > 0) {
		body.deadline_minutes = Math.round(options.deadlineMinutes);
	}
	const owner = (options.owner ?? '').trim();
	if (owner !== '') body.owner = owner;

	const approvers = (options.approvers?.approver ?? []).map((entry, index) => {
		const step = Number(entry.step);
		if (!Number.isInteger(step) || step < 1) {
			throw new InputRefusal(`Approver ${index + 1}: the step must be a whole number from 1.`);
		}
		return { step, ...personRef(entry.person, `Approver ${index + 1}`) };
	});
	if (approvers.length > 0) body.approvers = approvers;

	const chain = (options.chain?.step ?? []).map((entry, index) => chainStep(entry, index + 1));
	if (chain.length > 0) body.chain = chain;

	return body;
}

/** The payload as a JSON object: an object from an expression, or JSON text. Empty means {}. */
export function parsePayload(value: unknown): IDataObject {
	if (value === undefined || value === null) return {};
	let parsed: unknown = value;
	if (typeof value === 'string') {
		if (value.trim() === '') return {};
		let valid = true;
		try {
			parsed = JSON.parse(value);
		} catch {
			valid = false;
		}
		if (!valid) {
			throw new InputRefusal(
				'The Payload is not valid JSON. Write the task type\'s fields as an object, like {"order_id": "4821"}.',
			);
		}
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new InputRefusal('The Payload must be a JSON object, like {"order_id": "4821"}.');
	}
	return parsed as IDataObject;
}

/** A person by id, or by email address when the value contains "@". */
export function personRef(value: unknown, label: string): { human: string } | { email: string } {
	const text = typeof value === 'string' ? value.trim() : '';
	if (text === '') throw new InputRefusal(`${label}: fill in a person's ID or email address.`);
	return text.includes('@') ? { email: text } : { human: text };
}

function chainStep(
	entry: { people?: string; approvalsNeeded?: number; waitMinutes?: number; remind?: boolean },
	number: number,
): IDataObject {
	const label = `Chain step ${number}`;
	const people = (entry.people ?? '')
		.split(',')
		.map((person) => person.trim())
		.filter((person) => person !== '');
	if (people.length === 0) throw new InputRefusal(`${label}: fill in at least one person.`);
	const minutes = Number(entry.waitMinutes);
	if (!Number.isFinite(minutes) || minutes <= 0) {
		throw new InputRefusal(`${label}: Wait (Minutes) must be more than 0.`);
	}

	const step: IDataObject =
		people.length === 1
			? { ...personRef(people[0], label) }
			: { approvers: people.map((person) => personRef(person, label)) };
	if (people.length > 1 && typeof entry.approvalsNeeded === 'number' && entry.approvalsNeeded > 0) {
		step.approvals_needed = Math.round(entry.approvalsNeeded);
	}
	step.wait_seconds = Math.round(minutes * 60);
	if (entry.remind === false) step.remind = false;
	return step;
}

/** The default Idempotency-Key: the same for a retry of the same item in the same execution ("Retry On Fail"). */
export function defaultIdempotencyKey(executionId: string, nodeId: string, itemIndex: number): string {
	return `n8n-${executionId}-${nodeId}-${itemIndex}`;
}

/** Turns an n8n date value into an ISO 8601 instant for the API, or throws InputRefusal. */
export function toInstant(value: unknown, label: string): string {
	let text = '';
	if (typeof value === 'string') text = value.trim();
	else if (value instanceof Date) text = value.toISOString();
	else if (value !== null && typeof (value as { toISO?: unknown }).toISO === 'function') {
		// A Luxon DateTime, which n8n expressions such as {{ $now }} produce.
		text = String((value as { toISO: () => string }).toISO());
	}
	const time = Date.parse(text);
	if (text === '' || Number.isNaN(time)) throw new InputRefusal(`${label} is not a date and time.`);
	return new Date(time).toISOString();
}
