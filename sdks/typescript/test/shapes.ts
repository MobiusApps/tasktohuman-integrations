// One record per SDK type, listing every key with whether it is optional and whether it can be null. The record's
// type is computed from the SDK type, so the compiler refuses a missing key, an extra key or a wrong label: these
// records always describe the SDK types exactly. spec.test.ts then compares them with openapi/public-v1.json.
import type {
  ApiKeyRef,
  Approver,
  Attachment,
  CallbackRouting,
  CallbackTask,
  ChainApprover,
  ChainStep,
  CreateTaskParams,
  Decision,
  Entitlements,
  FieldMessage,
  GroupRef,
  HumanList,
  HumanRef,
  ListHumansParams,
  ListTaskTypesParams,
  ListTasksParams,
  Me,
  NamedRef,
  Problem,
  Quorum,
  QuorumAnswer,
  RoutingRuleRef,
  Task,
  TaskList,
  TaskType,
  TaskTypeField,
  TaskTypeList,
  TaskTypeStep,
} from "../src/index.js";

type Presence<T, K extends keyof T> = {} extends Pick<T, K> ? "optional" : "required";
type Nullability<T, K extends keyof T> = null extends T[K] ? "nullable" : "non-null";
export type Shape<T> = { [K in keyof Required<T>]: readonly [Presence<T, K>, Nullability<T, K>] };

export const TASK_KEYS: Shape<Task> = {
  id: ["required", "non-null"],
  state: ["required", "non-null"],
  task_type: ["required", "non-null"],
  title: ["required", "non-null"],
  test: ["required", "non-null"],
  owner: ["required", "nullable"],
  expires_at: ["required", "nullable"],
  created_at: ["required", "non-null"],
  finished_at: ["required", "nullable"],
  escalations: ["required", "non-null"],
  decision: ["required", "nullable"],
  payload: ["optional", "nullable"],
  quorum: ["optional", "nullable"],
  payload_sha256: ["optional", "nullable"],
  urgency: ["optional", "non-null"],
  tags: ["optional", "nullable"],
};

export const DECISION_KEYS: Shape<Decision> = {
  action: ["required", "non-null"],
  by: ["required", "nullable"],
  at: ["required", "non-null"],
  automatic: ["required", "non-null"],
  reason: ["required", "nullable"],
  comment: ["required", "nullable"],
  payload: ["required", "nullable"],
  fields: ["optional", "nullable"],
  attachments: ["optional", "nullable"],
};

export const ATTACHMENT_KEYS: Shape<Attachment> = {
  id: ["required", "non-null"],
  field: ["required", "non-null"],
  name: ["required", "non-null"],
  size: ["required", "non-null"],
  content_type: ["required", "non-null"],
  sha256: ["required", "non-null"],
  url: ["required", "non-null"],
  removed: ["optional", "non-null"],
  removed_at: ["optional", "nullable"],
  removed_reason: ["optional", "nullable"],
};

export const HUMAN_REF_KEYS: Shape<HumanRef> = {
  id: ["required", "non-null"],
  name: ["required", "nullable"],
};

export const QUORUM_KEYS: Shape<Quorum> = {
  needed: ["required", "non-null"],
  approvals: ["required", "non-null"],
  rejections: ["required", "non-null"],
  outcome: ["required", "nullable"],
  answers: ["required", "non-null"],
};

export const QUORUM_ANSWER_KEYS: Shape<QuorumAnswer> = {
  by: ["required", "non-null"],
  override: ["required", "non-null"],
  answer: ["required", "nullable"],
  at: ["required", "nullable"],
  comment: ["required", "nullable"],
};

export const TASK_LIST_KEYS: Shape<TaskList> = {
  data: ["required", "non-null"],
  next_cursor: ["optional", "nullable"],
};

export const CREATE_TASK_KEYS: Shape<CreateTaskParams> = {
  task_type: ["required", "non-null"],
  title: ["optional", "nullable"],
  payload: ["optional", "nullable"],
  callback_url: ["optional", "nullable"],
  deadline_minutes: ["optional", "nullable"],
  owner: ["optional", "nullable"],
  approvers: ["optional", "nullable"],
  chain: ["optional", "nullable"],
  urgency: ["optional", "nullable"],
};

/** The keys of one `approvers` entry; `human` and `email` exclude each other in the SDK type. */
export const APPROVER_KEYS: readonly (keyof Approver)[] = ["step", "human", "email"];

/** The keys of one `chain` step; one person and a consensus step exclude each other in the SDK type. */
export const CHAIN_STEP_KEYS: readonly (keyof ChainStep)[] = [
  "human",
  "email",
  "approvers",
  "approvals_needed",
  "wait_seconds",
  "remind",
];

/** The keys of one person of a consensus `chain` step. */
export const CHAIN_APPROVER_KEYS: readonly (keyof ChainApprover)[] = ["human", "email", "can_decide_alone"];

