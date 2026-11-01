import type { ImapFlow, ListResponse } from 'imapflow';
import type { AccountManager } from '../accounts.js';
import { formatAddress, type AddressLike } from '../render.js';
import { buildSearchQuery } from '../search.js';
import { analyzeStructure, type StructureNode } from '../structure.js';
import { bodyText } from '../tools/read.js';
import { buildClassifierInput, ClassifierClient, DEFAULT_BASE_URL, verdictAction } from './classifier.js';
import type { Action, Conditions, RuleFile } from './schema.js';
import { RunState, stateKey } from './state.js';

/** Messages fetched per FETCH command; candidates beyond this are paged, never dropped. */
export const PAGE_SIZE = 200;
const DAY_MS = 86_400_000;
const SENT_THREAD_DAYS = 90;
const SENT_RECIPIENT_DAYS = 180;

export interface RunOptions {
  files: RuleFile[];
  dryRun: boolean;
  /** Restrict to these accounts (intersected with each file's accounts). */
  accounts?: string[];
  since?: string;
  includeRead: boolean;
  noClassifier: boolean;
  state: RunState;
}

export interface EngineDeps {
  manager: AccountManager;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** One line per planned/applied message. */
  out?: (line: string) => void;
}

export interface MessageReport {
  account: string;
  mailbox: string;
  uid: number;
  date: string | null;
  from: string;
  subject: string;
  decided_by: string;
  via?: string;
  verdict?: string;
  confidence?: number;
  latency_ms?: number;
  tokens?: { input?: number; output?: number };
  cost?: number;
  classifier_error?: string;
  action: string;
  folder_missing?: true;
  skipped?: 'uidvalidity_changed';
}

export interface AccountReport {
  ok: boolean;
  error?: string;
  scanned: number;
  skipped_kept: number;
  actions: Record<string, { action: string; count: number }>;
  classifier: { calls: number; errors: number; cost: number };
}

export interface Report {
  started: string;
  finished: string;
  dry_run: boolean;
  files: string[];
  warnings: string[];
  accounts: Record<string, AccountReport>;
  messages: MessageReport[];
}

interface Candidate {
  uid: number;
  date?: Date;
  internalDate?: Date;
  from?: AddressLike;
  to: AddressLike[];
  cc: AddressLike[];
  replyTo: AddressLike[];
  subject: string;
  listId: string;
  /** Lazily fetched; undefined until a body condition or the classifier needs it. */
  body?: string;
}

interface Plan {
  candidate: Candidate;
  key: string;
  action: Action;
  report: MessageReport;
}

export function actionLabel(a: Action): string {
  if (a.kind === 'move') return `move:${a.folder}${a.read ? '+read' : ''}`;
  return a.kind;
}

export function normalizeSubject(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const stripped = s.replace(/^((re|fwd?|aw)\s*:|\[external\])\s*/i, '');
    if (stripped === s) break;
    s = stripped;
  }
  return s.replace(/\s+/g, ' ').toLowerCase();
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseListId(headers: Buffer | undefined): string {
  if (!headers) return '';
  const m = /^list-id:\s*((?:.*)(?:\r?\n[ \t].*)*)/im.exec(headers.toString('utf8'));
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
}

interface FetchedEnvelope {
  uid: number;
  internalDate?: Date | string;
  envelope?: {
    date?: Date;
    subject?: string;
    from?: AddressLike[];
    to?: AddressLike[];
    cc?: AddressLike[];
    replyTo?: AddressLike[];
  };
  headers?: Buffer;
}

function toCandidate(m: FetchedEnvelope): Candidate {
  const e = m.envelope ?? {};
  return {
    uid: m.uid,
    date: e.date ? new Date(e.date) : undefined,
    internalDate: m.internalDate ? new Date(m.internalDate) : undefined,
    from: e.from?.[0],
    to: e.to ?? [],
    cc: e.cc ?? [],
    replyTo: e.replyTo ?? [],
    subject: e.subject ?? '',
    listId: parseListId(m.headers),
  };
}

/** Search, then fetch envelopes in pages of PAGE_SIZE so no candidate is silently dropped. */
async function fetchCandidates(client: ImapFlow, query: Record<string, unknown>, where: string): Promise<Candidate[]> {
  const uids = await client.search(query, { uid: true });
  if (!uids) throw new Error(`Search failed in ${where}`);
  const sorted = [...uids].sort((a, b) => a - b);
  const out: Candidate[] = [];
  for (let i = 0; i < sorted.length; i += PAGE_SIZE) {
    const page = sorted.slice(i, i + PAGE_SIZE);
    for await (const msg of client.fetch(
      page,
      { uid: true, envelope: true, internalDate: true, headers: ['list-id'] },
      { uid: true },
    )) {
      out.push(toCandidate(msg as unknown as FetchedEnvelope));
    }
  }
  return out;
}

