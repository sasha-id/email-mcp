import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Wraps a tool body: any thrown error becomes an isError result instead of an
 * MCP protocol failure, so one bad account or mailbox never kills the server.
 */
export async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    // AggregateError (e.g. Node's happy-eyeballs connect failure) is an Error
    // whose own .message is usually empty — report the inner errors instead.
    if (err instanceof AggregateError) {
      const inner = err.errors.map(e => (e instanceof Error ? e.message : String(e))).join('; ');
      return fail(err.message ? `${err.message}: ${inner}` : inner);
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
}
