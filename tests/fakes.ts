import type { ImapFlow } from 'imapflow';
import type { Config } from '../src/config.js';
import { AccountManager, type ManagerDeps } from '../src/accounts.js';

type Call = { method: string; args: unknown[] };

export class FakeImap {
  usable = true;
  connected = false;
  calls: Call[] = [];
  lockedPaths: string[] = [];
  releasedPaths: string[] = [];

  searchResults: number[] = [];
  fetchResults: unknown[] = [];
  fetchOneResult: unknown = false;
  folders: Array<{ path: string; specialUse?: string }> = [];
  statusByPath: Record<string, { messages?: number; unseen?: number }> = {};

  private record(method: string, args: unknown[]) {
    this.calls.push({ method, args });
  }

  callsTo(method: string): Call[] {
    return this.calls.filter(c => c.method === method);
  }

  async connect() {
    this.connected = true;
    this.record('connect', []);
  }

  async logout() {
    this.connected = false;
    this.record('logout', []);
  }

  close() {
    this.connected = false;
    this.record('close', []);
  }

  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, fn: (...args: unknown[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
  }

  /** Mirrors EventEmitter semantics: an 'error' event with no listener throws. */
  emit(event: string, ...args: unknown[]) {
    const list = this.handlers.get(event) ?? [];
    if (event === 'error' && list.length === 0) throw args[0];
    for (const fn of list) fn(...args);
  }

  /** Set to make getMailboxLock throw (e.g. unknown-mailbox tests). */
  lockError: Error | null = null;

  async getMailboxLock(path: string) {
    if (this.lockError) throw this.lockError;
    this.lockedPaths.push(path);
    return { release: () => this.releasedPaths.push(path) };
  }

  async search(query: unknown, opts: unknown) {
    this.record('search', [query, opts]);
    return this.searchResults;
  }

  fetch(range: unknown, query: unknown, opts: unknown) {
    this.record('fetch', [range, query, opts]);
    const results = this.fetchResults;
    return (async function* () {
      for (const m of results) yield m;
    })();
  }

  async fetchOne(range: unknown, query: unknown, opts: unknown) {
    this.record('fetchOne', [range, query, opts]);
    return this.fetchOneResult;
  }

  async messageFlagsAdd(uids: unknown, flags: unknown, opts: unknown) {
    this.record('messageFlagsAdd', [uids, flags, opts]);
    return true;
  }

  async messageFlagsRemove(uids: unknown, flags: unknown, opts: unknown) {
    this.record('messageFlagsRemove', [uids, flags, opts]);
    return true;
  }

  async messageMove(uids: unknown, target: unknown, opts: unknown) {
    this.record('messageMove', [uids, target, opts]);
    return { path: target };
  }

  async messageDelete(uids: unknown, opts: unknown) {
    this.record('messageDelete', [uids, opts]);
    return true;
  }

  async list() {
    this.record('list', []);
    return this.folders;
  }

  async status(path: string, _query: unknown) {
    this.record('status', [path]);
    const st = this.statusByPath[path];
    if (!st) throw new Error(`no STATUS for ${path}`);
    return st;
  }

  async append(path: string, content: unknown, flags?: unknown) {
    this.record('append', [path, content, flags]);
    return { path };
  }
}

export function asImap(fake: FakeImap): ImapFlow {
  return fake as unknown as ImapFlow;
}

export function fakeConfig(): Config {
  return {
    accounts: {
      personal: {
        user: 'me@example.com',
        imap: { host: 'mail.example.com', port: 993 },
        smtp: { host: 'mail.example.com', port: 465 },
        auth: { type: 'password', pass: 'hunter2' },
        appendToSent: true,
      },
      work: {
        user: 'me@corp.example',
        imap: { host: 'outlook.office365.com', port: 993 },
        smtp: { host: 'smtp.office365.com', port: 587 },
        auth: { type: 'm365-oauth', tenant: 'corp.example' },
        appendToSent: false,
      },
    },
  };
}

/**
 * AccountManager wired to FakeImap(s). With an array, each new connection
 * consumes the next fake (the last one repeats) — used by the reconnect test.
 */
export function managerWith(fakes: FakeImap | FakeImap[], deps: Partial<ManagerDeps> = {}): AccountManager {
  const pool = Array.isArray(fakes) ? [...fakes] : [fakes];
  return new AccountManager(fakeConfig(), {
    makeClient: () => asImap(pool.length > 1 ? pool.shift()! : pool[0]),
    ...deps,
  });
}
