import type { INodeProperties, IWebhookDescription } from 'n8n-workflow';

/**
 * The restart webhook "Create and Wait for Decision" resumes on: TaskToHuman posts the signed decision to the
 * execution's signed resume URL. A named constant, the same pattern as n8n's own send-and-wait nodes. Only POST:
 * callbacks are always POST.
 */
export const decisionWebhooks: IWebhookDescription[] = [
	{
		name: 'default',
		httpMethod: 'POST',
		responseMode: 'onReceived',
		responseData: '',
		path: '={{ $nodeId }}',
		restartWebhook: true,
		isFullPath: true,
	},
];

const createOps = ['create', 'sendAndWait'];

export const taskTypeLocator: INodeProperties = {
	displayName: 'Task Type',
	name: 'taskType',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The task type the task is created from',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchTaskTypes', searchable: true },
		},
		{
			displayName: 'By Key',
			name: 'key',
			type: 'string',
			placeholder: 'approve_refund',
		},
	],
};

export const operationProperty: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['task'] } },
	options: [
		{
			name: 'Cancel',
			value: 'cancel',
			description: 'Cancel an open task',
			action: 'Cancel a task',
		},
		{
			name: 'Create',
			value: 'create',
			description: 'Create a task and continue at once',
			action: 'Create a task',
		},
		{
			// The value must be "sendAndWait": n8n checks the signature of a signed resume URL only for nodes whose
			// operation has this value.
			name: 'Create and Wait for Decision',
			value: 'sendAndWait',
			description: 'Create a task and pause the workflow until a person decides or the task finishes',
			action: 'Create a task and wait for the decision',
		},
		{
			name: 'Get',
			value: 'get',
			description: 'Get a task with its payload and decision',
			action: 'Get a task',
		},
		{
			name: 'Get Many',
			value: 'getAll',
			description: 'List tasks, newest created first',
			action: 'Get many tasks',
		},
	],
	default: 'create',
};

export const taskProperties: INodeProperties[] = [
	{
		...taskTypeLocator,
		displayOptions: { show: { resource: ['task'], operation: createOps } },
	},
	{
		displayName: 'Title',
		name: 'title',
		type: 'string',
		default: '',
		displayOptions: { show: { resource: ['task'], operation: createOps } },
		description:
			"Up to 200 characters; the task type's name when empty. Shown in notifications and not encrypted: keep sensitive data out of it.",
	},
	{
		displayName: 'Payload',
		name: 'payload',
		type: 'json',
		required: true,
		default: '{}',
		displayOptions: { show: { resource: ['task'], operation: createOps } },
		description:
			"The task type's fields as a JSON object, for example {\"order_id\": \"4821\", \"amount\": 249}. Fields marked sensitive appear only on the task page.",
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['task'], operation: createOps } },
		options: [
			{
				displayName: 'Approvers',
				name: 'approvers',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				description:
					'The person of each open step of the task type (one entry per person; a consensus step takes several)',
				options: [
					{
						displayName: 'Approver',
						name: 'approver',
						values: [
							{
								displayName: 'Step',
								name: 'step',
								type: 'number',
								typeOptions: { minValue: 1 },
								default: 1,
								description: "The step's number in the task type's chain, from 1",
							},
							{
								displayName: 'Person',
								name: 'person',
								type: 'string',
								default: '',
								placeholder: 'ana@example.com',
								description: "The person's ID, or the email address of a person of the workspace",
							},
						],
					},
				],
			},
			{
				displayName: 'Callback URL',
				name: 'callbackUrl',
				type: 'string',
				default: '',
				displayOptions: { show: { '/operation': ['create'] } },
				description:
					"A public https URL that receives the signed decision. Defaults to the task type's callback URL.",
			},
			{
				displayName: 'Chain',
				name: 'chain',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				description:
					"This task's own chain, replacing the task type's (only for task types that allow it). Not with Approvers or Owner.",
				options: [
					{
						displayName: 'Step',
						name: 'step',
						values: [
							{
								displayName: 'People',
								name: 'people',
								type: 'string',
								default: '',
								placeholder: 'ana@example.com',
								description:
									'One person (ID or email address), or several separated by commas for a consensus step',
							},
							{
								displayName: 'Approvals Needed',
								name: 'approvalsNeeded',
								type: 'number',
								typeOptions: { minValue: 0 },
								default: 0,
								description:
									'For a consensus step: how many approvals decide it, from 2 to the number of people. 0 leaves it out.',
							},
							{
								displayName: 'Wait (Minutes)',
								name: 'waitMinutes',
								type: 'number',
								typeOptions: { minValue: 1 },
								default: 60,
								description: 'How long the step waits for an answer before the task moves on',
							},
							{
								displayName: 'Remind',
								name: 'remind',
								type: 'boolean',
								default: true,
								description: 'Whether to send a reminder at half the wait',
							},
						],
					},
				],
			},
			{
				displayName: 'Deadline (Minutes)',
				name: 'deadlineMinutes',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 525600 },
				default: 60,
				description:
					"When the task type's default action applies. Defaults to the task type's deadline. With Create and Wait for Decision, the wait ends one hour after the deadline.",
			},
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				description:
					'Sending the same key and values again returns the same task instead of a second one. Empty: one key per execution, node and item, so "Retry On Fail" never asks twice.',
			},
			{
				displayName: 'Owner',
				name: 'owner',
				type: 'string',
				default: '',
				description:
					"The ID of a person of the workspace who gets the task first, instead of the task type's first step",
			},
		],
	},
	{
		displayName:
			'The workflow pauses until TaskToHuman sends the decision. Needs the credential\'s Signing Secret, a public https address for n8n (WEBHOOK_URL), and one input item. Without a deadline the wait never times out.',
		name: 'waitNotice',
		type: 'notice',
		default: '',
		displayOptions: { show: { resource: ['task'], operation: ['sendAndWait'] } },
	},
	{
		displayName: 'Task ID',
		name: 'taskId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: { resource: ['task'], operation: ['get', 'cancel'] } },
		description: 'The ID of the task (the "ID" field of a created task)',
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: { show: { resource: ['task'], operation: ['getAll'] } },
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		displayOptions: { show: { resource: ['task'], operation: ['getAll'], returnAll: [false] } },
		description: 'Max number of results to return',
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: ['task'], operation: ['getAll'] } },
		options: [
			{
				displayName: 'Created After',
				name: 'createdAfter',
				type: 'dateTime',
				default: '',
			},
			{
				displayName: 'Created Before',
				name: 'createdBefore',
				type: 'dateTime',
				default: '',
			},
			{
				displayName: 'Finished After',
				name: 'finishedAfter',
				type: 'dateTime',
				default: '',
				description:
					'Only finished tasks that finished at or after this time, oldest finished first instead of newest created first',
			},
			{
				displayName: 'State',
				name: 'state',
				type: 'options',
				default: 'notified',
				options: [
					{ name: 'Acknowledged', value: 'acknowledged' },
					{ name: 'Cancelled', value: 'cancelled' },
					{ name: 'Expired', value: 'expired' },
					{ name: 'Notified', value: 'notified' },
					{ name: 'Open', value: 'open' },
					{ name: 'Resolved', value: 'resolved' },
				],
			},
			{
				displayName: 'Task Type Key',
				name: 'taskType',
				type: 'string',
				default: '',
				placeholder: 'approve_refund',
			},
		],
	},
];
