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
/**
 * The marks the office draws with. The classic Windows console draws ●, ○ and → two cells wide where Claude Code
 * counts one, so every row holding one is shifted and its later updates land beside it; there the office keeps to
 * marks it draws one cell wide (measured in that console, as Claude Code falls back for its own figures).
 */
export type Glyphs = {
  status: Record<OfficeStatus, string>; tool: string; text: string; picked: string; arrow: string; border: string; range: string;
  /** a bar: full cells, the eighths of a cell after them (none in the classic console), the empty cells */
  full: string; parts: readonly string[]; empty: string;
  /** a column chart's cells, from empty to full (eighths) */
  levels: readonly string[];
  up: string; down: string; keys: string;
};
export const GLYPHS: Glyphs = {
  status: { working: '●', done: '✓', waiting: '○', failed: '✗' }, tool: '●', text: '●', picked: '▸', arrow: '→', border: 'round', range: '–',
  full: '█', parts: ['▏', '▎', '▍', '▌', '▋', '▊', '▉'], empty: '░', levels: [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  up: '↑', down: '↓', keys: '↑↓',
};
export const CLASSIC_GLYPHS: Glyphs = {
  status: { working: '*', done: 'v', waiting: '-', failed: 'x' }, tool: '*', text: '*', picked: '>', arrow: '->', border: 'single', range: '-',
  full: '#', parts: [], empty: '.', levels: [' ', '.', '.', '.', '#', '#', '#', '#', '#'],
  up: '+', down: '-', keys: 'up/down',
};
export function statusWord(s: OfficeStatus, g: Glyphs = GLYPHS): string { return `${g.status[s]} ${s}`; }

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
/**
 * A slot's cell on the model × effort grid (decision 225): `step` is s1…s7 for the seven legacy cells, else the
 * cell id ("sonnet-xhigh"); `estimated`, a cell whose cost nobody has measured yet. An older router sends no
 * `estimated`.
 */
export type SlotCell = { step: string; model: string; effort: string; estimated?: boolean };
export type DaemonSubtask = SlotCell & {
  id: string; role: string; slot: number; status: string; verdict: string | null;
  attempts: number; agentId: string | null; scope: string[]; checks: DaemonCheck[];
  repro: { required: boolean; state: string; reason?: string } | null;
};
export type Difficulty = 'routine' | 'moderate' | 'hard';
/**
 * How hard the lead judged the request after its first look (decision 225): `lead` when it said, `default` when it
 * said nothing (moderate then applies). Null and absent: a request from before difficulty was kept.
 */
export type DifficultyOf = { difficulty?: Difficulty | null; difficultySource?: 'lead' | 'default' | null };
export type LimitWindow = { usedPercentage: number; resetsAt: number | null };
export type DaemonOffice = {
  request: null | ({ id: string; level: string; source: string; preset: string; status: string; budgetUsd: number; usedUsd: number; leadDirect: boolean; leadModel: string | null } & DifficultyOf);
  subtasks: DaemonSubtask[];
  costUsd: number; costEstimated: boolean; costUnknown: boolean; sessionCostUsd: number;
  routing?: unknown;
  limits: null | { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null };
  /** the session's repository, and whether its parallel writers get a work tree each (null: not asked yet) */
  project?: { name: string; worktree: 'on' | 'off' | null } | null;
};

/** The daemon's subtask for a member: by agent id, else by tag. */
export function subtaskOf(view: DaemonOffice | null, a: Pick<OfficeAgent, 'id' | 'tag'>): DaemonSubtask | undefined {
  if (!view) return undefined;
  return view.subtasks.find(s => s.agentId === a.id) ?? (a.tag ? [...view.subtasks].reverse().find(s => s.id === a.tag) : undefined);
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

// ------------------------------------------------------------------ cells and difficulty (decision 225)

/** The seven legacy steps, which stay as names of seven cells of the grid (docs/design/difficulty-steps.md, section 4). */
export const STEP_ALIAS: Readonly<Record<string, string>> = {
  s1: 'haiku-low', s2: 'haiku-high', s3: 'sonnet-medium', s4: 'sonnet-high', s5: 'opus-high', s6: 'opus-xhigh', s7: 'fable-high',
};
const aliasOf = (step: string): string => (Object.hasOwn(STEP_ALIAS, step) ? step : '');

/** A step as its model and effort: "s3" and "sonnet-medium" are both Sonnet medium; null for one it cannot read. */
export function cellOf(step: string): { model: string; effort: string } | null {
  const m = /^([a-z]+)-([a-z]+)$/.exec(Object.hasOwn(STEP_ALIAS, step) ? STEP_ALIAS[step]! : step);
  return m ? { model: modelName(m[1]), effort: m[2]! } : null;
}

/**
 * A slot as the office names it: "Sonnet · medium (s3)", "Sonnet · xhigh est.". Given `max`, the longest form that
 * fits: the alias goes first, then the dot; "est." stays as long as there is room for it.
 */
export function cellText(s: SlotCell, max = Infinity): string {
  const model = modelName(s.model);
  const alias = aliasOf(s.step) ? ` (${s.step})` : '';
  const est = s.estimated ? ' est.' : '';
  const forms = [`${model} · ${s.effort}${alias}${est}`, `${model} · ${s.effort}${est}`, `${model} ${s.effort}${est}`, `${model} ${s.effort}`];
  return forms.find(f => [...f].length <= max) ?? fit(forms.at(-1)!, max);
}

/** A step change on the grid: "Haiku low→high" within a model, "Haiku high→Sonnet medium" across; a step it cannot read as it came. */
export function moveText(from: string, to: string, g: Glyphs = GLYPHS): string {
  const a = cellOf(from), b = cellOf(to);
  if (!a || !b) return `${from}${g.arrow}${to}`;
  return a.model === b.model ? `${a.model} ${a.effort}${g.arrow}${b.effort}` : `${a.model} ${a.effort}${g.arrow}${b.model} ${b.effort}`;
}

export const isDifficulty = (v: unknown): v is Difficulty => v === 'routine' || v === 'moderate' || v === 'hard';
/** The badge's color: the theme's, one per difficulty. */
export const DIFFICULTY_COLOR: Readonly<Record<Difficulty, string>> = { routine: 'success', moderate: 'suggestion', hard: 'warning' };
/** The badge where a row has four cells for it (the Work tab's list in a narrow dock). */
export const DIFFICULTY_SHORT: Readonly<Record<Difficulty, string>> = { routine: 'rtn', moderate: 'mod', hard: 'hard' };

/** The difficulty after the level ("L2 hard"), or '' for a request from before it was kept. */
export function difficultyText(d: DifficultyOf | null | undefined): string {
  return isDifficulty(d?.difficulty) ? d.difficulty : '';
}

/** Where the difficulty comes from, for the Work tab's detail: "difficulty hard, by the lead", "difficulty moderate (the lead gave none)". */
export function difficultyNote(d: DifficultyOf | null | undefined): string {
  if (!isDifficulty(d?.difficulty)) return '';
  return d.difficultySource === 'lead' ? `difficulty ${d.difficulty}, by the lead` : `difficulty ${d.difficulty} (the lead gave none)`;
}

/**
 * Parts on as few lines as `width` holds: the first line starts with `head`, the next ones with as many spaces;
 * a part that does not fit a line of its own is cut. Each line's parts, in order.
 */
export function packParts<T extends { text: string }>(head: string, parts: readonly T[], width: number, sep = ' · '): T[][] {
  const lines: T[][] = [];
  let line: T[] = [], used = [...head].length;
  for (const p of parts) {
    const n = [...p.text].length + (line.length ? sep.length : 0);
    if (line.length && used + n > width) { lines.push(line); line = []; used = [...head].length; }
    line.push(p);
    used += [...p.text].length + (line.length > 1 ? sep.length : 0);
  }
  if (line.length) lines.push(line);
  return lines;
}

/**
 * The step against what ran: the slot's cell, and — when the member's last request ran at other values (an
 * organization's cap, maxEffortLevel, a model's own levels) — what it ran at.
 */
export function stepLine(a: Pick<OfficeAgent, 'model' | 'effort'>, s: DaemonSubtask | undefined): { plan: string; ranAt?: string } | null {
  if (!s) return null;
  const plannedModel = modelName(s.model);
  const plan = cellText(s);
  const model = a.model && a.model !== 'model unknown' ? a.model : '';
  if (!model && !a.effort) return { plan };
  const differs = (model && cap(model) !== cap(plannedModel)) || (a.effort && a.effort !== s.effort);
  return differs ? { plan, ranAt: `ran at ${model || plannedModel} ${a.effort || s.effort}` } : { plan };
}

/**
 * What a desk adds to the model and effort it shows (decision 225): the slot's alias and whether its cell is
 * estimated, when the member shows both and they are its slot's cell; nothing when it ran at another cell (the
 * session's plan line says so) or has not said yet.
 */
export function deskCell(a: Pick<OfficeAgent, 'model' | 'effort'>, s: DaemonSubtask | undefined): { alias: string; estimated: boolean } {
  const model = a.model && a.model !== 'model unknown' ? a.model : '';
  if (!s || !model || !a.effort || cap(model) !== cap(modelName(s.model)) || a.effort !== s.effort) return { alias: '', estimated: false };
  return { alias: aliasOf(s.step), estimated: s.estimated === true };
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

/** The level with the difficulty beside it: "L2 hard", "L1 moderate lead-direct"; an older request, the level alone. */
const levelHead = (r: NonNullable<DaemonOffice['request']>): string => `${r.level}${difficultyText(r) ? ` ${difficultyText(r)}` : ''}${r.leadDirect ? ' lead-direct' : ''}`;

/** The office's top line from the daemon: "L2 hard · rule · $0.12 of $4 · 5h 23% · 7d 4%". */
export function requestLine(view: DaemonOffice | null): string {
  if (!view?.request) return '';
  const r = view.request;
  const parts = [levelHead(r), r.source, `${usd(view.costUsd)}${view.costEstimated ? '~' : ''} of ${usd(r.budgetUsd)}`];
  if (view.limits?.fiveHour) parts.push(`5h ${Math.round(view.limits.fiveHour.usedPercentage)}%`);
  if (view.limits?.sevenDay) parts.push(`7d ${Math.round(view.limits.sevenDay.usedPercentage)}%`);
  return parts.join(' · ');
}

/**
 * The Office tab's line while the router answers: the request's line, or, with no request yet, that the router is
 * on, with the limits it knows. Either way "isolation off" when this project's parallel writers share one folder
 * (`do-it-all-claude-code project disable`), so a person can tell the router is there before any request. The
 * limits come last: a narrow dock cuts the line at its end.
 */
export function routerLine(view: DaemonOffice | null): string {
  const r = view?.request;
  const head = r ? [levelHead(r), r.source, `${usd(view.costUsd)}${view.costEstimated ? '~' : ''} of ${usd(r.budgetUsd)}`] : ['router on', 'no request yet'];
  return [
    ...head,
    view?.project?.worktree === 'off' ? 'isolation off' : '',
    view?.limits?.fiveHour ? `5h ${Math.round(view.limits.fiveHour.usedPercentage)}%` : '',
    view?.limits?.sevenDay ? `7d ${Math.round(view.limits.sevenDay.usedPercentage)}%` : '',
  ].filter(Boolean).join(' · ');
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
export function officeSwitch(configText: string | undefined, key: 'office' | 'officeAutoOpen' = 'office'): 'on' | 'off' {
  if (!configText) return 'on';
  try { return (JSON.parse(configText) as Record<string, unknown>)?.[key] === 'off' ? 'off' : 'on'; } catch { return 'on'; }
}

/** One helper line (bridge.mjs, v 1), or null for anything else. */
export type HelperTabLine = 'work' | 'work-detail' | 'savings' | 'team' | 'settings' | 'applied';
export type HelperLine =
  | { type: 'office'; reach: 'ok' | 'down' | 'setup' | 'refused'; view: unknown }
  | { type: HelperTabLine; data: unknown; error?: string; period?: string; id?: string; status?: number };
const TAB_LINES: readonly string[] = ['work', 'work-detail', 'savings', 'team', 'settings', 'applied'];
export function parseHelperLine(text: string): HelperLine | null {
  let m: unknown;
  try { m = JSON.parse(text); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (o.type === 'office' && (o.reach === 'ok' || o.reach === 'down' || o.reach === 'setup' || o.reach === 'refused')) return { type: 'office', reach: o.reach, view: o.view ?? null };
  if (typeof o.type === 'string' && TAB_LINES.includes(o.type)) {
    return {
      type: o.type as HelperTabLine, data: o.data ?? null,
      ...(typeof o.error === 'string' ? { error: o.error } : {}), ...(typeof o.period === 'string' ? { period: o.period } : {}),
      ...(typeof o.id === 'string' ? { id: o.id } : {}), ...(typeof o.status === 'number' ? { status: o.status } : {}),
    };
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

// ------------------------------------------------------------------ the terminal and the room

/**
 * Whether the terminal draws Unicode marks one cell wide, decided as Claude Code decides it for its own figures:
 * anywhere but Windows unless TERM is linux; on Windows only in a terminal that says which it is. Elsewhere on
 * Windows it is the classic console. The names are the environment variables of Claude Code's process.
 */
export function unicodeTerminal(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.OS !== 'Windows_NT') return env.TERM !== 'linux';
  return Boolean(env.WT_SESSION) || Boolean(env.TERMINUS_SUBLIME) || env.ConEmuTask === '{cmd::Cmder}'
    || env.TERM_PROGRAM === 'Terminus-Sublime' || env.TERM_PROGRAM === 'vscode'
    || env.TERM === 'xterm-256color' || env.TERM === 'alacritty' || env.TERM === 'rxvt-unicode' || env.TERM === 'rxvt-unicode-256color'
    || env.TERMINAL_EMULATOR === 'JetBrains-JediTerm';
}

/** Columns every frame leaves free at the body's right: a line that reaches a terminal's last column is the first one a narrower window wraps. */
export const SLACK = 2;
/** A desk with the gap after it (scene.tsx: STATION_W + 2 across, STATION_H + 1 down). */
export const DESK_W = 24;
export const DESK_H = 12;
/** A small desk with the gap after it: the same member, no monitor, less room above its head (scene.tsx: MINI). */
export const SMALL_DESK_W = 16;
export const SMALL_DESK_H = 10;
/**
 * A narrow desk with the gap after it: the same member, nothing over its head, its name and its model below and
 * no desktop or status line (scene.tsx: NARROW). Four to a row in a 120 x 30 terminal's dock (about 53 x 25).
 */
export const NARROW_DESK_W = 12;
export const NARROW_DESK_H = 7;
export const SESSION_ROWS = 12;
export const MIN_SESSION_ROWS = 3;

export type OfficeLayout = {
  /**
   * `desks`: the members at their desks (scene.tsx); `list`: one line each; `tiny`: a room too low for frames (an
   * inline pane the person made short: Claude Code keeps that size for every plugin pane), lines only
   */
  mode: 'desks' | 'list' | 'tiny';
  /** `desks`: full desks with a monitor, or small ones where the full ones do not fit (the member drawn the same) */
  small: boolean;
  /** `desks`: narrow ones, where even the small ones do not fit (the member drawn the same) */
  narrow: boolean;
  /** the back wall above the desks */
  wall: boolean;
  /** desks to a row */
  perRow: number;
  /** the frames' width: the body's less SLACK */
  width: number;
  /** what a frame holds across: its width less the border and the padding */
  inner: number;
  /**
   * the session's frame holds this many rows: from 3 its two header lines and its last lines, 1 or 2 its last lines
   * only, 0 no frame at all (`tiny`: the session's lines that fit, maybe none)
   */
  sessionRows: number;
  /** which of the steps it is (0 the most drawn; `tiny` the last): the next layout starts from it (`prev`) */
  step: number;
  /** the members drawn at desks, the first ones; the rest go on one line under the desks (`desks`, cramped) */
  shown: number;
  /** no title line over the desks: the cramped step gives its row to the line of the members left over */
  bare: boolean;
};

/** Rows the office wants to spare before it climbs back to a bigger layout, so a dialog under the chat that opens and closes does not flip it. */
export const LAYOUT_SPARE = 2;

type LayoutStep = { kind: 'full' | 'small' | 'narrow' | 'list'; wall: boolean; session: number; cramped?: true };
/**
 * From the most drawn to the least. The desks get smaller first, then the session shrinks to its last line and goes;
 * then the narrow desks keep the rows of desks that fit, without the title line, and the members left over go on
 * one line under them; only then the list: the members stay drawn as long as they can (the person's choice).
 */
const LAYOUT_STEPS: readonly LayoutStep[] = [
  { kind: 'full', wall: true, session: MIN_SESSION_ROWS }, { kind: 'full', wall: false, session: MIN_SESSION_ROWS },
  { kind: 'small', wall: false, session: MIN_SESSION_ROWS }, { kind: 'narrow', wall: false, session: MIN_SESSION_ROWS },
  { kind: 'narrow', wall: false, session: 1 }, { kind: 'narrow', wall: false, session: 0 },
  { kind: 'narrow', wall: false, session: 0, cramped: true },
  { kind: 'list', wall: false, session: MIN_SESSION_ROWS }, { kind: 'list', wall: false, session: 1 }, { kind: 'list', wall: false, session: 0 },
];
/** The step number of `tiny`. */
export const TINY_STEP = LAYOUT_STEPS.length;

/**
 * The office in the room the pane has: the first of LAYOUT_STEPS that fits. Full desks with the back wall, the desks
 * alone, small desks (a 120-column terminal's dock is about 54 across, two full desks a row), narrow desks (a 120 x 30
 * terminal, Windows Terminal's first size, gives the dock about 25 rows), each with at least MIN_SESSION_ROWS of
 * session below; then the narrow desks with the session's last line only, then with no session; only then one line
 * a member, its session shrinking the same way. The session takes the rows left over. The classic console always
 * gets the list. Rows: the tab row, the router's line, the office's frame and title line, then the desks or the list,
 * then the session's frame (none at session 0). Too low for any: `tiny`, the tab row, a line on making room, the
 * members' lines, then what is left of the session.
 *
 * `prev`, the step the office was drawn at last, keeps it from flipping: a dialog under the chat (a permission
 * question, a list of tasks) takes rows from the pane while it is open. The office goes down a step as soon as its
 * step no longer fits, and back up only once the bigger one fits with LAYOUT_SPARE rows to spare.
 */
export function officeLayout(o: { columns: number; rows: number; members: number; routerLine: boolean; classic: boolean; prev?: number; notice?: boolean }): OfficeLayout {
  const width = Math.max(20, o.columns - SLACK);
  const inner = width - 4;
  const per = { full: Math.floor((inner + 2) / DESK_W), small: Math.floor((inner + 1) / SMALL_DESK_W), narrow: Math.floor((inner + 1) / NARROW_DESK_W), list: 1 };
  const deskH = { full: DESK_H, small: SMALL_DESK_H, narrow: NARROW_DESK_H, list: 1 };
  // `notice`: one more line in the office's frame (the classic console's, on where the desks show)
  const top = 1 + (o.routerLine ? 1 : 0) + 2 + 1 + (o.notice ? 1 : 0);
  // cramped: the rows of narrow desks that fit under the tab row, the router's line and the frame (no title line),
  // and, when members are left over, their line under the desks
  const cramped = (spare: number) => {
    const room = o.rows - spare - (top - 1);
    const all = Math.ceil(o.members / Math.max(1, per.narrow));
    const deskRows = all * NARROW_DESK_H <= room ? all : Math.floor((room - 1) / NARROW_DESK_H);
    return { deskRows, shown: Math.min(o.members, deskRows * per.narrow) };
  };
  // no members: the plant and the line saying how the desks fill
  const body = (s: LayoutStep) => (s.kind === 'list' ? Math.max(1, o.members)
    : (s.wall ? 2 : 0) + (o.members ? Math.ceil(o.members / per[s.kind]) * deskH[s.kind] : 7));
  const need = (s: LayoutStep) => top + body(s) + (s.session ? s.session + 2 : 0);
  const fits = (i: number, spare = 0) => {
    if (i >= TINY_STEP) return true;
    const s = LAYOUT_STEPS[i]!;
    if (s.kind !== 'list' && (o.classic || per[s.kind] < 1)) return false;
    if (s.cramped) return o.members > 0 && cramped(spare).deskRows >= 1;
    return need(s) + spare <= o.rows;
  };
  const first = (spare: number) => { let i = 0; while (!fits(i, spare)) i++; return i; };
  let at = first(0);
  const prev = o.prev;
  if (prev !== undefined && prev >= 0 && prev <= TINY_STEP && fits(prev) && at < prev) at = Math.min(prev, first(LAYOUT_SPARE));
  const base = { perRow: Math.max(1, per.full), width, inner, small: false, narrow: false, wall: false, step: at, shown: o.members, bare: false };
  if (at >= TINY_STEP) return { ...base, mode: 'tiny', inner: width, sessionRows: Math.max(0, o.rows - 2 - Math.max(1, o.members)) };
  const s = LAYOUT_STEPS[at]!;
  if (s.cramped) return { ...base, mode: 'desks', narrow: true, perRow: Math.max(1, per.narrow), sessionRows: 0, shown: cramped(0).shown, bare: true };
  const sessionRows = s.session ? Math.max(s.session, o.rows - top - body(s) - 2) : 0;
  if (s.kind === 'list') return { ...base, mode: 'list', sessionRows };
  return { ...base, mode: 'desks', wall: s.wall, small: s.kind === 'small', narrow: s.kind === 'narrow', perRow: Math.max(1, per[s.kind]), sessionRows };
}

/** The rows and columns the pane asks for when it opens: room for the desks and a full session; the engine grants what it can spare. */
export function wantedRoom(members: number): { rows: number; columns: number } {
  const across = Math.max(2, Math.min(4, members));
  return { rows: 1 + 1 + 2 + 1 + 2 + Math.max(1, Math.ceil(members / 4)) * DESK_H + 2 + SESSION_ROWS, columns: across * DESK_W - 2 + 4 + SLACK };
}

/** `text` cut to `max` characters, with an ellipsis where it was cut. */
export function fit(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

// ------------------------------------------------------------------ the tabs (decisions 193, 194)

export type TabId = 'office' | 'work' | 'savings' | 'team' | 'settings';
/** The tab row; `short` where the full labels do not fit across. A tab's key presses its button while the pane has the keys. */
export const TABS: ReadonlyArray<{ id: TabId; label: string; short: string; key: string }> = [
  { id: 'office', label: 'Office', short: 'Office', key: 'o' },
  { id: 'work', label: 'Work', short: 'Work', key: 'w' },
  { id: 'savings', label: 'Savings', short: 'Save', key: 's' },
  { id: 'team', label: 'Team', short: 'Team', key: 't' },
  { id: 'settings', label: 'Settings', short: 'Config', key: 'c' },
];
export const isTab = (v: unknown): v is TabId => TABS.some(t => t.id === v);
/** Whether the full labels fit: `[ label ]` each. */
export const tabLabelsFit = (width: number): boolean => TABS.reduce((n, t) => n + t.label.length + 4, 0) <= width;

export type Period = '24h' | '7d' | '30d';
export const PERIODS: readonly Period[] = ['24h', '7d', '30d'];
export const PERIOD_NAME: Record<Period, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
export const nextPeriod = (p: string): Period => PERIODS[(PERIODS.indexOf(p as Period) + 1) % PERIODS.length]!;
export const isPeriod = (v: unknown): v is Period => PERIODS.includes(v as Period);

// ---------------------------------------------------------------- the daemon's answers (docs/design/team-office.md, section 8)

export type Level = 'L0' | 'L1' | 'L2' | 'L3';
export type WorkState = 'open' | 'awaiting_user' | 'closed';
export type WorkRow = DifficultyOf & {
  requestId: string; state: WorkState; mine: boolean; createdAt: string; closedAt: string | null;
  kind: string | null; level: Level; finalLevel: Level;
  outcome: 'direct' | 'delegated' | 'no_delegation' | 'lead_takeover' | null;
  passed: boolean | null; acceptance: string | null;
  subtasks: number; verifyFailures: number; stepUps: number;
  changedFiles: number | null; linesAdded: number | null; linesRemoved: number | null;
  files: Array<{ path: string; added: number; removed: number }>;
  durationMs: number | null; activeMs: number | null;
  totalUsd: number; estimated: boolean; unknown: boolean; budgetExceeded: boolean;
};
export type WorkList = { open: WorkRow[]; rows: WorkRow[]; nextCursor: string | null; today: { done: number; failed: number; usd: number } };
export type StepChange = {
  at: string; requestId: string; subtaskId: string | null; role: string; slot: number; from: string; to: string;
  direction: 'up' | 'down'; reason: 'miss' | 'rejected' | 'escalation' | 'easy'; detail: string | null;
};
export type WorkCheck = { kind: string; attempt: number; result: 'ok' | 'failed' | 'skipped'; testsPassed?: number; testsFailed?: number; durationMs?: number };
export type WorkSubtask = SlotCell & {
  id: string; role: string; slot: number; attempts: number; ranModel: string | null;
  status: string; verdict: string | null; stepChanges: StepChange[]; scope: string[]; unscoped: boolean;
  files: { list: Array<{ path: string; added: number; removed: number; state: string }>; total: number; truncated: boolean; approximate: boolean } | null;
  checks: WorkCheck[];
  repro: { required: boolean; state: string; reason?: string } | null;
  review: { verdict: 'accept' | 'reject'; by: string; margin?: string } | null;
  time: { startedAt: string | null; stoppedAt: string | null; runMs: number | null; verifyMs: number | null };
  cost: { usd: number | null; state: string };
};
export type WorkDetail = {
  requestId: string; state: WorkState; createdAt: string; closedAt: string | null; kind: string | null; taskType: string | null;
  level: DifficultyOf & { judged: Level; source: string; rule: string | null; confidence: number | null; final: Level; changes: Array<{ from: Level; to: Level; why: string }> };
  plan: { preset: string; leadDirect: boolean; leadModel: string | null; leadClass: string | null; budgetUsd: number; holdout: string | null };
  outcome: WorkRow['outcome']; passed: boolean | null; acceptance: string | null;
  subtasks: WorkSubtask[];
  changes: { changedFiles: number; linesAdded: number; linesRemoved: number; newFiles: number; deletedFiles: number; approximate: boolean } | null;
  files: Array<{ path: string; added: number; removed: number; state: string }>;
  tests: { passed: number; failed: number } | null;
  stepChanges: StepChange[];
  time: { durationMs: number | null; activeMs: number | null; awaitingMs: number; phases: Array<{ phase: string; ms: number }> };
  timeline: Array<{ kind: 'plan' | 'worker' | 'verify' | 'awaiting_user'; role: string | null; subtaskId: string | null; startedAt: string; endedAt: string | null; ok: boolean | null }>;
  cost: { totalUsd: number; leadUsd: number | null; workerUsd: number; budgetUsd: number; estimated: boolean; unknown: boolean; budgetExceeded: boolean; basis: string };
  hasPrompt: boolean;
};
export type HoldoutArm = { n: number; accepted: number; costPerAcceptedUsd: number | null };
export type Savings = {
  period: Period; since: string; until: string;
  measured: {
    cost: { label: 'billed' | 'api-equivalent' | 'mixed'; totalUsd: number; leadUsd: number; workerUsd: number; requests: number; passed: number; costPerPassedUsd: number | null;
            flags: { estimated: number; unknown: number; budgetExceeded: number } };
    /** as /router/v1/office gives them: `resetsAt` in epoch seconds */
    limits: { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null; updatedAt?: number } | null;
  };
  estimated: {
    leadPriced: { workerUsd: number; atLeadPriceUsd: number; differenceUsd: number; requests: number; leftOut: { noLeadModel: number; noPrice: number; noTokens: number }; assumptions: string[] };
    holdout: Array<{ leadClass: string; level: Level; team: HoldoutArm; direct: HoldoutArm; need: { team: number; direct: number }; enough: boolean; differencePct: number | null }>;
    holdoutRate: number; holdoutMode: string;
  };
  series: { unit: 'hour' | 'day'; utcOffsetMinutes: number; points: Array<{ start: string; requests: number; passed: number; totalUsd: number; leadUsd: number; workerUsd: number; leadPricedDifferenceUsd: number | null }> };
};
export type Source = 'default' | 'profile' | 'own' | 'project';
export type Team = {
  period: Period; profile: { value: string; source: string }; leadClass: string | null; delegateFrom: { value: Level; source: Source } | null;
  roles: Array<{
    role: string;
    /** one entry a level, or (decision 225) one a level and difficulty, each with the start cell the router computed */
    levels: Array<SlotCell & { level: Level; difficulty?: Difficulty | null; count: number; source: Source }>;
    stats: { subtasks: number; passed: number; failed: number; passRate: number | null; avgCostUsd: number | null; avgRunMs: number | null; stepUps: number; stepDowns: number };
  }>;
  stepChanges: StepChange[];
  triage: { overall: { total: number; levelHeld: number; teamFit: number; startStepFit: number }; byRule?: Array<{ rule: string; count: number; suggestLevelUp: boolean; suggestStepUp: boolean }> } | null;
};
export type SettingValue = string | number | boolean | null;
export type SettingItem = {
  path: string; group: string; title: string; description: string; type: 'enum' | 'boolean' | 'number' | 'integer';
  options?: string[]; min?: number; max?: number; step?: number;
  /** a step's model and effort ("haiku low") */
  optionLabels?: Record<string, string>;
  /** the values a number steps through, where min, max and step would make too many */
  choices?: number[];
  value: SettingValue; source: Source; sourceNote?: string; default: SettingValue; profileValue?: SettingValue;
  appliesAt: string; editable: boolean; why?: string;
};
export type OfficeSettings = {
  revision: { config: string; presets: string };
  profile: { value: string; source: string; options: Array<{ id: string; title: string; summary: string; measured: string | null }> };
  items: SettingItem[];
  team: Array<{ level: Level; leadDirect: boolean; budgetUsd: number; roles: Array<SlotCell & { role: string; count: number; source: Source }> }>;
  text: Array<{ key: string; title: string; value: string; command: string }>;
  project: { name: string; worktree: 'on' | 'off' | null } | null;
  problems: Array<{ path: string; message: string }>;
  managed: Array<{ key: string; reason: string }>;
};

// ---------------------------------------------------------------- figures drawn as text

/** `value` of `max` as a bar `width` cells across: full cells, an eighth-cell part where the terminal has one, then empty cells. */
export function bar(value: number, max: number, width: number, g: Glyphs = GLYPHS): string {
  const w = Math.max(0, Math.floor(width));
  const f = max > 0 && Number.isFinite(value) ? Math.min(1, Math.max(0, value / max)) : 0;
  const eighths = g.parts.length ? Math.round(f * w * 8) : Math.round(f * w) * 8;
  const full = Math.floor(eighths / 8);
  const part = eighths % 8 && full < w ? g.parts[(eighths % 8) - 1] ?? '' : '';
  return g.full.repeat(full) + part + g.empty.repeat(Math.max(0, w - full - (part ? 1 : 0)));
}

/** A column chart: one column of `colWidth` cells a value, `gap` apart, `height` rows; the top row first. A value above 0 shows at least its lowest mark. */
export function columns(values: readonly number[], height: number, colWidth: number, gap: number, g: Glyphs = GLYPHS): string[] {
  const max = Math.max(0, ...values.filter(v => Number.isFinite(v)));
  const rows: string[] = [];
  for (let r = height - 1; r >= 0; r--) {
    rows.push(values.map(v => {
      const e = max > 0 && v > 0 ? Math.max(1, Math.round((v / max) * height * 8)) : 0;
      const cell = g.levels[Math.max(0, Math.min(8, e - r * 8))] ?? ' ';
      return cell.repeat(colWidth);
    }).join(' '.repeat(gap)));
  }
  return rows;
}

/** git's stat bar: `+` and `-` in proportion to the lines, at most `width` marks; a changed file shows at least one. */
export function statBar(added: number, removed: number, width: number, most: number): { plus: string; minus: string } {
  const total = added + removed;
  if (total <= 0 || width <= 0) return { plus: '', minus: '' };
  const n = Math.max(1, Math.round((total / Math.max(total, most)) * width));
  const p = added ? Math.max(1, Math.round((added / total) * n)) : 0;
  const m = removed ? Math.max(1, n - p) : 0;
  return { plus: '+'.repeat(Math.min(p, width)), minus: '-'.repeat(Math.min(m, Math.max(0, width - p))) };
}

/** A percentage, or a dash for nothing known. */
export const pct = (v: number | null | undefined, digits = 0): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—');

/** A duration as people read it: 42s, 3:05, 1h 07m. */
export function dur(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** A time (ISO, or epoch seconds as the limits give it) as the hour and minute of the machine's clock; the date first when it is not `now`'s day. */
export function clockTime(at: string | number | null | undefined, now: number): string {
  if (at === null || at === undefined || at === '') return '—';
  const d = new Date(typeof at === 'number' ? at * 1000 : at);
  if (Number.isNaN(d.getTime())) return '—';
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === n.toDateString() ? hm : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

/** A series point's label: the hour (24 hours) or the month and day. */
export function pointLabel(iso: string, unit: 'hour' | 'day'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return unit === 'hour' ? `${String(d.getHours()).padStart(2, '0')}h` : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Up and down counts in the terminal's marks: "↑2 ↓1", or "2 up, 1 down" in the classic console. */
export function upDown(up: number, down: number, g: Glyphs = GLYPHS): string {
  if (g.up === '↑') return [up ? `${g.up}${up}` : '', down ? `${g.down}${down}` : ''].filter(Boolean).join(' ');
  return [up ? `${up} up` : '', down ? `${down} down` : ''].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------- the Work tab

/** A request's state as a mark, a word and a theme color. */
export function workMark(r: Pick<WorkRow, 'state' | 'passed'>, g: Glyphs = GLYPHS): { mark: string; word: string; color: string } {
  if (r.state === 'open') return { mark: g.status.working, word: 'running', color: 'warning' };
  if (r.state === 'awaiting_user') return { mark: g.status.waiting, word: 'waiting for you', color: 'suggestion' };
  if (r.passed === false) return { mark: g.status.failed, word: 'failed', color: 'error' };
  return { mark: g.status.done, word: r.passed ? 'passed' : 'done', color: 'success' };
}

/** "L2", or "L1→L2" when it ran at another level than judged. */
export const levelText = (judged: string, final: string, g: Glyphs = GLYPHS): string => (final && final !== judged ? `${judged}${g.arrow}${final}` : judged);

/** What a request changed, short: "src/slug.ts +6 -2, 2 more files", or its line counts alone. */
export function filesText(r: Pick<WorkRow, 'files' | 'changedFiles' | 'linesAdded' | 'linesRemoved'>): string {
  const first = r.files[0];
  const more = (r.changedFiles ?? r.files.length) - (first ? 1 : 0);
  if (first) return `${first.path} +${first.added} -${first.removed}${more > 0 ? `, ${more} more file${more === 1 ? '' : 's'}` : ''}`;
  if (r.changedFiles) return `${r.changedFiles} file${r.changedFiles === 1 ? '' : 's'} +${r.linesAdded ?? 0} -${r.linesRemoved ?? 0}`;
  return '';
}

/** The Work tab's first line: what runs now and how today went. */
export function workHeadline(w: WorkList | null): string {
  if (!w) return '';
  const running = w.open.filter(r => r.state === 'open').length;
  const waiting = w.open.length - running;
  const now = running ? `${running} running` : 'Nothing running';
  return [now, waiting ? `${waiting} waiting for you` : '', `today ${w.today.done} done${w.today.failed ? `, ${w.today.failed} failed` : ''} · ${usd(w.today.usd)}`].filter(Boolean).join(' · ');
}

/** A timeline span's name: "plan", the role (and subtask), "verify", "waiting". */
export function spanName(s: WorkDetail['timeline'][number]): string {
  if (s.kind === 'plan') return 'plan';
  if (s.kind === 'verify') return `verify${s.subtaskId ? ` ${s.subtaskId}` : ''}`;
  if (s.kind === 'awaiting_user') return 'waiting';
  const name = s.role ? (ROLE_NAME as Record<string, string>)[s.role] ?? s.role : 'worker';
  return `${name}${s.subtaskId ? ` ${s.subtaskId}` : ''}`;
}

/**
 * The spans on one time axis `width` cells across, from the first start to the last end (an open span ends at
 * `now`): each span's first cell and its length, at least one cell.
 */
export function timelineCells(spans: WorkDetail['timeline'], width: number, now: number): Array<{ from: number; len: number; ms: number }> {
  const t = (iso: string | null) => (iso ? new Date(iso).getTime() : now);
  const starts = spans.map(s => t(s.startedAt)), ends = spans.map(s => Math.max(t(s.startedAt), t(s.endedAt)));
  const lo = Math.min(...starts), hi = Math.max(...ends);
  const span = Math.max(1, hi - lo);
  return spans.map((_, i) => {
    const from = Math.min(width - 1, Math.floor(((starts[i]! - lo) / span) * width));
    const to = Math.max(from + 1, Math.round(((ends[i]! - lo) / span) * width));
    return { from, len: Math.min(width - from, to - from), ms: ends[i]! - starts[i]! };
  });
}

// ---------------------------------------------------------------- the Savings tab

/** The measured line: what was spent and the limits, never an estimate. */
export function spentLine(m: Savings['measured'] | null | undefined): string {
  if (!m) return '';
  const c = m.cost;
  const label = c.label === 'billed' ? 'billed' : c.label === 'mixed' ? 'billed and at API prices' : 'at API prices';
  const parts = [`Spent ${usd(c.totalUsd)} ${label}`, `${c.requests} request${c.requests === 1 ? '' : 's'}, ${c.passed} passed`];
  if (m.limits?.fiveHour) parts.push(`5h limit ${Math.round(m.limits.fiveHour.usedPercentage)}%`);
  if (m.limits?.sevenDay) parts.push(`7d ${Math.round(m.limits.sevenDay.usedPercentage)}%`);
  return parts.join(' · ');
}

/** One holdout row, as decided: the counts and the need, and a difference only once there are enough. */
export function holdoutText(h: Savings['estimated']['holdout'][number]): { head: string; tail: string; enough: boolean } {
  const head = `${h.leadClass} ${h.level}: team ${h.team.n}, lead alone ${h.direct.n}`;
  if (!h.enough || h.differencePct === null) {
    const missing = Math.max(0, h.need.team - h.team.n) + Math.max(0, h.need.direct - h.direct.n);
    return { head, tail: `not enough requests yet (${missing} more needed)`, enough: false };
  }
  const d = h.differencePct;
  return { head, tail: `team ${usd(h.team.costPerAcceptedUsd)} vs alone ${usd(h.direct.costPerAcceptedUsd)} per accepted (${d > 0 ? '+' : ''}${Math.round(d)}%)`, enough: true };
}

// ---------------------------------------------------------------- the Settings tab

/** A setting's value as text: on/off for a boolean, dollars for a budget, "none" for no value. */
export function settingText(item: Pick<SettingItem, 'path' | 'type' | 'optionLabels'>, v: SettingValue | undefined): string {
  if (v === null || v === undefined) return 'none';
  if (item.type === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number' && /^budgetsUsd\./.test(item.path)) return usd(v);
  if (typeof v === 'number' && /rate/i.test(item.path) && v <= 1) return `${Math.round(v * 100)}%`;
  const label = typeof v === 'string' ? item.optionLabels?.[v] : undefined;
  return label ? `${v} ${label}` : String(v);
}

/** What the item comes back to with no own value: the profile's, else the default. */
export const inherited = (item: Pick<SettingItem, 'default' | 'profileValue'>): SettingValue => (item.profileValue !== undefined ? item.profileValue : item.default);

/** The values Enter steps through, in order: an enum's options, off/on, a number from min to max by step (at most 24). */
export function choices(item: SettingItem): SettingValue[] {
  if (item.type === 'boolean') return [false, true];
  if (item.type === 'enum') return [...(item.options ?? [])];
  if (item.choices?.length) return [...item.choices];
  const lo = item.min ?? 0, hi = item.max ?? lo, step = item.step ?? (item.type === 'integer' ? 1 : 0.5);
  if (!(hi >= lo) || !(step > 0)) return [item.value];
  const out: number[] = [];
  for (let k = 0; k <= 24 && lo + k * step <= hi + 1e-9; k++) out.push(Number((lo + k * step).toFixed(6)));
  return out;
}

/** The next value after `current` (Enter); a value not among the choices goes to the first. */
export function cycle(item: SettingItem, current: SettingValue): SettingValue {
  const list = choices(item);
  if (!list.length) return current;
  const i = list.findIndex(v => v === current);
  return list[(i + 1) % list.length]!;
}

/** The value a row shows: the pending one, else the effective one. */
export const shownValue = (item: SettingItem, pending: Readonly<Record<string, SettingValue>>): SettingValue => (Object.hasOwn(pending, item.path) ? pending[item.path]! : item.value);

/**
 * The POST's `set`: each pending change, a value equal to what the item would inherit sent as null (the own value
 * taken away, so the profile or the default applies again); a change back to the current value is left out.
 */
export function pendingSet(items: readonly SettingItem[], pending: Readonly<Record<string, SettingValue>>): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const [path, v] of Object.entries(pending)) {
    const item = items.find(i => i.path === path);
    if (!item || !item.editable || v === item.value) continue;
    out[path] = v === inherited(item) && item.source === 'own' ? null : v;
  }
  return out;
}

/** The confirmation's words, the changes by when they take effect: "Apply 2 changes? · now: Step down · next start: Record prompts". */
export function confirmLine(items: readonly SettingItem[], set: Readonly<Record<string, SettingValue>>): string {
  const by: Record<string, string[]> = {};
  for (const path of Object.keys(set)) {
    const item = items.find(i => i.path === path);
    (by[item?.appliesAt ?? 'now'] ??= []).push(item?.title ?? path);
  }
  const order = ['now', 'next request', 'next session', 'next start'];
  const when = Object.keys(by).sort((a, b) => (order.indexOf(a) + 9) % 9 - (order.indexOf(b) + 9) % 9);
  const n = Object.keys(set).length;
  return [`Apply ${n} change${n === 1 ? '' : 's'}?`, ...when.map(at => `${at}: ${by[at]!.join(', ')}`)].join(' · ');
}

/** What the person reads of an apply's answer: what changed, or each problem on its own line. */
export function appliedLines(status: number | undefined, body: unknown, error?: string): { ok: boolean; lines: string[] } {
  if (error && status === undefined) return { ok: false, lines: [error] };
  const b = (body && typeof body === 'object' ? body : {}) as { ok?: boolean; changed?: string[]; nextStart?: string[]; notes?: string[]; errors?: Array<{ path?: string; message?: string }> };
  if (status === 200 && b.ok) {
    const changed = b.changed ?? [];
    return { ok: true, lines: [changed.length ? `Applied: ${changed.join(', ')}` : 'Nothing changed', ...(b.nextStart?.length ? [`from the next start: ${b.nextStart.join(', ')}`] : []), ...(b.notes ?? []).filter(x => x !== 'no change')] };
  }
  if (status === 409) return { ok: false, lines: ['The settings changed elsewhere since this tab read them: they are read again, nothing was written'] };
  const errs = (b.errors ?? []).map(x => `${x.path ?? ''}: ${x.message ?? 'refused'}`);
  return { ok: false, lines: errs.length ? errs : [error ?? `the router answered ${status ?? 'nothing'}`] };
}
