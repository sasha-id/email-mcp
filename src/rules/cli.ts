import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { AccountManager } from '../accounts.js';
import { loadConfig, type Config } from '../config.js';
import { runRules, type Report } from './engine.js';
import { parseRuleFile, type RuleFile } from './schema.js';
import { RunState } from './state.js';

export interface CliDeps {
  loadConfig?: () => Config;
  makeManager?: (config: Config) => AccountManager;
  readFile?: (path: string) => string;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const USAGE = `usage:
  email-mcp rules check <file.yml>...
  email-mcp rules run <file.yml>... [--dry-run] [--accounts a,b] [--since YYYY-MM-DD] [--include-read]
                                    [--state <path>] [--report <path.json>] [--no-classifier]
  email-mcp rules folders <file.yml>... [--create]`;

class UsageError extends Error {}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** Exit codes: 0 ok, 1 config/validation error, 2 partial failure (some account failed). */
export async function rulesCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? (line => process.stdout.write(line + '\n'));
  const stderr = deps.stderr ?? (line => process.stderr.write(line + '\n'));
  const [command, ...rest] = argv;
  try {
    if (command === 'check') return check(rest, deps, stdout, stderr);
    if (command === 'run') return await run(rest, deps, stdout, stderr);
    if (command === 'folders') return await folders(rest, deps, stdout, stderr);
    throw new UsageError(command ? `unknown rules command "${command}"` : 'missing rules command');
  } catch (err) {
    stderr(err instanceof UsageError ? `${err.message}\n${USAGE}` : `error: ${message(err)}`);
    return 1;
  }
}

function parse<T extends ParseArgsOptionsConfig>(args: string[], options: T) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true as const });
  } catch (err) {
    throw new UsageError(message(err));
  }
  if (parsed.positionals.length === 0) throw new UsageError('at least one rule file is required');
  return parsed;
}

function loadFiles(paths: string[], config: Config, deps: CliDeps): { files: RuleFile[]; errors: string[] } {
  const read = deps.readFile ?? (p => readFileSync(p, 'utf8'));
  const accounts = Object.keys(config.accounts);
  const files: RuleFile[] = [];
  const errors: string[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = read(path);
    } catch (err) {
      errors.push(`${path}: cannot read file (${message(err)})`);
      continue;
    }
    const result = parseRuleFile(text, path, accounts);
    if (result.file) files.push(result.file);
    errors.push(...result.errors);
  }
  return { files, errors };
}

function check(args: string[], deps: CliDeps, stdout: (l: string) => void, stderr: (l: string) => void): number {
  const { positionals } = parse(args, {});
  const config = (deps.loadConfig ?? loadConfig)();
  const { files, errors } = loadFiles(positionals, config, deps);
  for (const e of errors) stderr(e);
  for (const f of files) stdout(`${f.path}: ok (${f.rules.length} rules)`);
  return errors.length > 0 ? 1 : 0;
}

