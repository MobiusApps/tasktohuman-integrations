// Create Task: POST /v1/tasks with the chosen type's fields, the people of its open steps and the options. Returns
// the created task at once.
import { defineCreate, type Bundle, type ZObject } from 'zapier-platform-core';
import { send, failure, type Task } from '../api.js';
import { buildCreateBody, idempotencyHeaders, taskTypeChoices, taskTypeInputFields } from '../fields.js';
import { createdTask, taskOutputFields } from '../samples.js';

export const taskTypeInput = {
  key: 'task_type',
  label: 'Task Type',
  required: true,
  altersDynamicFields: true,
  choices: { perform: taskTypeChoices },
  helpText: 'The kind of task to create. Its fields appear below once you choose it.',
};

export const titleInput = {
  key: 'title',
  label: 'Title',
  required: false,
  helpText: 'Up to 200 characters; the task type\'s name when empty. Shown in notifications and not encrypted: keep sensitive data out of it.',
};

export const deadlineInput = {
  key: 'deadline_minutes',
  label: 'Deadline (Minutes)',
  type: 'integer' as const,
  required: false,
  helpText: '1 to 525600 (a year). The task type\'s default action applies when it passes. Empty: the task type\'s deadline.',
};

export const urgentInput = {
  key: 'urgent',
  label: 'Urgent',
  type: 'boolean' as const,
  required: false,
  helpText: 'Marks the task as urgent in the app; its email subjects start with [Urgent]. It never changes a deadline.',
};

export const callbackInput = {
  key: 'callback_url',
  label: 'Callback URL',
  required: false,
  helpText: 'Where TaskToHuman sends the decision for this task, instead of the task type\'s callback URL. A public https address.',
};

export const idempotencyInput = {
  key: 'idempotency_key',
  label: 'Idempotency Key',
  required: false,
  helpText:
    'A value that names this request, such as an order id. Sending the same value again returns the first task instead of asking twice.',
};

/**
 * POST /v1/tasks; the task with `replayed: true` when the Idempotency Key returned an earlier task. `conflictMessage`
 * replaces the usual message for 409 idempotency_conflict.
 */
export async function createTaskRequest(z: ZObject, bundle: Bundle, body: Record<string, unknown>, conflictMessage?: string) {
  const response = await send(z, 'POST', '/v1/tasks', { body, headers: idempotencyHeaders(bundle) });
  const code = (response.data as { code?: unknown } | null)?.code;
  if (conflictMessage && response.status === 409 && code === 'idempotency_conflict') {
    throw new z.errors.HaltedError(conflictMessage);
  }
  if (response.status < 200 || response.status >= 300) throw failure(z, response);
  return { ...(response.data as Task), replayed: response.header('idempotent-replayed') === 'true' };
}

export async function perform(z: ZObject, bundle: Bundle) {
  return createTaskRequest(z, bundle, buildCreateBody(bundle));
}

export const createTask = defineCreate({
  key: 'create_task',
  noun: 'Task',
  display: {
    label: 'Create Task',
    description:
      'Creates a task for a person and returns at once. To act on the answer, use Create Task and Wait for Decision, or a second Zap that starts with Task Finished.',
  },
  operation: {
    inputFields: [
      taskTypeInput,
      titleInput,
      taskTypeInputFields,
      deadlineInput,
      urgentInput,
      callbackInput,
      idempotencyInput,
    ],
    perform,
    sample: { ...createdTask, replayed: false },
    outputFields: [...taskOutputFields, { key: 'replayed', label: 'Returned an Earlier Task', type: 'boolean' as const }],
  },
});
