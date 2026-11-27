// Create Task and Wait for Decision: creates the task with a Zapier callback URL as its callback_url, and the step
// waits until TaskToHuman calls it (up to Zapier's 30 days). The callback only says "look now": performResume reads
// the task through the API with the connection's key and never trusts the posted body (no signing secret needed).
import { defineCreate, type Bundle, type ZObject } from 'zapier-platform-core';
import { FINAL_STATES, call, segment, type Task } from '../api.js';
import { buildCreateBody, empty, getTaskType, taskTypeInputFields } from '../fields.js';
import { resolvedTask, taskOutputFields } from '../samples.js';
import { createTaskRequest, deadlineInput, idempotencyInput, taskTypeInput, titleInput, urgentInput } from './createTask.js';

/** Zapier resumes a waiting step only within 30 days. */
export const MAX_WAIT_MINUTES = 43_200;

const ALREADY_CREATED =
  'A task with this Idempotency Key already exists (from an earlier run). This step cannot wait for it: use Find Task, or a Zap that starts with Task Finished.';

const TOO_LONG =
  'TaskToHuman tasks of this type can wait longer than Zapier allows (30 days). Set Deadline (Minutes) to 43200 or less.';

export async function perform(z: ZObject, bundle: Bundle) {
  if (bundle.meta?.isLoadingSample) return { ...resolvedTask, replayed: false, callback_received: false };

  // Refuse before anything is created when the task could outlive Zapier's wait.
  const raw = bundle.inputData?.deadline_minutes;
  if (empty(raw)) {
    const type = await getTaskType(z, bundle.inputData?.task_type);
    const fallback = type.default_deadline_minutes;
    if (typeof fallback !== 'number' || fallback > MAX_WAIT_MINUTES) throw new z.errors.HaltedError(TOO_LONG);
  } else if (Number(String(raw).trim()) > MAX_WAIT_MINUTES) {
    throw new z.errors.HaltedError(TOO_LONG);
  }

  // Every run has its own callback URL, and the API hashes it with the body: a repeat run with the same Idempotency
  // Key is a conflict, not a replay, and the earlier run's task calls back the earlier URL. Say so instead.
  const body = buildCreateBody(bundle, { callbackUrl: z.generateCallbackUrl() });
  const task = await createTaskRequest(z, bundle, body, ALREADY_CREATED);
  return { ...task, callback_received: false };
}

export async function performResume(z: ZObject, bundle: Bundle) {
  // The body Zapier received (bundle.cleanedRequest) is ignored on purpose: anyone who learns the URL could post it.
  const id = (bundle.outputData as { id?: unknown } | undefined)?.id;
  const task = await call<Task>(z, 'GET', `/v1/tasks/${segment(id, 'the task ID', z)}`);
  if (!FINAL_STATES.includes(task.state)) throw new z.errors.Error('The task is not finished yet');
  const replayed = (bundle.outputData as { replayed?: unknown }).replayed === true;
  return { ...task, replayed, callback_received: true };
}

export const createTaskWait = defineCreate({
  key: 'create_task_wait',
  noun: 'Task',
  display: {
    label: 'Create Task and Wait for Decision',
    description:
      'Creates a task for a person and pauses the Zap until they decide (up to 30 days), then continues with the decision.',
  },
  operation: {
    inputFields: [
      {
        key: 'wait_help',
        type: 'copy',
        helpText:
          'This step pauses the Zap until a person decides, for up to 30 days. Set a deadline shorter than 30 days, or use Create Task and the Task Finished trigger in a second Zap.',
      },
      taskTypeInput,
      titleInput,
      taskTypeInputFields,
      { ...deadlineInput, helpText: '1 to 43200 (30 days, the longest Zapier waits). Empty: the task type\'s deadline, which must be 30 days or less.' },
      urgentInput,
      {
        ...idempotencyInput,
        helpText:
          'A value that names this request, such as an order id. It stops a second task being created: a repeat run with the same value stops with an error instead of waiting.',
      },
    ],
    perform,
    performResume,
    sample: { ...resolvedTask, replayed: false, callback_received: true },
    outputFields: [
      ...taskOutputFields,
      { key: 'replayed', label: 'Returned an Earlier Task', type: 'boolean' as const },
      { key: 'callback_received', label: 'Decision Received', type: 'boolean' as const },
    ],
  },
});
