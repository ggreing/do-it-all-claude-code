// The team office's pure parts (decision 186): who a member is, the lines of its session, the masking of secrets,
// and what the daemon's answers mean on screen. No `claude-code` import at run time, so node:test runs this file
// as it is (packages/core/test/office-model.test.ts).

export type OfficeRole = 'lead' | 'architect' | 'coder' | 'reviewer' | 'tester' | 'ui-designer' | 'helper';
export type OfficeStatus = 'working' | 'done' | 'waiting' | 'failed';

/** One member of the office: the main loop (id "lead") or a subagent. */
export type OfficeAgent = {
  id: string;
  role: OfficeRole;
  label: string;
  /** The model and effort of its last model request, as `turn.step` reported them. */
  model: string;
  effort: string;
  task: string;
  status: OfficeStatus;
  startedAt: number;
  endedAt?: number;
  /** The router's subtask tag ("A" from [subtask:A]), when the Agent prompt had one. */
  tag?: string;
  /** False for the preview's made-up members: there is no transcript to open. */
  real: boolean;
};

/** One line of a member's session, drawn the way Claude Code draws its own. */
export type OfficeRow = { kind: 'text' | 'tool' | 'result' | 'error'; text: string };

export const LEAD = 'lead';
export const MAX_ROWS = 200;
export const MAX_MEMBERS = 40;

const ROLES = ['architect', 'coder', 'reviewer', 'tester', 'ui-designer'] as const;
export const ROLE_NAME: Record<OfficeRole, string> = {
  lead: 'lead', architect: 'architect', coder: 'coder', reviewer: 'reviewer', tester: 'tester', 'ui-designer': 'designer', helper: 'helper',
};
export const STATUS_WORD: Record<OfficeStatus, string> = { working: '● working', done: '✓ done', waiting: '○ waiting', failed: '✗ failed' };

export function roleOf(subagentType: string): OfficeRole {
  const t = subagentType.split(':').pop() ?? subagentType;
  return ROLES.find(r => r === t) ?? 'helper';
}

export function modelName(m: string | undefined): string {
  const s = (m ?? '').toLowerCase();
  if (s.includes('opus')) return 'Opus';
  if (s.includes('sonnet')) return 'Sonnet';
  if (s.includes('haiku')) return 'Haiku';
  if (s.includes('fable')) return 'Fable';
  return m || 'model unknown';
}

/** The router's subtask tag on the prompt's first line, `[subtask:A]`. */
export function tagOf(prompt: string | undefined): string | undefined {
  const m = /^\s*\[subtask:([A-Za-z0-9._-]{1,32})\]/.exec(prompt ?? '');
  return m ? m[1] : undefined;
}

/** "coder A" from the tag; without one, by order: coder A, coder B…, reviewer, reviewer 2… */
export function labelFor(role: OfficeRole, tag: string | undefined, list: readonly OfficeAgent[]): string {
  if (tag) return `${ROLE_NAME[role]} ${tag}`;
  const n = list.filter(a => a.role === role).length;
  if (role === 'coder') return `coder ${'ABCDEFGHIJ'[n] ?? n + 1}`;
  return n ? `${ROLE_NAME[role]} ${n + 1}` : ROLE_NAME[role];
}

