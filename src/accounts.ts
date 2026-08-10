import { ImapFlow } from 'imapflow';
import type { Account, Config, OpReader } from './config.js';
import { resolvePassword } from './config.js';
import { M365Auth } from './oauth.js';

const IDLE_MS = 5 * 60_000;

export interface ImapConnectOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass?: string; accessToken?: string };
  logger: false;
  autoSelectFamily: boolean;
}

export type MakeClient = (opts: ImapConnectOptions) => ImapFlow;

export interface ManagerDeps {
  makeClient?: MakeClient;
  opReader?: OpReader;
  tokenDir?: string;
  fetchFn?: typeof fetch;
}

export type SmtpAuth =
  | { user: string; pass: string }
  | { type: 'OAuth2'; user: string; accessToken: string };

export class AccountManager {
  private readonly clients = new Map<string, ImapFlow>();
  private readonly connecting = new Map<string, Promise<ImapFlow>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly auths = new Map<string, M365Auth>();
  private readonly makeClient: MakeClient;
  private readonly deps: ManagerDeps;

  constructor(
    readonly config: Config,
    deps: ManagerDeps = {},
  ) {
    this.deps = deps;
    // imapflow's bundled option types lag the runtime; the shape is correct.
    this.makeClient = deps.makeClient ?? (opts => new ImapFlow(opts as never));
  }

  accountNames(): string[] {
    return Object.keys(this.config.accounts);
  }

  account(name: string): Account {
    const account = this.config.accounts[name];
    if (!account) {
      throw new Error(`Unknown account "${name}". Configured accounts: ${this.accountNames().join(', ')}`);
    }
    return account;
  }

  m365(name: string): M365Auth {
    const existing = this.auths.get(name);
    if (existing) return existing;
    const account = this.account(name);
    if (account.auth.type !== 'm365-oauth') {
      throw new Error(`Account "${name}" does not use m365-oauth`);
    }
    const auth = new M365Auth({
      account: name,
      tenant: account.auth.tenant,
      clientId: account.auth.clientId,
      tokenDir: this.deps.tokenDir,
      fetchFn: this.deps.fetchFn,
    });
    this.auths.set(name, auth);
    return auth;
  }

  private async imapAuth(name: string): Promise<ImapConnectOptions['auth']> {
    const account = this.account(name);
    if (account.auth.type === 'password') {
      return { user: account.user, pass: await resolvePassword(account.auth.pass, this.deps.opReader) };
    }
    return { user: account.user, accessToken: await this.m365(name).getAccessToken() };
  }

  async smtpAuth(name: string): Promise<SmtpAuth> {
    const account = this.account(name);
    if (account.auth.type === 'password') {
      return { user: account.user, pass: await resolvePassword(account.auth.pass, this.deps.opReader) };
    }
    return { type: 'OAuth2', user: account.user, accessToken: await this.m365(name).getAccessToken() };
  }

  private touch(name: string, client: ImapFlow): void {
    clearTimeout(this.idleTimers.get(name));
    const timer = setTimeout(() => {
      this.clients.delete(name);
      this.idleTimers.delete(name);
      void client.logout().catch(() => client.close());
    }, IDLE_MS);
    timer.unref?.();
    this.idleTimers.set(name, timer);
  }

  async getClient(name: string): Promise<ImapFlow> {
    const existing = this.clients.get(name);
    if (existing?.usable) {
      this.touch(name, existing);
      return existing;
    }
    // Concurrent calls for the same account share one in-flight connection
    // attempt — otherwise the loser's socket would leak with no idle timer.
    const pending = this.connecting.get(name);
    if (pending) return pending;
    const promise = this.connect(name).finally(() => this.connecting.delete(name));
    this.connecting.set(name, promise);
    return promise;
  }

  private async connect(name: string): Promise<ImapFlow> {
    const account = this.account(name);
    const client = this.makeClient({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure ?? account.imap.port === 993,
      auth: await this.imapAuth(name),
      logger: false,
      // Dual-stack hosts with high IPv4 RTT lose Node's 250ms happy-eyeballs
      // race on every connection attempt; disable it.
      autoSelectFamily: false,
    });
    await client.connect();
    this.clients.set(name, client);
    client.on('close', () => {
      if (this.clients.get(name) === client) this.clients.delete(name);
    });
    this.touch(name, client);
    return client;
  }

  async withClient<T>(name: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.getClient(name);
    try {
      return await fn(client);
    } catch (err) {
      if (client.usable) throw err; // logical error, not a dropped connection
      this.clients.delete(name); // dropped connection: retry once on a fresh client
      const fresh = await this.getClient(name);
      return await fn(fresh);
    }
  }

  async withMailbox<T>(name: string, mailbox: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return this.withClient(name, async client => {
      let lock: { release(): void };
      try {
        lock = await client.getMailboxLock(mailbox);
      } catch {
        // Unknown mailbox is the common cause — make the error actionable.
        // (If the connection dropped instead, client.usable is false and
        // withClient retries this whole callback on a fresh client.)
        const folders = await client.list().catch(() => []);
        const available = folders.map(f => f.path).join(', ');
        throw new Error(
          `Cannot open mailbox "${mailbox}" in account "${name}"${available ? `. Available folders: ${available}` : ''}`,
        );
      }
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    });
  }

  async closeAll(): Promise<void> {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const client of this.clients.values()) {
      await client.logout().catch(() => client.close());
    }
    this.clients.clear();
  }
}
