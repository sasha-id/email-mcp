import { describe, expect, it } from 'vitest';
import { analyzeStructure } from '../src/structure.js';

describe('analyzeStructure', () => {
  it('picks the first text/plain leaf as body; non-text leaves are attachments', () => {
    const result = analyzeStructure({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 17 },
        {
          part: '2',
          type: 'application/pdf',
          size: 512_000,
          disposition: 'attachment',
          dispositionParameters: { filename: 'report.pdf' },
        },
      ],
    });
    expect(result.body).toEqual({ part: '1', mimeType: 'text/plain', size: 17, isHtml: false });
    expect(result.attachments).toEqual([
      { part: '2', filename: 'report.pdf', mimeType: 'application/pdf', size: 512_000 },
    ]);
  });

  it('descends nested multiparts and prefers text/plain over text/html', () => {
    // The shape of the 14 MB message that motivated this: plain+html wrapped in
    // alternative, then heavyweight inline images.
    const result = analyzeStructure({
      type: 'multipart/related',
      childNodes: [
        {
          part: '1',
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain', size: 15_707 },
            { part: '1.2', type: 'text/html', size: 24_112 },
          ],
        },
        { part: '2', type: 'image/jpeg', size: 3_652_990, disposition: 'inline' },
      ],
    });
    expect(result.body?.part).toBe('1.1');
    // The html twin of the alternative group is not an attachment; the inline
    // image is.
    expect(result.attachments).toEqual([
      { part: '2', filename: undefined, mimeType: 'image/jpeg', size: 3_652_990 },
    ]);
  });

  it('falls back to the text/html leaf when no plain part exists', () => {
    const result = analyzeStructure({ type: 'text/html', size: 900 });
    expect(result.body).toEqual({ part: '1', mimeType: 'text/html', size: 900, isHtml: true });
    expect(result.attachments).toEqual([]);
  });

  it('treats a single-node text/plain message as part "1"', () => {
    const result = analyzeStructure({ type: 'text/plain', size: 42 });
    expect(result.body?.part).toBe('1');
    expect(result.attachments).toEqual([]);
  });

  it('keeps extra top-level text parts as attachments (only the alternative twin is dropped)', () => {
    const result = analyzeStructure({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        { part: '2', type: 'text/plain', size: 20, dispositionParameters: { filename: 'notes.txt' } },
      ],
    });
    expect(result.body?.part).toBe('1');
    expect(result.attachments).toEqual([{ part: '2', filename: 'notes.txt', mimeType: 'text/plain', size: 20 }]);
  });

  it('resolves filenames from dispositionParameters, falling back to parameters.name', () => {
    const result = analyzeStructure({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        { part: '2', type: 'application/pdf', size: 1, disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' } },
        { part: '3', type: 'application/pdf', size: 1, parameters: { name: 'b.pdf' } },
      ],
    });
    expect(result.attachments.map(a => a.filename)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('handles a missing or empty structure', () => {
    expect(analyzeStructure(undefined)).toEqual({ body: null, attachments: [] });
  });
});
