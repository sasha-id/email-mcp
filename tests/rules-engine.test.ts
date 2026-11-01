import { describe, expect, it } from 'vitest';
import { normalizeSubject, runRules, type EngineDeps, type RunOptions } from '../src/rules/engine.js';
import type { RuleFile } from '../src/rules/schema.js';
import { RunState, stateKey } from '../src/rules/state.js';
import { DAY, fetchQueue, HOUR, luna, managerFor, MailFake, msg, NOW, ruleFile } from './rules-fakes.js';

const HEAD = 'version: 1\naccounts: [personal]\n';

function run(
  files: RuleFile | RuleFile[],
  fakes: Record<string, MailFake>,
  opts: Partial<RunOptions> = {},
  deps: Partial<EngineDeps> = {},
) {
  return runRules(
    {
      files: Array.isArray(files) ? files : [files],
      dryRun: false,
      includeRead: false,
      noClassifier: false,
      state: RunState.empty(),
      ...opts,
    },
    { manager: managerFor(fakes), env: {}, now: () => NOW, sleep: async () => {}, ...deps },
  );
}

function decisions(report: Awaited<ReturnType<typeof run>>) {
  return Object.fromEntries(report.messages.map(m => [m.uid, `${m.decided_by}:${m.action}`]));
}

describe('rule matching', () => {
  it('first match wins, in file order', async () => {
    const fake = new MailFake();
    const a = msg({ subject: 'invoice 1' });
    fake.add('INBOX', a);
    const file = ruleFile(`${HEAD}rules:
  - { id: first, when: { subject: invoice }, action: read }
  - { id: second, when: { subject: invoice }, action: trash }
`);
    const report = await run(file, { personal: fake });
    expect(decisions(report)).toEqual({ [a.uid]: 'first:read' });
  });

  it('skips a rule whose accounts filter excludes the account', async () => {
    const p = new MailFake();
    const o = new MailFake();
    const pm = msg();
    const om = msg();
    p.add('INBOX', pm);
    o.add('INBOX', om);
    const file = ruleFile(`version: 1
accounts: [personal, other]
rules:
  - { id: only-other, accounts: [other], action: read }
  - { id: rest, action: keep }
`);
    const report = await run(file, { personal: p, other: o });
    expect(decisions(report)).toEqual({ [pm.uid]: 'rest:keep', [om.uid]: 'only-other:read' });
  });

  it('falls through to default_action when nothing matches and there is no classifier', async () => {
    const fake = new MailFake();
    const m = msg();
    fake.add('INBOX', m);
    const report = await run(ruleFile(`${HEAD}default_action: read\nrules:\n  - { id: x, when: { subject: nomatch }, action: trash }\n`), {
      personal: fake,
    });
    expect(decisions(report)).toEqual({ [m.uid]: 'default:read' });
  });

  const base = {
    from: { name: 'Acme Billing', address: 'billing@acme.com' },
    to: [{ address: 'me@example.com' }],
    cc: [{ address: 'boss@corp.com' }],
    subject: 'Your invoice',
    listId: 'Acme News <news.acme.com>',
    body: 'Total due: 42',
    date: new Date(NOW - 2 * DAY),
  };
  it.each([
    ['from', "from: '^billing@acme\\.com$'", true],
    ['from (no match)', "from: '^other@'", false],
    ['from is case-insensitive', "from: 'BILLING@ACME'", true],
    ['from_not', "from_not: 'acme'", false],
    ['from_not (passes)', "from_not: 'example'", true],
    ['from_name', "from_name: '^acme billing$'", true],
    ['subject', "subject: 'invoice'", true],
    ['subject_not', "subject_not: 'invoice'", false],
    ['to', "to: '^me@example\\.com$'", true],
    ['to does not look at cc', "to: 'boss@'", false],
    ['cc', "cc: 'boss@corp'", true],
    ['to_cc', "to_cc: 'boss@corp'", true],
    ['list_id', "list_id: 'news\\.acme\\.com'", true],
    ['older_than', 'older_than: 24h', true],
    ['older_than (too young)', 'older_than: 3d', false],
    ['body', "body: 'total due'", true],
    ['body (no match)', "body: 'refund'", false],
    ['AND of conditions', "{ from: acme, subject: refund }", false],
  ])('condition %s', async (_name, when, expected) => {
    const fake = new MailFake();
    const m = msg(base);
    fake.add('INBOX', m);
    const w = when.startsWith('{') ? when : `{ ${when} }`;
    const report = await run(ruleFile(`${HEAD}rules:\n  - { id: hit, when: ${w}, action: read }\n`), { personal: fake });
    expect(report.messages[0].decided_by).toBe(expected ? 'hit' : 'default');
  });

  it('fetches the body only when a body rule reaches the message', async () => {
    const fake = new MailFake();
    const early = msg({ subject: 'early' });
    const late = msg({ subject: 'late', body: 'secret code' });
    fake.add('INBOX', early, late);
    const file = ruleFile(`${HEAD}rules:
  - { id: subj, when: { subject: early }, action: read }
  - { id: bod, when: { body: 'code' }, action: trash }
`);
    const report = await run(file, { personal: fake });
    expect(decisions(report)).toEqual({ [early.uid]: 'subj:read', [late.uid]: 'bod:trash' });
    expect(fake.callsTo('download').map(c => c.args[0])).toEqual([String(late.uid)]);
  });

  it('does not fetch any body when no rule needs one', async () => {
    const fake = new MailFake();
    fake.add('INBOX', msg(), msg());
    await run(ruleFile(`${HEAD}rules:\n  - { id: s, when: { subject: x }, action: read }\n`), { personal: fake });
    expect(fake.callsTo('download')).toHaveLength(0);
    expect(fake.callsTo('fetchOne')).toHaveLength(0);
  });

  it('sent_thread matches a normalised subject from the Sent folder (last 90 days)', async () => {
    const fake = new MailFake().addBox('Sent', '\\Sent', [
      msg({ subject: 'Project plan', to: [{ address: 'bob@x.com' }], date: new Date(NOW - 10 * DAY) }),
      msg({ subject: 'Ancient thread', to: [{ address: 'carol@x.com' }], date: new Date(NOW - 120 * DAY) }),
    ]);
    const reply = msg({ subject: 'RE: [EXTERNAL] Fwd: project   plan' });
    const old = msg({ subject: 'Re: Ancient thread' });
    const other = msg({ subject: 'Unrelated' });
    fake.add('INBOX', reply, old, other);
    const report = await run(ruleFile(`${HEAD}rules:\n  - { id: thread, when: { sent_thread: true }, action: keep }\n`), {
      personal: fake,
    });
    expect(decisions(report)).toEqual({
      [reply.uid]: 'thread:keep',
      [old.uid]: 'default:keep',
      [other.uid]: 'default:keep',
    });
    // Sent is scanned once per account, not per message.
    expect(fake.lockedPaths.filter(p => p === 'Sent')).toHaveLength(1);
  });

  it('sent_recipient matches a sender Alexander sent to (To/Cc, last 180 days)', async () => {
    const fake = new MailFake().addBox('Sent', '\\Sent', [
      msg({ to: [{ address: 'Bob@X.com' }], cc: [{ address: 'carol@x.com' }], date: new Date(NOW - 150 * DAY) }),
      msg({ to: [{ address: 'dave@x.com' }], date: new Date(NOW - 200 * DAY) }),
    ]);
    const bob = msg({ from: { address: 'bob@x.com' } });
    const carol = msg({ from: { address: 'carol@x.com' } });
    const dave = msg({ from: { address: 'dave@x.com' } });
    fake.add('INBOX', bob, carol, dave);
    const report = await run(ruleFile(`${HEAD}rules:\n  - { id: known, when: { sent_recipient: true }, action: keep }\n`), {
      personal: fake,
    });
    expect(decisions(report)).toEqual({ [bob.uid]: 'known:keep', [carol.uid]: 'known:keep', [dave.uid]: 'default:keep' });
  });

  it('normalizeSubject strips reply/forward prefixes and [EXTERNAL]', () => {
    expect(normalizeSubject('AW: Fw: RE:[EXTERNAL]  Hello  World')).toBe('hello world');
  });
});

