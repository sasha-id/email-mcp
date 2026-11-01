import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { VERDICTS } from './classifier.js';

/** What a rule, classifier verdict or default does to one message. */
export type Action =
  | { kind: 'keep' }
  | { kind: 'read' }
  | { kind: 'trash' }
  | { kind: 'move'; folder: string; read: boolean };

export type RuleAction = Action | { kind: 'classify' };

export interface Conditions {
  from?: RegExp;
  from_not?: RegExp;
  from_name?: RegExp;
  subject?: RegExp;
  subject_not?: RegExp;
  to?: RegExp;
  cc?: RegExp;
  to_cc?: RegExp;
  list_id?: RegExp;
  body?: RegExp;
  sent_thread?: boolean;
  sent_recipient?: boolean;
  /** Minimum message age in ms. */
  older_than?: number;
}

export interface Rule {
  id: string;
  name?: string;
  accounts?: string[];
  when: Conditions;
  action: RuleAction;
}

export interface Classifier {
  provider: 'luna' | 'jev';
  min_confidence: number;
  map: Record<string, Action>;
}

export interface Purge {
  folder: string;
  older_than: number;
}

export interface RuleFile {
  path: string;
  accounts: string[];
  mailboxes: string[];
  unread_only: boolean;
  default_action: Action;
  sweep_trash_unread: boolean;
  classifier?: Classifier;
  account_purpose: Record<string, string>;
  create_folders: Record<string, string[]>;
  purge: Purge[];
  rules: Rule[];
}

export function parseDuration(value: string): number | null {
  const m = /^(\d+)([hd])$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 86_400_000);
}

const Duration = z.string().transform((v, ctx) => {
  const ms = parseDuration(v);
  if (ms === null) {
    ctx.addIssue({ code: 'custom', message: `invalid duration "${v}" — expected Nh or Nd` });
    return z.NEVER;
  }
  return ms;
});

const Regex = z.string().transform((v, ctx) => {
  try {
    return new RegExp(v, 'i');
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: `invalid regex: ${err instanceof Error ? err.message : String(err)}` });
    return z.NEVER;
  }
});

const MoveAction = z
  .strictObject({ move: z.string().min(1), read: z.boolean() })
  .transform((a): Action => ({ kind: 'move', folder: a.move, read: a.read }));

const ActionSchema = z.union([
  z.enum(['keep', 'read', 'trash']).transform((k): Action => ({ kind: k })),
  MoveAction,
]);

const RuleActionSchema = z.union([
  z.literal('classify').transform((): RuleAction => ({ kind: 'classify' })),
  ActionSchema,
]);

const ConditionsSchema = z.strictObject({
  from: Regex.optional(),
  from_not: Regex.optional(),
  from_name: Regex.optional(),
  subject: Regex.optional(),
  subject_not: Regex.optional(),
  to: Regex.optional(),
  cc: Regex.optional(),
  to_cc: Regex.optional(),
  list_id: Regex.optional(),
  body: Regex.optional(),
  sent_thread: z.boolean().optional(),
  sent_recipient: z.boolean().optional(),
  older_than: Duration.optional(),
});

const RuleSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().optional(),
  accounts: z.array(z.string()).min(1).optional(),
  when: ConditionsSchema.default({}),
  action: RuleActionSchema,
});

const FileSchema = z.strictObject({
  version: z.literal(1),
  accounts: z.array(z.string()).min(1),
  mailboxes: z.array(z.string().min(1)).min(1).default(['INBOX']),
  unread_only: z.boolean().default(true),
  default_action: ActionSchema.default({ kind: 'keep' }),
  sweep_trash_unread: z.boolean().default(false),
  classifier: z
    .strictObject({
      provider: z.enum(['luna', 'jev']),
      min_confidence: z.number().min(0).max(1).default(0.6),
      map: z.record(z.string(), ActionSchema).default({}),
    })
    .optional(),
  account_purpose: z.record(z.string(), z.string()).default({}),
  create_folders: z.record(z.string(), z.array(z.string().min(1))).default({}),
  purge: z
    .array(z.strictObject({ folder: z.string().min(1), older_than: Duration, action: z.literal('trash') }))
    .default([]),
  rules: z.array(RuleSchema).default([]),
});

export interface ParseResult {
  file: RuleFile | null;
  errors: string[];
}

/**
 * Parse and validate one rule file. `knownAccounts` are the account names in
 * the email-mcp config; every account the file names must be one of them.
 */
export function parseRuleFile(text: string, path: string, knownAccounts: string[]): ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { file: null, errors: [`${path}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const result = FileSchema.safeParse(raw);
  if (!result.success) {
    return {
      file: null,
      errors: result.error.issues.map(i => `${path}: ${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const data = result.data;
  const errors: string[] = [];
  const known = new Set(knownAccounts);
  const checkAccount = (name: string, where: string) => {
    if (!known.has(name)) errors.push(`${path}: ${where}: unknown account "${name}"`);
  };
  data.accounts.forEach(a => checkAccount(a, 'accounts'));
  Object.keys(data.create_folders).forEach(a => checkAccount(a, 'create_folders'));
  Object.keys(data.account_purpose).forEach(a => checkAccount(a, 'account_purpose'));
  const ids = new Set<string>();
  data.rules.forEach((rule, i) => {
    rule.accounts?.forEach(a => checkAccount(a, `rules.${i}.accounts`));
    if (ids.has(rule.id)) errors.push(`${path}: rules.${i}.id: duplicate rule id "${rule.id}"`);
    ids.add(rule.id);
  });
  data.rules.forEach((rule, i) => {
    if (rule.action.kind === 'classify' && !data.classifier) {
      errors.push(`${path}: rules.${i}.action: classify needs a classifier section`);
    }
  });
  for (const verdict of Object.keys(data.classifier?.map ?? {})) {
    if (!VERDICTS.includes(verdict)) {
      errors.push(`${path}: classifier.map: unknown verdict "${verdict}" (known: ${VERDICTS.join(', ')})`);
    }
  }
  if (errors.length > 0) return { file: null, errors };
  return {
    file: {
      path,
      accounts: data.accounts,
      mailboxes: data.mailboxes,
      unread_only: data.unread_only,
      default_action: data.default_action,
      sweep_trash_unread: data.sweep_trash_unread,
      classifier: data.classifier,
      account_purpose: data.account_purpose,
      create_folders: data.create_folders,
      purge: data.purge.map(p => ({ folder: p.folder, older_than: p.older_than })),
      rules: data.rules,
    },
    errors: [],
  };
}
