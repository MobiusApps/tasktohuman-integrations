import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class TaskToHumanApi implements ICredentialType {
	name = 'taskToHumanApi';

	displayName = 'TaskToHuman API';

	icon: Icon = { light: 'file:../icons/tasktohuman.svg', dark: 'file:../icons/tasktohuman.dark.svg' };

	documentationUrl =
		'https://github.com/MobiusApps/tasktohuman-integrations/tree/main/n8n#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'tth_test_…',
			description:
				'A workspace API key from the TaskToHuman app (Settings → API keys). A tth_test_… key works like a live one but notifies only you: start with one.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			required: true,
			default: 'https://api.tasktohuman.com',
			description:
				'Leave the default unless TaskToHuman support gave you another address. Must start with https://.',
		},
		{
			displayName: 'Signing Secret',
			name: 'signingSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			placeholder: 'whsec_…',
			description:
				'Only for "Create and Wait for Decision": the workspace signing secret (Settings → workspace → Signing secret → Reveal or Rotate). It proves that a decision really comes from TaskToHuman. During a rotation the old and the new secret both work.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// Checks the key only: the signing secret cannot be checked through the API. A wrong secret shows up as refused
	// decisions (README, "Create and Wait for Decision").
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/me',
			method: 'GET',
		},
	};
}