async function run(args: string[], deps: CliDeps, stdout: (l: string) => void, stderr: (l: string) => void): Promise<number> {
  const { values, positionals } = parse(args, {
    'dry-run': { type: 'boolean', default: false },
    accounts: { type: 'string' },
    since: { type: 'string' },
    'include-read': { type: 'boolean', default: false },
    state: { type: 'string' },
    report: { type: 'string' },
    'no-classifier': { type: 'boolean', default: false },
  });
  const reportPath = values.report as string | undefined;
  const now = deps.now ?? Date.now;
  const started = new Date(now()).toISOString();
  const failEarly = (errors: string[]): number => {
    for (const e of errors) stderr(e);
    if (reportPath) {
      const report: Report & { error: string } = {
        started,
        finished: new Date(now()).toISOString(),
        dry_run: Boolean(values['dry-run']),
        files: positionals,
        warnings: [],
        accounts: {},
        messages: [],
        error: errors.join('\n'),
      };
      writeJson(reportPath, report);
    }
    return 1;
  };

  let config: Config;
  try {
    config = (deps.loadConfig ?? loadConfig)();
  } catch (err) {
    return failEarly([`error: ${message(err)}`]);
  }
  const { files, errors } = loadFiles(positionals, config, deps);
  const since = values.since as string | undefined;
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) errors.push(`--since: expected YYYY-MM-DD, got "${since}"`);
  const accounts = (values.accounts as string | undefined)?.split(',').map(a => a.trim()).filter(Boolean);
  for (const a of accounts ?? []) {
    if (!config.accounts[a]) errors.push(`--accounts: unknown account "${a}"`);
  }
  if (errors.length > 0) return failEarly(errors);

  const statePath = values.state as string | undefined;
  const warnings: string[] = [];
  const state = statePath ? RunState.load(statePath, now(), w => warnings.push(w)) : RunState.empty();
  const manager = (deps.makeManager ?? (c => new AccountManager(c)))(config);
  let report: Report;
  try {
    report = await runRules(
      {
        files,
        dryRun: Boolean(values['dry-run']),
        accounts,
        since,
        includeRead: Boolean(values['include-read']),
        noClassifier: Boolean(values['no-classifier']),
        state,
      },
      { manager, env: deps.env, fetchFn: deps.fetchFn, sleep: deps.sleep, now: deps.now, out: stdout },
    );
  } finally {
    await manager.closeAll().catch(() => {});
  }
  report.warnings.unshift(...warnings);
  if (statePath && !report.dry_run) state.save(statePath);
  if (reportPath) writeJson(reportPath, report);

  for (const w of report.warnings) stderr(`warning: ${w}`);
  let failed = false;
  for (const [name, a] of Object.entries(report.accounts)) {
    if (!a.ok) {
      failed = true;
      stderr(`${name}: FAILED — ${a.error}`);
      continue;
    }
    const acted = Object.values(a.actions).reduce((n, x) => n + (x.action === 'keep' ? 0 : x.count), 0);
    stderr(`${name}: scanned ${a.scanned}, ${report.dry_run ? 'would act on' : 'acted on'} ${acted}`);
  }
  return failed ? 2 : 0;
}

/** Every folder the file's move/map/purge actions target, per account. */
export function targetFolders(file: RuleFile): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>(file.accounts.map(a => [a, new Set<string>()]));
  const add = (accounts: string[], folder: string) => {
    for (const a of accounts) out.get(a)?.add(folder);
  };
  for (const rule of file.rules) {
    if (rule.action.kind === 'move') add(rule.accounts ?? file.accounts, rule.action.folder);
  }
  for (const action of Object.values(file.classifier?.map ?? {})) {
    if (action.kind === 'move') add(file.accounts, action.folder);
  }
  for (const p of file.purge) add(file.accounts, p.folder);
  return out;
}

async function folders(args: string[], deps: CliDeps, stdout: (l: string) => void, stderr: (l: string) => void): Promise<number> {
  const { values, positionals } = parse(args, { create: { type: 'boolean', default: false } });
  const config = (deps.loadConfig ?? loadConfig)();
  const { files, errors } = loadFiles(positionals, config, deps);
  for (const e of errors) stderr(e);
  if (errors.length > 0) return 1;

  const targets = new Map<string, Set<string>>();
  const approved = new Map<string, Set<string>>();
  for (const file of files) {
    for (const [account, set] of targetFolders(file)) {
      targets.set(account, new Set([...(targets.get(account) ?? []), ...set]));
    }
    for (const [account, list] of Object.entries(file.create_folders)) {
      approved.set(account, new Set([...(approved.get(account) ?? []), ...list]));
    }
  }

  const manager = (deps.makeManager ?? (c => new AccountManager(c)))(config);
  let failed = false;
  try {
    for (const [account, wanted] of targets) {
      try {
        await manager.withClient(account, async client => {
          const existing = new Set((await client.list()).map(f => f.path));
          stdout(`${account}:`);
          for (const folder of [...wanted].sort()) {
            if (existing.has(folder)) {
              stdout(`  ${folder} — exists`);
            } else if (values.create && approved.get(account)?.has(folder)) {
              await client.mailboxCreate(folder);
              stdout(`  ${folder} — created`);
            } else {
              const hint = values.create ? ' (not in create_folders, not created)' : '';
              stdout(`  ${folder} — missing${hint}`);
            }
          }
        });
      } catch (err) {
        failed = true;
        stderr(`${account}: FAILED — ${message(err)}`);
      }
    }
  } finally {
    await manager.closeAll().catch(() => {});
  }
  return failed ? 2 : 0;
}
