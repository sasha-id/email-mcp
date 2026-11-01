import { Readable } from 'node:stream';
import { AccountManager } from '../src/accounts.js';
import type { Config } from '../src/config.js';
import { parseRuleFile, type RuleFile } from '../src/rules/schema.js';
import { asImap, FakeImap } from './fakes.js';

export const NOW = Date.parse('2026-06-10T12:00:00Z');
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

type Addr = { name?: string; address: string };

export interface FakeMessage {
  uid: number;
  from?: Addr;
  to?: Addr[];
  cc?: Addr[];
  replyTo?: Addr[];
  subject?: string;
  date?: Date;
  internalDate?: Date;
  listId?: string;
  body?: string;
  html?: boolean;
  flags?: Set<string>;
}

interface Box {
  uidValidity: bigint;
  messages: FakeMessage[];
}

/**
 * FakeImap with real mailbox state: search filters by \Seen/since/before,
 * fetch returns envelopes for the requested uids, flag/move calls mutate.
 */
export class MailFake extends FakeImap {
  boxes = new Map<string, Box>();
  current = '';
  connectError: Error | null = null;
  /** Called inside getMailboxLock — lets a test change UIDVALIDITY between phases. */
  onLock?: (path: string, lockCount: number) => void;
  private lockCount = 0;

  constructor() {
    super();
    this.addBox('INBOX');
  }

  addBox(path: string, specialUse?: string, messages: FakeMessage[] = [], uidValidity = 1n): this {
    this.boxes.set(path, { uidValidity, messages });
    this.folders = this.folders.filter(f => f.path !== path);
    this.folders.push(specialUse ? { path, specialUse } : { path });
    return this;
  }

  box(path: string): Box {
    const b = this.boxes.get(path);
    if (!b) throw new Error(`no box ${path}`);
    return b;
  }

  add(path: string, ...messages: FakeMessage[]): this {
    this.box(path).messages.push(...messages);
    return this;
  }

  get mailbox() {
    return this.current ? { path: this.current, uidValidity: this.box(this.current).uidValidity } : false;
  }

  mutations() {
    return this.calls.filter(c => ['messageFlagsAdd', 'messageFlagsRemove', 'messageMove', 'messageDelete', 'mailboxCreate'].includes(c.method));
  }

  async connect() {
    if (this.connectError) throw this.connectError;
    await super.connect();
  }

  async getMailboxLock(path: string) {
    if (!this.boxes.has(path)) throw new Error(`Mailbox doesn't exist: ${path}`);
    this.onLock?.(path, ++this.lockCount);
    this.current = path;
    return super.getMailboxLock(path);
  }

  async search(query: unknown, opts: unknown) {
    this.calls.push({ method: 'search', args: [query, opts] });
    const q = query as { seen?: boolean; since?: Date; before?: Date };
    return this.box(this.current)
      .messages.filter(m => {
        const t = (m.internalDate ?? m.date ?? new Date(0)).getTime();
        if (q.seen === false && m.flags?.has('\\Seen')) return false;
        if (q.seen === true && !m.flags?.has('\\Seen')) return false;
        if (q.since && t < q.since.getTime()) return false;
        if (q.before && t >= q.before.getTime()) return false;
        return true;
      })
      .map(m => m.uid);
  }

  fetch(range: unknown, query: unknown, opts: unknown) {
    this.calls.push({ method: 'fetch', args: [range, query, opts] });
    const uids = new Set(range as number[]);
    const msgs = this.box(this.current).messages.filter(m => uids.has(m.uid));
    return (async function* () {
      for (const m of msgs) {
        yield {
          uid: m.uid,
          internalDate: m.internalDate ?? m.date,
          envelope: { date: m.date, subject: m.subject, from: m.from ? [m.from] : undefined, to: m.to, cc: m.cc, replyTo: m.replyTo },
          headers: Buffer.from(m.listId ? `List-Id: ${m.listId}\r\n\r\n` : '\r\n'),
        };
      }
    })();
  }

  private find(uid: unknown): FakeMessage | undefined {
    return this.box(this.current).messages.find(m => m.uid === Number(uid));
  }

  async fetchOne(range: unknown, query: unknown, opts: unknown) {
    this.calls.push({ method: 'fetchOne', args: [range, query, opts] });
    const m = this.find(range);
    if (!m) return false;
    return { uid: m.uid, bodyStructure: { part: '1', type: m.html ? 'text/html' : 'text/plain' } };
  }

  async download(range: unknown, part: string, opts: unknown) {
    this.calls.push({ method: 'download', args: [range, part, opts] });
    return { meta: {}, content: Readable.from(Buffer.from(this.find(range)?.body ?? '')) };
  }

  async messageFlagsAdd(uids: unknown, flags: unknown, opts: unknown) {
    this.calls.push({ method: 'messageFlagsAdd', args: [uids, flags, opts] });
    for (const uid of uids as number[]) {
      const m = this.find(uid);
      if (m) m.flags = new Set([...(m.flags ?? []), ...(flags as string[])]);
    }
    return true;
  }

  async messageMove(uids: unknown, target: unknown, opts: unknown) {
    this.calls.push({ method: 'messageMove', args: [uids, target, opts] });
    const src = this.box(this.current);
    const dst = this.box(target as string);
    const set = new Set(uids as number[]);
    dst.messages.push(...src.messages.filter(m => set.has(m.uid)));
    src.messages = src.messages.filter(m => !set.has(m.uid));
    return { path: target };
  }

  async mailboxCreate(path: string) {
    this.calls.push({ method: 'mailboxCreate', args: [path] });
    this.addBox(path);
    return { path, created: true };
  }
}

export function rulesConfig(): Config {
  const account = (user: string) => ({
    user,
    imap: { host: 'imap.example.com', port: 993 },
    auth: { type: 'password' as const, pass: 'x' },
    appendToSent: false,
  });
  return { accounts: { personal: account('me@example.com'), other: account('other@example.com') } };
}

/** AccountManager whose connections go to the fake registered for each account's user. */
export function managerFor(fakes: Record<string, MailFake>): AccountManager {
  const config = rulesConfig();
  const byUser = new Map(Object.entries(fakes).map(([name, fake]) => [config.accounts[name].user, fake]));
  return new AccountManager(config, {
    makeClient: opts => {
      const fake = byUser.get(opts.auth.user);
      if (!fake) throw new Error(`no fake for ${opts.auth.user}`);
      return asImap(fake);
    },
  });
}

export function ruleFile(yaml: string, path = 'rules.yml'): RuleFile {
  const r = parseRuleFile(yaml, path, Object.keys(rulesConfig().accounts));
  if (!r.file) throw new Error(r.errors.join('\n'));
  return r.file;
}

let nextUid = 100;
export function msg(over: Partial<FakeMessage> = {}): FakeMessage {
  return {
    uid: nextUid++,
    from: { name: 'Sender', address: 'sender@example.com' },
    to: [{ address: 'me@example.com' }],
    subject: 'Hello',
    date: new Date(NOW - HOUR),
    body: 'body text',
    ...over,
  };
}

export function luna(choice: string, confidence: number) {
  return () =>
    new Response(JSON.stringify({ answers: [{ choice, confidence }] }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-litellm-response-cost': '0.001' },
    });
}

export function fetchQueue(responses: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error('unexpected classifier call');
    return next();
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