function currentUidValidity(client: ImapFlow): string {
  return client.mailbox ? String(client.mailbox.uidValidity) : '';
}

/** Arrival time where the server reports it, else the Date header. */
function messageTime(c: Candidate): number | undefined {
  return (c.internalDate ?? c.date)?.getTime();
}

function errorMessage(err: unknown): string {
  if (err instanceof AggregateError) {
    const inner = err.errors.map(e => (e instanceof Error ? e.message : String(e))).join('; ');
    return err.message ? `${err.message}: ${inner}` : inner;
  }
  return err instanceof Error ? err.message : String(err);
}

class AccountRun {
  folders: ListResponse[] = [];
  private sent?: { subjects: Set<string>; recipients: Set<string> };

  constructor(
    readonly name: string,
    readonly report: AccountReport,
    private readonly engine: Engine,
  ) {}

  has(path: string): boolean {
    return this.folders.some(f => f.path === path);
  }

  special(use: string): string | undefined {
    return this.folders.find(f => f.specialUse === use)?.path;
  }

  async sentSets(): Promise<{ subjects: Set<string>; recipients: Set<string> }> {
    if (this.sent) return this.sent;
    const subjects = new Set<string>();
    const recipients = new Set<string>();
    this.sent = { subjects, recipients };
    const sentPath = this.special('\\Sent');
    if (!sentPath) {
      this.engine.warn(`${this.name}: no \\Sent folder — sent_thread/sent_recipient never match`);
      return this.sent;
    }
    const now = this.engine.now();
    const threadCutoff = now - SENT_THREAD_DAYS * DAY_MS;
    const sent = await this.engine.manager.withMailbox(this.name, sentPath, client =>
      fetchCandidates(client, buildSearchQuery({ since: day(now - SENT_RECIPIENT_DAYS * DAY_MS) }), `${this.name}/${sentPath}`),
    );
    for (const m of sent) {
      for (const a of [...m.to, ...m.cc]) if (a.address) recipients.add(a.address.toLowerCase());
      const t = messageTime(m);
      if (m.subject && t !== undefined && t >= threadCutoff) subjects.add(normalizeSubject(m.subject));
    }
    return this.sent;
  }

  /** Tally under the deciding id; an id that led to a second action (e.g. a low-confidence verdict) gets `id->action`. */
  count(id: string, action: string, n = 1): void {
    const existing = this.report.actions[id];
    const key = !existing || existing.action === action ? id : `${id}->${action}`;
    this.report.actions[key] ??= { action, count: 0 };
    this.report.actions[key].count += n;
  }
}

class Engine {
  readonly manager: AccountManager;
  readonly now: () => number;
  readonly report: Report;
  private readonly classifiers = new Map<string, ClassifierClient>();
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(
    private readonly opts: RunOptions,
    private readonly deps: EngineDeps,
  ) {
    this.manager = deps.manager;
    this.now = deps.now ?? Date.now;
    const env = deps.env ?? process.env;
    this.apiKey = env.LITELLM_API_KEY || undefined;
    this.report = {
      started: new Date(this.now()).toISOString(),
      finished: '',
      dry_run: opts.dryRun,
      files: opts.files.map(f => f.path),
      warnings: [],
      accounts: {},
      messages: [],
    };
    if (!opts.noClassifier && !this.apiKey && opts.files.some(f => f.classifier)) {
      this.warn('LITELLM_API_KEY is not set — classifier skipped for this run (default_action applies)');
    }
    this.baseUrl = env.LITELLM_BASE_URL || DEFAULT_BASE_URL;
  }

  warn(msg: string): void {
    this.report.warnings.push(msg);
  }

  private classifier(file: RuleFile): ClassifierClient | null {
    if (!file.classifier || this.opts.noClassifier || !this.apiKey) return null;
    const provider = file.classifier.provider;
    let client = this.classifiers.get(provider);
    if (!client) {
      client = new ClassifierClient(provider, {
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        fetchFn: this.deps.fetchFn,
        sleep: this.deps.sleep,
        now: this.deps.now,
      });
      this.classifiers.set(provider, client);
    }
    return client;
  }

