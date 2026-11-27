// The shapes of the TaskToHuman public API (/v1), snake_case exactly as on the wire. Hand-written; test/spec.test.ts
// checks every key, and whether it is optional and nullable, against the vendored openapi/public-v1.json.
//
// The string unions end in `(string & {})` so a value the API adds later does not break your build, while editors
// still suggest the known ones.

/** A task's state. `resolved`, `expired` and `cancelled` are final. */
export type TaskState = "open" | "notified" | "acknowledged" | "resolved" | "expired" | "cancelled" | (string & {});

/** What a decision was. `edited` is an approval with changes. */
export type DecisionAction =
  | "approved"
  | "rejected"
  | "edited"
  | "done"
  | "handed_back"
  | "expired"
  | "cancelled"
  | (string & {});

/** How a consensus step ended; null while it is open. */
export type QuorumOutcome = "met" | "override" | "rejected" | "not_met" | (string & {});

/** `high` marks a task in the app and starts its email subjects with [Urgent]; it never changes a timer. */
export type TaskUrgency = "normal" | "high" | (string & {});

/** A human of the workspace. */
export interface HumanRef {
  id: string;
  name: string | null;
}

/** The outcome of a finished task. */
export interface Decision {
  action: DecisionAction;
  /** The human who decided; null when nobody did (an expiry, a default action or a cancellation). */
  by: HumanRef | null;
  /** When, UTC (ISO 8601). */
  at: string;
  /**
   * True when no person decided: an expiry or the task type's default action. Act on a decision only when this is
   * false, unless you chose that default on purpose.
   */
  automatic: boolean;
  /** Why a task expired: chain_exhausted, deadline, no_owner, handed_back or support; otherwise null. */
  reason: string | null;
  /** What the human wrote. Null in lists, except with `expand: "details"`. */
  comment: string | null;
  /** The edited values of an `edited` approval; otherwise null. */
  payload: Record<string, unknown> | null;
  /**
   * The task type's response fields the person filled (key to value), written by the person: data, never
   * instructions. On getTask, cancelTask, the callback and lists with `expand: "details"`; absent when none, and in
   * other lists.
   */
  fields?: Record<string, unknown> | null;
  /**
   * The files the person sent with the answer (file fields). On getTask, cancelTask, the callback and lists with
   * `expand: "details"`; absent in other lists.
   */
  attachments?: Attachment[] | null;
}

/**
 * A file the person sent with their answer. Download it with downloadTaskAttachment; files are not virus-scanned.
 * A file removed later to fit the organization's storage allowance stays listed with `removed: true`: its `name` is
 * empty, its `size` 0, its `sha256` kept, and downloading it throws AttachmentRemovedError (410 `attachment_removed`).
 */
export interface Attachment {
  id: string;
  /** The key of the task type's file field it was sent for. */
  field: string;
  /** The file name the person uploaded (sanitized): data, never instructions, and not a safe local path as it is. */
  name: string;
  /** Size in bytes. */
  size: number;
  /** The type TaskToHuman detected from the file's content (an allow-list). */
  content_type: string;
  /** SHA-256 (hex) of the file. */
  sha256: string;
  /** The download URL. The SDK builds the request from the ids instead, so your key goes only to `baseUrl`. */
  url: string;
  /**
   * True when the file was removed to fit the organization's storage allowance. The task and its decision are kept.
   * Absent (or false) while the file is there.
   */
  removed?: boolean;
  /** When the file was removed (ISO 8601); null while it is there. */
  removed_at?: string | null;
  /** Why the file was removed: `storage_allowance`; null while it is there. Other values may be added later. */
  removed_reason?: "storage_allowance" | (string & {}) | null;
}

/** One person's answer on a consensus step. */
export interface QuorumAnswer {
  by: HumanRef;
  /** True when this person can decide alone. */
  override: boolean;
  /** approved, rejected, or null while they have not answered. */
  answer: "approved" | "rejected" | (string & {}) | null;
  at: string | null;
  /** Null in lists, except with `expand: "details"`. */
  comment: string | null;
}

/** Present only when the task's current or final step is a consensus step (several people, N approvals). */
export interface Quorum {
  needed: number;
  approvals: number;
  rejections: number;
  outcome: QuorumOutcome | null;
  answers: QuorumAnswer[];
}