describe('actions', () => {
  function setup() {
    return new MailFake().addBox('Trash', '\\Trash').addBox('Archive');
  }

  it('read adds \\Seen in place, batched per action', async () => {
    const fake = setup();
    const a = msg();
    const b = msg();
    fake.add('INBOX', a, b);
    await run(ruleFile(`${HEAD}rules:\n  - { id: r, action: read }\n`), { personal: fake });
    expect(fake.mutations()).toEqual([{ method: 'messageFlagsAdd', args: [[a.uid, b.uid], ['\\Seen'], { uid: true }] }]);
  });

  it('keep changes nothing', async () => {
    const fake = setup();
    fake.add('INBOX', msg());
    await run(ruleFile(`${HEAD}rules:\n  - { id: k, action: keep }\n`), { personal: fake });
    expect(fake.mutations()).toEqual([]);
  });

  it('trash marks read then moves to \\Trash and never expunges', async () => {
    const fake = setup();
    const a = msg();
    fake.add('INBOX', a);
    await run(ruleFile(`${HEAD}rules:\n  - { id: t, action: trash }\n`), { personal: fake });
    expect(fake.mutations().map(c => c.method)).toEqual(['messageFlagsAdd', 'messageMove']);
    expect(fake.callsTo('messageMove')[0].args).toEqual([[a.uid], 'Trash', { uid: true }]);
    expect(fake.callsTo('messageDelete')).toHaveLength(0);
    expect(fake.box('Trash').messages[0].flags?.has('\\Seen')).toBe(true);
  });

  it('move with read: true marks read and moves', async () => {
    const fake = setup();
    const a = msg();
    fake.add('INBOX', a);
    await run(ruleFile(`${HEAD}rules:\n  - { id: m, action: {move: Archive, read: true} }\n`), { personal: fake });
    expect(fake.mutations().map(c => c.method)).toEqual(['messageFlagsAdd', 'messageMove']);
    expect(fake.box('Archive').messages.map(m => m.uid)).toEqual([a.uid]);
  });

  it('move with read: false moves and leaves \\Seen alone', async () => {
    const fake = setup();
    fake.add('INBOX', msg());
    await run(ruleFile(`${HEAD}rules:\n  - { id: m, action: {move: Archive, read: false} }\n`), { personal: fake });
    expect(fake.mutations().map(c => c.method)).toEqual(['messageMove']);
  });

  it('move to a missing folder applies only the read flag and records folder_missing', async () => {
    const fake = setup();
    const a = msg();
    fake.add('INBOX', a);
    const report = await run(ruleFile(`${HEAD}rules:\n  - { id: m, action: {move: Nowhere, read: true} }\n`), { personal: fake });
    expect(report.accounts.personal.ok).toBe(true);
    expect(fake.mutations()).toEqual([{ method: 'messageFlagsAdd', args: [[a.uid], ['\\Seen'], { uid: true }] }]);
    expect(report.messages[0]).toMatchObject({ action: 'move:Nowhere+read', folder_missing: true });
  });

  it('move to a missing folder with read: false changes nothing', async () => {
    const fake = setup();
    fake.add('INBOX', msg());
    const report = await run(ruleFile(`${HEAD}rules:\n  - { id: m, action: {move: Nowhere, read: false} }\n`), { personal: fake });
    expect(fake.mutations()).toEqual([]);
    expect(report.messages[0].folder_missing).toBe(true);
  });

  it('counts actions per deciding id in the account report', async () => {
    const fake = setup();
    fake.add('INBOX', msg({ subject: 'a' }), msg({ subject: 'a' }), msg({ subject: 'b' }));
    const report = await run(
      ruleFile(`${HEAD}rules:\n  - { id: A, when: { subject: a }, action: read }\n  - { id: B, action: trash }\n`),
      { personal: fake },
    );
    expect(report.accounts.personal).toMatchObject({
      ok: true,
      scanned: 3,
      actions: { A: { action: 'read', count: 2 }, B: { action: 'trash', count: 1 } },
    });
  });
});

