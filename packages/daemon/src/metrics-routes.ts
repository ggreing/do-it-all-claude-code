// The metrics reads (decision 132), as routes of the daemon's own API: GET /router/v1/metrics/<what>. They are
// read-only and reached like every other route (a sealed call, decision 156). Until 0.5.0 they were cookie
// routes of the browser dashboard (decision 183 removed it); the query parameters and the answers are the same.
//
//   summary          ?since=&until=                      the window's totals, plus the latest rate limits
//   requests         ?since=&until=&limit=&level=&outcome=&before=<closedAt>,<requestId>
//   requests/<id>    one request's record and signals; its prompt only while recordPrompts is on
//   triage-report    ?since=&until=
import type { Level } from '@do-it-all-claude-code/core';
import { isoTime } from './data.ts';
import type { Ledger } from './ledger.ts';
import { latestLimits } from './limits.ts';
import { metricsRequestDetail, metricsRequests, metricsSummary, metricsTriageReport, type RequestsQuery } from './metrics.ts';

export const METRICS_PREFIX = '/router/v1/metrics';

export interface MetricsRouteOptions {
  /** Decision 142: a stored prompt is returned only while the option is on. */
  recordPrompts?: boolean;
  /** Values masked in a returned prompt. */
  secrets?: string[];
}

export interface RouteAnswer { status: number; body: unknown }

/** Whether a path is one of the metrics routes (so the server can answer 404 for anything else before auth). */
export const isMetricsRoute = (pathname: string): boolean => pathname.startsWith(`${METRICS_PREFIX}/`);

/** The answer of a metrics route. Bad input is a 400 and an unknown path a 404; the ledger is only read. */
export function metricsRoute(ledger: Ledger, method: string | undefined, url: URL, o: MetricsRouteOptions = {}): RouteAnswer {
  if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };
  const q = url.searchParams;
  for (const k of ['since', 'until']) {
    const raw = q.get(k);
    if (raw !== null && raw !== '' && !isoTime(raw)) return { status: 400, body: { error: `${k} is not a date` } };
  }
  const window = { since: q.get('since') || undefined, until: q.get('until') || undefined };
  const sub = url.pathname.slice(METRICS_PREFIX.length).replace(/^\//, '');
  const limitRaw = q.get('limit');
  if (limitRaw !== null && !/^\d{1,4}$/.test(limitRaw)) return { status: 400, body: { error: 'limit must be a number' } };
  try {
    if (sub === 'summary') return { status: 200, body: { ...metricsSummary(ledger, window), limits: latestLimits(ledger.db) } };
    if (sub === 'requests') {
      const before = q.get('before');
      const bits = before ? before.split(',') : null;
      const query: RequestsQuery = {
        ...window,
        limit: limitRaw ? Number(limitRaw) : undefined,
        level: (q.get('level') as Level) ?? undefined,
        outcome: q.get('outcome') ?? undefined,
        before: bits && bits.length === 2 ? { closedAt: bits[0]!, requestId: bits[1]! } : null,
      };
      return { status: 200, body: metricsRequests(ledger, query) };
    }
    if (sub.startsWith('requests/')) {
      let id: string;
      try { id = decodeURIComponent(sub.slice('requests/'.length)); } catch { return { status: 400, body: { error: 'malformed request id' } }; }
      const detail = metricsRequestDetail(ledger, id, { includePrompt: o.recordPrompts === true, secrets: o.secrets ?? [] });
      return detail ? { status: 200, body: detail } : { status: 404, body: { error: 'no such request' } };
    }
    if (sub === 'triage-report') return { status: 200, body: metricsTriageReport(ledger, window) };
  } catch {
    return { status: 500, body: { error: 'metrics query failed' } };
  }
  return { status: 404, body: { error: 'not found' } };
}

/** What `/dashboard` answers for one release (decision 186): the page is gone, and where its content went. */
export const DASHBOARD_GONE = 'The browser dashboard was removed in 0.5.0. Use /office inside Claude Code.\n';
export const isDashboardPath = (pathname: string): boolean => pathname === '/dashboard' || pathname.startsWith('/dashboard/');
