// Reads a `claude -p --output-format stream-json --verbose` run: the init message (what loaded, which credential),
// the result (cost estimate, per-model usage), rate-limit events, and for `/usage` the usage_report that Claude Code
// attaches to the assistant message carrying the report (Agent SDK reference: SDKAssistantMessage.usage_report,
// SDKUsageReport; experimental). Only the fields used here are read, each defensively.

export interface InitInfo {
  /** "none" for a claude.ai login; "ANTHROPIC_API_KEY", "apiKeyHelper" or "/login managed key" when a key is in use. */
  apiKeySource: string | null;
  version: string | null;
  model: string | null;
  effort: string | null;
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  plugins: string[];
  /** Plugins that ship inside Claude Code (see isBuiltinPlugin): a baseline both arms have, not the user's. */
  builtinPlugins: string[];
  /** The init message's plugin entries as sent (their primitive fields), so a reading shows what marks a built-in. */
  pluginEntries: Array<Record<string, string | number | boolean | null>>;
  pluginErrors: string[];
  agents: string[];
  skills: string[];
}

/** One meter row as the server sent it; `key` tells rows apart (kind, plus the scope's label for scoped rows). */
export interface MeterRow {
  key: string;
  kind: string;
  group: string | null;
  percent: number;
  resetsAt: string | null;
  scope: string | null;
  severity: string | null;
  isActive: boolean;
}

export interface UsageReport { rows: MeterRow[]; extraUsageEnabled: boolean | null }

export interface ResultInfo {
  isError: boolean;
  subtype: string | null;
  costUsd: number;
  numTurns: number | null;
  durationMs: number | null;
  usage: Record<string, unknown> | null;
  modelUsage: Record<string, Record<string, unknown>>;
}

export interface RateLimitEvent { status: string; resetsAt: number | null; utilization: number | null }

export interface StreamSummary {
  init: InitInfo | null;
  result: ResultInfo | null;
  usageReport: UsageReport | null;
  /** The text of the assistant message that carried /usage (for when there is no usage_report). */
  usageText: string | null;
  rateLimitEvents: RateLimitEvent[];
  lines: number;
  badLines: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Whether an init plugin entry is one that ships inside Claude Code. 2.1.323 marks them in the entry itself:
 * { name: "cc-plugin-agents-md", path: "builtin", source: "cc-plugin-agents-md@builtin" }. That marker decides; an
 * entry with a real path or another source is the user's, whatever its name. Only an entry with neither a path nor
 * a source (an older version) falls back to the cc-plugin-<name> pattern Claude Code registers its built-ins under.
 */
export function isBuiltinPlugin(p: Obj): boolean {
  if (p.builtin === true || p.isBuiltin === true || p.builtIn === true) return true;
  if (typeof p.source === 'string') return /@built-?in$/i.test(p.source) || /^built-?in$/i.test(p.source);
  if (typeof p.path === 'string') return /^built-?in$/i.test(p.path);
  return typeof p.name === 'string' && /^cc-plugin-[a-z0-9][a-z0-9-]{0,63}$/.test(p.name);
}

function parseInit(m: Obj): InitInfo {
  const entries = (Array.isArray(m.plugins) ? m.plugins : []).filter(isObj);
  return {
    apiKeySource: str(m.apiKeySource), version: str(m.claude_code_version), model: str(m.model), effort: str(m.effort),
    tools: strings(m.tools),
    mcpServers: (Array.isArray(m.mcp_servers) ? m.mcp_servers : []).filter(isObj).map(s => ({ name: String(s.name ?? ''), status: String(s.status ?? '') })),
    plugins: entries.map(p => String(p.name ?? '')),
    builtinPlugins: entries.filter(isBuiltinPlugin).map(p => String(p.name ?? '')).sort(),
    pluginEntries: entries.map(p => Object.fromEntries(Object.entries(p).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) as Record<string, string | number | boolean | null>),
    pluginErrors: (Array.isArray(m.plugin_errors) ? m.plugin_errors : []).filter(isObj).map(e => `${String(e.plugin ?? '')}: ${String(e.message ?? '')}`),
    agents: strings(m.agents), skills: strings(m.skills),
  };
}

/** The usage_report's rows; null when the field is absent or carries no rows. */
export function parseUsageReport(r: unknown): UsageReport | null {
  if (!isObj(r) || !isObj(r.rate_limits)) return null;
  const limits = r.rate_limits.limits;
  if (!Array.isArray(limits)) return null;
  const rows: MeterRow[] = [];
  const seen = new Map<string, number>();
  for (const l of limits) {
    if (!isObj(l)) continue;
    const kind = str(l.kind), percent = num(l.percent);
    if (!kind || percent === null) continue;
    const scope = isObj(l.scope) ? str(isObj(l.scope.model) ? l.scope.model.display_name : null) ?? str(isObj(l.scope.surface) ? l.scope.surface.display_name : null) : null;
    let key = scope ? `${kind}:${scope}` : kind;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) key = `${key}#${n}`;
    rows.push({ key, kind, group: str(l.group), percent, resetsAt: str(l.resets_at), scope, severity: str(l.severity), isActive: l.is_active === true });
  }
  if (!rows.length) return null;
  const extra = isObj(r.rate_limits.extra_usage) ? r.rate_limits.extra_usage.is_enabled : undefined;
  return { rows, extraUsageEnabled: typeof extra === 'boolean' ? extra : null };
}

