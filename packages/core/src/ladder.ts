// Model x effort grid (spec 3.5; decision 225 widened the fixed 1-D ladder into a 2-D grid).
// The seven legacy cells s1..s6 are Phase-0 measured (Appendix E); s7 and the other 13 cells are estimated
// (anchored on each model's measured `high` cell x the CLI's effort_cost_index; see docs/design/difficulty-steps.md).
import type { Cell, Difficulty, Effort, LadderId, LadderStep, ModelAlias, Role, Step, Tier } from './types.ts';

export const DIFFICULTIES: readonly Difficulty[] = ['routine', 'moderate', 'hard'];
/** Decision 225: the difficulty the router assumes when the lead reports none. */
export const DEFAULT_DIFFICULTY: Difficulty = 'moderate';

const MODELS: Record<ModelAlias, { tier: Tier; modelId: string }> = {
  haiku: { tier: 'T1', modelId: 'claude-haiku-5-5' },
  sonnet: { tier: 'T2', modelId: 'claude-sonnet-5-5' },
  opus: { tier: 'T3', modelId: 'claude-opus-5-5' },
  fable: { tier: 'T3+', modelId: 'claude-fable-5-2' },   // decision 226: the CLI's `fable` alias resolves to 5.2
};

/** The seven legacy cells keep their s-alias; every other cell's id is `model-effort`. */
const LEGACY: Record<Step, [ModelAlias, Effort]> = {
  s1: ['haiku', 'low'], s2: ['haiku', 'high'], s3: ['sonnet', 'medium'], s4: ['sonnet', 'high'],
  s5: ['opus', 'high'], s6: ['opus', 'xhigh'], s7: ['fable', 'high'],
};
const ALIAS_OF = new Map<string, Step>(
  (Object.entries(LEGACY) as Array<[Step, [ModelAlias, Effort]]>).map(([s, [m, e]]) => [`${m}-${e}`, s]));

/** Coefficient (effective cost vs s1) and whether it is MEASURED (Phase 0); the six legacy cells s1..s6 are, the rest are estimated. */
const COST: Record<ModelAlias, Record<Effort, [number, boolean]>> = {
  haiku: { low: [1.0, true], medium: [1.6, false], high: [3.1, true], xhigh: [6.3, false], max: [13.5, false] },
  sonnet: { low: [7.5, false], medium: [9.1, true], high: [15.3, true], xhigh: [28.6, false], max: [84.2, false] },
  opus: { low: [21.6, false], medium: [29.6, false], high: [44.9, true], xhigh: [96.2, true], max: [154.5, false] },
  // decision 226: Fable 5.2 at $8/$40 is ~2.0x Opus-high (not 2.5x), so the 5.1 estimates are scaled x0.8. All estimated.
  fable: { low: [67.4, false], medium: [77.2, false], high: [89.8, false], xhigh: [123.9, false], max: [156.2, false] },
};

const MODEL_ORDER: readonly ModelAlias[] = ['haiku', 'sonnet', 'opus', 'fable'];
const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The id of a cell: the s-alias for a legacy cell, else `model-effort`. */
export function cellId(model: ModelAlias, effort: Effort): LadderId {
  return ALIAS_OF.get(`${model}-${effort}`) ?? `${model}-${effort}`;
}

function makeCell(model: ModelAlias, effort: Effort): Cell {
  const [coefficient, measured] = COST[model][effort];
  const alias = ALIAS_OF.get(`${model}-${effort}`) ?? null;
  return { id: cellId(model, effort), model, effort, tier: MODELS[model].tier, modelId: MODELS[model].modelId,
    optIn: model === 'fable', coefficient, estimated: !measured, alias };
}

/** Every cell of the grid (decision 225): 4 models x 5 efforts. */
export const GRID: readonly Cell[] = MODEL_ORDER.flatMap(m => EFFORT_ORDER.map(e => makeCell(m, e)));

const BY_ID = new Map<LadderId, Cell>(GRID.map(c => [c.id, c]));
// a cell is also addressable by its `model-effort` form even when it has an s-alias
for (const c of GRID) BY_ID.set(`${c.model}-${c.effort}`, c);

/** Resolve a cell id (s1..s7 or `model-effort`) to its Cell. Throws on an unknown id. */
export function cellOf(id: LadderId): Cell {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`unknown ladder cell: ${id}`);
  return c;
}

export function isCellId(id: string): boolean {
  return BY_ID.has(id);
}

/** Cells ordered by cost (ascending), the grid's 1-D projection; estimated cells included. */
export const COST_ORDER: readonly Cell[] = [...GRID].sort((a, b) => a.coefficient - b.coefficient || GRID.indexOf(a) - GRID.indexOf(b));

/**
 * The automatic step-up path (decisions 225, 226): climb effort within a model while the next effort cell is still
 * cheaper than the next model's entry, then change model; dominated cells (haiku-max, sonnet-xhigh/max, opus-max)
 * are off this path and reachable by config only. Ceiling s6 (opus-xhigh) without Fable. With Fable opted in, the
 * rule routes opus-high -> fable-low -> fable-medium -> fable-high (s7) and opus-xhigh (s6) drops off the path,
 * because at $8/$40 the Fable entry costs less than opus-xhigh (decision 226); ceiling s7.
 */
