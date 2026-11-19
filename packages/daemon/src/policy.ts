// Agent-call rules for the lead (decisions Q3 and Q5, 2026-11-10).
// - Only subagent types `do-it-all-claude-code:<role>` are managed; others pass untouched.
// - First prompt line must be `[subtask:<ID>]`; optional second line `[scope: glob, glob]`.
// - model/effort must equal the slot's ladder step (Phase 1: the preset start step); otherwise deny
//   with the expected values. A role the preset lacks: deny when the lead may not adjust the team
//   (L0), else expect the role's default start step for that level.
// - s7 needs fableOptIn; usedUsd >= budgetUsd denies.
import { DEFAULT_DIFFICULTY, DEFAULT_PROFILE, GRID_LADDER, PROTECTED_WRITE_PATHS, difficultyRank, memberStartCell } from '@do-it-all-claude-code/core';
import type { Difficulty, DifficultySource, LadderId, LadderStep, Level, Profile, Role, Step, TeamPreset } from '@do-it-all-claude-code/core';

export const MANAGED_PREFIX = 'do-it-all-claude-code:';
export const ROLES: readonly Role[] = ['architect', 'ui-designer', 'coder', 'reviewer', 'tester'];

/** Role of a managed agent type; null for a managed type with an unknown role; undefined when unmanaged. */
export function managedRole(agentType: string | undefined): Role | null | undefined {
  if (!agentType || !agentType.startsWith(MANAGED_PREFIX)) return undefined;
  const r = agentType.slice(MANAGED_PREFIX.length);
  return (ROLES as readonly string[]).includes(r) ? (r as Role) : null;
}

export const isAgentTool = (toolName: string | undefined) => toolName === 'Agent' || toolName === 'Task';

/** Decision Q3: default start step of a role at a level when the preset does not list it. */
const BASE_START: Record<Role, Step> = { architect: 's3', 'ui-designer': 's3', coder: 's1', reviewer: 's3', tester: 's1' };
const LEVEL_START: Partial<Record<Level, Partial<Record<Role, Step>>>> = {
  L1: { reviewer: 's1' },
  L3: { architect: 's5', coder: 's5', reviewer: 's5' },
};

export function defaultStartStep(level: Level, role: Role): Step {
  return LEVEL_START[level]?.[role] ?? BASE_START[role];
}

/** The routine baseline cell a role starts at in a preset (its member's start, else the level's default). */
export function startStep(preset: TeamPreset, level: Level, role: Role): LadderId {
  return preset.roles.find(r => r.role === role && r.count > 0)?.start ?? defaultStartStep(level, role);
}

/** Ladder cell for an Agent call's model + effort. `model` may be the alias or the pinned model id. */
export function stepOf(model: string | undefined, effort: string | undefined, ladder: readonly LadderStep[] = GRID_LADDER): LadderStep | undefined {
  if (!model || !effort) return undefined;
  return ladder.find(s => (s.alias === model || s.modelId === model) && s.effort === effort);
}

// ------------------------------------------------------------------ prompt lines

const TAG = /^\s*\[subtask:\s*([A-Za-z0-9_.-]{1,64})\s*\]/;
const SCOPE = /^\s*\[scope:([^\]]*)\]\s*$/;

export function parseTag(prompt: string | undefined): string | undefined {
  const first = (prompt ?? '').split(/\r?\n/, 1)[0] ?? '';
  return TAG.exec(first)?.[1];
}

export type ScopeParse = { ok: true; allowed: string[]; unscoped: boolean } | { ok: false; reason: string };

/**
 * Decision Q5: second prompt line `[scope: a/**, b/**]`; without it the whole repository is allowed.
 * Decision 219: an empty line on a role that cannot write (`readOnly`, a reviewer) means it writes nothing. A writer's
 * empty line stays refused: a writer that may change no file would spend its whole run on refusals.
 */
