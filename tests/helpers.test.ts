import { describe, expect, it } from 'vitest';
import { run } from '../src/tools/helpers.js';
import { isError, textOf } from './mcp.js';

describe('run', () => {
  it('passes through a successful result', async () => {
    const result = await run(async () => ({ content: [{ type: 'text', text: 'fine' }] }));
    expect(isError(result)).toBe(false);
    expect(textOf(result)).toBe('fine');
  });

  it('surfaces an ordinary error message', async () => {
    const result = await run(async () => {
      throw new Error('NO such mailbox');
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toBe('NO such mailbox');
  });

  it('joins the inner errors of an AggregateError instead of its empty message', async () => {
    // Node's happy-eyeballs connect failure is an AggregateError whose own
    // .message is empty — reporting it as-is yields a blank MCP error.
    const result = await run(async () => {
      throw new AggregateError(
        [new Error('connect ETIMEDOUT 2001:db8::1'), new Error('connect EHOSTUNREACH 51.158.1.2')],
        '',
      );
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toBe('connect ETIMEDOUT 2001:db8::1; connect EHOSTUNREACH 51.158.1.2');
  });

  it('keeps a non-empty AggregateError message ahead of the inner errors', async () => {
    const result = await run(async () => {
      throw new AggregateError([new Error('inner boom')], 'outer context');
    });
    expect(textOf(result)).toBe('outer context: inner boom');
  });
});
