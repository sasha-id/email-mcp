import type { Action } from './schema.js';

export const INSTR =
  "Triage one email that arrived in one of Alexander Yusupov's mailboxes. Choose the single action category that fits it best. " +
  'Prefer attention only when Alexander personally must act, reply or know now; a broadcast or automated update that is merely relevant is fyi. ' +
  'Security or account-change notices he may not have caused are attention. Never choose trash for receipts, statements, security notices or real human correspondence. ' +
  'Choose unsure when the email fits none of the categories or the evidence is ambiguous.';

export const CHOICES: Array<[string, string]> = [
  ['attention', 'Keep unread: a real person or system needs Alexander to act, reply, decide or know now (direct human mail to him, a mention, assignment or review request for him, an unexpected security or account warning, a required action with a deadline).'],
  ['fyi', 'Mark read and keep in place: legitimate and relevant but no action needed now (routine updates, team broadcasts, informational notices).'],
  ['finance', 'Bank, card, broker or payment-service transaction alerts, transfers and statements.'],
  ['auth', 'One-time passwords, verification or login codes, magic sign-in links.'],
  ['receipts', 'Receipts, invoices, payment confirmations and subscription renewals from vendors.'],
  ['orders', 'Order, shipping and delivery status updates from shops and marketplaces.'],
  ['alerts', 'Automated system alarms: monitoring, health events, CI or job failures, error and quota notices.'],
  ['trash', 'Marketing, promotions, newsletters, surveys and bulk noise Alexander never needs; safe to delete.'],
  ['unsure', 'None of the above fits or the evidence is ambiguous.'],
];

export const VERDICTS = CHOICES.map(([v]) => v);

const BODY_CAP = 8_000;
const HEADER_CAP = 600;
const MIN_INTERVAL_MS = 200; // ~5 requests per second
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 30_000;

export interface ClassifierMessage {
  account: string;
  purpose?: string;
  from?: string;
  to?: string;
  cc?: string;
  replyTo?: string;
  date?: string;
  subject?: string;
  body: string;
}

/**
 * Collapse whitespace and drop obviously quoted history: `>` lines and
 * everything after a "On … wrote:" or Outlook "Original Message"/From+Sent block.
 */
export function cleanBody(text: string): string {
  const kept: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^On .+wrote:\s*$/i.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim())) break;
    if (/^From:\s/i.test(line) && /^(Sent|Date):\s/i.test(lines[i + 1] ?? '')) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line.replace(/[ \t ]+/g, ' ').trim());
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildClassifierInput(m: ClassifierMessage): string {
  const lines = [m.purpose ? `Mailbox: ${m.account} (${m.purpose})` : `Mailbox: ${m.account}`];
  const headers: Array<[string, string | undefined]> = [
    ['From', m.from],
    ['To', m.to],
    ['Cc', m.cc],
    ['Reply-To', m.replyTo],
    ['Date', m.date],
    ['Subject', m.subject],
  ];
  for (const [name, value] of headers) {
    if (value) lines.push(`${name}: ${value.slice(0, HEADER_CAP)}`);
  }
  let body = cleanBody(m.body);
  const truncated = body.length > BODY_CAP;
  if (truncated) body = body.slice(0, BODY_CAP);
  lines.push(`Body (cleaned${truncated ? ', truncated' : ''}):`);
  lines.push(body || '(empty)');
  return lines.join('\n');
}

export type ClassifyResult =
  | {
      ok: true;
      verdict: string;
      confidence: number;
      latency_ms: number;
      tokens?: { input?: number; output?: number };
      cost?: number;
    }
  | { ok: false; error: string; latency_ms: number };

export interface ClassifierDeps {
  apiKey: string;
  baseUrl: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class ClassifierClient {
  private nextSlot = 0;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly provider: 'luna' | 'jev',
    private readonly deps: ClassifierDeps,
  ) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.sleep = deps.sleep ?? realSleep;
    this.now = deps.now ?? Date.now;
  }

  private request(text: string): { path: string; body: unknown } {
    if (this.provider === 'luna') {
      return {
        path: '/v1/decisions',
        body: {
          model: 'openai/gpt-6-luna',
          input: text,
          questions: [
            { type: 'choice', instructions: INSTR, choices: CHOICES.map(([value, description]) => ({ value, description })) },
          ],
        },
      };
    }
    return {
      path: '/typesafe/v1/systemone',
      body: {
        model: 'jev-latest',
        state: text,
        questions: { category: { type: 'choice', instructions: INSTR, criteria: Object.fromEntries(CHOICES) } },
      },
    };
  }

  private parse(json: unknown): { verdict: unknown; confidence: unknown; usage: Record<string, unknown> } {
    const j = json as { answers?: unknown; usage?: Record<string, unknown> };
    const answer =
      this.provider === 'luna'
        ? (j.answers as Array<Record<string, unknown>> | undefined)?.[0]
        : (j.answers as Record<string, Record<string, unknown>> | undefined)?.category;
    return { verdict: answer?.choice, confidence: answer?.confidence, usage: j.usage ?? {} };
  }

  private async gate(): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + MIN_INTERVAL_MS;
    if (slot > now) await this.sleep(slot - now);
  }

  async classify(text: string): Promise<ClassifyResult> {
    const { path, body } = this.request(text);
    const url = this.deps.baseUrl.replace(/\/+$/, '') + path;
    const started = this.now();
    const failed = (error: string): ClassifyResult => ({ ok: false, error, latency_ms: this.now() - started });
    for (let attempt = 1; ; attempt++) {
      await this.gate();
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.deps.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.deps.timeoutMs ?? TIMEOUT_MS),
        });
      } catch (err) {
        return failed(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) return failed(`HTTP ${res.status} after ${attempt} attempts`);
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
        await this.sleep(Math.min(wait, MAX_BACKOFF_MS));
        continue;
      }
      if (!res.ok) return failed(`HTTP ${res.status}`);
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return failed('invalid JSON response');
      }
      const { verdict, confidence, usage } = this.parse(json);
      if (typeof verdict !== 'string' || !VERDICTS.includes(verdict) || typeof confidence !== 'number') {
        return failed('invalid classifier output');
      }
      const cost = Number(res.headers.get('x-litellm-response-cost'));
      return {
        ok: true,
        verdict,
        confidence,
        latency_ms: this.now() - started,
        tokens: {
          input: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
          output: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
        },
        cost: res.headers.has('x-litellm-response-cost') && Number.isFinite(cost) ? cost : undefined,
      };
    }
  }
}

/**
 * Map a classifier verdict to an action: unmapped verdicts, "unsure" and
 * confidence below the threshold fall back to the file's default action.
 */
export function verdictAction(
  verdict: string,
  confidence: number,
  cfg: { min_confidence: number; map: Record<string, Action> },
  fallback: Action,
): Action {
  if (verdict === 'unsure' || confidence < cfg.min_confidence) return fallback;
  return cfg.map[verdict] ?? fallback;
}