const AUTO_CORE: readonly LadderId[] = ['s1', 'haiku-medium', 's2', 'haiku-xhigh', 'sonnet-low', 's3', 's4', 'opus-low', 'opus-medium', 's5'];   // up to opus-high
const AUTO_NO_FABLE: readonly LadderId[] = [...AUTO_CORE, 's6'];
const AUTO_FABLE: readonly LadderId[] = [...AUTO_CORE, 'fable-low', 'fable-medium', 's7'];
function autoSeq(fableOptIn: boolean): readonly LadderId[] {
  return fableOptIn ? AUTO_FABLE : AUTO_NO_FABLE;
}

// ------------------------------------------------------------------ legacy 1-D view (back-compat)

/** The seven legacy cells as LadderSteps, in s1..s7 order (spec 3.5, Appendix E). */
export const DEFAULT_LADDER: readonly LadderStep[] = (Object.keys(LEGACY) as Step[]).map(s => toLadderStep(cellOf(s)));
export const STEPS: readonly Step[] = Object.keys(LEGACY) as Step[];
/** Every grid cell as a LadderStep (decision 225): the full set an Agent call's model+effort can resolve to. */
export const GRID_LADDER: readonly LadderStep[] = GRID.map(toLadderStep);

function toLadderStep(c: Cell): LadderStep {
  return { step: c.id, tier: c.tier, alias: c.model, effort: c.effort, modelId: c.modelId, optIn: c.optIn, coefficient: c.coefficient, estimated: c.estimated };
}

/** A LadderStep for a cell id. A custom `ladder` is searched first (legacy callers); otherwise the grid. */
export function ladderStep(step: LadderId, ladder?: readonly LadderStep[]): LadderStep {
  if (ladder) {
    const s = ladder.find(x => x.step === step);
    if (s) return s;
  }
  return toLadderStep(cellOf(step));
}

/**
 * Strength rank of a cell: `stepIndex(a) > stepIndex(b)` means a is the stronger cell (model tier first, then
 * effort). GRID is built in that order, so this is its index. Strength, not cost, so a cheaper-but-stronger cell
 * (a Fable cell under decision 226) still ranks above Opus, and the rank rises monotonically along the auto path.
 */
export function stepIndex(step: LadderId): number {
  const c = cellOf(step);
  return GRID.findIndex(x => x.id === c.id);
}

/** Highest usable cell on the automatic path: s6, or s7 when Fable is opted in. */
export function topStep(fableOptIn: boolean): Step {
  return fableOptIn ? 's7' : 's6';
}

/**
 * The next cell up the automatic path. For a cell on the path, the following one; for a config-only cell, the
 * cheapest path cell that costs more than it. Null at or above the ceiling.
 */
export function stepUp(step: LadderId, fableOptIn = false): LadderId | null {
  const seq = autoSeq(fableOptIn);
  const i = seq.indexOf(step);
  if (i >= 0) return i < seq.length - 1 ? seq[i + 1]! : null;
  const c = cellOf(step).coefficient;
  const up = seq.map(cellOf).filter(x => x.coefficient > c).sort((a, b) => a.coefficient - b.coefficient)[0];
  return up ? up.id : null;
}

/**
 * The next cell up the automatic path whose MODEL differs (decision 225): a hard task that comes back unverified
 * jumps model, not just effort. Null at or above the ceiling.
 */
export function modelJump(step: LadderId, fableOptIn = false): LadderId | null {
  const from = cellOf(step).model;
  let cur: LadderId | null = step;
  while (cur !== null) {
    const next: LadderId | null = stepUp(cur, fableOptIn);
    if (next === null) return null;
    if (cellOf(next).model !== from) return next;
    cur = next;
  }
  return null;
}

/**
 * The next cell down: lower effort first within the model, then drop a model tier (the automatic path walked
 * backwards). For a config-only cell, the costliest path cell cheaper than it. Null at the bottom.
 */
export function stepDown(step: LadderId): LadderId | null {
  // a cell may be on the Fable path (s7, fable-*) or the no-Fable path (s6); walk back on whichever holds it.
  for (const seq of [AUTO_FABLE, AUTO_NO_FABLE]) {
    const i = seq.indexOf(step);
    if (i > 0) return seq[i - 1]!;
    if (i === 0) return null;
  }
  const c = cellOf(step).coefficient;
  const down = AUTO_NO_FABLE.map(cellOf).filter(x => x.coefficient < c).sort((a, b) => b.coefficient - a.coefficient)[0];
  return down ? down.id : null;
}

export function tierOf(step: LadderId): Tier {
  return cellOf(step).tier;
}

/** A step change that changes the model, so a new subagent is started (an effort-only change reuses the agent). */
export function crossesTier(from: LadderId, to: LadderId): boolean {
  return cellOf(from).model !== cellOf(to).model;
}

export function maxStep(a: LadderId, b: LadderId): LadderId {
  return stepIndex(a) >= stepIndex(b) ? a : b;
}