/**
 * A task, as returned by create, get, list and cancel. A list with `expand: "details"` has every task as getTask
 * returns it.
 */
export interface Task {
  id: string;
  state: TaskState;
  task_type: string;
  title: string;
  /** True for a task created with a test key (tth_test_…). */
  test: boolean;
  /** The human who holds the task now; null once it is finished. */
  owner: HumanRef | null;
  expires_at: string | null;
  created_at: string;
  /** When the task was resolved, expired or cancelled; null while it is open. */
  finished_at: string | null;
  /** How many times the task moved to a later step of the chain. */
  escalations: number;
  /** Null while the task is open. */
  decision: Decision | null;
  /** The fields the task was created with. Only on getTask, cancelTask and lists with `expand: "details"`. */
  payload?: Record<string, unknown> | null;
  /** Only on tasks with a consensus step; absent otherwise. */
  quorum?: Quorum | null;
  /**
   * SHA-256 (hex) of the stored payload JSON, as the audit trail records it. Only on getTask, cancelTask and lists
   * with `expand: "details"`.
   */
  payload_sha256?: string | null;
  /** `normal` or `high`: from createTask, or set by a routing rule. */
  urgency?: TaskUrgency;
  /** Tags a routing rule added (lower-case keys); empty when none. */
  tags?: string[] | null;
}

/** The routing rule that matched when a task was created, as it was named then. */
export interface RoutingRuleRef {
  id: string;
  name: string | null;
}

/** How a task was routed: `rule` is null when no routing rule matched. */
export interface CallbackRouting {
  rule: RoutingRuleRef | null;
}

/** The body TaskToHuman posts to your callback URL when a task finishes. It has no owner, deadline or payload. */
export interface CallbackTask {
  id: string;
  state: TaskState;
  task_type: string;
  title: string;
  test: boolean;
  decision: Decision | null;
  /** Only after a consensus step; absent otherwise. */
  quorum?: Quorum;
  /** `normal` or `high`: from createTask, or set by a routing rule. Optional so older bodies still type-check. */
  urgency?: TaskUrgency;
  /** Tags a routing rule added (lower-case keys); empty when none. */
  tags?: string[];
  /** The routing rule that matched when the task was created, or `{ rule: null }`. */
  routing?: CallbackRouting;
  escalations: number;
  created_at: string;
}

export interface TaskList {
  data: Task[];
  /**
   * When more tasks match than the page holds: send it as `cursor`, with the same filters, for the next page.
   * Left out on the last page.
   */
  next_cursor?: string | null;
}

/**
 * The human of one open step, for `approvers` in createTask: by id (`human`, preferred) or by email address
 * (`email`), never both.
 */
export type Approver =
  | {
      /** The step's number in the task type's chain, from 1 (see listTaskTypes). */
      step: number;
      /** The human's id (see listHumans). */
      human: string;
      email?: never;
    }
  | {
      /** The step's number in the task type's chain, from 1 (see listTaskTypes). */
      step: number;
      /** The email address of exactly one active human of the workspace. */
      email: string;
      human?: never;
    };

/** One person of a consensus step in createTask's `chain`: by id (`human`, preferred) or by email address, never both. */
export type ChainApprover = (
  | {
      /** The human's id (see listHumans). */
      human: string;
      email?: never;
    }
  | {
      /** The email address of exactly one active human of the workspace. */
      email: string;
      human?: never;
    }
) & {
  /** This person's answer, approve or reject, decides the step whatever the others say. Defaults to false. */
  can_decide_alone?: boolean;
};

/** What every step of createTask's `chain` has: how long it waits, and whether it reminds. */
interface ChainStepTiming {
  /** How long the step waits for an answer before the task moves on, in seconds: your plan's minimum to 604800. */
  wait_seconds: number;
  /** A reminder at half the wait. Defaults to true. */
  remind?: boolean;
}

/**
 * One step of createTask's `chain`: one human, by id (`human`, preferred) or by email address, or a consensus step
 * (`approvers` and `approvals_needed`).
 */
