import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerAuthenticate } from '../src/tools/authenticate.js';
import { FakeImap, managerWith } from './fakes.js';
import { connectServer, isError, textOf } from './mcp.js';

type FakeResponse = { status?: number; body: unknown };

function fetchQueue(responses: FakeResponse[]): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as Response;
  }) as typeof fetch;
}

const DEVICECODE_OK: FakeResponse = {
  body: {
    device_code: 'dc-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://microsoft.com/devicelogin',
    interval: 0,
    expires_in: 900,
  },
};

function makeDeps(responses: FakeResponse[]) {
  return { tokenDir: mkdtempSync(join(tmpdir(), 'email-mcp-tok-')), fetchFn: fetchQueue(responses) };
}

describe('email_authenticate', () => {
  it('rejects password accounts', async () => {
    const manager = managerWith(new FakeImap(), makeDeps([]));
    const client = await connectServer(server => registerAuthenticate(server, manager));
    const result = await client.callTool({ name: 'email_authenticate', arguments: { account: 'personal' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/password auth/);
  });

  it('starts a device flow and reports pending status on the next call', async () => {
    const responses: FakeResponse[] = [DEVICECODE_OK, { status: 400, body: { error: 'authorization_pending' } }];
    const manager = managerWith(new FakeImap(), makeDeps(responses));
    const client = await connectServer(server => registerAuthenticate(server, manager));

    const start = await client.callTool({ name: 'email_authenticate', arguments: { account: 'work' } });
    expect(isError(start)).toBe(false);
    expect(textOf(start)).toContain('https://microsoft.com/devicelogin');
    expect(textOf(start)).toContain('ABCD-1234');

    const status = await client.callTool({ name: 'email_authenticate', arguments: { account: 'work' } });
    expect(textOf(status)).toContain('still pending');

    // stop the background poll so it doesn't spin for the rest of the suite:
    // the fetch queue repeats its last entry, so a pushed terminal error ends the loop
    responses.push({ status: 400, body: { error: 'expired_token' } });
    await manager.m365('work').pollPromise;
  });

  it('reports completion after the user finishes login', async () => {
    const manager = managerWith(
      new FakeImap(),
      makeDeps([DEVICECODE_OK, { body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } }]),
    );
    const client = await connectServer(server => registerAuthenticate(server, manager));
    await client.callTool({ name: 'email_authenticate', arguments: { account: 'work' } });
    await manager.m365('work').pollPromise; // wait out the background poll
    const result = await client.callTool({ name: 'email_authenticate', arguments: { account: 'work' } });
    expect(textOf(result)).toContain('completed');
  });
});
