import type { IDataObject } from 'n8n-workflow';

// The trigger's cursor logic, kept free of n8n calls so it can be tested alone.
//
// GET /v1/tasks?finished_after=T returns tasks that finished at or after T, oldest first. A task's finish time is
// the clock time when the decision was computed, not when it was saved, so with several servers (or a retried
// write) a task with an earlier time can become visible after a later one. Each poll therefore starts OVERLAP_MS
// before the latest finish time seen, and skips the tasks it already emitted (remembered for that window).

export const OVERLAP_MS = 2 * 60 * 1000;
/** New tasks handled per poll (each costs one GET for its comment and edited values); the rest come next poll. */
export const MAX_NEW_PER_POLL = 20;
/** List pages read per poll once something new was found (100 tasks each). */
export const MAX_PAGES_PER_POLL = 10;
export const PAGE_SIZE = 100;

export interface PollState extends IDataObject {
	/** The latest finish time handled (ISO 8601). Absent before the first poll. */
	cursor?: string;
	/** Tasks handled within OVERLAP_MS before the cursor: `${id}|${finished_at}` → finished_at. */
	seen?: IDataObject;
}

export interface FinishedTask extends IDataObject {
	id: string;
	finished_at?: string | null;
}

export type FetchPage = (
	finishedAfter: string,
	cursor: string | undefined,
) => Promise<{ data: FinishedTask[]; next_cursor?: string | null }>;

/** A task finishing again after support reopened it has a new finish time, so it is emitted again. */
export function seenKey(task: FinishedTask): string {
	return `${task.id}|${task.finished_at ?? ''}`;
}

export function queryStart(cursor: string): string {
	return new Date(Date.parse(cursor) - OVERLAP_MS).toISOString();
}

/**
 * Finds the tasks finished since the last poll that were not handled yet, oldest first, at most MAX_NEW_PER_POLL.
 * On the very first poll it handles nothing and only sets the cursor to now: nothing earlier is replayed.
 */
export async function findNew(
	state: PollState,
	fetchPage: FetchPage,
): Promise<{ first: true } | { first: false; tasks: FinishedTask[] }> {
	if (!state.cursor) return { first: true };
	const seen = state.seen ?? {};
	const start = queryStart(state.cursor);
	const found: FinishedTask[] = [];
	const keys = new Set<string>();
	let cursor: string | undefined;
	let pages = 0;
	do {
		const page = await fetchPage(start, cursor);
		for (const task of page.data) {
			if (!task.finished_at) continue;
			const key = seenKey(task);
			if (seen[key] !== undefined || keys.has(key)) continue;
			keys.add(key);
			found.push(task);
			if (found.length >= MAX_NEW_PER_POLL) break;
		}
		cursor = page.next_cursor ?? undefined;
		pages++;
		// Past the page cap only while nothing new was found: otherwise more than MAX_PAGES_PER_POLL pages of handled
		// tasks inside the overlap window would stop the cursor for good. Bounded by the size of that window.
	} while (cursor && found.length < MAX_NEW_PER_POLL && (pages < MAX_PAGES_PER_POLL || found.length === 0));
	return { first: false, tasks: found };
}

/** The state after handling `handled` (emitted or filtered out): cursor moved forward, old entries dropped. */
export function advance(state: PollState, handled: FinishedTask[], now: Date): PollState {
	if (!state.cursor) return { cursor: now.toISOString(), seen: {} };
	let cursorTime = Date.parse(state.cursor);
	for (const task of handled) {
		const time = Date.parse(task.finished_at ?? '');
		if (!Number.isNaN(time) && time > cursorTime) cursorTime = time;
	}
	const keepFrom = cursorTime - OVERLAP_MS;
	const seen: IDataObject = {};
	const all: Array<[string, unknown]> = [
		...Object.entries(state.seen ?? {}),
		...handled.map((task): [string, unknown] => [seenKey(task), task.finished_at]),
	];
	for (const [key, finishedAt] of all) {
		const time = Date.parse(String(finishedAt));
		if (!Number.isNaN(time) && time >= keepFrom) seen[key] = String(finishedAt);
	}
	return { cursor: new Date(cursorTime).toISOString(), seen };
}

/** The trigger's filters: outcomes (empty = all) and whether automatic outcomes count. */
export function matchesFilters(
	task: IDataObject,
	filters: { outcomes: string[]; includeAutomatic: boolean },
): boolean {
	const decision = (task.decision ?? null) as { action?: unknown; automatic?: unknown } | null;
	if (!filters.includeAutomatic && decision?.automatic === true) return false;
	if (filters.outcomes.length === 0) return true;
	return typeof decision?.action === 'string' && filters.outcomes.includes(decision.action);
}

/** Drops the task's fields unless the user asked for them (sensitive values would end up in n8n's execution log). */
export function withoutPayload(task: IDataObject): IDataObject {
	const copy: IDataObject = { ...task };
	delete copy.payload;
	return copy;
}