describe('dry run', () => {
  it('performs every read but no mutation and sets no \\Seen', async () => {
    const fake = new MailFake().addBox('Trash', '\\Trash').addBox('Archive');
    const a = msg({ subject: 'trash me' });
    const b = msg({ subject: 'move me' });
    const c = msg({ subject: 'classify me' });
    fake.add('INBOX', a, b, c);
    const file = ruleFile(`${HEAD}classifier:
  provider: luna
  map: { fyi: read }
rules:
  - { id: t, when: { subject: trash }, action: trash }
  - { id: m, when: { subject: move }, action: {move: Archive, read: true} }
`);
    const { fetchFn, calls } = fetchQueue([luna('fyi', 0.9)]);
    const lines: string[] = [];
    const report = await run(file, { personal: fake }, { dryRun: true }, { env: { LITELLM_API_KEY: 'k', LITELLM_BASE_URL: 'https://llm.test' }, fetchFn, out: l => lines.push(l) });
    expect(fake.mutations()).toEqual([]);
    expect(fake.box('INBOX').messages.every(m => !m.flags?.has('\\Seen'))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(report.dry_run).toBe(true);
    expect(decisions(report)).toEqual({ [a.uid]: 't:trash', [b.uid]: 'm:move:Archive+read', [c.uid]: 'classifier:read' });
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/classify me \| classifier fyi\(0\.9\) -> read/);
  });
});

