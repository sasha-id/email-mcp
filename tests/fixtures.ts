export const EML_PLAIN = [
  'From: Alice Example <alice@example.com>',
  'To: Bob Example <bob@example.com>',
  'Cc: carol@example.com',
  'Subject: Lunch?',
  'Date: Mon, 01 Jun 2026 10:00:00 +0000',
  'Message-ID: <plain-1@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Sushi at noon?',
  '',
].join('\r\n');

export const EML_HTML_ONLY = [
  'From: news@example.com',
  'To: bob@example.com',
  'Subject: Weekly digest',
  'Date: Tue, 02 Jun 2026 09:00:00 +0000',
  'Message-ID: <html-1@example.com>',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><head><style>p{color:red}</style></head>',
  '<body><h1>Digest</h1><p>First &amp; second item</p><br><p>Bye</p></body></html>',
  '',
].join('\r\n');

export const EML_WITH_ATTACHMENT = [
  'From: Alice Example <alice@example.com>',
  'To: Bob Example <bob@example.com>',
  'Subject: Quarterly report',
  'Date: Mon, 01 Jun 2026 10:00:00 +0000',
  'Message-ID: <attach-1@example.com>',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Report attached.',
  '--b1',
  'Content-Type: application/pdf',
  'Content-Disposition: attachment; filename="report.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQKJeLjz9MK',
  '--b1--',
  '',
].join('\r\n');

export const EML_REPLY_TARGET = [
  'From: Dana Sender <dana@example.com>',
  'Reply-To: dana-replies@example.com',
  'To: me@example.com',
  'Subject: Project kickoff',
  'Date: Wed, 03 Jun 2026 08:00:00 +0000',
  'Message-ID: <kickoff-9@example.com>',
  'References: <thread-root-1@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Shall we start Monday?',
  '',
].join('\r\n');

/** Header block of EML_REPLY_TARGET, as a HEADER.FIELDS fetch would return it. */
export const EML_REPLY_TARGET_HEADERS = EML_REPLY_TARGET.slice(0, EML_REPLY_TARGET.indexOf('\r\n\r\n') + 4);

/** Header block of EML_WITH_ATTACHMENT, as a BODY.PEEK[HEADER] fetch would return it. */
export const EML_WITH_ATTACHMENT_HEADERS = EML_WITH_ATTACHMENT.slice(0, EML_WITH_ATTACHMENT.indexOf('\r\n\r\n') + 4);

/** BODYSTRUCTURE of EML_WITH_ATTACHMENT, as imapflow parses it. */
export const STRUCT_WITH_ATTACHMENT = {
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'text/plain', size: 17 },
    {
      part: '2',
      type: 'application/pdf',
      size: 16,
      disposition: 'attachment',
      dispositionParameters: { filename: 'report.pdf' },
    },
  ],
};

/** Decoded content of the fixture's report.pdf part (what download() streams). */
export const PDF_BYTES = Buffer.from('%PDF-1.4\nfake-pdf-bytes');