export function parseScope(prompt: string | undefined, opts: { readOnly?: boolean } = {}): ScopeParse {
  const second = (prompt ?? '').split(/\r?\n/)[1] ?? '';
  const m = SCOPE.exec(second);
  if (!m) return { ok: true, allowed: ['**'], unscoped: true };
  const globs = m[1]!.split(',').map(g => g.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
  if (!globs.length && opts.readOnly) return { ok: true, allowed: [], unscoped: false };
  if (!globs.length) return { ok: false, reason: 'the [scope: ...] line is empty: list repo-relative globs, or remove the line to allow the whole repository' };
  const bad = globs.filter(g => g.startsWith('/') || /^[A-Za-z]:/.test(g) || g.split('/').includes('..') || g.startsWith('~'));
  if (bad.length) return { ok: false, reason: `scope globs must be repo-relative (no absolute paths, "~" or ".."): ${bad.join(', ')}` };
  return { ok: true, allowed: globs, unscoped: false };
}

// ------------------------------------------------------------------ per-subtask difficulty (decision 230)

const DIFFICULTY_TAG = /^\s*\[difficulty:\s*(routine|moderate|hard)\s*\]\s*$/i;

/**
 * Decision 230 (item 5): the `[difficulty: routine|moderate|hard]` header tag of an Agent prompt, read
 * order-independently from the header lines before the spec (as repro.ts reads `[repro:]`). Undefined when absent;
 * the caller then uses the request's difficulty.
 */
export function parseDifficultyTag(prompt: string | undefined): Difficulty | undefined {
  for (const l of (prompt ?? '').split(/\r?\n/, 6)) {
    const m = DIFFICULTY_TAG.exec(l);
    if (m) return m[1]!.toLowerCase() as Difficulty;
  }
  return undefined;
}

// Decision 230 (item 6): "source files" are paths OUTSIDE the test/doc/changelog/config patterns. A scope glob
// counts as non-source only when its literal pattern is confined to one of these; anything else (and the whole
// repo) is treated as source-changing, conservatively.
const NON_SOURCE_GLOB = new RegExp([
  '(^|/)(tests?|__tests__|specs?|__mocks__|testdata|fixtures|__fixtures__|__snapshots__|docs?)(/|$)',  // a test/doc directory on the path
  '(^|/)(test_[^/]*|[^/]*_test|[^/]*\\.(test|spec))\\.[^/]*$',                                          // a test file name
  '(^|/)CHANGELOG[^/]*$',                                                                               // changelog
  '\\.(md|mdx|rst|txt|json|ya?ml|toml|ini|cfg|conf|lock)$',                                             // doc/config extensions
].join('|'), 'i');

/** Whether one scope glob targets only non-source files (tests, docs, changelog, config). The whole repo is not. */
export function globTargetsOnlyNonSource(glob: string): boolean {
  const g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!g || g === '**' || g === '**/*' || g === '*') return false;
  return NON_SOURCE_GLOB.test(g);
}

/** Decision 230 (item 6): whether a write scope can change source files (then a coder's difficulty may not go below the request floor). */
export function scopeChangesSource(allowed: readonly string[], unscoped: boolean): boolean {
  if (unscoped) return true;
  return !allowed.every(globTargetsOnlyNonSource);
}

export interface CallDifficultyInput {
  role: Role;
  /** The call's `[difficulty:]` tag, if any. */
  tag?: Difficulty;
  /** The request's difficulty (the assumed default when the request has none set). */
  requestDifficulty: Difficulty;
  /** Decision 230 (item 6): the request difficulty was SET (lead report or router floor), not the assumed default. */
  requestDifficultySet: boolean;
  scope: readonly string[];
  unscoped: boolean;
}

/**
 * Decision 230 (items 5, 6): the difficulty one Agent call runs at. Its tag when given, else the request's. A coder
 * subtask that can change source files may not be tagged below a SET request difficulty: a lower tag is raised to it
 * (source 'floor'), so the router's answer then carries the floor's cell exactly as a wrong model is corrected today.
 */
export function resolveCallDifficulty(i: CallDifficultyInput): { difficulty: Difficulty; source: DifficultySource } {
  if (i.tag === undefined) return { difficulty: i.requestDifficulty, source: 'request' };
  if (i.role === 'coder' && i.requestDifficultySet && scopeChangesSource(i.scope, i.unscoped)
    && difficultyRank(i.tag) < difficultyRank(i.requestDifficulty)) {
    return { difficulty: i.requestDifficulty, source: 'floor' };
  }
  return { difficulty: i.tag, source: 'tag' };
}

