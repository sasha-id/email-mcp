/**
 * Walk an IMAP BODYSTRUCTURE tree and decide which part is the displayable
 * body and which parts are attachments — without transferring any content.
 * Sizes and filenames come from the structure itself, so a read can fetch
 * just the (small) text part it will actually render.
 */

export interface StructureNode {
  part?: string;
  type?: string;
  size?: number;
  disposition?: string | null;
  dispositionParameters?: { filename?: string } | null;
  parameters?: { name?: string } | null;
  childNodes?: StructureNode[];
}

export interface BodyPartRef {
  part: string;
  mimeType: string;
  size?: number;
  isHtml: boolean;
}

export interface AttachmentRef {
  part: string;
  filename?: string;
  mimeType: string;
  size?: number;
}

export interface MessageStructure {
  body: BodyPartRef | null;
  attachments: AttachmentRef[];
}

export function analyzeStructure(root: StructureNode | undefined | null): MessageStructure {
  const texts: Array<BodyPartRef & { alternative: boolean; filename?: string }> = [];
  const attachments: AttachmentRef[] = [];

  const walk = (node: StructureNode, inAlternative: boolean) => {
    if (node.childNodes && node.childNodes.length > 0) {
      const alternative = (node.type ?? '').toLowerCase() === 'multipart/alternative';
      for (const child of node.childNodes) walk(child, alternative);
      return;
    }
    // Single-node messages address their whole body as part "1".
    const part = node.part ?? '1';
    const type = (node.type ?? '').toLowerCase();
    const isText = type === 'text/plain' || type === 'text/html';
    if (isText && (node.disposition ?? '').toLowerCase() !== 'attachment') {
      texts.push({
        part,
        mimeType: node.type ?? 'text/plain',
        size: node.size,
        isHtml: type === 'text/html',
        alternative: inAlternative,
        filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? undefined,
      });
    } else {
      attachments.push({
        part,
        filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? undefined,
        mimeType: node.type ?? 'application/octet-stream',
        size: node.size,
      });
    }
  };

  if (root) walk(root, false);

  const body = texts.find(t => !t.isHtml) ?? texts[0] ?? null;
  // The unchosen twin inside multipart/alternative is the same body in another
  // representation — not an attachment. Extra text parts anywhere else are.
  for (const t of texts) {
    if (t === body || t.alternative) continue;
    attachments.push({ part: t.part, filename: t.filename, mimeType: t.mimeType, size: t.size });
  }
  return { body: body ? { part: body.part, mimeType: body.mimeType, size: body.size, isHtml: body.isHtml } : null, attachments };
}