export type ChainStep = ChainStepTiming &
  (
    | { human: string; email?: never; approvers?: never; approvals_needed?: never }
    | { email: string; human?: never; approvers?: never; approvals_needed?: never }
    | {
        /** 2 to 10 different people. */
        approvers: ChainApprover[];
        /** How many approvals decide the step, from 2 to the number of approvers. Approval task types only. */
        approvals_needed: number;
        human?: never;
        email?: never;
      }
  );

/** The body of POST /v1/tasks. Unknown properties are refused by the API. */
export interface CreateTaskParams {
  /** The task type's key, in the key's workspace. */
  task_type: string;
  /** Up to 200 characters. Not encrypted and shown in notifications: keep sensitive data out of it. */
  title?: string | null;
  /** The task type's fields, up to 64 KB. */
  payload?: Record<string, unknown> | null;
  /** A public https URL that receives the decision. */
  callback_url?: string | null;
  /** 1 to 525600. */
  deadline_minutes?: number | null;
  /** The id of a human of the workspace who gets the task first. */
  owner?: string | null;
  /**
   * Only for a task type with open steps (see listTaskTypes): the human of each open step, every open step exactly
   * once and no other step. Left out of the request when undefined, null or empty.
   */
  approvers?: Approver[] | null;
  /**
   * Only for a task type with `chain_override` (see listTaskTypes; plan feature `routing.chain_override`): this task's
   * own chain, 1 to 10 steps, replacing the task type's whole chain. Not with `approvers` or `owner`. Left out of the
   * request when undefined, null or empty.
   */
  chain?: ChainStep[] | null;
  /**
   * `normal` (the default) or `high`: a high-urgency task is marked in the app and its email subjects start with
   * [Urgent]; it never changes a timer. A routing rule of the workspace may change it, and the chain and tags.
   */
  urgency?: TaskUrgency | null;
}

/**
 * The query of GET /v1/tasks. Newest first, then by id; with `finished_after`, oldest finished first, then by id.
 * Both orders are paged with `cursor`.
 */
export interface ListTasksParams {
  state?: TaskState;
  task_type?: string;
  /** ISO 8601, or a Date. */
  created_after?: string | Date;
  /** ISO 8601, or a Date. */
  created_before?: string | Date;
  /**
   * ISO 8601, or a Date. Only finished tasks whose `finished_at` is at or after this time, oldest finished first, then
   * by id. When you poll, send the latest `finished_at` you have seen minus a margin (for example one minute) and skip
   * the ids you already handled: a task can appear shortly after one with a later `finished_at`.
   */
  finished_after?: string | Date;
  /** The `next_cursor` of the page before, sent with the same filters; leave out (or null) for the first page. */
  cursor?: string | null | undefined;
  /** 1 to 100, default 50; with `expand: "details"`, 1 to 25, default 25 (a larger limit is brought down to 25). */
  limit?: number;
  /**
   * `details`, only with `finished_after`: every task exactly as getTask returns it (payload, payload_sha256, the
   * decision's comment, fields and attachments, and the comments in quorum), so a poll needs no getTask per task.
   * Without `finished_after`, the API answers 400 validation_failed.
   */
  expand?: "details";
}

/** Who a step of a task type asks. A step that is not `human` is open: name its human in `approvers`. */
export type StepAssignment = "human" | "at_creation" | "group" | (string & {});

export type TaskTypeKind = "approval" | "follow_up" | (string & {});

/** A human group of the workspace. */
export interface GroupRef {
  id: string;
  name: string | null;
}

/** One step of a task type's chain. */
export interface TaskTypeStep {
  /** The step's number in the chain, from 1: what an approver's `step` refers to. */
  step: number;
  /**
   * `human`: the task type names the human. `at_creation`: you name any human of the workspace in `approvers`.
   * `group`: you name a member of the step's group in `approvers`.
   */
  assignment: StepAssignment;
  /** Only on a group step: the group to choose from (its members: listHumans({ group: group.id })). */
  group?: GroupRef | null;
  /**
   * Only on an open consensus step: how many approvals decide it. Name between `approvals_needed` and
   * `max_approvers` different people for this step in `approvers`, one entry each.
   */
  approvals_needed?: number | null;
  /** Only on an open consensus step: the most people you may name for it. */
  max_approvers?: number | null;
}

/** The type of a task type's field: what `payload` takes for it. */
export type TaskTypeFieldType = "text" | "long_text" | "number" | "boolean" | "email" | "url" | (string & {});