/**
 * The start cell for a role, from the request's difficulty (decision 226, final table). Difficulty alone sets
 * the coder's model; the level decides the team (roles, counts), not the coder's cell. Same table at every level.
 *
 * | role               | routine        | moderate (default) | hard         |
 * | coder, tester      | haiku-low (s1) | sonnet-medium (s3) | opus-high (s5) |
 * | architect, reviewer| sonnet-medium  | sonnet-high (s4)   | opus-xhigh (s6) |   (coder's model one effort richer, floor sonnet-medium; hard -> opus-xhigh)
 * | ui-designer        | sonnet-medium  | sonnet-medium (s3) | sonnet-high (s4) |
 *
 * `notch` applies the profile shift (save -1 down, quality +1 up), capped at the grid's reachable top. A start the
 * user set in teams.yaml, or a role override, wins over all of this: the caller passes it as `override`.
 */
const CODER_CELL: Record<Difficulty, LadderId> = { routine: 's1', moderate: 's3', hard: 's5' };
const SUPPORT_CELL: Record<Difficulty, LadderId> = { routine: 's3', moderate: 's4', hard: 's6' };
const UI_CELL: Record<Difficulty, LadderId> = { routine: 's3', moderate: 's3', hard: 's4' };
export function startCellFor(role: Role, difficulty: Difficulty, opts: { override?: LadderId; notch?: number; fableOptIn?: boolean } = {}): LadderId {
  if (opts.override !== undefined) return opts.override;
  const base = role === 'architect' || role === 'reviewer' ? SUPPORT_CELL[difficulty]
    : role === 'ui-designer' ? UI_CELL[difficulty] : CODER_CELL[difficulty];
  const notch = opts.notch ?? 0;
  if (notch > 0) return stepUp(base, opts.fableOptIn) ?? base;
  if (notch < 0) return stepDown(base) ?? base;
  return base;
}

// ------------------------------------------------------------------ step-down (spec 3.5, decision 135)

/** This many easy passes in a row on a slot move it one step down for its next subtask. */
export const EASY_PASSES_FOR_STEP_DOWN = 2;
/** After a raise the slot stays at its new step for this many dispatches (floor lock). */
export const FLOOR_LOCK_TASKS = 2;

/**
 * A slot's state for moving down. An easy pass is a first attempt that passed verify without a fix round
 * and that a reviewer or tester accepted with margin "easy"; verify alone, or the lead's own word, is not one.
 */
export interface SlotAdjust {
  step: LadderId;
  /** Raises that still count against the 3-raise limit; a step-down gives one back. */
  upCount: number;
  easyStreak: number;
  /** Whether the slot's latest result was an easy pass (a result nobody reported as easy ends the streak). */
  lastEasy: boolean;
  /** Floor lock: while lockLeft > 0 the slot does not go below lockStep. */
  lockStep: LadderId | null;
  lockLeft: number;
  downCount: number;
}

export function newSlotAdjust(step: LadderId, upCount = 0): SlotAdjust {
  return { step, upCount, easyStreak: 0, lastEasy: false, lockStep: null, lockLeft: 0, downCount: 0 };
}

/**
 * An easy pass on the slot's latest subtask. The second in a row moves the slot one step down, unless it is
 * at the bottom step or the floor lock holds it; then the streak stays full and the next easy pass tries again.
 */
export function afterEasyPass(s: SlotAdjust): { state: SlotAdjust; steppedDownTo?: LadderId } {
  const easyStreak = Math.min(EASY_PASSES_FOR_STEP_DOWN, s.easyStreak + 1);
  const state = { ...s, easyStreak, lastEasy: true };
  if (easyStreak < EASY_PASSES_FOR_STEP_DOWN) return { state };
  const to = stepDown(s.step);
  if (!to) return { state };
  if (s.lockLeft > 0 && s.lockStep && stepIndex(to) < stepIndex(s.lockStep)) return { state };
  return {
    state: { ...state, step: to, upCount: Math.max(0, s.upCount - 1), easyStreak: 0, downCount: s.downCount + 1 },
    steppedDownTo: to,
  };
}

/** Any result that is not an easy pass (a plain accept, a reject, a failure) ends the streak. */
export function afterOtherResult(s: SlotAdjust): SlotAdjust {
  return { ...s, easyStreak: 0, lastEasy: false };
}

/** A raise to `to`: the streak ends and the slot is locked at the new step for the next dispatches. */
export function afterRaise(s: SlotAdjust, to: LadderId): SlotAdjust {
  return { ...s, step: to, upCount: s.upCount + 1, easyStreak: 0, lastEasy: false, lockStep: to, lockLeft: FLOOR_LOCK_TASKS };
}

/**
 * A new subtask takes the slot. A previous result that was not reported as an easy pass ends the streak;
 * the new subtask's own result is not known yet; one locked task is used up.
 */
export function atDispatch(s: SlotAdjust): SlotAdjust {
  const lockLeft = Math.max(0, s.lockLeft - 1);
  return { ...s, easyStreak: s.lastEasy ? s.easyStreak : 0, lastEasy: false, lockLeft, lockStep: lockLeft > 0 ? s.lockStep : null };
}