export function elapsed(a: Pick<OfficeAgent, 'startedAt' | 'endedAt'>, now: number): string {
  const s = Math.max(0, Math.floor(((a.endedAt ?? now) - a.startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fromAgentStatus(s: string): OfficeStatus {
  if (s === 'completed') return 'done';
  if (s === 'failed' || s === 'killed') return 'failed';
  if (s === 'idle' || s === 'waiting') return 'waiting';
  return 'working';
}

// ------------------------------------------------------------------ masking

export type SecretPatterns = { patterns: Array<{ source: string; flags?: string }> };

/** The guard's secret patterns (plugin/hooks/secret-patterns.json), compiled; a pattern that does not compile is left out. */
export function compileSecrets(file: unknown): RegExp[] {
  const list = file && typeof file === 'object' && Array.isArray((file as SecretPatterns).patterns) ? (file as SecretPatterns).patterns : [];
  const out: RegExp[] = [];
  for (const p of list) {
    if (!p || typeof p.source !== 'string') continue;
    try { out.push(new RegExp(p.source, (p.flags ?? 'g').includes('g') ? p.flags ?? 'g' : `${p.flags ?? ''}g`)); } catch { /* skipped */ }
  }
  return out;
}

export function mask(text: string, secrets: readonly RegExp[]): string {
  let out = text;
  for (const re of secrets) { re.lastIndex = 0; out = out.replace(re, '[secret]'); }
  return out;
}

// ------------------------------------------------------------------ session lines

export function oneLine(text: string, max = 160): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function argOf(e: object): string {
  const a = e as Record<string, unknown>;
  for (const k of ['file_path', 'command', 'pattern', 'description', 'url', 'query', 'path']) {
    const v = a[k];
    if (typeof v === 'string' && v) return oneLine(v, 80);
  }
  return '';
}

export function callRow(e: { tool: string } & object, secrets: readonly RegExp[] = []): OfficeRow {
  const arg = argOf(e);
  return { kind: 'tool', text: mask(arg ? `${e.tool}(${arg})` : e.tool, secrets) };
}

function textOf(r: object): string {
  const x = r as Record<string, unknown>;
  if (typeof x.text === 'string') return x.text;
  const res = x.result;
  if (typeof res === 'string') return res;
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>;
    for (const k of ['stdout', 'content', 'text', 'output']) if (typeof o[k] === 'string') return o[k] as string;
  }
  return '';
}

export function resultRow(tool: string, r: object, secrets: readonly RegExp[] = []): OfficeRow {
  const x = r as Record<string, unknown>;
  const text = textOf(r);
  if (typeof x.deny === 'string') return { kind: 'error', text: mask(`refused: ${oneLine(x.deny, 120)}`, secrets) };
  if (x.isError === true) return { kind: 'error', text: mask(oneLine(text || 'error', 120), secrets) };
  const lines = text ? text.split('\n').filter(l => l.trim()).length : 0;
  if (tool === 'Read') return { kind: 'result', text: `read ${lines} line${lines === 1 ? '' : 's'}` };
  if (tool === 'Edit' || tool === 'MultiEdit') return { kind: 'result', text: 'edited' };
  if (tool === 'Write') return { kind: 'result', text: 'written' };
  if (tool === 'Grep' || tool === 'Glob') return { kind: 'result', text: `${lines} result${lines === 1 ? '' : 's'}` };
  const first = text.split('\n').find(l => l.trim());
  return { kind: 'result', text: first ? mask(oneLine(first, 120), secrets) : 'done' };
}

export function textRow(text: string, secrets: readonly RegExp[] = []): OfficeRow {
  return { kind: 'text', text: mask(oneLine(text), secrets) };
}

/** Appends a row, keeping the last MAX_ROWS of each member and at most MAX_MEMBERS members. */
export function withRow(all: Readonly<Record<string, OfficeRow[]>>, who: string, row: OfficeRow): Record<string, OfficeRow[]> {
  const next: Record<string, OfficeRow[]> = { ...all, [who]: [...(all[who] ?? []), row].slice(-MAX_ROWS) };
  const keys = Object.keys(next);
  if (keys.length > MAX_MEMBERS) for (const k of keys.slice(0, keys.length - MAX_MEMBERS)) if (k !== LEAD && k !== who) delete next[k];
  return next;
}

// ------------------------------------------------------------------ the daemon's view

export type DaemonCheck = { kind: string; result: 'ok' | 'failed' | 'skipped'; testsPassed?: number; testsFailed?: number };
export type DaemonSubtask = {
  id: string; role: string; slot: number; step: string; model: string; effort: string; status: string; verdict: string | null;
  attempts: number; agentId: string | null; scope: string[]; checks: DaemonCheck[];
  repro: { required: boolean; state: string; reason?: string } | null;
};
export type LimitWindow = { usedPercentage: number; resetsAt: number | null };
export type DaemonOffice = {
  request: null | { id: string; level: string; source: string; preset: string; status: string; budgetUsd: number; usedUsd: number; leadDirect: boolean; leadModel: string | null };
  subtasks: DaemonSubtask[];
  costUsd: number; costEstimated: boolean; costUnknown: boolean; sessionCostUsd: number;
  routing?: unknown;
  limits: null | { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null };
};

/** The daemon's subtask for a member: by agent id, else by tag. */
export function subtaskOf(view: DaemonOffice | null, a: Pick<OfficeAgent, 'id' | 'tag'>): DaemonSubtask | undefined {
  if (!view) return undefined;
  return view.subtasks.find(s => s.agentId === a.id) ?? (a.tag ? [...view.subtasks].reverse().find(s => s.id === a.tag) : undefined);
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * The step against what ran: the step and its planned model and effort, and — when the member's last request ran
 * at other values (an organization's cap, maxEffortLevel, a model's own levels) — what it ran at.
 */
export function stepLine(a: Pick<OfficeAgent, 'model' | 'effort'>, s: DaemonSubtask | undefined): { plan: string; ranAt?: string } | null {
  if (!s) return null;
  const plannedModel = modelName(s.model);
  const plan = `${s.step} (${plannedModel} ${s.effort})`;
  const model = a.model && a.model !== 'model unknown' ? a.model : '';
  if (!model && !a.effort) return { plan };
  const differs = (model && cap(model) !== cap(plannedModel)) || (a.effort && a.effort !== s.effort);
  return differs ? { plan, ranAt: `ran at ${model || plannedModel} ${a.effort || s.effort}` } : { plan };
}

/** How verify ended, one short phrase: "test ok (3 passed), scope ok". */
export function checksLine(checks: readonly DaemonCheck[]): string {
  return checks.map(c => `${c.kind} ${c.result}${c.kind === 'test' && c.result !== 'skipped' && c.testsPassed !== undefined
    ? ` (${c.testsPassed} passed${c.testsFailed ? `, ${c.testsFailed} failed` : ''})` : ''}`).join(', ');
}

export function usd(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(n >= 1 ? 2 : 3)}`;
}

/** The office's top line from the daemon: "L2 · rule · $0.12 of $4 · 5h 23% · 7d 4%". */
export function requestLine(view: DaemonOffice | null): string {
  if (!view?.request) return '';
  const r = view.request;
  const parts = [`${r.level}${r.leadDirect ? ' lead-direct' : ''}`, r.source, `${usd(view.costUsd)}${view.costEstimated ? '~' : ''} of ${usd(r.budgetUsd)}`];
  if (view.limits?.fiveHour) parts.push(`5h ${Math.round(view.limits.fiveHour.usedPercentage)}%`);
  if (view.limits?.sevenDay) parts.push(`7d ${Math.round(view.limits.sevenDay.usedPercentage)}%`);
  return parts.join(' · ');
}

export const DAEMON_DOWN = 'router daemon not reachable — run do-it-all-claude-code start';

// ------------------------------------------------------------------ the router home (for its office switch only)

const sepOf = (p: string): string => (p.includes('\\') && !p.includes('/') ? '\\' : '/');
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}${sepOf(dir)}${name}`;
}
export function parentPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i > 0 ? trimmed.slice(0, i) : trimmed;
}

/**
 * Where the router home may be, in order: the folder above the plugin when it runs from the home marketplace
 * (<home>/plugin), DO_IT_ALL_CLAUDE_CODE_HOME, then ~/.do-it-all-claude-code. The helper (bridge.mjs) looks in the
 * same order; the module reads only `office` from the config there, never the token.
 */
export function homeCandidates(o: { pluginRoot?: string | undefined; envHome?: string | undefined; userHome?: string | undefined }): string[] {
  const out: string[] = [];
  if (o.pluginRoot) out.push(parentPath(o.pluginRoot));
  if (o.envHome) out.push(o.envHome);
  if (o.userHome) out.push(joinPath(o.userHome, '.do-it-all-claude-code'));
  return [...new Set(out)];
}

/** `office: off` in a config.json text turns the panel off; anything else (or no file) leaves it on. */
export function officeSwitch(configText: string | undefined): 'on' | 'off' {
  if (!configText) return 'on';
  try { return (JSON.parse(configText) as { office?: unknown })?.office === 'off' ? 'off' : 'on'; } catch { return 'on'; }
}

/** One helper line (bridge.mjs, v 1), or null for anything else. */
export type HelperLine =
  | { type: 'office'; reach: 'ok' | 'down' | 'setup' | 'refused'; view: unknown }
  | { type: 'history' | 'detail' | 'cost' | 'routing'; data: unknown; error?: string; period?: string };
export function parseHelperLine(text: string): HelperLine | null {
  let m: unknown;
  try { m = JSON.parse(text); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (o.type === 'office' && (o.reach === 'ok' || o.reach === 'down' || o.reach === 'setup' || o.reach === 'refused')) return { type: 'office', reach: o.reach, view: o.view ?? null };
  if (o.type === 'history' || o.type === 'detail' || o.type === 'cost' || o.type === 'routing') {
    return { type: o.type, data: o.data ?? null, ...(typeof o.error === 'string' ? { error: o.error } : {}), ...(typeof o.period === 'string' ? { period: o.period } : {}) };
  }
  return null;
}

/** Splits streamed text into whole lines; returns them and what is left for the next piece. */
export function takeLines(buffer: string, piece: string): { lines: string[]; rest: string } {
  const all = buffer + piece;
  const parts = all.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.map(l => l.replace(/\r$/, '')).filter(Boolean), rest: rest.length > 1_000_000 ? '' : rest };
}

/** A version like "2.1.325" or "2.1.325-dev.…" at least `min`. */
export function versionAtLeast(version: string | undefined, min: readonly [number, number, number]): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) { if (v[i]! > min[i]!) return true; if (v[i]! < min[i]!) return false; }
  return true;
}

/** The Claude Code build the office was tested on (decision 186 ②; the router's MIN_CLAUDE is the same). */
export const OFFICE_MIN_CLAUDE = [2, 1, 325] as const;
