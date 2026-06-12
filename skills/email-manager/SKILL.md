---
name: email-manager
description: Manage email across configured accounts via the email MCP tools — triage, search, read, reply, archive, batch operations. Use when the user asks about their email, inbox, unread messages, or wants to send/reply/archive/delete mail.
---

# Email Manager

Orchestrates the `email_*` MCP tools (email-mcp server). All tools are
account-scoped; message identity is `{account, mailbox, uid}`.

## Ground rules

1. **Start with `email_list_accounts`** when account names are not already
   known in this conversation. Never guess account names.
2. **Confirm before sending.** Show the user recipient(s), subject, and body
   before calling `email_send`. Same for `email_delete` with
   `permanent: true` — that one is irreversible. Trash-deletes, flag changes,
   and moves do not need confirmation.
3. **Batch mutations.** Collect uids from `email_search`, then issue ONE
   `email_mark`/`email_move`/`email_delete` call with `uids: [...]` — never
   one call per message.
4. **M365 auth expiry.** If a tool fails with "run email_authenticate", call
   `email_authenticate` for that account, give the user the URL + code, and
   retry the original call after they confirm login (check with another
   `email_authenticate` call).
5. **Keep output small.** Default search limit is 20; raise it only when the
   user asks. Use `email_read` on selected uids, not on whole result lists.

## Workflows

### Cross-account triage ("anything new?", "check my email")
1. `email_list_accounts`
2. `email_search` per account in parallel with `{ seen: false }`
3. Summarize per account: count + one line per notable message (sender,
   subject). Flag anything urgent-looking.

### Read / summarize a thread
1. `email_search` with `subject`/`from` to find the messages
2. `email_read` each relevant uid (newest first, stop when context suffices)
3. Synthesize; offer to reply.

### Reply in-thread
1. Locate the message (`email_search`, note `account`, `mailbox`, `uid`)
2. Draft the reply body; show the user
3. On approval: `email_send` with `replyTo: { mailbox, uid }` — recipients
   and "Re:" subject default from the original; threading headers are set
   automatically.

### Bulk archive/cleanup ("archive all newsletters from X")
1. `email_search` with `from`/`subject` filters (raise `limit` if needed)
2. Show the user the matching list briefly
3. `email_list_folders` to find the archive/target folder
4. One `email_move` with all uids.

### Save an attachment
1. `email_read` the message — attachments are listed `[index] name — type, size`
2. `email_attachment` with `index` and an absolute `savePath`.

## Account notes

Fill in (or learn from `email_list_accounts`):
- `personal` — primary personal mail
- `work` — M365/Exchange Online; needs `email_authenticate` on first use and
  after long idle periods
