// Public library entry: `@sashaid/email-mcp/lib`.
export { loadConfig, configPath } from './config.js';
export type { Account, Config, OpReader } from './config.js';
export { AccountManager } from './accounts.js';
export type { ImapConnectOptions, ManagerDeps, MakeClient, SmtpAuth } from './accounts.js';
export { sendMail } from './mail.js';
export type { SendMailOptions, SendMailResult } from './mail.js';
export { appendToSentFolder } from './sent.js';
export type { AppendResult } from './sent.js';
export type { SendDeps, SmtpTransportOptions } from './tools/send.js';
export type { ImapFlow } from 'imapflow';
