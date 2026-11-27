// Task type → Zapier input fields, and Zapier inputData → the POST /v1/tasks body.
// A task-type field becomes `payload__<key>` (the prefix keeps it from colliding with the fixed inputs); a person for
// an open step becomes `approver__<step>`.
import type { Bundle, ZObject } from 'zapier-platform-core';
import { call, segment, type Page } from './api.js';

export interface TaskTypeField {
  key: string;
  label: string;
  type: string; // text, long_text, number, boolean, email or url
  required: boolean;
  sensitive: boolean;
  editable: boolean;
}

export interface TaskTypeStep {
  step: number;
  assignment: string; // human, at_creation or group
  group?: { id: string; name: string | null } | null;
  approvals_needed?: number | null;
  max_approvers?: number | null;
}

export interface TaskType {
  key: string;
  name: string;
  kind: string;
  steps: TaskTypeStep[];
  chain_override: boolean;
  fields?: TaskTypeField[];
  default_deadline_minutes?: number | null;
}

interface Human {
  id: string;
  name: string | null;
}

/** A Zapier input field as this app builds it at run time (plain data, no functions). */
export interface ZapierField {
  key: string;
  label: string;
  type?: 'string' | 'text' | 'number' | 'boolean' | 'integer';
  required?: boolean;
  helpText?: string;
  list?: boolean;
  choices?: Array<{ value: string; label: string; sample: string }>;
  meta?: Record<string, string>;
}

export const PAYLOAD_PREFIX = 'payload__';
export const APPROVER_PREFIX = 'approver__';
/** Zapier keeps how a payload field should be sent in the field's meta (strings from mapped values become numbers…). */
const TYPE_META = 'tth_type';
const HUMAN_PAGES = 5;

const ZAPIER_TYPES: Record<string, ZapierField['type']> = {
  text: 'string',
  email: 'string',
  url: 'string',
  long_text: 'text',
  number: 'number',
  boolean: 'boolean',
};

/** The task type dropdown: GET /v1/task-types, paged with Zapier's paging_token. */
export async function taskTypeChoices(z: ZObject, bundle: Bundle) {
  const params: Record<string, string | number> = { limit: 100 };
  if (bundle.meta?.paging_token) params.cursor = bundle.meta.paging_token;
  const page = await call<Page<TaskType>>(z, 'GET', '/v1/task-types', { params });
  return {
    results: page.data.map((type) => ({ id: type.key, label: type.name })),
    paging_token: page.next_cursor ?? null,
  };
}

export async function getTaskType(z: ZObject, key: unknown): Promise<TaskType> {
  return call<TaskType>(z, 'GET', `/v1/task-types/${segment(key, 'Task Type', z)}`);
}

/** One Zapier field per task-type field. */
export function payloadFields(type: TaskType): ZapierField[] {
  return (type.fields ?? []).map((field) => {
    const result: ZapierField = {
      key: `${PAYLOAD_PREFIX}${field.key}`,
      label: field.sensitive ? `${field.label} (sensitive)` : field.label,
      type: ZAPIER_TYPES[field.type] ?? 'string',
      required: field.required,
      meta: { [TYPE_META]: field.type },
    };
    if (field.sensitive) {
      result.helpText = 'Shown only on the task page, masked until revealed. Zapier keeps what you map here in its Zap history.';
    }
    return result;
  });
}

/** True for a step whose person the creator names (at_creation or group). */
export function isOpen(step: TaskTypeStep): boolean {
  return step.assignment === 'at_creation' || step.assignment === 'group';
}

/** One field per open step: a dropdown of the workspace's people (or the group's), names only. */
export async function approverFields(z: ZObject, type: TaskType): Promise<ZapierField[]> {
  const open = type.steps.filter(isOpen);
  const cache = new Map<string, Human[]>();
  const fields: ZapierField[] = [];
  for (const step of open) {
    const group = step.assignment === 'group' ? (step.group?.id ?? '') : '';
    if (!cache.has(group)) cache.set(group, await listHumans(z, group));
    const people = cache.get(group) ?? [];
    const consensus = typeof step.approvals_needed === 'number' && typeof step.max_approvers === 'number';
    const field: ZapierField = {
      key: `${APPROVER_PREFIX}${step.step}`,
      label: consensus ? `Approvers for step ${step.step}` : `Approver for step ${step.step}`,
      type: 'string',
      required: true,
    };
    // Zapier allows no empty choice list: a group with nobody yet gets a plain field (map an ID or email address).
    if (people.length > 0) {
      field.choices = people.map((person) => ({ value: person.id, label: person.name ?? person.id, sample: person.id }));
    }
    const from = step.group?.name ? `A member of ${step.group.name}. ` : '';
    field.helpText = consensus
      ? `${from}Between ${step.approvals_needed} and ${step.max_approvers} different people. Choose them, or map their TaskToHuman IDs or email addresses.`
      : `${from}Choose a person, or map a TaskToHuman ID or email address.`;
    if (consensus) field.list = true;
    fields.push(field);
  }
  return fields;
}