  private accountReport(name: string): AccountReport {
    this.report.accounts[name] ??= {
      ok: true,
      scanned: 0,
      skipped_kept: 0,
      actions: {},
      classifier: { calls: 0, errors: 0, cost: 0 },
    };
    return this.report.accounts[name];
  }

  async run(): Promise<Report> {
    for (const file of this.opts.files) {
      const accounts = file.accounts.filter(a => !this.opts.accounts || this.opts.accounts.includes(a));
      for (const name of accounts) {
        const report = this.accountReport(name);
        if (!report.ok) continue; // already failed under an earlier file
        const acct = new AccountRun(name, report, this);
        try {
          acct.folders = await this.manager.withClient(name, client => client.list());
          for (const mailbox of file.mailboxes) await this.processMailbox(file, acct, mailbox);
          for (const purge of file.purge) await this.purge(acct, purge.folder, purge.older_than);
          if (file.sweep_trash_unread) await this.sweepTrash(acct);
        } catch (err) {
          report.ok = false;
          report.error = errorMessage(err);
        }
      }
    }
    this.report.finished = new Date(this.now()).toISOString();
    return this.report;
  }

  private async body(acct: AccountRun, mailbox: string, c: Candidate): Promise<string> {
    if (c.body !== undefined) return c.body;
    c.body = await this.manager.withMailbox(acct.name, mailbox, async client => {
      const meta = (await client.fetchOne(String(c.uid), { bodyStructure: true }, { uid: true })) as
        | { bodyStructure?: StructureNode }
        | false;
      if (!meta || !meta.bodyStructure) return '';
      return (await bodyText(client, c.uid, analyzeStructure(meta.bodyStructure))) ?? '';
    });
    return c.body;
  }

  private async matches(when: Conditions, acct: AccountRun, mailbox: string, c: Candidate): Promise<boolean> {
    const address = c.from?.address ?? '';
    const anyOf = (re: RegExp, list: AddressLike[]) => list.some(a => re.test(a.address ?? ''));
    if (when.from && !when.from.test(address)) return false;
    if (when.from_not && when.from_not.test(address)) return false;
    if (when.from_name && !when.from_name.test(c.from?.name ?? '')) return false;
    if (when.subject && !when.subject.test(c.subject)) return false;
    if (when.subject_not && when.subject_not.test(c.subject)) return false;
    if (when.to && !anyOf(when.to, c.to)) return false;
    if (when.cc && !anyOf(when.cc, c.cc)) return false;
    if (when.to_cc && !anyOf(when.to_cc, [...c.to, ...c.cc])) return false;
    if (when.list_id && !when.list_id.test(c.listId)) return false;
    if (when.older_than !== undefined) {
      const t = messageTime(c);
      if (t === undefined || this.now() - t < when.older_than) return false;
    }
    if (when.sent_thread !== undefined) {
      const { subjects } = await acct.sentSets();
      if (subjects.has(normalizeSubject(c.subject)) !== when.sent_thread) return false;
    }
    if (when.sent_recipient !== undefined) {
      const { recipients } = await acct.sentSets();
      if (recipients.has(address.toLowerCase()) !== when.sent_recipient) return false;
    }
    // Last: the only condition that costs a body download.
    if (when.body && !when.body.test(await this.body(acct, mailbox, c))) return false;
    return true;
  }

  private async classify(
    file: RuleFile,
    acct: AccountRun,
    mailbox: string,
    c: Candidate,
    base: MessageReport,
  ): Promise<{ action: Action; report: MessageReport }> {
    // A classifier failure must never trash mail.
    const fallback: Action = file.default_action.kind === 'trash' ? { kind: 'keep' } : file.default_action;
    if (this.opts.noClassifier || mailbox === acct.special('\\Junk')) {
      return { action: file.default_action, report: { ...base, decided_by: 'default' } };
    }
    const client = this.classifier(file);
    if (!client) return { action: fallback, report: { ...base, decided_by: 'default' } }; // no API key
    const fmt = (list: AddressLike[]) => list.map(a => formatAddress(a)).join(', ');
    const text = buildClassifierInput({
      account: acct.name,
      purpose: file.account_purpose[acct.name],
      from: c.from ? formatAddress(c.from) : undefined,
      to: fmt(c.to),
      cc: fmt(c.cc),
      replyTo: fmt(c.replyTo),
      date: c.date?.toISOString(),
      subject: c.subject,
      body: await this.body(acct, mailbox, c),
    });
    const stats = acct.report.classifier;
    stats.calls++;
    const result = await client.classify(text);
    if (!result.ok) {
      stats.errors++;
      return {
        action: fallback,
        report: { ...base, decided_by: 'default', classifier_error: result.error, latency_ms: result.latency_ms },
      };
    }
    if (result.cost !== undefined) stats.cost += result.cost;
    return {
      action: verdictAction(result.verdict, result.confidence, file.classifier!, file.default_action),
      report: {
        ...base,
        decided_by: 'classifier',
        verdict: result.verdict,
        confidence: result.confidence,
        latency_ms: result.latency_ms,
        tokens: result.tokens,
        ...(result.cost !== undefined ? { cost: result.cost } : {}),
      },
    };
  }

