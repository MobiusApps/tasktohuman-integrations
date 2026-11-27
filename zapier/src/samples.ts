// Samples and output field labels. The task bodies are copies of the repository's fixtures (fixtures/api/*.json, the
// docs' examples checked against the real API); test/samples.test.mjs fails when they drift apart.

/** fixtures/api/get-resolved.json: a finished, approved task with a comment. */
export const resolvedTask = {
  id: '01a1e3a7-6489-7106-aa3a-c976287f9999',
  state: 'resolved',
  task_type: 'approve_refund',
  title: 'Refund €249 to order #4821?',
  test: false,
  owner: null,
  expires_at: '2026-11-16T11:19:20.713Z',
  created_at: '2026-11-16T09:19:20.713Z',
  finished_at: '2026-11-16T09:19:54.377Z',
  escalations: 0,
  decision: {
    action: 'approved',
    by: { id: '01a1dcba-b57a-7aa2-b6b1-05d81545c2ba', name: 'Ana' },
    at: '2026-11-16T09:19:54.377Z',
    automatic: false,
    reason: null,
    comment: 'Photos confirm the damage.',
    payload: null,
  },
  payload: { order_id: '4821', amount: 249, reason: 'Arrived damaged', customer_email: 'marta@example.com' },
  payload_sha256: '77d21b5d074a3fa4dca6ed88891f798696041c64eca3e26e7d5d3a7f91d747ef',
};

/** fixtures/api/create.json: a task just created. */
export const createdTask = {
  id: '01a1e3a7-6489-7106-aa3a-c976287f9999',
  state: 'notified',
  task_type: 'approve_refund',
  title: 'Refund €249 to order #4821?',
  test: false,
  owner: { id: '01a1dcba-b57a-7aa2-b6b1-05d81545c2ba', name: 'Ana' },
  expires_at: '2026-11-16T11:19:20.7134083Z',
  created_at: '2026-11-16T09:19:20.7134083Z',
  finished_at: null,
  escalations: 0,
  decision: null,
};

/** fixtures/api/cancel.json: a cancelled task. */
export const cancelledTask = {
  id: '01a1e3a7-6cee-70ef-995d-129e212beeb0',
  state: 'cancelled',
  task_type: 'approve_refund',
  title: 'Refund request for order #4822',
  test: false,
  owner: null,
  expires_at: null,
  created_at: '2026-11-16T09:19:22.862Z',
  finished_at: '2026-11-16T09:19:30.777Z',
  escalations: 0,
  decision: {
    action: 'cancelled',
    by: null,
    at: '2026-11-16T09:19:30.7778539Z',
    automatic: false,
    reason: null,
    comment: null,
    payload: null,
  },
  payload: { order_id: '4822', amount: 249, customer_email: 'marta@example.com' },
  payload_sha256: 'c039eb0d560cb51766cf4a79e918bb20fb9985d39019df3338182d872199434a',
};

/** Labels for the common paths of a task (Zapier flattens nested keys with "__"). */
export const taskOutputFields = [
  { key: 'id', label: 'Task ID' },
  { key: 'state', label: 'State' },
  { key: 'task_type', label: 'Task Type' },
  { key: 'title', label: 'Title' },
  { key: 'test', label: 'Test Task', type: 'boolean' as const },
  { key: 'created_at', label: 'Created At', type: 'datetime' as const },
  { key: 'expires_at', label: 'Expires At', type: 'datetime' as const },
  { key: 'finished_at', label: 'Finished At', type: 'datetime' as const },
  { key: 'decision__action', label: 'Decision' },
  { key: 'decision__automatic', label: 'Decided Automatically', type: 'boolean' as const },
  { key: 'decision__comment', label: 'Comment' },
  { key: 'decision__by__name', label: 'Decided By' },
  { key: 'decision__reason', label: 'Expiry Reason' },
];

/** The trigger's de-duplication key: id and finished_at together, so a task reopened and finished again triggers again. */
export const triggerOutputFields = taskOutputFields.map((field) =>
  field.key === 'id' || field.key === 'finished_at' ? { ...field, primary: true } : field,
);