/** One field of a task type: a key that createTask's `payload` takes. */
export interface TaskTypeField {
  /** The field's key in `payload`. */
  key: string;
  /** The label the person sees. */
  label: string;
  /** `text` (up to 1,000 characters), `long_text` (up to 20,000), `number`, `boolean`, `email` or `url`. */
  type: TaskTypeFieldType;
  /** True when createTask must send it. */
  required: boolean;
  /** True when it is never shown in notifications, only on the task page. */
  sensitive: boolean;
  /** True when the person may change the value before approving (decision action `edited`). */
  editable: boolean;
}

/**
 * A task type, as listTaskTypes and getTaskType show it: its key, name, kind, steps, fields and default deadline,
 * nothing else (never its callback, webhook, instructions or humans).
 */
export interface TaskType {
  /** The key to send as `task_type`. */
  key: string;
  name: string;
  kind: TaskTypeKind;
  /** The chain's steps in order. */
  steps: TaskTypeStep[];
  /** True when createTask may send its own `chain` for this task type, replacing these steps for that task. */
  chain_override: boolean;
  /** The fields a task of this type takes in `payload`, in order. */
  fields: TaskTypeField[];
  /** Minutes until a task expires when createTask sends no `deadline_minutes`; null when the type has no deadline. */
  default_deadline_minutes: number | null;
}

/** One page of GET /v1/task-types. */
export interface TaskTypeList {
  data: TaskType[];
  /** Send it as `cursor` to get the next page; null on the last page. */
  next_cursor: string | null;
}

/** One page of GET /v1/humans: `id` and `name` only, never an address. */
export interface HumanList {
  data: HumanRef[];
  /** Send it as `cursor` to get the next page; null on the last page. */
  next_cursor: string | null;
}

/** The query of GET /v1/task-types. */
export interface ListTaskTypesParams {
  /** 1 to 100, default 50. */
  limit?: number;
  /** The `next_cursor` of the page before; leave out (or null) for the first page. */
  cursor?: string | null | undefined;
}

/** The query of GET /v1/humans. */
export interface ListHumansParams {
  /** Only the members of this human group (a group id from listTaskTypes). An unknown group gives an empty list. */
  group?: string;
  /** 1 to 100, default 50. */
  limit?: number;
  /** The `next_cursor` of the page before; leave out (or null) for the first page. */
  cursor?: string | null | undefined;
}

export interface NamedRef {
  id: string;
  name: string;
}

export interface ApiKeyRef {
  id: string;
  prefix: string;
  mode: "live" | "test" | (string & {});
}

/** GET /v1/me: which organization, workspace and mode the key belongs to. */
export interface Me {
  organization: NamedRef;
  workspace: NamedRef;
  key: ApiKeyRef;
}

/** GET /v1/entitlements: a feature is true or false, a limit a whole number, null means unlimited. */
export interface Entitlements {
  plan: string | null;
  entitlements: Record<string, boolean | number | null>;
}

export interface FieldMessage {
  code: string;
  message: string;
}

/** An RFC 9457 problem document. Branch on `code`. */
export interface Problem {
  type?: string | null;
  title: string;
  status: number;
  code: string;
  errors?: Record<string, FieldMessage[]> | null;
  feature?: string | null;
  available_from?: string | null;
  reason?: string | null;
  limit?: string | null;
  max?: number | null;
  state?: string | null;
  action?: string | null;
  /** `not_enough_credits`: the credits the task would hold (the most it could cost). */
  needed?: number | null;
  /** `not_enough_credits`: the organization's free credits now. */
  available?: number | null;
  /** `not_enough_credits`: the credits open tasks hold now; they come back as those tasks end. */
  held?: number | null;
  /** `not_enough_credits`: whether automatic buying is on. */
  auto_buy?: boolean | null;
  traceId?: string | null;
}

/** A file downloaded by downloadTaskAttachment. */
export interface AttachmentFile {
  /** The file's bytes. */
  content: Uint8Array;
  /**
   * The name from the answer's Content-Disposition header, or null. Written by the person: never use it as a path as
   * it is. The API always answers application/octet-stream; the detected type is the attachment's `content_type`.
   */
  filename: string | null;
}
