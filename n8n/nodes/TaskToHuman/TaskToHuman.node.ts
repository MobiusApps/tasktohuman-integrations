import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';

import { decisionWebhooks, operationProperty, taskProperties } from './descriptions';
import {
	CREDENTIAL,
	describeFailure,
	request,
	requestRaw,
	toNodeApiError,
	type Task,
	type TaskPage,
	type TaskToHumanCredentials,
} from './shared/api';
import {
	buildCreateBody,
	defaultIdempotencyKey,
	InputRefusal,
	toInstant,
	type CreateInput,
} from './shared/body';
import { searchTaskTypes } from './shared/listSearch';
import { checkCallback, CUSTOM_DATA_LIMIT, isFinal, waitBindingKey, waitTill } from './shared/wait';

export class TaskToHuman implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'TaskToHuman',
		name: 'taskToHuman',
		icon: { light: 'file:../../icons/tasktohuman.svg', dark: 'file:../../icons/tasktohuman.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Ask a person to approve, edit or do a task, and get the decision',
		defaults: { name: 'TaskToHuman' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'taskToHumanApi', required: true }],
		webhooks: decisionWebhooks,
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [{ name: 'Task', value: 'task' }],
				default: 'task',
			},
			operationProperty,
			...taskProperties,
		],
	};

	methods = {
		listSearch: { searchTaskTypes },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = this.getNodeParameter('operation', 0) as string;
		if (operation === 'sendAndWait') return await createAndWait.call(this);

		const items = this.getInputData();
		const output: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				if (operation === 'getAll') {
					for (const task of await getMany.call(this, i)) output.push({ json: task, pairedItem: { item: i } });
					continue;
				}
				let result: IDataObject;
				if (operation === 'create') {
					result = await request.call(this, 'POST', '/v1/tasks', {
						body: createBody.call(this, i),
						headers: { 'Idempotency-Key': idempotencyKey.call(this, i) },
						itemIndex: i,
					});
				} else if (operation === 'get') {
					result = await request.call(this, 'GET', `/v1/tasks/${taskIdPath.call(this, i)}`, { itemIndex: i });
				} else if (operation === 'cancel') {
					result = await cancel.call(this, i);
				} else {
					throw new NodeOperationError(this.getNode(), `The operation "${operation}" is not known.`, {
						itemIndex: i,
					});
				}
				output.push({ json: result, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					output.push({ json: failureJson(error), pairedItem: { item: i } });
					continue;
				}
				throw asNodeError.call(this, error, i);
			}
		}
		return [output];
	}

	/** The decision arrives at the signed resume URL: resume only on a valid, fresh TaskToHuman signature. */
	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const res = this.getResponseObject();
		if (!req.rawBody && typeof req.readRawBody === 'function') await req.readRawBody();
		const credentials = await this.getCredentials<TaskToHumanCredentials>(CREDENTIAL);
		const check = checkCallback({
			rawBody: req.rawBody,
			header: req.headers['tth-signature'],
			secret: credentials.signingSecret,
			nowSeconds: Math.floor(Date.now() / 1000),
			expectedTaskId: this.customData.get(waitBindingKey(nodeKey(this.getNode()))),
		});
		if (!check.accept) {
			// Not answered with 2xx, so TaskToHuman retries (signed again with a fresh timestamp); the execution keeps
			// waiting. The reason is logged without the body or header.
			this.logger.warn(`TaskToHuman: refused a callback (${check.reason})`);
			res.status(check.status).end();
			return { noWebhookResponse: true };
		}
		return { workflowData: [[{ json: { ...check.task, callback_received: true } }]] };
	}
}

/** "Create and Wait for Decision": one item, one task, one wait. */
async function createAndWait(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	try {
		if (items.length !== 1) {
			throw new NodeOperationError(
				this.getNode(),
				`Create and Wait for Decision handles one item per execution; it got ${items.length}.`,
				{
					description:
						'Put a Loop Over Items node with a batch size of 1 before this node, or use Create and the TaskToHuman Trigger.',
				},
			);
		}
		const credentials = await this.getCredentials<TaskToHumanCredentials>(CREDENTIAL);
		if (!credentials.signingSecret) {
			throw new NodeOperationError(this.getNode(), 'Add the Signing Secret to the TaskToHuman credential.', {
				description:
					'It proves that a decision really comes from TaskToHuman. Find it in the app: Settings → workspace → Signing secret → Reveal or Rotate.',
			});
		}
		// The created task's id is kept with the execution, so webhook() resumes only on that task's callback.
		const bindingKey = waitBindingKey(nodeKey(this.getNode()));
		const customData = this.customData.getAll();
		if (!(bindingKey in customData) && Object.keys(customData).length >= CUSTOM_DATA_LIMIT) {
			throw new NodeOperationError(this.getNode(), 'This execution has no room left for custom data.', {
				description: `Create and Wait for Decision keeps the task id in the execution's custom data, which holds at most ${CUSTOM_DATA_LIMIT} values. Set fewer values with Execution Data nodes before this node.`,
			});
		}
		const body = createBody.call(this, 0, this.getSignedResumeUrl());
		const task = (await request.call(this, 'POST', '/v1/tasks', {
			body,
			headers: { 'Idempotency-Key': idempotencyKey.call(this, 0) },
			itemIndex: 0,
			forWait: true,
		})) as Task;
		// Already finished (an idempotent replay of a task decided earlier): its callback may have come before this
		// execution was waiting, so return it at once.
		if (!isFinal(task.state)) {
			this.customData.set(bindingKey, String(task.id));
			await this.putExecutionToWait(waitTill(task.expires_at));
		}
		// What flows on when the wait times out; a received decision replaces it (webhook()).
		return [[{ json: { ...task, callback_received: false }, pairedItem: { item: 0 } }]];
	} catch (error) {
		if (this.continueOnFail()) return [[{ json: failureJson(error), pairedItem: { item: 0 } }]];
		throw asNodeError.call(this, error, 0);
	}
}

