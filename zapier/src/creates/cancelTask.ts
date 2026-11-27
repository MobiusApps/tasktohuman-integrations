// Cancel Task: POST /v1/tasks/{id}/cancel. A task that already finished is not an error (a race with the person
// deciding): the step returns the task as it is with `cancelled: false`, as the n8n node and MCP do.
import { defineCreate, type Bundle, type ZObject } from 'zapier-platform-core';
import { call, failure, segment, send, type Task } from '../api.js';
import { cancelledTask, taskOutputFields } from '../samples.js';

export async function perform(z: ZObject, bundle: Bundle) {
  const id = segment(bundle.inputData?.task_id, 'the task ID', z);
  const response = await send(z, 'POST', `/v1/tasks/${id}/cancel`);
  if (response.status >= 200 && response.status < 300) return { ...(response.data as Task), cancelled: true };
  if (response.status === 409 && (response.data as { code?: unknown } | null)?.code === 'task_already_finished') {
    const task = await call<Task>(z, 'GET', `/v1/tasks/${id}`);
    return { ...task, cancelled: false };
  }
  throw failure(z, response);
}

export const cancelTask = defineCreate({
  key: 'cancel_task',
  noun: 'Task',
  display: {
    label: 'Cancel Task',
    description: 'Cancels a task that is still open. A task that already finished is returned as it is.',
  },
  operation: {
    inputFields: [
      {
        key: 'task_id',
        label: 'Task ID',
        required: true,
        helpText: 'The ID of a task created with this connection\'s workspace and mode (test or live).',
      },
    ],
    perform,
    sample: { ...cancelledTask, cancelled: true },
    outputFields: [...taskOutputFields, { key: 'cancelled', label: 'Cancelled by This Step', type: 'boolean' as const }],
  },
});
