import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthRequiredError, M365Auth } from '../src/oauth.js';

type FakeResponse = { status?: number; body: unknown };

function fakeFetch(responses: FakeResponse[]) {
  const calls: Array<{ url: string; form: URLSearchParams }> = [];
  let i = 0;
  const fn = (async (url: unknown, init?: { body?: string }) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    calls.push({ url: String(url), form: new URLSearchParams(init?.body ?? '') });
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
    } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

function makeAuth(responses: FakeResponse[], tokenDir = mkdtempSync(join(tmpdir(), 'email-mcp-tok-'))) {
  const { fn, calls } = fakeFetch(responses);
  const auth = new M365Auth({ account: 'work', tenant: 'corp.example', tokenDir, fetchFn: fn });
  return { auth, calls, tokenDir };
}

function seedTokens(tokenDir: string, overrides: Partial<{ accessToken: string; refreshToken: string; expiresAt: number }> = {}) {
  writeFileSync(
    join(tokenDir, 'work.json'),
    JSON.stringify({ accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() + 3_600_000, ...overrides }),
  );
}

describe('M365Auth.getAccessToken', () => {
  it('throws AuthRequiredError when no tokens are cached', async () => {
    const { auth } = makeAuth([]);
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('returns the cached access token while unexpired, without fetching', async () => {
    const { auth, calls, tokenDir } = makeAuth([]);
    seedTokens(tokenDir);
    await expect(auth.getAccessToken()).resolves.toBe('at-old');
    expect(calls.length).toBe(0);
  });

  it('refreshes an expired token and persists the new token set with 0600 perms', async () => {
    const { auth, calls, tokenDir } = makeAuth([
      { body: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 } },
    ]);
    seedTokens(tokenDir, { expiresAt: Date.now() - 1000 });
    await expect(auth.getAccessToken()).resolves.toBe('at-new');
    expect(calls[0].url).toContain('/corp.example/oauth2/v2.0/token');
    expect(calls[0].form.get('grant_type')).toBe('refresh_token');
    expect(calls[0].form.get('refresh_token')).toBe('rt-old');
    const saved = JSON.parse(readFileSync(join(tokenDir, 'work.json'), 'utf8'));
    expect(saved.refreshToken).toBe('rt-new');
    expect(statSync(join(tokenDir, 'work.json')).mode & 0o777).toBe(0o600);
  });

  it('throws AuthRequiredError when refresh is rejected', async () => {
    const { auth, tokenDir } = makeAuth([{ status: 400, body: { error: 'invalid_grant' } }]);
    seedTokens(tokenDir, { expiresAt: Date.now() - 1000 });
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('tokenState reflects cache presence and expiry without network', () => {
    const { auth, tokenDir } = makeAuth([]);
    expect(auth.tokenState()).toBe('none');
    seedTokens(tokenDir);
    expect(auth.tokenState()).toBe('valid');
    seedTokens(tokenDir, { expiresAt: Date.now() - 1000 });
    expect(auth.tokenState()).toBe('expired');
  });
});

const DEVICECODE_OK = {
  body: {
    device_code: 'dc-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://microsoft.com/devicelogin',
    interval: 0,
    expires_in: 900,
  },
};

describe('M365Auth device flow', () => {
  it('starts a flow, polls through authorization_pending to success, and saves tokens', async () => {
    const { auth, tokenDir } = makeAuth([
      DEVICECODE_OK,
      { status: 400, body: { error: 'authorization_pending' } },
      { body: { access_token: 'at-flow', refresh_token: 'rt-flow', expires_in: 3600 } },
    ]);
    const info = await auth.startDeviceFlow();
    expect(info).toEqual({ verificationUri: 'https://microsoft.com/devicelogin', userCode: 'ABCD-1234' });
    expect(auth.flowStatus()).toEqual({
      state: 'pending',
      verificationUri: 'https://microsoft.com/devicelogin',
      userCode: 'ABCD-1234',
    });
    await auth.pollPromise;
    expect(auth.flowStatus()).toEqual({ state: 'completed' });
    expect(auth.flowStatus()).toEqual({ state: 'idle' }); // terminal state reported once
    const saved = JSON.parse(readFileSync(join(tokenDir, 'work.json'), 'utf8'));
    expect(saved.accessToken).toBe('at-flow');
  });

  it('reports failure when the user denies', async () => {
    const { auth } = makeAuth([
      DEVICECODE_OK,
      { status: 400, body: { error: 'access_denied', error_description: 'user said no' } },
    ]);
    await auth.startDeviceFlow();
    await auth.pollPromise;
    expect(auth.flowStatus()).toEqual({ state: 'failed', error: 'user said no' });
  });

  it('throws when the devicecode request itself fails', async () => {
    const { auth } = makeAuth([{ status: 400, body: { error: 'invalid_client', error_description: 'bad client' } }]);
    await expect(auth.startDeviceFlow()).rejects.toThrow(/bad client/);
  });
});
