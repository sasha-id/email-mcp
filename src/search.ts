export interface SearchParams {
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: string; // YYYY-MM-DD
  before?: string; // YYYY-MM-DD
  seen?: boolean;
  flagged?: boolean;
}

export type ImapSearchQuery = Record<string, string | boolean | Date>;

function parseDay(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${field} date "${value}" — expected YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${field} date "${value}"`);
  }
  return date;
}

export function buildSearchQuery(params: SearchParams): ImapSearchQuery {
  const query: ImapSearchQuery = {};
  if (params.text) query.body = params.text;
  if (params.from) query.from = params.from;
  if (params.to) query.to = params.to;
  if (params.subject) query.subject = params.subject;
  if (params.since) query.since = parseDay(params.since, 'since');
  if (params.before) query.before = parseDay(params.before, 'before');
  if (params.seen !== undefined) query.seen = params.seen;
  if (params.flagged !== undefined) query.flagged = params.flagged;
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}