  private async decide(
    file: RuleFile,
    acct: AccountRun,
    mailbox: string,
    c: Candidate,
    base: MessageReport,
  ): Promise<{ action: Action; report: MessageReport }> {
    for (const rule of file.rules) {
      if (rule.accounts && !rule.accounts.includes(acct.name)) continue;
      if (!(await this.matches(rule.when, acct, mailbox, c))) continue;
      if (rule.action.kind === 'classify') {
        const r = await this.classify(file, acct, mailbox, c, base);
        return { action: r.action, report: { ...r.report, via: rule.id } };
      }
      return { action: rule.action, report: { ...base, decided_by: rule.id } };
    }
    if (file.classifier) return this.classify(file, acct, mailbox, c, base);
    return { action: file.default_action, report: { ...base, decided_by: 'default' } };
  }

  private baseReport(acct: AccountRun, mailbox: string, c: Candidate): MessageReport {
    return {
      account: acct.name,
      mailbox,
      uid: c.uid,
      date: c.date ? c.date.toISOString() : null,
      from: c.from ? formatAddress(c.from) : '(unknown)',
      subject: c.subject,
      decided_by: '',
      action: '',
    };
  }

  /** Fill in the action label and flag a move/trash whose target folder does not exist. */
  private finishPlan(acct: AccountRun, c: Candidate, key: string, action: Action, report: MessageReport): Plan {
    report.action = actionLabel(action);
    const missing =
      (action.kind === 'move' && !acct.has(action.folder)) || (action.kind === 'trash' && !acct.special('\\Trash'));
    if (missing) report.folder_missing = true;
    return { candidate: c, key, action, report };
  }

  private async processMailbox(file: RuleFile, acct: AccountRun, mailbox: string): Promise<void> {
    const where = `${acct.name}/${mailbox}`;
    const unreadOnly = file.unread_only && !this.opts.includeRead;
    const query = buildSearchQuery({ seen: unreadOnly ? false : undefined, since: this.opts.since });
    const { uidValidity, candidates } = await this.manager.withMailbox(acct.name, mailbox, async client => ({
      uidValidity: currentUidValidity(client),
      candidates: await fetchCandidates(client, query, where),
    }));

    const plans: Plan[] = [];
    for (const c of candidates) {
      acct.report.scanned++;
      const key = stateKey(acct.name, mailbox, uidValidity, c.uid);
      if (this.opts.state.isKept(key)) {
        acct.report.skipped_kept++;
        continue;
      }
      const { action, report } = await this.decide(file, acct, mailbox, c, this.baseReport(acct, mailbox, c));
      plans.push(this.finishPlan(acct, c, key, action, report));
    }

    if (!this.opts.dryRun) await this.apply(acct, mailbox, uidValidity, plans);

    for (const p of plans) {
      if (p.report.skipped) continue;
      const id = p.report.decided_by === 'classifier' ? `classifier:${p.report.verdict}` : p.report.decided_by;
      acct.count(id, p.report.action);
      const decidedByRuleOrClassifier = p.report.decided_by !== 'default';
      if (!this.opts.dryRun && p.action.kind === 'keep' && decidedByRuleOrClassifier) {
        this.opts.state.record(p.key, 'keep', this.now());
      }
    }
    this.emit(plans);
  }

  /** Apply plans batched per action+target, after re-checking the mailbox identity. */
  private async apply(acct: AccountRun, mailbox: string, uidValidity: string, plans: Plan[]): Promise<void> {
    const groups = new Map<string, Plan[]>();
    for (const p of plans) {
      if (p.action.kind === 'keep') continue;
      const label = actionLabel(p.action);
      groups.set(label, [...(groups.get(label) ?? []), p]);
    }
    if (groups.size === 0) return;
    await this.manager.withMailbox(acct.name, mailbox, async client => {
      if (currentUidValidity(client) !== uidValidity) {
        this.warn(`${acct.name}/${mailbox}: UIDVALIDITY changed during the run — no actions applied`);
        for (const list of groups.values()) for (const p of list) p.report.skipped = 'uidvalidity_changed';
        return;
      }
      for (const list of groups.values()) {
        await this.mutate(client, acct, mailbox, list[0].action, list.map(p => p.candidate.uid));
      }
    });
  }

