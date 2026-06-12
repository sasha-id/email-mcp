import type { Email } from 'postal-mime';

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

export function renderEmail(email: Email, opts: { maxBody?: number } = {}): string {
  const maxBody = opts.maxBody ?? 50_000;
  const lines: string[] = [];
  lines.push(`From: ${formatAddress(email.from as AddressLike)}`);
  if (email.to?.length) lines.push(`To: ${email.to.map(a => formatAddress(a as AddressLike)).join(', ')}`);
  if (email.cc?.length) lines.push(`Cc: ${email.cc.map(a => formatAddress(a as AddressLike)).join(', ')}`);
  lines.push(`Date: ${email.date ?? '(unknown)'}`);
  lines.push(`Subject: ${email.subject ?? '(no subject)'}`);
  if (email.messageId) lines.push(`Message-ID: ${email.messageId}`);
  if (email.inReplyTo) lines.push(`In-Reply-To: ${email.inReplyTo}`);

  let body = email.text ?? (email.html ? htmlToText(email.html) : '(no body)');
  let notice = '';
  if (body.length > maxBody) {
    body = body.slice(0, maxBody);
    notice = `\n[body truncated at ${maxBody} characters]`;
  }
  lines.push('', body + notice);

  if (email.attachments.length > 0) {
    lines.push('', 'Attachments:');
    email.attachments.forEach((a, i) => {
      const bytes = typeof a.content === 'string' ? a.content.length : a.content.byteLength;
      lines.push(`  [${i}] ${a.filename ?? '(unnamed)'} — ${a.mimeType}, ${bytes} bytes`);
    });
  }
  return lines.join('\n');
}