function textOf(message: unknown): string | null {
  if (!isObj(message) || !Array.isArray(message.content)) return null;
  const parts = message.content.filter(isObj).map(c => str(c.text)).filter((t): t is string => t !== null);
  return parts.length ? parts.join('\n') : null;
}

export function parseStream(stdout: string): StreamSummary {
  const out: StreamSummary = { init: null, result: null, usageReport: null, usageText: null, rateLimitEvents: [], lines: 0, badLines: 0 };
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    out.lines++;
    let m: unknown;
    try { m = JSON.parse(t); } catch { out.badLines++; continue; }
    if (!isObj(m)) { out.badLines++; continue; }
    if (m.type === 'system' && m.subtype === 'init' && !out.init) out.init = parseInit(m);
    else if (m.type === 'assistant' && m.parent_tool_use_id == null && 'usage_report' in m) {
      out.usageReport = parseUsageReport(m.usage_report) ?? out.usageReport;
      out.usageText = textOf(m.message) ?? out.usageText;
    } else if (m.type === 'assistant' && m.parent_tool_use_id == null && out.usageText === null && out.usageReport === null) {
      out.usageText = textOf(m.message);        // a /usage answer without the field (other logins, older versions)
    } else if (m.type === 'rate_limit_event' && isObj(m.rate_limit_info)) {
      const i = m.rate_limit_info;
      out.rateLimitEvents.push({ status: String(i.status ?? ''), resetsAt: num(i.resetsAt), utilization: num(i.utilization) });
    } else if (m.type === 'result') {
      out.result = {
        isError: m.is_error === true, subtype: str(m.subtype), costUsd: num(m.total_cost_usd) ?? 0, numTurns: num(m.num_turns),
        durationMs: num(m.duration_ms), usage: isObj(m.usage) ? m.usage : null,
        modelUsage: isObj(m.modelUsage) ? Object.fromEntries(Object.entries(m.modelUsage).filter(([, v]) => isObj(v))) as Record<string, Obj> : {},
      };
    }
  }
  return out;
}

/** Input, output and cache tokens of a usage object, summed (0 when absent). */
export function tokenTotal(u: Record<string, unknown> | null | undefined): number {
  if (!u) return 0;
  let n = 0;
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) {
    const v = u[k];
    if (typeof v === 'number' && Number.isFinite(v)) n += v;
  }
  return n;
}

/** The most decimals any percent shows (the meter's resolution as sent). */
export function decimalsOf(values: number[]): number {
  let d = 0;
  for (const v of values) {
    const s = String(v);
    const i = s.indexOf('.');
    if (i >= 0 && !/e/i.test(s)) d = Math.max(d, s.length - i - 1);
  }
  return d;
}
