import { describe, expect, it } from 'vitest';
import { parseDuration, parseRuleFile } from '../src/rules/schema.js';

const ACCOUNTS = ['personal', 'work'];

function parse(yaml: string) {
  return parseRuleFile(yaml, 'test.yml', ACCOUNTS);
}

describe('parseRuleFile', () => {
  it('applies defaults to a minimal file', () => {
    const r = parse('version: 1\naccounts: [personal]\n');
    expect(r.errors).toEqual([]);
    expect(r.file).toMatchObject({
      accounts: ['personal'],
      mailboxes: ['INBOX'],
      unread_only: true,
      default_action: { kind: 'keep' },
      sweep_trash_unread: false,
      rules: [],
      purge: [],
    });
  });

  it('normalises actions and compiles case-insensitive regexes', () => {
    const r = parse(`
version: 1
accounts: [personal]
default_action: read
rules:
  - id: R1
    when: { from: '^a@b\\.com$', older_than: 2d }
    action: {move: Archive, read: true}
  - id: R2
    action: classify
classifier:
  provider: luna
`);
    expect(r.errors).toEqual([]);
    expect(r.file!.default_action).toEqual({ kind: 'read' });
    expect(r.file!.rules[0].action).toEqual({ kind: 'move', folder: 'Archive', read: true });
    expect(r.file!.rules[0].when.from!.test('A@B.COM')).toBe(true);
    expect(r.file!.rules[0].when.older_than).toBe(2 * 86_400_000);
    expect(r.file!.rules[1].action).toEqual({ kind: 'classify' });
  });

  it('reports YAML syntax errors', () => {
    const r = parse('version: 1\naccounts: [personal\n');
    expect(r.file).toBeNull();
    expect(r.errors[0]).toMatch(/test\.yml/);
  });

  it.each([
    ['missing accounts', 'version: 1\n', /accounts/],
    ['wrong version', 'version: 2\naccounts: [personal]\n', /version/],
    ['unknown top-level key', 'version: 1\naccounts: [personal]\nbogus: 1\n', /bogus/],
    ['unknown account', 'version: 1\naccounts: [nobody]\n', /unknown account "nobody"/],
    [
      'unknown account in a rule filter',
      'version: 1\naccounts: [personal]\nrules:\n  - id: X\n    accounts: [ghost]\n    action: keep\n',
      /unknown account "ghost"/,
    ],
    [
      'invalid regex',
      "version: 1\naccounts: [personal]\nrules:\n  - id: X\n    when: { subject: '(' }\n    action: keep\n",
      /rules\.0\.when\.subject.*invalid regex/,
    ],
    [
      'bad duration',
      'version: 1\naccounts: [personal]\nrules:\n  - id: X\n    when: { older_than: 3w }\n    action: keep\n',
      /older_than/,
    ],
    [
      'unknown condition',
      'version: 1\naccounts: [personal]\nrules:\n  - id: X\n    when: { form: x }\n    action: keep\n',
      /form/,
    ],
    [
      'duplicate rule id',
      'version: 1\naccounts: [personal]\nrules:\n  - id: X\n    action: keep\n  - id: X\n    action: read\n',
      /duplicate rule id "X"/,
    ],
    [
      'bad action',
      'version: 1\naccounts: [personal]\nrules:\n  - id: X\n    action: explode\n',
      /action/,
    ],
    [
      'classify as default_action',
      'version: 1\naccounts: [personal]\ndefault_action: classify\n',
      /default_action/,
    ],
    [
      'unknown classifier verdict',
      'version: 1\naccounts: [personal]\nclassifier:\n  provider: luna\n  map: { spam: trash }\n',
      /unknown verdict "spam"/,
    ],
    [
      'unknown provider',
      'version: 1\naccounts: [personal]\nclassifier:\n  provider: gpt\n',
      /provider/,
    ],
    [
      'min_confidence out of range',
      'version: 1\naccounts: [personal]\nclassifier:\n  provider: luna\n  min_confidence: 2\n',
      /min_confidence/,
    ],
    [
      'purge action other than trash',
      'version: 1\naccounts: [personal]\npurge:\n  - { folder: Auth, older_than: 24h, action: read }\n',
      /purge/,
    ],
    [
      'classify action without a classifier section',
      'version: 1\naccounts: [personal]\nrules:\n  - id: X\n    action: classify\n',
      /classify needs a classifier section/,
    ],
    [
      'create_folders for an unknown account',
      'version: 1\naccounts: [personal]\ncreate_folders: { nobody: [X] }\n',
      /unknown account "nobody"/,
    ],
  ])('rejects %s', (_name, yaml, pattern) => {
    const r = parse(yaml);
    expect(r.file).toBeNull();
    expect(r.errors.join('\n')).toMatch(pattern);
  });
});

describe('parseDuration', () => {
  it('parses hours and days', () => {
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('7d')).toBe(7 * 86_400_000);
    expect(parseDuration('1w')).toBeNull();
  });
});