async function listHumans(z: ZObject, group: string): Promise<Human[]> {
  const people: Human[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < HUMAN_PAGES; page++) {
    const params: Record<string, string | number> = { limit: 100 };
    if (group) params.group = group;
    if (cursor) params.cursor = cursor;
    const result = await call<Page<Human>>(z, 'GET', '/v1/humans', { params });
    people.push(...result.data);
    cursor = result.next_cursor;
    if (!cursor) break;
  }
  return people;
}

/** The dynamic part of Create Task: the chosen type's fields, then a person for each open step. One type read. */
export async function taskTypeInputFields(z: ZObject, bundle: Bundle): Promise<ZapierField[]> {
  const key = bundle.inputData?.task_type;
  if (typeof key !== 'string' || key.trim() === '') return [];
  const type = await getTaskType(z, key);
  return [...payloadFields(type), ...(await approverFields(z, type))];
}

/** True for a missing value or one that is only spaces. */
export const empty = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** A mapped value as the task-type field type wants it; anything that does not convert is sent as is (the API checks). */
function convert(value: unknown, type: string | undefined): unknown {
  if (type === 'number' && typeof value === 'string') {
    const number = Number(value.trim());
    return Number.isFinite(number) ? number : value;
  }
  if (type === 'boolean' && typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(text)) return true;
    if (['false', 'no', '0'].includes(text)) return false;
  }
  return value;
}

/** True for Zapier's boolean values ("true"/"yes" strings from mapped values too). */
export function truthy(value: unknown): boolean {
  return convert(value, 'boolean') === true;
}

/** A person by id, or by email address when the value contains "@". */
function person(value: string): { human: string } | { email: string } {
  const text = value.trim();
  return text.includes('@') ? { email: text } : { human: text };
}

/** Builds the POST /v1/tasks body. Only non-empty values; numbers and booleans converted; the API checks the rest. */
export function buildCreateBody(bundle: Bundle, options: { callbackUrl?: string } = {}): Record<string, unknown> {
  const input = (bundle.inputData ?? {}) as Record<string, unknown>;
  const meta = bundle.meta?.inputFields ?? {};
  const body: Record<string, unknown> = { task_type: String(input.task_type ?? '').trim() };

  if (!empty(input.title)) body.title = String(input.title).trim();

  const payload: Record<string, unknown> = {};
  const approvers: Array<Record<string, unknown>> = [];
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith(PAYLOAD_PREFIX) && !empty(value)) {
      const type = meta[key]?.[TYPE_META];
      payload[key.slice(PAYLOAD_PREFIX.length)] = convert(value, typeof type === 'string' ? type : undefined);
    } else if (key.startsWith(APPROVER_PREFIX)) {
      const step = Number(key.slice(APPROVER_PREFIX.length));
      const values = (Array.isArray(value) ? value : [value]).filter((entry) => !empty(entry));
      for (const entry of values) approvers.push({ step, ...person(String(entry)) });
    }
  }
  body.payload = payload;
  if (approvers.length > 0) body.approvers = approvers;

  if (!empty(input.deadline_minutes)) body.deadline_minutes = convert(input.deadline_minutes, 'number');
  if (truthy(input.urgent)) body.urgency = 'high';
  const callbackUrl = options.callbackUrl ?? (empty(input.callback_url) ? undefined : String(input.callback_url).trim());
  if (callbackUrl) body.callback_url = callbackUrl;
  return body;
}

/** The Idempotency-Key header, when the user set one. */
export function idempotencyHeaders(bundle: Bundle): Record<string, string> {
  const value = bundle.inputData?.idempotency_key;
  return empty(value) ? {} : { 'Idempotency-Key': String(value).trim() };
}
