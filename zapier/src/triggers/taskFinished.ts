// Task Finished (polling). Each poll reads the tasks finished in the last 30 minutes, with their details
// (expand=details), and returns them newest first. Zapier de-duplicates on id + finished_at (primary output fields),
// so the overlap between polls costs nothing and a task that finishes again after support reopened it triggers again.
import { defineTrigger, type Bundle, type ZObject } from 'zapier-platform-core';
import { call, type Page, type Task } from '../api.js';
import { taskTypeChoices, truthy } from '../fields.js';
import { resolvedTask, triggerOutputFields } from '../samples.js';

export const LOOK_BACK_MS = 30 * 60 * 1000;
/** Sample loading widens the window until it finds tasks: the last hour, the last day, the last 30 days. */
export const SAMPLE_WINDOWS_MS = [60 * 60 * 1000, 24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000];
export const PAGE_SIZE = 25; // the API's maximum with expand=details
export const MAX_PAGES = 8;
export const SAMPLE_MAX_PAGES = 20;
export const BUDGET_MS = 20_000; // Zapier stops a poll after 30 s
export const MAX_RESULTS = 100;
export const SAMPLE_RESULTS = 3;

export const OUTCOMES = [
  { value: 'approved', label: 'Approved', sample: 'approved' },
  { value: 'rejected', label: 'Rejected', sample: 'rejected' },
  { value: 'edited', label: 'Edited (approved with changes)', sample: 'edited' },
  { value: 'done', label: 'Done', sample: 'done' },
  { value: 'handed_back', label: 'Handed back', sample: 'handed_back' },
  { value: 'expired', label: 'Expired', sample: 'expired' },
  { value: 'cancelled', label: 'Cancelled', sample: 'cancelled' },
];

/** The trigger's filters: outcomes (empty = all) and whether automatic outcomes count. */
export function matches(task: Task, outcomes: string[], includeAutomatic: boolean): boolean {
  if (!includeAutomatic && task.decision?.automatic === true) return false;
  if (outcomes.length === 0) return true;
  return typeof task.decision?.action === 'string' && outcomes.includes(task.decision.action);
}

function outcomeList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return list.map((entry) => String(entry).trim()).filter((entry) => entry !== '');
}

/** True for an item with the details of expand=details (an older API release answers without them). */
function hasDetails(task: Task): boolean {
  return 'payload' in task;
}

/** Reads the tasks finished since `since`, oldest first, up to the page cap and within the time budget. */
async function finishedSince(
  z: ZObject,
  params: Record<string, string | number>,
  since: number,
  maxPages: number,
  started: number,
): Promise<Task[]> {
  const query = { ...params, finished_after: new Date(since).toISOString() };
  const tasks: Task[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await call<Page<Task>>(z, 'GET', '/v1/tasks', { params: cursor ? { ...query, cursor } : query });
    // Throwing before anything is returned leaves Zapier's de-duplication untouched: the next poll, still inside the
    // look-back, delivers these tasks with their details.
    if (result.data.some((task) => !hasDetails(task))) {
      throw new z.errors.Error('TaskToHuman answered without task details; the next poll tries again.');
    }
    tasks.push(...result.data);
    cursor = result.next_cursor;
    if (!cursor || Date.now() - started > BUDGET_MS) break;
  }
  return tasks;
}

export async function perform(z: ZObject, bundle: Bundle): Promise<Task[]> {
  const sample = bundle.meta?.isLoadingSample === true;
  const started = Date.now();
  const params: Record<string, string | number> = { expand: 'details', limit: PAGE_SIZE };
  const taskType = bundle.inputData?.task_type;
  if (typeof taskType === 'string' && taskType.trim() !== '') params.task_type = taskType.trim();

  const outcomes = outcomeList(bundle.inputData?.outcomes);
  const includeAutomatic = bundle.inputData?.include_automatic === undefined || bundle.inputData.include_automatic === ''
    ? true
    : truthy(bundle.inputData.include_automatic);
  const newestFirst = (tasks: Task[]) =>
    tasks.filter((task) => task.finished_at && matches(task, outcomes, includeAutomatic)).reverse();

  if (!sample) {
    const tasks = await finishedSince(z, params, started - LOOK_BACK_MS, MAX_PAGES, started);
    return newestFirst(tasks).slice(0, MAX_RESULTS);
  }

  // Sample: the newest 3, from the narrowest window that has any (usually one request).
  let found: Task[] = [];
  for (const window of SAMPLE_WINDOWS_MS) {
    found = newestFirst(await finishedSince(z, params, started - window, SAMPLE_MAX_PAGES, started));
    if (found.length > 0 || Date.now() - started > BUDGET_MS) break;
  }
  return found.slice(0, SAMPLE_RESULTS);
}

export const taskFinished = defineTrigger({
  key: 'task_finished',
  noun: 'Task',
  display: {
    label: 'Task Finished',
    description:
      'Triggers when a task is approved, rejected, edited, done, handed back, expires or is cancelled.',
  },
  operation: {
    type: 'polling',
    inputFields: [
      {
        key: 'task_type',
        label: 'Task Type',
        required: false,
        choices: { perform: taskTypeChoices },
        helpText: 'Only tasks of this type. Leave empty for every type.',
      },
      {
        key: 'outcomes',
        label: 'Outcomes',
        required: false,
        list: true,
        choices: OUTCOMES,
        helpText: 'Only these outcomes. Leave empty for every outcome.',
      },
      {
        key: 'include_automatic',
        label: 'Include Automatic Outcomes',
        type: 'boolean',
        required: false,
        default: 'true',
        helpText:
          'Starts when a task finishes. Zapier checks every 1 to 15 minutes, depending on your Zapier plan. Act only when "decision automatic" is false: when it is true, nobody decided (the deadline passed or the task type\'s default action applied). Set this to false to leave those out.',
      },
    ],
    perform,
    sample: resolvedTask,
    outputFields: triggerOutputFields,
  },
});
