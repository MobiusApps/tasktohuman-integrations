import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IPollFunctions,
} from 'n8n-workflow';

import { taskTypeLocator } from '../TaskToHuman/descriptions';
import { describeFailure, request, requestRaw, toNodeApiError, type TaskPage } from '../TaskToHuman/shared/api';
import { searchTaskTypes } from '../TaskToHuman/shared/listSearch';
import {
	advance,
	findNew,
	matchesFilters,
	PAGE_SIZE,
	withoutPayload,
	type FinishedTask,
	type PollState,
} from '../TaskToHuman/shared/poll';

export class TaskToHumanTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'TaskToHuman Trigger',
		name: 'taskToHumanTrigger',
		icon: { light: 'file:../../icons/tasktohuman.svg', dark: 'file:../../icons/tasktohuman.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: 'On task finished',
		description: 'Starts the workflow when a TaskToHuman task finishes: decided, expired or cancelled',
		defaults: { name: 'TaskToHuman Trigger' },
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'taskToHumanApi', required: true }],
		properties: [
			{
				displayName:
					'Checks for finished tasks at the interval below. On activation it starts from now: tasks that finished earlier are not replayed.',
				name: 'pollNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				options: [{ name: 'Task Finished', value: 'taskFinished' }],
				default: 'taskFinished',
			},
			{
				...taskTypeLocator,
				required: false,
				description: 'Only tasks of this task type. Empty: every task type.',
			},
			{
				displayName: 'Outcomes',
				name: 'outcomes',
				type: 'multiOptions',
				default: [],
				description: 'Only tasks with these outcomes (decision.action). Empty: every outcome.',
				options: [
					{ name: 'Approved', value: 'approved' },
					{ name: 'Cancelled', value: 'cancelled' },
					{ name: 'Done', value: 'done' },
					{ name: 'Edited', value: 'edited' },
					{ name: 'Expired', value: 'expired' },
					{ name: 'Handed Back', value: 'handed_back' },
					{ name: 'Rejected', value: 'rejected' },
				],
			},
			{
				displayName: 'Include Automatic Outcomes',
				name: 'includeAutomatic',
				type: 'boolean',
				default: true,
				description:
					"Whether to include tasks nobody decided (an expiry or the task type's default action, decision.automatic = true)",
			},
			{
				displayName: 'Include Payload',
				name: 'includePayload',
				type: 'boolean',
				default: false,
				description:
					"Whether to include the task's fields, sensitive ones too. n8n stores them in its execution log.",
			},
		],
	};

	methods = {
		listSearch: { searchTaskTypes },
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const taskType = ((this.getNodeParameter('taskType', '', { extractValue: true }) as string) ?? '').trim();
		const filters = {
			outcomes: this.getNodeParameter('outcomes', []) as string[],
			includeAutomatic: this.getNodeParameter('includeAutomatic', true) as boolean,
		};
		const includePayload = this.getNodeParameter('includePayload', false) as boolean;
		const typeFilter: IDataObject = taskType !== '' ? { task_type: taskType } : {};

		if (this.getMode() === 'manual') {
			const sample = await latestFinished.call(this, typeFilter);
			if (!sample) {
				throw new NodeOperationError(this.getNode(), 'No finished task among the 20 newest tasks.', {
					description: 'Finish a task (for example, cancel a test task) and fetch again.',
				});
			}
			const task = await details.call(this, sample);
			return [[{ json: includePayload ? task : withoutPayload(task) }]];
		}

		const staticData = this.getWorkflowStaticData('node') as PollState;
		const now = new Date();
		const found = await findNew(staticData, async (finishedAfter, cursor) => {
			const qs: IDataObject = { ...typeFilter, finished_after: finishedAfter, limit: PAGE_SIZE };
			if (cursor) qs.cursor = cursor;
			const page = (await request.call(this, 'GET', '/v1/tasks', { qs })) as unknown as TaskPage;
			return { data: page.data as FinishedTask[], next_cursor: page.next_cursor };
		});

		const emitted: INodeExecutionData[] = [];
		const handled: FinishedTask[] = found.first ? [] : found.tasks;
		for (const listed of handled) {
			// The list view carries the decision, so filtered-out tasks cost no further request.
			if (!matchesFilters(listed, filters)) continue;
			const task = await details.call(this, listed);
			emitted.push({ json: includePayload ? task : withoutPayload(task) });
		}
		// Moved only after every task was handled: a failure above re-reads the same tasks next time.
		const next = advance(staticData, handled, now);
		staticData.cursor = next.cursor;
		staticData.seen = next.seen;
		return emitted.length > 0 ? [emitted] : null;
	}
}

/** The full task, for the decision's comment and edited values; the list view if it is gone (404). */
async function details(this: IPollFunctions, listed: FinishedTask): Promise<IDataObject> {
	const response = await requestRaw.call(this, 'GET', `/v1/tasks/${encodeURIComponent(listed.id)}`);
	if (response.status >= 200 && response.status < 300) return response.body as IDataObject;
	if (response.status === 404) return listed;
	throw toNodeApiError(this.getNode(), describeFailure(response));
}

/** For a manual test: the most recently finished of the 20 newest tasks. */
async function latestFinished(this: IPollFunctions, typeFilter: IDataObject): Promise<FinishedTask | undefined> {
	const page = (await request.call(this, 'GET', '/v1/tasks', {
		qs: { ...typeFilter, limit: 20 },
	})) as unknown as TaskPage;
	let latest: FinishedTask | undefined;
	for (const task of page.data as FinishedTask[]) {
		if (!task.finished_at) continue;
		if (!latest || Date.parse(task.finished_at) > Date.parse(latest.finished_at ?? '')) latest = task;
	}
	return latest;
}
