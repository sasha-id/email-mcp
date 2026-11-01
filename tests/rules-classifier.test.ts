import { describe, expect, it } from 'vitest';
import {
  buildClassifierInput,
  ClassifierClient,
  cleanBody,
  INSTR,
  verdictAction,
} from '../src/rules/classifier.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function recorder(responses: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next();
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const noSleep = { sleeps: [] as number[] };
function deps(fetchFn: typeof fetch, sleeps: number[] = noSleep.sleeps) {
  return { apiKey: 'k', baseUrl: 'https://llm.test', fetchFn, sleep: async (ms: number) => void sleeps.push(ms) };
}

describe('ClassifierClient', () => {
  it('posts the luna decision request and parses the answer', async () => {
    const { calls, fetchFn } = recorder([
      () =>
        jsonResponse(
          { answers: [{ choice: 'finance', confidence: 0.9 }], usage: { input_tokens: 10, output_tokens: 2 } },
          200,
          { 'x-litellm-response-cost': '0.0012' },
        ),
    ]);
    const result = await new ClassifierClient('luna', deps(fetchFn)).classify('hello');
    expect(result).toMatchObject({ ok: true, verdict: 'finance', confidence: 0.9, tokens: { input: 10, output: 2 }, cost: 0.0012 });
    expect(calls[0].url).toBe('https://llm.test/v1/decisions');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe('openai/gpt-6-luna');
    expect(body.input).toBe('hello');
    expect(body.questions[0].instructions).toBe(INSTR);
    expect(body.questions[0].choices.map((c: { value: string }) => c.value)).toContain('unsure');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('posts the jev systemone request and parses the answer', async () => {
    const { calls, fetchFn } = recorder([() => jsonResponse({ answers: { category: { choice: 'auth', confidence: 0.8 } } })]);
    const result = await new ClassifierClient('jev', deps(fetchFn)).classify('hi');
    expect(result).toMatchObject({ ok: true, verdict: 'auth', confidence: 0.8 });
    expect(calls[0].url).toBe('https://llm.test/typesafe/v1/systemone');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe('jev-latest');
    expect(body.state).toBe('hi');
    expect(Object.keys(body.questions.category.criteria)).toContain('trash');
  });

  it('retries HTTP 429 honouring Retry-After, then succeeds', async () => {
    const sleeps: number[] = [];
    const { calls, fetchFn } = recorder([
      () => jsonResponse({}, 429, { 'retry-after': '2' }),
      () => jsonResponse({}, 503),
      () => jsonResponse({ answers: [{ choice: 'fyi', confidence: 0.7 }] }),
    ]);
    const result = await new ClassifierClient('luna', deps(fetchFn, sleeps)).classify('x');
    expect(result).toMatchObject({ ok: true, verdict: 'fyi' });
    expect(calls).toHaveLength(3);
    expect(sleeps).toContain(2000);
  });

  it('gives up after 3 attempts', async () => {
    const { calls, fetchFn } = recorder([
      () => jsonResponse({}, 429),
      () => jsonResponse({}, 429),
      () => jsonResponse({}, 429),
    ]);
    const result = await new ClassifierClient('luna', deps(fetchFn, [])).classify('x');
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it('fails on timeout without retrying', async () => {
    let n = 0;
    const fetchFn = ((_url: string, init: RequestInit) => {
      n++;
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }) as unknown as typeof fetch;
    const result = await new ClassifierClient('luna', { ...deps(fetchFn), timeoutMs: 10 }).classify('x');
    expect(result.ok).toBe(false);
    expect(n).toBe(1);
  });

  it.each([
    ['a 4xx', () => jsonResponse({ error: 'refused' }, 400)],
    ['an unknown verdict', () => jsonResponse({ answers: [{ choice: 'spam', confidence: 0.9 }] })],
    ['a missing confidence', () => jsonResponse({ answers: [{ choice: 'fyi' }] })],
    ['non-JSON', () => new Response('nope', { status: 200 })],
  ])('fails on %s', async (_name, response) => {
    const { fetchFn } = recorder([response]);
    expect((await new ClassifierClient('luna', deps(fetchFn)).classify('x')).ok).toBe(false);
  });

  it('spaces requests to about 5 per second', async () => {
    const sleeps: number[] = [];
    const ok = () => jsonResponse({ answers: [{ choice: 'fyi', confidence: 1 }] });
    const { fetchFn } = recorder([ok, ok, ok]);
    const client = new ClassifierClient('luna', { ...deps(fetchFn, sleeps), now: () => 1000 });
    await client.classify('a');
    await client.classify('b');
    await client.classify('c');
    expect(sleeps).toEqual([200, 400]);
  });
});

describe('verdictAction', () => {
  const cfg = {
    min_confidence: 0.6,
    map: { finance: { kind: 'move', folder: 'Finance', read: true } as const, unsure: { kind: 'trash' } as const },
  };
  const fallback = { kind: 'keep' } as const;

  it('maps a confident verdict', () => {
    expect(verdictAction('finance', 0.9, cfg, fallback)).toEqual({ kind: 'move', folder: 'Finance', read: true });
  });
  it('falls back below min_confidence', () => {
    expect(verdictAction('finance', 0.5, cfg, fallback)).toBe(fallback);
  });
  it('falls back for unsure even when mapped', () => {
    expect(verdictAction('unsure', 0.99, cfg, fallback)).toBe(fallback);
  });
  it('falls back for an unmapped verdict', () => {
    expect(verdictAction('orders', 0.99, cfg, fallback)).toBe(fallback);
  });
});

describe('classifier input', () => {
  it('drops quoted history and collapses whitespace', () => {
    const body = 'Hi   there\n\n\n\nSee below\n> old line\nOn Mon, 1 Jun 2026, Bob wrote:\n> quoted';
    expect(cleanBody(body)).toBe('Hi there\n\nSee below');
  });

  it('renders headers, purpose and caps the body with a truncated marker', () => {
    const text = buildClassifierInput({
      account: 'personal',
      purpose: 'home mail',
      from: 'a@b.com',
      subject: 'Hello',
      body: 'x'.repeat(9000),
    });
    expect(text).toMatch(/^Mailbox: personal \(home mail\)\nFrom: a@b\.com\nSubject: Hello\nBody \(cleaned, truncated\):\n/);
    expect(text.endsWith('x'.repeat(8000))).toBe(true);
    expect(text.length).toBeLessThan(8200);
  });
});
