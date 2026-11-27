// Find Task: GET /v1/tasks/{id}. Not found (also: another workspace, or the other mode) is Zapier's "nothing found".
import { defineSearch, type Bundle, type ZObject } from 'zapier-platform-core';
import { failure, segment, send, type Task } from '../api.js';
import { resolvedTask, taskOutputFields } from '../samples.js';

export async function perform(z: ZObject, bundle: Bundle): Promise<Task[]> {
  const response = await send(z, 'GET', `/v1/tasks/${segment(bundle.inputData?.task_id, 'the task ID', z)}`);
  if (response.status === 404) return [];
  if (response.status < 200 || response.status >= 300) throw failure(z, response);
  return [response.data as Task];
}

export const findTask = defineSearch({
  key: 'find_task',
  noun: 'Task',
  display: {
    label: 'Find Task',
    description: 'Finds a task by its ID, with its payload and decision.',
  },
  operation: {
    inputFields: [
      {
        key: 'task_id',
        label: 'Task ID',
        required: true,
        helpText:
          'The task\'s ID. Nothing is found for a task of another workspace, or of the other mode: a test key sees only test tasks, a live key only live ones.',
      },
    ],
    perform,
    sample: resolvedTask,
    outputFields: taskOutputFields,
  },
});
