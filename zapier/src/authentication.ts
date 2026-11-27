// API key authentication: the key is a password field (Zapier hides it on entry and censors it in its logs), sent
// only as the Authorization header by addHeaders (api.ts). The test is GET /v1/me; the label names the workspace and
// whether the key is a test or a live key, never the key itself.
import type { Bundle, ZObject } from 'zapier-platform-core';
import { call } from './api.js';

interface Me {
  workspace?: { name?: string | null };
  key?: { mode?: string };
}

export async function testAuth(z: ZObject): Promise<Me> {
  return call<Me>(z, 'GET', '/v1/me');
}

/** "Shop · Test" or "Shop · Live". Zapier hands the test's answer in as inputData. */
export async function connectionLabel(_z: ZObject, bundle: Bundle): Promise<string> {
  const me = (bundle.inputData ?? {}) as Me & { 'workspace__name'?: string; 'key__mode'?: string };
  const name = me.workspace?.name ?? me.workspace__name ?? 'TaskToHuman';
  const mode = me.key?.mode ?? me.key__mode;
  return `${name} · ${mode === 'test' ? 'Test' : 'Live'}`;
}

export const authentication = {
  type: 'custom' as const,
  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password' as const,
      required: true,
      helpText:
        'A `tth_live_…` or `tth_test_…` key from TaskToHuman → Developers → API keys. Create one key just for Zapier so you can revoke it alone. A test key notifies only you and its tasks end quickly.',
    },
  ],
  test: testAuth,
  connectionLabel,
};
