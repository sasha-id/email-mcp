import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rulesCli, type CliDeps } from '../src/rules/cli.js';
import { RunState, stateKey } from '../src/rules/state.js';
import { DAY, managerFor, MailFake, msg, NOW, rulesConfig } from './rules-fakes.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'email-mcp-rules-'));
}

function cli(files: Record<string, string>, fakes: Record<string, MailFake> = {}, extra: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    loadConfig: rulesConfig,
    makeManager: () => managerFor(fakes),
    readFile: p => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    },
    env: {},
    now: () => NOW,
    sleep: async () => {},
    stdout: l => out.push(l),
    stderr: l => err.push(l),
    ...extra,
  };
  return { out, err, exec: (...argv: string[]) => rulesCli(argv, deps) };
}

const GOOD = 'version: 1\naccounts: [personal]\nrules:\n  - { id: r, action: read }\n';

describe('rules check', () => {
  it('exits 0 for valid files', async () => {
    const c = cli({ 'a.yml': GOOD });
    expect(await c.exec('check', 'a.yml')).toBe(0);
    expect(c.out).toEqual(['a.yml: ok (1 rules)']);
  });

  it('exits 1 and prints every error', async () => {
    const c = cli({ 'a.yml': GOOD, 'b.yml': 'version: 1\naccounts: [ghost]\n' });
    expect(await c.exec('check', 'a.yml', 'b.yml', 'missing.yml')).toBe(1);
    expect(c.err.join('\n')).toMatch(/b\.yml: accounts: unknown account "ghost"/);
    expect(c.err.join('\n')).toMatch(/missing\.yml: cannot read file/);
  });

  it('exits 1 on usage errors', async () => {
    const c = cli({});
    expect(await c.exec('check')).toBe(1);
    expect(await c.exec('frobnicate', 'a.yml')).toBe(1);
    expect(await c.exec('run', 'a.yml', '--bogus')).toBe(1);
  });

  it('exits 1 when the email-mcp config cannot be loaded', async () => {
    const c = cli({ 'a.yml': GOOD }, {}, {
      loadConfig: () => {
        throw new Error('Cannot read config file');
      },
    });
    expect(await c.exec('check', 'a.yml')).toBe(1);
    expect(c.err.join()).toMatch(/Cannot read config file/);
  });
});

describe('rules run', () => {
  it('applies rules, prints one line per message and writes the report', async () => {
    const dir = tmp();
    const fake = new MailFake();
    const m = msg({ subject: 'Hi there' });
    fake.add('INBOX', m);
    const c = cli({ 'a.yml': GOOD }, { personal: fake });
    const report = join(dir, 'out', 'report.json');
    expect(await c.exec('run', 'a.yml', '--report', report)).toBe(0);
    expect(c.out).toHaveLength(1);
    expect(c.out[0]).toMatch(new RegExp(`^personal INBOX uid=${m.uid} 2026-06-10 Sender <sender@example\\.com> — Hi there \\| r -> read$`));
    const json = JSON.parse(readFileSync(report, 'utf8'));
    expect(json).toMatchObject({
      dry_run: false,
      files: ['a.yml'],
      accounts: { personal: { ok: true, scanned: 1, actions: { r: { action: 'read', count: 1 } } } },
      messages: [{ account: 'personal', mailbox: 'INBOX', uid: m.uid, from: 'Sender <sender@example.com>', subject: 'Hi there', decided_by: 'r', action: 'read' }],
    });
    expect(json.started).toBe(new Date(NOW).toISOString());
  });

  it('exits 2 when an account fails, still processing and reporting the others', async () => {
    const dir = tmp();
    const bad = new MailFake();
    bad.connectError = new Error('connect ETIMEDOUT');
    const good = new MailFake();
    good.add('INBOX', msg());
    const file = 'version: 1\naccounts: [personal, other]\nrules:\n  - { id: r, action: read }\n';
    const c = cli({ 'a.yml': file }, { personal: bad, other: good });
    const report = join(dir, 'r.json');
    expect(await c.exec('run', 'a.yml', '--report', report)).toBe(2);
    const json = JSON.parse(readFileSync(report, 'utf8'));
    expect(json.accounts.personal).toMatchObject({ ok: false, error: 'connect ETIMEDOUT' });
    expect(json.accounts.other.ok).toBe(true);
    expect(good.callsTo('messageFlagsAdd')).toHaveLength(1);
  });

  it('exits 1 on a validation error and still writes the report', async () => {
    const dir = tmp();
    const c = cli({ 'a.yml': 'version: 1\naccounts: []\n' });
    const report = join(dir, 'r.json');
    expect(await c.exec('run', 'a.yml', '--report', report)).toBe(1);
    expect(JSON.parse(readFileSync(report, 'utf8')).error).toMatch(/accounts/);
  });

  it('rejects an unknown --accounts name and a malformed --since', async () => {
    const c = cli({ 'a.yml': GOOD });
    expect(await c.exec('run', 'a.yml', '--accounts', 'ghost')).toBe(1);
    expect(await c.exec('run', 'a.yml', '--since', '1 June')).toBe(1);
  });

  it('--accounts restricts the run', async () => {
    const p = new MailFake();
    const o = new MailFake();
    p.add('INBOX', msg());
    o.add('INBOX', msg());
    const file = 'version: 1\naccounts: [personal, other]\nrules:\n  - { id: r, action: read }\n';
    const c = cli({ 'a.yml': file }, { personal: p, other: o });
    expect(await c.exec('run', 'a.yml', '--accounts', 'other')).toBe(0);
    expect(p.calls).toHaveLength(0);
    expect(o.callsTo('messageFlagsAdd')).toHaveLength(1);
  });

  it('--dry-run mutates nothing and leaves the state file alone', async () => {
    const dir = tmp();
    const fake = new MailFake();
    fake.add('INBOX', msg());
    const state = join(dir, 'state.json');
    const c = cli({ 'a.yml': 'version: 1\naccounts: [personal]\nrules:\n  - { id: k, action: keep }\n' }, { personal: fake });
    expect(await c.exec('run', 'a.yml', '--dry-run', '--state', state)).toBe(0);
    expect(fake.mutations()).toEqual([]);
    expect(() => readFileSync(state)).toThrow();
  });

  it('persists keep decisions, skips them next run and prunes entries older than 60 days', async () => {
    const dir = tmp();
    const state = join(dir, 'state.json');
    writeFileSync(
      state,
      JSON.stringify({
        'personal|INBOX|1|1': { decision: 'keep', at: new Date(NOW - 61 * DAY).toISOString() },
        'personal|INBOX|1|2': { decision: 'keep', at: new Date(NOW - 59 * DAY).toISOString() },
      }),
    );
    const fake = new MailFake();
    const fresh = msg();
    fake.add('INBOX', fresh);
    const file = 'version: 1\naccounts: [personal]\nrules:\n  - { id: k, action: keep }\n';
    const c = cli({ 'a.yml': file }, { personal: fake });
    expect(await c.exec('run', 'a.yml', '--state', state)).toBe(0);
    const saved = JSON.parse(readFileSync(state, 'utf8'));
    expect(Object.keys(saved).sort()).toEqual(['personal|INBOX|1|2', stateKey('personal', 'INBOX', '1', fresh.uid)].sort());

    const second = cli({ 'a.yml': file }, { personal: fake });
    expect(await second.exec('run', 'a.yml', '--state', state)).toBe(0);
    expect(second.out).toEqual([]);
  });

  it('starts empty with a warning when the state file is corrupt', async () => {
    const dir = tmp();
    const state = join(dir, 'state.json');
    writeFileSync(state, '{not json');
    const fake = new MailFake();
    fake.add('INBOX', msg());
    const report = join(dir, 'r.json');
    const c = cli({ 'a.yml': GOOD }, { personal: fake });
    expect(await c.exec('run', 'a.yml', '--state', state, '--report', report)).toBe(0);
    expect(JSON.parse(readFileSync(report, 'utf8')).warnings.join()).toMatch(/not valid JSON/);
  });
});