describe('classifier', () => {
  const file = (extra = '') =>
    ruleFile(`${HEAD}default_action: keep
account_purpose: { personal: 'home mail' }
classifier:
  provider: luna
  min_confidence: 0.6
  map:
    fyi: read
    finance: {move: Finance, read: true}
    trash: trash
${extra}`);
  const env = { LITELLM_API_KEY: 'k', LITELLM_BASE_URL: 'https://llm.test' };

  it('maps verdicts, applies min_confidence and unsure', async () => {
    const fake = new MailFake().addBox('Finance').addBox('Trash', '\\Trash');
    const fin = msg({ subject: 'statement' });
    const low = msg({ subject: 'meh' });
    const unsure = msg({ subject: 'hmm' });
    const unmapped = msg({ subject: 'order' });
    fake.add('INBOX', fin, low, unsure, unmapped);
    const { fetchFn, calls } = fetchQueue([luna('finance', 0.95), luna('trash', 0.5), luna('unsure', 0.99), luna('orders', 0.9)]);
    const report = await run(file(), { personal: fake }, {}, { env, fetchFn });
    expect(decisions(report)).toEqual({
      [fin.uid]: 'classifier:move:Finance+read',
      [low.uid]: 'classifier:keep',
      [unsure.uid]: 'classifier:keep',
      [unmapped.uid]: 'classifier:keep',
    });
    expect(report.messages[0]).toMatchObject({ verdict: 'finance', confidence: 0.95, cost: 0.001 });
    expect(calls[0].url).toBe('https://llm.test/v1/decisions');
    expect(String(calls[0].body.input)).toMatch(/^Mailbox: personal \(home mail\)\nFrom: Sender <sender@example\.com>/);
    expect(report.accounts.personal.classifier).toMatchObject({ calls: 4, errors: 0 });
    expect(report.accounts.personal.classifier.cost).toBeCloseTo(0.004);
    expect(fake.callsTo('messageMove')[0].args[1]).toBe('Finance');
    expect(fake.callsTo('messageDelete')).toHaveLength(0);
  });

  it('retries HTTP 429 and then uses the verdict', async () => {
    const fake = new MailFake();
    fake.add('INBOX', msg());
    const { fetchFn, calls } = fetchQueue([() => new Response('', { status: 429, headers: { 'retry-after': '1' } }), luna('fyi', 0.9)]);
    const report = await run(file(), { personal: fake }, {}, { env, fetchFn });
    expect(calls).toHaveLength(2);
    expect(report.messages[0]).toMatchObject({ decided_by: 'classifier', action: 'read' });
  });

  it('falls back to default_action on error and never trashes on failure', async () => {
    const fake = new MailFake().addBox('Trash', '\\Trash');
    const a = msg();
    const b = msg();
    fake.add('INBOX', a, b);
    const failing = ruleFile(`${HEAD}default_action: trash\nclassifier:\n  provider: luna\n  map: { fyi: read }\n`);
    const { fetchFn } = fetchQueue([
      () => new Response('bad', { status: 400 }),
      () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    ]);
    const report = await run(failing, { personal: fake }, {}, { env, fetchFn });
    expect(decisions(report)).toEqual({ [a.uid]: 'default:keep', [b.uid]: 'default:keep' });
    expect(report.messages[1].classifier_error).toMatch(/TimeoutError/);
    expect(report.accounts.personal.classifier).toMatchObject({ calls: 2, errors: 2 });
    expect(fake.mutations()).toEqual([]);
  });

  it('uses default_action on error', async () => {
    const fake = new MailFake();
    fake.add('INBOX', msg());
    const { fetchFn } = fetchQueue([() => new Response('', { status: 500 }), () => new Response('', { status: 500 }), () => new Response('', { status: 500 })]);
    const f = ruleFile(`${HEAD}default_action: read\nclassifier:\n  provider: luna\n`);
    const report = await run(f, { personal: fake }, {}, { env, fetchFn });
    expect(report.messages[0]).toMatchObject({ decided_by: 'default', action: 'read' });
  });

  it('is skipped with a warning when LITELLM_API_KEY is missing', async () => {
    const fake = new MailFake();
    fake.add('INBOX', msg());
    const { fetchFn, calls } = fetchQueue([]);
    const report = await run(file(), { personal: fake }, {}, { env: {}, fetchFn });
    expect(calls).toHaveLength(0);
    expect(report.messages[0]).toMatchObject({ decided_by: 'default', action: 'keep' });
    expect(report.warnings.join()).toMatch(/LITELLM_API_KEY/);
  });

  it('is skipped with a warning when LITELLM_BASE_URL is missing', async () => {
    const fake = new MailFake();
    fake.add('INBOX', msg());
    const { fetchFn, calls } = fetchQueue([]);
    const report = await run(file(), { personal: fake }, {}, { env: { LITELLM_API_KEY: 'k' }, fetchFn });
    expect(calls).toHaveLength(0);
    expect(report.messages[0]).toMatchObject({ decided_by: 'default', action: 'keep' });
    expect(report.warnings.join()).toMatch(/LITELLM_BASE_URL/);
  });

  it('does not trash when the key is missing and default_action is trash', async () => {
    const fake = new MailFake().addBox('Trash', '\\Trash');
    fake.add('INBOX', msg());
    const f = ruleFile(`${HEAD}default_action: trash\nclassifier:\n  provider: luna\n`);
    const report = await run(f, { personal: fake }, {}, { env: {} });
    expect(report.messages[0]).toMatchObject({ decided_by: 'default', action: 'keep' });
    expect(fake.mutations()).toEqual([]);
  });

  it('is skipped with --no-classifier', async () => {
    const fake = new MailFake();
    fake.add('INBOX', msg());
    const { fetchFn, calls } = fetchQueue([]);
    await run(file(), { personal: fake }, { noClassifier: true }, { env, fetchFn });
    expect(calls).toHaveLength(0);
  });

  it('runs for a classify rule action and records the rule as via', async () => {
    const fake = new MailFake();
    const a = msg({ subject: 'security alert' });
    fake.add('INBOX', a);
    const f = file(`rules:\n  - { id: sec, when: { subject: security }, action: classify }\n  - { id: rest, action: keep }\n`);
    const { fetchFn } = fetchQueue([luna('fyi', 0.9)]);
    const report = await run(f, { personal: fake }, {}, { env, fetchFn });
    expect(report.messages[0]).toMatchObject({ decided_by: 'classifier', via: 'sec', action: 'read' });
  });

  it('never classifies the Junk folder', async () => {
    const fake = new MailFake().addBox('Junk', '\\Junk');
    fake.add('Junk', msg());
    const f = ruleFile(`${HEAD}mailboxes: [Junk]\nclassifier:\n  provider: luna\n`);
    const { fetchFn, calls } = fetchQueue([]);
    const report = await run(f, { personal: fake }, {}, { env, fetchFn });
    expect(calls).toHaveLength(0);
    expect(report.messages[0].decided_by).toBe('default');
  });
});