export const LIST_TASKS_KEYS: Shape<ListTasksParams> = {
  state: ["optional", "non-null"],
  task_type: ["optional", "non-null"],
  created_after: ["optional", "non-null"],
  created_before: ["optional", "non-null"],
  finished_after: ["optional", "non-null"],
  cursor: ["optional", "nullable"],
  limit: ["optional", "non-null"],
  expand: ["optional", "non-null"],
};

export const LIST_TASK_TYPES_KEYS: Shape<ListTaskTypesParams> = {
  limit: ["optional", "non-null"],
  cursor: ["optional", "nullable"],
};

export const LIST_HUMANS_KEYS: Shape<ListHumansParams> = {
  group: ["optional", "non-null"],
  limit: ["optional", "non-null"],
  cursor: ["optional", "nullable"],
};

export const TASK_TYPE_LIST_KEYS: Shape<TaskTypeList> = {
  data: ["required", "non-null"],
  next_cursor: ["required", "nullable"],
};

export const TASK_TYPE_KEYS: Shape<TaskType> = {
  key: ["required", "non-null"],
  name: ["required", "non-null"],
  kind: ["required", "non-null"],
  steps: ["required", "non-null"],
  chain_override: ["required", "non-null"],
  fields: ["required", "non-null"],
  default_deadline_minutes: ["required", "nullable"],
};

export const TASK_TYPE_FIELD_KEYS: Shape<TaskTypeField> = {
  key: ["required", "non-null"],
  label: ["required", "non-null"],
  type: ["required", "non-null"],
  required: ["required", "non-null"],
  sensitive: ["required", "non-null"],
  editable: ["required", "non-null"],
};

export const TASK_TYPE_STEP_KEYS: Shape<TaskTypeStep> = {
  step: ["required", "non-null"],
  assignment: ["required", "non-null"],
  group: ["optional", "nullable"],
  approvals_needed: ["optional", "nullable"],
  max_approvers: ["optional", "nullable"],
};

export const GROUP_REF_KEYS: Shape<GroupRef> = {
  id: ["required", "non-null"],
  name: ["required", "nullable"],
};

export const HUMAN_LIST_KEYS: Shape<HumanList> = {
  data: ["required", "non-null"],
  next_cursor: ["required", "nullable"],
};

export const PROBLEM_KEYS: Shape<Problem> = {
  type: ["optional", "nullable"],
  title: ["required", "non-null"],
  status: ["required", "non-null"],
  code: ["required", "non-null"],
  errors: ["optional", "nullable"],
  feature: ["optional", "nullable"],
  available_from: ["optional", "nullable"],
  reason: ["optional", "nullable"],
  limit: ["optional", "nullable"],
  max: ["optional", "nullable"],
  state: ["optional", "nullable"],
  action: ["optional", "nullable"],
  needed: ["optional", "nullable"],
  available: ["optional", "nullable"],
  held: ["optional", "nullable"],
  auto_buy: ["optional", "nullable"],
  traceId: ["optional", "nullable"],
};

export const FIELD_MESSAGE_KEYS: Shape<FieldMessage> = {
  code: ["required", "non-null"],
  message: ["required", "non-null"],
};

export const ME_KEYS: Shape<Me> = {
  organization: ["required", "non-null"],
  workspace: ["required", "non-null"],
  key: ["required", "non-null"],
};

export const NAMED_REF_KEYS: Shape<NamedRef> = {
  id: ["required", "non-null"],
  name: ["required", "non-null"],
};

export const API_KEY_REF_KEYS: Shape<ApiKeyRef> = {
  id: ["required", "non-null"],
  prefix: ["required", "non-null"],
  mode: ["required", "non-null"],
};

export const ENTITLEMENTS_KEYS: Shape<Entitlements> = {
  plan: ["required", "nullable"],
  entitlements: ["required", "non-null"],
};

/** Not in the OpenAPI file: checked against the signature vectors' body in verify.test.ts. */
export const CALLBACK_TASK_KEYS: Shape<CallbackTask> = {
  id: ["required", "non-null"],
  state: ["required", "non-null"],
  task_type: ["required", "non-null"],
  title: ["required", "non-null"],
  test: ["required", "non-null"],
  decision: ["required", "nullable"],
  quorum: ["optional", "non-null"],
  urgency: ["optional", "non-null"],
  tags: ["optional", "non-null"],
  routing: ["optional", "non-null"],
  escalations: ["required", "non-null"],
  created_at: ["required", "non-null"],
};

/** Not in the OpenAPI file: checked against the signature vectors' body in verify.test.ts. */
export const CALLBACK_ROUTING_KEYS: Shape<CallbackRouting> = {
  rule: ["required", "nullable"],
};

/** Not in the OpenAPI file: checked against the signature vectors' body in verify.test.ts. */
export const ROUTING_RULE_REF_KEYS: Shape<RoutingRuleRef> = {
  id: ["required", "non-null"],
  name: ["required", "nullable"],
};