  private async mutate(client: ImapFlow, acct: AccountRun, mailbox: string, action: Action, uids: number[]): Promise<void> {
    const where = `${acct.name}/${mailbox}`;
    const markRead = async () => {
      if (!(await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true }))) {
        throw new Error(`Failed to mark ${uids.length} message(s) read in ${where}`);
      }
    };
    const move = async (target: string) => {
      if (!(await client.messageMove(uids, target, { uid: true }))) {
        throw new Error(`Move of ${uids.length} message(s) to "${target}" failed in ${where}`);
      }
    };
    if (action.kind === 'read') return markRead();
    if (action.kind === 'trash') {
      // Soft delete only: \Seen then MOVE to \Trash. Never EXPUNGE.
      await markRead();
      const trash = acct.special('\\Trash');
      if (trash && trash !== mailbox) await move(trash);
      return;
    }
    if (action.kind === 'move') {
      if (action.read) await markRead();
      if (acct.has(action.folder) && action.folder !== mailbox) await move(action.folder);
    }
  }

  private async purge(acct: AccountRun, folder: string, olderThan: number): Promise<void> {
    if (!acct.has(folder)) {
      this.warn(`${acct.name}: purge folder "${folder}" does not exist — skipped`);
      return;
    }
    const cutoff = this.now() - olderThan;
    // SEARCH BEFORE is day-granular: over-select by a day, then filter exactly.
    const query = buildSearchQuery({ before: day(cutoff + DAY_MS) });
    const action: Action = { kind: 'trash' };
    const plans = await this.manager.withMailbox(acct.name, folder, async client => {
      const candidates = await fetchCandidates(client, query, `${acct.name}/${folder}`);
      const old = candidates.filter(c => {
        const t = messageTime(c);
        return t !== undefined && t <= cutoff;
      });
      const plans = old.map(c => {
        const report = { ...this.baseReport(acct, folder, c), decided_by: 'purge' };
        return this.finishPlan(acct, c, '', action, report);
      });
      if (!this.opts.dryRun && plans.length > 0) {
        await this.mutate(client, acct, folder, action, plans.map(p => p.candidate.uid));
      }
      return plans;
    });
    if (plans.length > 0) acct.count(`purge:${folder}`, 'trash', plans.length);
    this.emit(plans);
  }

  private async sweepTrash(acct: AccountRun): Promise<void> {
    const trash = acct.special('\\Trash');
    if (!trash) {
      this.warn(`${acct.name}: no \\Trash folder — sweep_trash_unread skipped`);
      return;
    }
    const count = await this.manager.withMailbox(acct.name, trash, async client => {
      const uids = await client.search(buildSearchQuery({ seen: false }), { uid: true });
      if (!uids) throw new Error(`Search failed in ${acct.name}/${trash}`);
      if (uids.length > 0 && !this.opts.dryRun) {
        if (!(await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true }))) {
          throw new Error(`Failed to mark ${uids.length} message(s) read in ${acct.name}/${trash}`);
        }
      }
      return uids.length;
    });
    if (count > 0) acct.count('sweep_trash_unread', 'read', count);
  }

  private emit(plans: Plan[]): void {
    const out = this.deps.out;
    for (const p of plans) {
      this.report.messages.push(p.report);
      if (!out) continue;
      const r = p.report;
      const verdict = r.verdict !== undefined ? ` ${r.verdict}(${r.confidence})` : '';
      const notes = [r.folder_missing ? 'folder missing' : '', r.skipped ?? '', r.classifier_error ? 'classifier error' : '']
        .filter(Boolean)
        .join(', ');
      out(
        `${r.account} ${r.mailbox} uid=${r.uid} ${r.date?.slice(0, 10) ?? 'unknown-date'} ${r.from} — ${r.subject || '(no subject)'}` +
          ` | ${r.decided_by}${verdict} -> ${r.action}${notes ? ` [${notes}]` : ''}`,
      );
    }
  }
}

export async function runRules(opts: RunOptions, deps: EngineDeps): Promise<Report> {
  return new Engine(opts, deps).run();
}