// ------------------------------------------------------------------ writers at the same time (decision 178)

const WILD = /[*?[{]/;

/** A glob's fixed leading directories (before the first segment with a wildcard), and whether it names one path. */
function fixedPart(glob: string): { segs: string[]; exact: boolean } {
  const segs = glob.toLowerCase().split('/').filter(Boolean);
  const i = segs.findIndex(s => WILD.test(s));
  return i < 0 ? { segs, exact: true } : { segs: segs.slice(0, i), exact: false };
}

/**
 * Whether two write-scope globs can name the same file. They cannot when they part at a fixed directory or file name
 * ("src/a/**" and "src/b/**", "src/a.ts" and "src/b/**"); two exact paths meet only when equal. Anything else counts
 * as overlapping ("src/**" and "src/a/**", "src/index.ts" and "src/*.ts", "**\/*.ts" and anything): conservative, and
 * compared without case (case-insensitive file systems).
 */
export function globsMayMeet(a: string, b: string): boolean {
  const pa = fixedPart(a), pb = fixedPart(b);
  const n = Math.min(pa.segs.length, pb.segs.length);
  for (let i = 0; i < n; i++) if (pa.segs[i] !== pb.segs[i]) return false;
  return pa.exact && pb.exact ? pa.segs.length === pb.segs.length : true;
}

/** The first pair of globs, one from each scope, that may name the same file; undefined when the scopes are disjoint. */
export function scopesOverlap(a: readonly string[], b: readonly string[]): [string, string] | undefined {
  for (const x of a) for (const y of b) if (globsMayMeet(x, y)) return [x, y];
  return undefined;
}

/** Roles that write files: the ones the concurrent-writer rule applies to. */
export const WRITER_ROLES: ReadonlySet<Role> = new Set<Role>(['coder', 'ui-designer']);

export interface ConcurrentWriterInput {
  tag: string;
  role: Role;
  scope: readonly string[];
  isolation: string | undefined;
  /** The other writer subtasks of the request that are dispatched and not finished. */
  running: ReadonlyArray<{ id: string; role: Role; scope: readonly string[] }>;
}

/**
 * Decision 178 (다): a writer sent while another writer of the request is still running must have a write scope
 * that does not overlap any of theirs, so the two never edit the same file. The reason tells the lead how to send it instead. A writer sent when no other writer
 * runs is never refused here, so sending one after another always works.
 */
export function concurrentWriterProblem(i: ConcurrentWriterInput): { kind: 'overlap'; reason: string } | null {
  if (!WRITER_ROLES.has(i.role)) return null;
  const others = i.running.filter(w => WRITER_ROLES.has(w.role) && w.id !== i.tag);
  if (!others.length) return null;
  for (const w of others) {
    const pair = scopesOverlap(i.scope, w.scope);
    if (pair) {
      return {
        kind: 'overlap',
        reason: `subtask ${i.tag}: its write scope overlaps subtask ${w.id}'s, which is still running ("${pair[0]}" and "${pair[1]}" can name the same file). `
          + `Either give the two subtasks scopes that share no file (separate directories or files, such as "src/a/**" and "src/b/**"; a file both need, like an index or a shared type, goes to one of them only), `
          + `or send ${i.tag} after ${w.id} has finished (its task-notification): a writer sent while no other writer runs is never refused for this.`,
      };
    }
  }
  // A worktree per concurrent writer stays the instruction (decision 83), not a refusal: disjoint writers in one
  // working tree are supported (decision 103 explains a scoped sibling's changes).
  return null;
}

export function scopeFileBody(allowed: string[], unscoped: boolean) {
  return { allowed, protected: [...PROTECTED_WRITE_PATHS], ...(unscoped ? { unscoped: true } : {}) };
}

// ------------------------------------------------------------------ the check

export interface AgentCallInput {
  tag: string;
  role: Role;
  model?: string;
  effort?: string;
  level: Level;
  preset: TeamPreset;
  budgetUsd: number;
  spentUsd: number;
  fableOptIn: boolean;
  /** Decision 225: the request's difficulty; with the profile it sets each role's start cell (decision 226). */
  difficulty?: Difficulty;
  profile?: Profile;
  busySlots: number[];          // slots of this role whose subtask is pending or running
  tagBusy: boolean;             // the same subtask ID is already pending or running
  /** Spec 3.5: the cell a slot of this role was raised to after a miss (absent: the difficulty-adjusted start). */
  slotSteps?: Record<number, LadderId>;
  ladder?: readonly LadderStep[];
}

export type AgentCallCheck = { ok: true; slot: number; step: LadderId } | { ok: false; reason: string };

const describe = (s: LadderStep) => `model="${s.alias}", effort="${s.effort}"`;

export function checkAgentCall(i: AgentCallInput): AgentCallCheck {
  const ladder = i.ladder ?? GRID_LADDER;
  const id = `subtask ${i.tag}`;
  if (i.spentUsd >= i.budgetUsd) {
    return { ok: false, reason: `${id}: the ${i.level} request budget is used up ($${i.spentUsd.toFixed(4)} of $${i.budgetUsd}). Do not start more subagents; report progress to the user and ask how to continue.` };
  }
  if (i.tagBusy) return { ok: false, reason: `${id} is already running; wait for it to finish or use a new subtask ID.` };

  const member = i.preset.roles.find(r => r.role === i.role && r.count > 0);
  if (!member && !i.preset.leadMayAdjust) {
    const team = i.preset.roles.map(r => `${r.role} x${r.count}`).join(', ');
    return { ok: false, reason: `${id}: the ${i.level} team is fixed (${team}); a ${i.role} cannot be added.` };
  }
  // decision 226: the start cell comes from the difficulty table, the profile notch, and a user teams.yaml/role override.
  const profile = i.profile ?? DEFAULT_PROFILE;
  const start = memberStartCell(i.role, member?.start ?? defaultStartStep(i.level, i.role), member?.startSet, i.difficulty ?? DEFAULT_DIFFICULTY, profile, i.fableOptIn);
  const stepFor = (slot: number): LadderId => i.slotSteps?.[slot] ?? start;

  // Free slots of the role, in order; past the team's count only when the lead may adjust the team.
  const count = member?.count ?? 0;
  const free: number[] = [];
  for (let s = 0; s < count; s++) if (!i.busySlots.includes(s)) free.push(s);
  if (!free.length) {
    if (!i.preset.leadMayAdjust) return { ok: false, reason: `${id}: all ${count} ${i.role} slot(s) of the ${i.level} team are busy; wait for one to finish (a subtask that was allowed but never started can be dispatched again with the same ID).` };
    free.push(firstFree(i.busySlots, count, Number.MAX_SAFE_INTEGER)!);
  }
  const expected = stepFor(free[0]!);
  const exp = ladder.find(s => s.step === expected);
  if (!exp) return { ok: false, reason: `${id}: ladder step ${expected} is not defined.` };
  const where = (slot: number) => (i.slotSteps?.[slot] ? ` (slot ${slot} was raised to ${i.slotSteps[slot]} after a miss)` : '');

  if (exp.optIn && !i.fableOptIn) return { ok: false, reason: `${id}: step ${expected} needs the Fable opt-in, which is off.` };
  const asked = stepOf(i.model, i.effort, ladder);
  if (!i.model || !i.effort) {
    return { ok: false, reason: `${id}: pass model and effort on the Agent call. The ${i.role} runs at step ${expected} (${describe(exp)}) for this ${i.level} request${where(free[0]!)}.` };
  }
  if (asked?.optIn && !i.fableOptIn) return { ok: false, reason: `${id}: step ${asked.step} (Fable) needs the opt-in, which is off. Use ${describe(exp)}.` };
  // the first free slot takes the call, at its own step: a slot raised after a miss is used next (spec 3.5)
  const slot = free[0]!;
  if (!asked || asked.step !== stepFor(slot)) {
    return { ok: false, reason: `${id}: the ${i.role} runs at step ${expected} (${describe(exp)}) for this ${i.level} request${where(free[0]!)}, but the call asked for model="${i.model}", effort="${i.effort}". Call again with ${describe(exp)}.` };
  }
  return { ok: true, slot, step: stepFor(slot) };
}

function firstFree(busy: number[], from: number, to: number): number | undefined {
  for (let s = from; s < to; s++) if (!busy.includes(s)) return s;
  return undefined;
}
