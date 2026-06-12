import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const THUNDERBIRD_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const SCOPES =
  'https://outlook.office365.com/IMAP.AccessAsUser.All https://outlook.office365.com/SMTP.Send offline_access';
const EXPIRY_SLACK_MS = 60_000;

export class AuthRequiredError extends Error {
  constructor(account: string) {
    super(
      `No valid Microsoft 365 token for account "${account}". Run email_authenticate with account "${account}".`,
    );
    this.name = 'AuthRequiredError';
  }
}

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface M365AuthOptions {
  account: string;
  tenant: string;
  clientId?: string;
  tokenDir?: string;
  fetchFn?: typeof fetch;
}

export class M365Auth {
  readonly account: string;
  private readonly tenant: string;
  private readonly clientId: string;
  private readonly tokenDir: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: M365AuthOptions) {
    this.account = opts.account;
    this.tenant = opts.tenant;
    this.clientId = opts.clientId ?? THUNDERBIRD_CLIENT_ID;
    this.tokenDir = opts.tokenDir ?? join(homedir(), '.config', 'email-mcp', 'tokens');
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private tokenFile(): string {
    return join(this.tokenDir, `${this.account}.json`);
  }

  private loadTokens(): TokenSet | null {
    try {
      return JSON.parse(readFileSync(this.tokenFile(), 'utf8')) as TokenSet;
    } catch {
      return null;
    }
  }

  private saveTokens(tokens: TokenSet): void {
    mkdirSync(this.tokenDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.tokenFile(), JSON.stringify(tokens), { mode: 0o600 });
    chmodSync(this.tokenFile(), 0o600); // the mode option only applies at creation — re-assert on overwrite
  }

  /** Local check only — never hits the network. 'expired' still refreshes silently on next use. */
  tokenState(): 'none' | 'valid' | 'expired' {
    const tokens = this.loadTokens();
    if (!tokens) return 'none';
    return tokens.expiresAt - EXPIRY_SLACK_MS > Date.now() ? 'valid' : 'expired';
  }

  async getAccessToken(): Promise<string> {
    const tokens = this.loadTokens();
    if (!tokens) throw new AuthRequiredError(this.account);
    if (tokens.expiresAt - EXPIRY_SLACK_MS > Date.now()) return tokens.accessToken;
    return this.refresh(tokens.refreshToken);
  }

  private endpoint(name: 'token' | 'devicecode'): string {
    return `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/${name}`;
  }

  // Form-posts to the Microsoft identity platform. Responses are read as JSON
  // even on 400 — OAuth error bodies carry the machine-readable `error` field.
  private async postForm(
    name: 'token' | 'devicecode',
    form: Record<string, string>,
  ): Promise<{ ok: boolean; data: Record<string, unknown> & { error?: string; error_description?: string } }> {
    const res = await this.fetchFn(this.endpoint(name), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    return { ok: res.ok, data: (await res.json()) as Record<string, unknown> };
  }

  private async refresh(refreshToken: string): Promise<string> {
    const { data } = await this.postForm('token', {
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: SCOPES,
    });
    if (typeof data.access_token !== 'string') throw new AuthRequiredError(this.account);
    this.saveTokens({
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken,
      expiresAt: Date.now() + (data.expires_in as number) * 1000,
    });
    return data.access_token;
  }
}
