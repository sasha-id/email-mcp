# email-mcp

MCP server (stdio) exposing structured email tools over IMAP/SMTP for multiple
accounts: `email_list_accounts`, `email_list_folders`, `email_search`,
`email_read`, `email_attachment`, `email_mark`, `email_move`, `email_delete`,
`email_send`, `email_authenticate`.

## Setup

```bash
npm install
npm run build
```

Copy `accounts.example.json` to `~/.config/email-mcp/accounts.json` (or set
`EMAIL_MCP_CONFIG`) and fill in your accounts.

- `auth.type: "password"` — plain IMAP LOGIN / SMTP AUTH. `pass` is either a
  literal or a 1Password reference (`op://vault/item/field`), resolved via
  `op read` at first use — the `op` CLI must be signed in.
- `auth.type: "m365-oauth"` — Exchange Online / Microsoft 365 via XOAUTH2
  device-code flow (basic-auth IMAP is dead there). `tenant` is your domain or
  tenant ID; `clientId` is optional and defaults to Thunderbird's public client.
  Run the `email_authenticate` tool once per account; the refresh token is
  cached at `~/.config/email-mcp/tokens/<account>.json` (chmod 600).
- `appendToSent: true` — copy sent mail to the `\Sent` folder via IMAP APPEND
  (for servers that don't save it automatically; keep `false` for M365/Gmail).

## Register with Claude Code (user scope)

```bash
claude mcp add --scope user email -- node /path/to/email-mcp/dist/index.js
```

Or in JSON config:

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["/path/to/email-mcp/dist/index.js"],
      "env": { "EMAIL_MCP_CONFIG": "/absolute/path/to/accounts.json" }
    }
  }
}
```

## Skill

Symlink the bundled orchestration skill into your personal skills directory so
Claude Code picks it up:

```bash
ln -s /path/to/email-mcp/skills/email-manager ~/.claude/skills/email-manager
```

## Rules mode (non-interactive sorting)

`email-mcp rules` sorts mail by ordered, deterministic rules from YAML files,
with an optional LiteLLM classifier for mail no rule matches. It uses the same
account config, 1Password references and M365 tokens as the server. With no
subcommand, `email-mcp` still starts the MCP server.

```bash
email-mcp rules check <file.yml>...        # validate; exit 0/1
email-mcp rules run <file.yml>... [--dry-run] [--accounts a,b] [--since YYYY-MM-DD]
                                  [--include-read] [--state <path>] [--report <path.json>]
                                  [--no-classifier]
email-mcp rules folders <file.yml>... [--create]
```

- `run` handles unread mail in the file's mailboxes by default. Add `--since`
  and `--include-read` for a one-off backlog pass.
- `--dry-run` still searches, fetches and calls the classifier, but changes
  nothing and never sets `\Seen`. It prints the planned action for each message.
- `--state` remembers messages already decided `keep` (by a rule or the
  classifier), so later runs skip them. Entries older than 60 days are pruned.
- `--report` writes a JSON report. It is written even if the run fails.
- Exit codes: `0` ok, `1` config or validation error, `2` some account failed
  (the other accounts were still processed).
- `folders` lists the folders each account's move, map and purge actions
  target. `--create` creates the missing ones, but only those listed in
  `create_folders`.

```yaml
version: 1
accounts: [personal, work]       # account names from accounts.json (required)
mailboxes: [INBOX]               # default [INBOX]
unread_only: true                # default true
default_action: keep             # no rule matched and no classifier verdict
sweep_trash_unread: false        # mark unread mail in \Trash read after the pass
account_purpose:                 # optional context line for the classifier
  personal: "personal mail: family, home, bank"
classifier:                      # optional
  provider: luna                 # luna | jev
  min_confidence: 0.6            # below => default_action
  map:                           # verdict -> action; unlisted or "unsure" => default_action
    fyi: read
    finance: {move: Finance, read: true}
    auth: {move: Auth, read: true}
    trash: trash
purge:                           # time-based clean-up of a folder
  - {folder: Auth, older_than: 24h, action: trash}
create_folders:                  # folders `rules folders --create` may create
  personal: [Finance, Auth]
rules:                           # ordered; first match wins
  - id: codes
    accounts: [personal]         # optional filter
    when:                        # all conditions must hold; case-insensitive JS regexes
      from: '@accounts\.example\.com$'
      subject: 'verification code'
    action: {move: Auth, read: true}
  - id: replies
    when: {sent_thread: true}    # subject matches something you sent in the last 90 days
    action: keep
```

Conditions: `from`, `from_not`, `from_name`, `subject`, `subject_not`, `to`,
`cc`, `to_cc`, `list_id`, `body` (fetched only when a rule reaches that
condition), `sent_thread`, `sent_recipient` (a sender you wrote to in the last
180 days), and `older_than` (`Nh` or `Nd`). Actions:

- `keep`: change nothing.
- `read`: mark read.
- `trash`: mark read, then move to `\Trash`. It never expunges.
- `{move: F, read: bool}`: move to folder `F`. If `F` is missing, only the read
  flag is applied and the report records `folder_missing`.
- `classify`: send the message to the classifier.

The classifier calls LiteLLM at `LITELLM_BASE_URL` using `LITELLM_API_KEY`.
Without either it is skipped for the run and a warning goes in the report. If it fails, the
message gets `default_action`, except that a failure never trashes mail. The
Junk folder is never sent to the classifier.

## Use as a library

The IMAP, SMTP and OAuth code is importable without running the MCP server:

```ts
import { loadConfig, AccountManager, sendMail } from '@sashaid/email-mcp/lib';

const manager = new AccountManager(loadConfig());
await manager.withClient('personal', async client => client.list());
await sendMail(manager, 'personal', { to: ['a@example.com'], subject: 'Hi', text: 'Hello' });
```

`/lib` exports `loadConfig`, `configPath`, `AccountManager`, `sendMail` and the
related types (`Config`, `Account`, `SendMailOptions`, `SendMailResult`, `SmtpAuth`, ...).
`sendMail` uses the account's SMTP settings and auth (password, 1Password, or
Microsoft 365 OAuth) like the `email_send` tool; it does not file a copy in Sent.

## Development

```bash
npm test          # vitest unit suite (no network)
npm run build     # tsc → dist/
```

Manual end-to-end testing: run the server and exercise each tool against a real account.
