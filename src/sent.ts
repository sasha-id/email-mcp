import type { AccountManager } from './accounts.js';

export interface AppendResult {
  /** Folder the copy was saved to */
  path?: string;
  /** Why no copy was saved (no \\Sent folder, or the APPEND failed) */
  error?: string;
  /** True when the account has no \\Sent folder (error is also set) */
  noSentFolder?: boolean;
}

/**
 * File a copy of a sent message in the account's \\Sent folder. Never throws:
 * the message has already been sent, so a failure here must not trigger a resend.
 */
export async function appendToSentFolder(manager: AccountManager, account: string, raw: Buffer): Promise<AppendResult> {
  try {
    // retry: false — APPEND is not idempotent; after an ambiguous
    // drop, re-appending could file a duplicate copy in Sent.
    return await manager.withClient(
      account,
      async client => {
        const folders = await client.list();
        const sent = folders.find(f => f.specialUse === '\\Sent');
        if (!sent) return { error: 'no \\Sent folder found', noSentFolder: true };
        await client.append(sent.path, raw, ['\\Seen']);
        return { path: sent.path };
      },
      { retry: false },
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
