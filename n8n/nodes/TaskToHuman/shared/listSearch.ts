import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { describeFailure, requestRaw, toNodeApiError } from './api';

interface TaskTypePage {
	data: Array<{ key: string; name: string }>;
	next_cursor: string | null;
}

/** Pages read at most for one search, when the earlier pages hold no match. */
export const MAX_SEARCH_PAGES = 10;

/**
 * "From List" for Task Type: GET /v1/task-types, filtered by name or key on this side. With a search text, reads on
 * (up to MAX_SEARCH_PAGES pages) until a page has a match: n8n asks for the next page only when the list is scrolled,
 * and an empty list cannot be.
 */
export async function searchTaskTypes(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const needle = (filter ?? '').trim().toLowerCase();
	let cursor = paginationToken;
	let results: INodeListSearchResult['results'] = [];
	for (let pages = 0; pages < MAX_SEARCH_PAGES; pages++) {
		const page = await fetchTaskTypes.call(this, cursor);
		results = page.data
			.filter(
				(type) =>
					needle === '' || type.name.toLowerCase().includes(needle) || type.key.toLowerCase().includes(needle),
			)
			.map((type) => ({ name: `${type.name} (${type.key})`, value: type.key }));
		cursor = page.next_cursor ?? undefined;
		if (results.length > 0 || needle === '' || !cursor) break;
	}
	return { results, paginationToken: cursor };
}

async function fetchTaskTypes(this: ILoadOptionsFunctions, cursor: string | undefined): Promise<TaskTypePage> {
	const response = await requestRaw.call(this, 'GET', '/v1/task-types', {
		qs: cursor ? { limit: 100, cursor } : { limit: 100 },
	});
	if (response.status === 403 && (response.body as { code?: unknown } | null)?.code === 'feature_not_in_plan') {
		throw new NodeOperationError(
			this.getNode(),
			'Your plan does not list task types through the API. Choose "By Key" and type the task type\'s key (shown on the task type in the TaskToHuman app).',
		);
	}
	if (response.status < 200 || response.status >= 300) {
		throw toNodeApiError(this.getNode(), describeFailure(response));
	}
	return response.body as TaskTypePage;
}
