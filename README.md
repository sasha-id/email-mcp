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

## Development

```bash
npm test          # vitest unit suite (no network)
npm run build     # tsc → dist/
```

Manual end-to-end testing: run the server and exercise each tool against a real account.
