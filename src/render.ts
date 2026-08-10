export interface AddressLike {
  name?: string;
  address?: string;
}

export function formatAddress(addr?: AddressLike | null): string {
  if (!addr) return '(unknown)';
  if (addr.name && addr.address) return `${addr.name} <${addr.address}>`;
  return addr.address ?? addr.name ?? '(unknown)';
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface MessageSummary {
  uid: number;
  envelope: {
    date?: Date | null;
    subject?: string | null;
    from?: AddressLike[] | null;
  };
  flags?: Set<string>;
  size?: number;
}

export function summarizeMessage(m: MessageSummary): string {
  const date = m.envelope?.date
    ? new Date(m.envelope.date).toISOString().slice(0, 10)
    : 'unknown-date';
  const from = formatAddress(m.envelope?.from?.[0]);
  const subject = m.envelope?.subject || '(no subject)';
  const flags = m.flags && m.flags.size > 0 ? ` [${[...m.flags].join(' ')}]` : '';
  const size = m.size !== undefined ? ` (${m.size} bytes)` : '';
  return `uid=${m.uid} ${date} ${from} — ${subject}${flags}${size}`;
}

/**
 * A message ready to render: headers already parsed, body already plain text
 * (HTML stripped by the caller), attachments as structure metadata only.
 * Nothing here requires the full message source to have been transferred.
 */
export interface RenderableMessage {
  from?: AddressLike | null;
  to?: AddressLike[] | null;
  cc?: AddressLike[] | null;
  date?: string | null;
  subject?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  body: string;
  attachments: Array<{ filename?: string; mimeType: string; size?: number }>;
}

export function renderMessage(msg: RenderableMessage, opts: { maxBody?: number } = {}): string {
  const maxBody = opts.maxBody ?? 50_000;
  const lines: string[] = [];
  lines.push(`From: ${formatAddress(msg.from)}`);
  if (msg.to?.length) lines.push(`To: ${msg.to.map(a => formatAddress(a)).join(', ')}`);
  if (msg.cc?.length) lines.push(`Cc: ${msg.cc.map(a => formatAddress(a)).join(', ')}`);
  lines.push(`Date: ${msg.date ?? '(unknown)'}`);
  lines.push(`Subject: ${msg.subject ?? '(no subject)'}`);
  if (msg.messageId) lines.push(`Message-ID: ${msg.messageId}`);
  if (msg.inReplyTo) lines.push(`In-Reply-To: ${msg.inReplyTo}`);

  let body = msg.body;
  let notice = '';
  if (body.length > maxBody) {
    body = body.slice(0, maxBody);
    notice = `\n[body truncated at ${maxBody} characters]`;
  }
  lines.push('', body + notice);

  if (msg.attachments.length > 0) {
    lines.push('', 'Attachments:');
    msg.attachments.forEach((a, i) => {
      const size = a.size !== undefined ? `${a.size} bytes` : 'unknown size';
      lines.push(`  [${i}] ${a.filename ?? '(unnamed)'} — ${a.mimeType}, ${size}`);
    });
  }
  return lines.join('\n');
}