describe('state', () => {
  it('skips messages already decided keep and records new keep decisions', async () => {
    const fake = new MailFake();
    const kept = msg();
    const fresh = msg();
    fake.add('INBOX', kept, fresh);
    const state = RunState.empty();
    state.record(stateKey('personal', 'INBOX', '1', kept.uid), 'keep', NOW - DAY);
    const report = await run(ruleFile(`${HEAD}rules:\n  - { id: k, action: keep }\n`), { personal: fake }, { state });
    expect(report.messages.map(m => m.uid)).toEqual([fresh.uid]);
    expect(report.accounts.personal).toMatchObject({ scanned: 2, skipped_kept: 1 });
    expect(state.isKept(stateKey('personal', 'INBOX', '1', fresh.uid))).toBe(true);
  });

  it('does not record default decisions or anything in a dry run', async () => {
    const fake = new MailFake();
    const a = msg({ subject: 'x' });
    const b = msg({ subject: 'y' });
    fake.add('INBOX', a, b);
    const file = ruleFile(`${HEAD}rules:\n  - { id: k, when: { subject: x }, action: keep }\n`);
    const state = RunState.empty();
    await run(file, { personal: fake }, { state });
    expect(state.isKept(stateKey('personal', 'INBOX', '1', a.uid))).toBe(true);
    expect(state.isKept(stateKey('personal', 'INBOX', '1', b.uid))).toBe(false);
    const dry = RunState.empty();
    await run(file, { personal: fake }, { state: dry, dryRun: true });
    expect(dry.toJSON()).toEqual({});
  });

  it('does not skip a kept entry from a different UIDVALIDITY', async () => {
    const fake = new MailFake();
    const m = msg();
    fake.add('INBOX', m);
    const state = RunState.empty();
    state.record(stateKey('personal', 'INBOX', '999', m.uid), 'keep', NOW);
    const report = await run(ruleFile(HEAD), { personal: fake }, { state });
    expect(report.messages).toHaveLength(1);
  });
});

