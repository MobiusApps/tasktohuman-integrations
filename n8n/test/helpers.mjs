// Small hand-written fakes of n8n's function contexts, and access to the built code (dist/, CommonJS).
// No network: every HTTP call goes to the `routes` function a test gives.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const load = (path) => require(`../dist/${path}`);

/** n8n-workflow's CommonJS build, the one the node loads (its ESM build does not load under plain Node). */
export const n8nWorkflow = require('n8n-workflow');

/** A fake of n8n's execution custom data (`this.customData`) around a plain object. */
export const fakeCustomData = (store = {}) => ({
	store,
	set(key, value) {
		store[key] = String(value);
	},
	get: (key) => store[key],
	getAll: () => ({ ...store }),
});

export const fixture = (name) =>
	JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'));

export const API_KEY = 'tth_test_FAKE_n8n_key_not_real';
export const SECRET = 'whsec_docs_example_not_a_secret';

export const credentials = (extra = {}) => ({
	apiKey: API_KEY,
	baseUrl: 'https://api.example.test/',
	signingSecret: SECRET,
	...extra,
});

export const json = (status, body, headers = {}) => ({ statusCode: status, body, headers });

/**
 * A fake IExecuteFunctions / IPollFunctions / ILoadOptionsFunctions.
 * - params: node parameters; a function value is called with the item index.
 * - routes(options): returns { statusCode, body, headers } for a request (options as the node sent them).
 */
export function fakeContext({
	params = {},
	items = [{ json: {} }],
	routes = () => json(500, {}),
	creds = credentials(),
	mode = 'trigger',
	continueOnFail = false,
	staticData = {},
	customData = {},
} = {}) {
	const calls = [];
	const waits = [];
	const warnings = [];
	const node = { id: 'node-1', name: 'TaskToHuman', type: 'n8n-nodes-tasktohuman.taskToHuman', typeVersion: 1, parameters: {} };
	const context = {
		calls,
		waits,
		warnings,
		staticData,
		customData: fakeCustomData(customData),
		getNode: () => node,
		getInputData: () => items,
		getExecutionId: () => 'exec-42',
		getMode: () => mode,
		continueOnFail: () => continueOnFail,
		getCredentials: async () => creds,
		getWorkflowStaticData: () => staticData,
		getSignedResumeUrl: () => 'https://n8n.example.test/webhook-waiting/exec-42/node-1?signature=abc',
		putExecutionToWait: async (date) => {
			waits.push(date);
		},
		logger: { warn: (message) => warnings.push(message), debug() {}, info() {}, error() {} },
		getNodeParameter(name, indexOrFallback, fallback, options) {
			// Execute: (name, itemIndex, fallback, options). Poll: (name, fallback, options).
			const pollStyle = typeof indexOrFallback !== 'number';
			const def = pollStyle ? indexOrFallback : fallback;
			const opts = pollStyle ? fallback : options;
			let value = name in params ? params[name] : def;
			if (typeof value === 'function') value = value(pollStyle ? 0 : indexOrFallback);
			if (opts?.extractValue && value && typeof value === 'object' && 'value' in value) value = value.value;
			return value;
		},
		getCurrentNodeParameter: (name) => params[name],
		helpers: {
			async httpRequestWithAuthentication(credentialType, options) {
				calls.push({ credentialType, ...options });
				return routes(options, calls.length);
			},
		},
	};
	return context;
}

/**
 * A fake IWebhookFunctions around a request with a raw body and headers. waitingFor: the id of the task the waiting
 * execution created (kept in its custom data under the key for node-1).
 */
export function fakeWebhook({ rawBody, headers = {}, creds = credentials(), waitingFor }) {
	const response = { statusCode: 200, ended: false };
	const res = {
		status(code) {
			response.statusCode = code;
			return res;
		},
		end() {
			response.ended = true;
			return res;
		},
	};
	const warnings = [];
	return {
		response,
		warnings,
		getRequestObject: () => ({ rawBody, headers }),
		getResponseObject: () => res,
		getCredentials: async () => creds,
		getNode: () => ({ id: 'node-1', name: 'TaskToHuman' }),
		customData: fakeCustomData(waitingFor === undefined ? {} : { tth_task_node_1: waitingFor }),
		logger: { warn: (message) => warnings.push(message) },
	};
}

/** Signs a body the way TaskToHuman does: HMAC-SHA256 of `${t}.${body}` with the secret. */
export async function sign(body, t = Math.floor(Date.now() / 1000), secret = SECRET) {
	const { createHmac } = await import('node:crypto');
	return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}