/** The canvas node id (stable across renames); the name only if an old n8n gives no id. */
function nodeKey(node: { id?: string; name: string }): string {
	return node.id ?? node.name;
}

function createBody(this: IExecuteFunctions, i: number, callbackUrl?: string): IDataObject {
	const input: CreateInput = {
		taskType: this.getNodeParameter('taskType', i, '', { extractValue: true }) as string,
		title: this.getNodeParameter('title', i, '') as string,
		payload: this.getNodeParameter('payload', i, '{}'),
		options: this.getNodeParameter('options', i, {}) as CreateInput['options'],
	};
	const options = (input.options ?? {}) as IDataObject;
	input.callbackUrl = callbackUrl ?? (typeof options.callbackUrl === 'string' ? options.callbackUrl.trim() : '');
	return buildCreateBody(input);
}

function idempotencyKey(this: IExecuteFunctions, i: number): string {
	const options = this.getNodeParameter('options', i, {}) as IDataObject;
	const given = typeof options.idempotencyKey === 'string' ? options.idempotencyKey.trim() : '';
	return given !== '' ? given : defaultIdempotencyKey(this.getExecutionId(), this.getNode().id, i);
}

function taskIdPath(this: IExecuteFunctions, i: number): string {
	const id = (this.getNodeParameter('taskId', i, '') as string).trim();
	if (id === '') throw new NodeOperationError(this.getNode(), 'Fill in the Task ID.', { itemIndex: i });
	return encodeURIComponent(id);
}

/** Cancel; a task that already finished is returned as it is, with cancelled: false (a race, not a failure). */
async function cancel(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const id = taskIdPath.call(this, i);
	const response = await requestRaw.call(this, 'POST', `/v1/tasks/${id}/cancel`);
	if (response.status >= 200 && response.status < 300) return { ...(response.body as IDataObject), cancelled: true };
	if (response.status === 409 && (response.body as { code?: unknown } | null)?.code === 'task_already_finished') {
		const task = await request.call(this, 'GET', `/v1/tasks/${id}`, { itemIndex: i });
		return { ...task, cancelled: false };
	}
	throw toNodeApiError(this.getNode(), describeFailure(response), i);
}

/** Get Many: pages through next_cursor until the limit (or the end with Return All). */
async function getMany(this: IExecuteFunctions, i: number): Promise<IDataObject[]> {
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const limit = returnAll ? Infinity : (this.getNodeParameter('limit', i, 50) as number);
	const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
	const qs: IDataObject = {};
	if (typeof filters.state === 'string' && filters.state !== '') qs.state = filters.state;
	if (typeof filters.taskType === 'string' && filters.taskType.trim() !== '') qs.task_type = filters.taskType.trim();
	if (filters.createdAfter) qs.created_after = toInstant(filters.createdAfter, 'Created After');
	if (filters.createdBefore) qs.created_before = toInstant(filters.createdBefore, 'Created Before');
	if (filters.finishedAfter) qs.finished_after = toInstant(filters.finishedAfter, 'Finished After');

	const tasks: IDataObject[] = [];
	let cursor: string | undefined;
	do {
		const page = (await request.call(this, 'GET', '/v1/tasks', {
			qs: { ...qs, limit: Math.min(100, limit - tasks.length), ...(cursor ? { cursor } : {}) },
			itemIndex: i,
		})) as unknown as TaskPage;
		tasks.push(...page.data);
		cursor = page.next_cursor ?? undefined;
	} while (cursor && tasks.length < limit);
	return tasks.slice(0, limit);
}

function asNodeError(this: IExecuteFunctions, error: unknown, itemIndex: number): Error {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	if (error instanceof InputRefusal) return new NodeOperationError(this.getNode(), error.message, { itemIndex });
	return new NodeOperationError(this.getNode(), error as Error, { itemIndex });
}

/** The item continueOnFail() emits: message, code and status only. */
function failureJson(error: unknown): IDataObject {
	const json: IDataObject = { error: error instanceof Error ? error.message : String(error) };
	if (error instanceof NodeApiError) {
		if (error.httpCode) json.status = Number(error.httpCode);
		const code = (error.errorResponse as IDataObject | undefined)?.code;
		if (typeof code === 'string') json.code = code;
	}
	return json;
}