describe('RunState.load', () => {
  it('drops malformed entries', () => {
    const dir = tmp();
    const path = join(dir, 's.json');
    writeFileSync(path, JSON.stringify({ a: { decision: 'keep', at: new Date(NOW).toISOString() }, b: { nope: 1 }, c: null }));
    const warnings: string[] = [];
    const state = RunState.load(path, NOW, w => warnings.push(w));
    expect(Object.keys(state.toJSON())).toEqual(['a']);
    expect(warnings).toEqual([]);
  });

  it('warns on a missing file', () => {
    const warnings: string[] = [];
    RunState.load(join(tmp(), 'none.json'), NOW, w => warnings.push(w));
    expect(warnings[0]).toMatch(/not found/);
  });
});

describe('rules folders', () => {
  const FILE = `version: 1
accounts: [personal, other]
classifier:
  provider: luna
  map: { finance: {move: Finance, read: true} }
purge:
  - { folder: Auth, older_than: 24h, action: trash }
create_folders:
  personal: [Finance, Auth]
rules:
  - { id: arch, accounts: [personal], action: {move: Archive, read: true} }
`;

  it('lists target folders per account and whether each exists', async () => {
    const p = new MailFake().addBox('Archive');
    const o = new MailFake().addBox('Finance');
    const c = cli({ 'a.yml': FILE }, { personal: p, other: o });
    expect(await c.exec('folders', 'a.yml')).toBe(0);
    expect(c.out).toEqual([
      'personal:',
      '  Archive — exists',
      '  Auth — missing',
      '  Finance — missing',
      'other:',
      '  Auth — missing',
      '  Finance — exists',
    ]);
    expect(p.callsTo('mailboxCreate')).toHaveLength(0);
  });

  it('--create creates only the missing folders listed in create_folders', async () => {
    const p = new MailFake();
    const o = new MailFake();
    const c = cli({ 'a.yml': FILE }, { personal: p, other: o });
    expect(await c.exec('folders', 'a.yml', '--create')).toBe(0);
    expect(p.callsTo('mailboxCreate').map(x => x.args[0])).toEqual(['Auth', 'Finance']);
    expect(o.callsTo('mailboxCreate')).toHaveLength(0);
    expect(c.out).toContain('  Archive — missing (not in create_folders, not created)');
    expect(c.out).toContain('  Auth — created');
  });
});