describe('safety', () => {
  it('skips all actions when UIDVALIDITY changes before acting', async () => {
    const fake = new MailFake().addBox('Trash', '\\Trash');
    fake.add('INBOX', msg(), msg());
    fake.onLock = (path, n) => {
      if (path === 'INBOX' && n > 1) fake.box('INBOX').uidValidity = 2n;
    };
    const report = await run(ruleFile(`${HEAD}rules:\n  - { id: t, action: trash }\n`), { personal: fake });
    expect(fake.mutations()).toEqual([]);
    expect(report.messages.every(m => m.skipped === 'uidvalidity_changed')).toBe(true);
    expect(report.accounts.personal.actions).toEqual({});
    expect(report.warnings.join()).toMatch(/UIDVALIDITY/);
  });

  it('keeps processing other accounts when one fails', async () => {
    const bad = new MailFake();
    bad.connectError = new Error('AUTHENTICATIONFAILED');
    const good = new MailFake();
    const m = msg();
    good.add('INBOX', m);
    const file = ruleFile(`version: 1\naccounts: [personal, other]\nrules:\n  - { id: r, action: read }\n`);
    const report = await run(file, { personal: bad, other: good });
    expect(report.accounts.personal).toMatchObject({ ok: false, error: 'AUTHENTICATIONFAILED' });
    expect(report.accounts.other.ok).toBe(true);
    expect(good.callsTo('messageFlagsAdd')[0].args[0]).toEqual([m.uid]);
  });

  it('enumerates every candidate beyond 200, in pages', async () => {
    const fake = new MailFake();
    for (let i = 0; i < 450; i++) fake.add('INBOX', msg());
    const report = await run(ruleFile(`${HEAD}rules:\n  - { id: r, action: read }\n`), { personal: fake });
    expect(report.accounts.personal.scanned).toBe(450);
    expect(fake.callsTo('fetch').map(c => (c.args[0] as number[]).length)).toEqual([200, 200, 50]);
    expect((fake.callsTo('messageFlagsAdd')[0].args[0] as number[]).length).toBe(450);
  });

  it('searches unread only by default; --include-read and --since widen it', async () => {
    const fake = new MailFake();
    const seen = msg({ flags: new Set(['\\Seen']) });
    const old = msg({ date: new Date(NOW - 40 * DAY) });
    const unread = msg();
    fake.add('INBOX', seen, old, unread);
    const file = ruleFile(`${HEAD}rules:\n  - { id: k, action: keep }\n`);
    let report = await run(file, { personal: fake });
    expect(report.messages.map(m => m.uid).sort()).toEqual([old.uid, unread.uid]);
    report = await run(file, { personal: fake }, { includeRead: true, since: '2026-05-20' });
    expect(report.messages.map(m => m.uid).sort()).toEqual([seen.uid, unread.uid]);
  });
});

