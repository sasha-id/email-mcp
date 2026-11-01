import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const RETAIN_MS = 60 * 86_400_000;

export interface StateEntry {
  decision: string;
  at: string;
}

export function stateKey(account: string, mailbox: string, uidValidity: string, uid: number): string {
  return `${account}|${mailbox}|${uidValidity}|${uid}`;
}

/**
 * Decisions remembered across runs, so mail already decided `keep` (by a rule
 * or the classifier) is not re-evaluated — and re-classified — every run.
 */
export class RunState {
  private constructor(private readonly entries: Record<string, StateEntry>) {}

  static empty(): RunState {
    return new RunState({});
  }

  /** Missing or unreadable file => empty state plus a warning; old entries are pruned. */
  static load(path: string, now: number, warn: (msg: string) => void): RunState {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      warn(`state file ${path} not found — starting empty`);
      return RunState.empty();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warn(`state file ${path} is not valid JSON — starting empty`);
      return RunState.empty();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn(`state file ${path} has an unexpected shape — starting empty`);
      return RunState.empty();
    }
    const entries: Record<string, StateEntry> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const e = value as Partial<StateEntry> | null;
      if (!e || typeof e.decision !== 'string' || typeof e.at !== 'string') continue;
      const at = Date.parse(e.at);
      if (Number.isNaN(at) || now - at > RETAIN_MS) continue;
      entries[key] = { decision: e.decision, at: e.at };
    }
    return new RunState(entries);
  }

  isKept(key: string): boolean {
    return this.entries[key]?.decision === 'keep';
  }

  record(key: string, decision: string, now: number): void {
    this.entries[key] = { decision, at: new Date(now).toISOString() };
  }

  toJSON(): Record<string, StateEntry> {
    return this.entries;
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2));
    renameSync(tmp, path);
  }
}