describe('purge and trash sweep', () => {
  it('trashes purge-folder messages older than the threshold, read or not', async () => {
    const fake = new MailFake().addBox('Trash', '\\Trash').addBox('Auth', undefined, [
      msg({ uid: 1, date: new Date(NOW - 30 * HOUR), flags: new Set(['\\Seen']) }),
      msg({ uid: 2, date: new Date(NOW - 23 * HOUR) }),
      msg({ uid: 3, date: new Date(NOW - 10 * DAY) }),
    ]);
    const report = await run(ruleFile(`${HEAD}purge:\n  - { folder: Auth, older_than: 24h, action: trash }\n`), { personal: fake });
    expect(fake.box('Auth').messages.map(m => m.uid)).toEqual([2]);
    expect(fake.box('Trash').messages.map(m => m.uid).sort()).toEqual([1, 3]);
    expect(fake.callsTo('messageDelete')).toHaveLength(0);
    expect(report.accounts.personal.actions['purge:Auth']).toEqual({ action: 'trash', count: 2 });
    expect(report.messages.filter(m => m.decided_by === 'purge')).toHaveLength(2);
  });

  it('purge in a dry run only reports', async () => {
    const fake = new MailFake().addBox('Trash', '\\Trash').addBox('Auth', undefined, [msg({ date: new Date(NOW - 2 * DAY) })]);
    const report = await run(ruleFile(`${HEAD}purge:\n  - { folder: Auth, older_than: 1d, action: trash }\n`), { personal: fake }, { dryRun: true });
    expect(fake.mutations()).toEqual([]);
    expect(report.messages).toHaveLength(1);
  });

  it('warns and skips a purge folder that does not exist', async () => {
    const fake = new MailFake();
    const report = await run(ruleFile(`${HEAD}purge:\n  - { folder: Auth, older_than: 1d, action: trash }\n`), { personal: fake });
    expect(report.accounts.personal.ok).toBe(true);
    expect(report.warnings.join()).toMatch(/Auth/);
  });

  it('sweep_trash_unread marks unread mail in \\Trash read after the pass', async () => {
    const fake = new MailFake().addBox('Trash', '\\Trash', [msg({ uid: 7 }), msg({ uid: 8, flags: new Set(['\\Seen']) })]);
    const inbox = msg();
    fake.add('INBOX', inbox);
    const report = await run(ruleFile(`${HEAD}sweep_trash_unread: true\nrules:\n  - { id: t, action: trash }\n`), { personal: fake });
    // The trashed inbox message was already marked read; only uid 7 was left unread.
    expect(fake.callsTo('messageFlagsAdd').at(-1)!.args[0]).toEqual([7]);
    expect(report.accounts.personal.actions.sweep_trash_unread).toEqual({ action: 'read', count: 1 });
  });
});
