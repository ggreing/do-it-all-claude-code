// The team office's read route (decision 186, docs/design/team-office.md section 3): one sealed GET that gives the
// office panel what only the daemon knows about a session's latest request — the level and its source, each
// subtask with its step and the step's planned model and effort, how verify ended per check kind with the test
// counts, the reproduction outcome, the cost and the latest limits.
//
// It carries no prompt text, no tool arguments and no output tails (a check's detail can hold the masked tail of
// its output): only kinds, results and counts. Nor the status view's `clients` (node paths, router homes).
import type { Ledger } from './ledger.ts';
import type { RoleView, StatusView } from './router.ts';
import { latestLimits, type SessionLimits } from './limits.ts';
import { checksByKind } from './checks.ts';
import { ladderStep, type Difficulty, type DifficultySource, type Step } from '@do-it-all-claude-code/core';

export const OFFICE_PATH = '/router/v1/office';

export interface OfficeCheck {
  kind: string;
  result: 'ok' | 'failed' | 'skipped';
  testsPassed?: number;
  testsFailed?: number;
}

export interface OfficeSubtask {
  id: string;
  role: string;
  slot: number;
  step: string;
  /** The step's planned model alias and effort: what the router asked the Agent call to carry. */
  model: string;
  effort: string;
  /** Decision 225: the step's cell is estimated (not Phase-0 measured). Decision 230: the subtask's own difficulty and source. */
  estimated?: boolean;
  difficulty?: Difficulty;
  difficultySource?: DifficultySource;
  status: string;
  verdict: string | null;
  attempts: number;
  agentId: string | null;
  scope: string[];
  /** The checks of the latest attempt, in the order they ran. */
  checks: OfficeCheck[];
  repro: { required: boolean; state: string; reason?: string } | null;
}

export interface OfficeView {
  request: StatusView['request'];
  roles: RoleView[];
  subtasks: OfficeSubtask[];
  costUsd: number;
  costEstimated: boolean;
  costUnknown: boolean;
  sessionCostUsd: number;
  routing: StatusView['routing'];
  stepAdjust: StatusView['stepAdjust'];
  limits: SessionLimits | null;
  /**
   * Decision 192: the session's repository (its folder name only) and whether parallel writers get a work tree each
   * there; `worktree` null: not asked yet. Null when the session's folder is not known or is not a repository.
   */
  project: ProjectView | null;
}
export interface ProjectView { name: string; worktree: 'on' | 'off' | null }

export interface OfficeContext {
  status(sessionId?: string): StatusView;
  ledger?: Ledger | undefined;
  project?: (sessionId: string) => ProjectView | null;
}

/** Signals that are not a verify check: a review score, a repeated error, a tool error, a scope note. */
const NOT_A_CHECK = new Set(['review', 'error_repeat', 'max_turns', 'tool_error', 'repro']);

export function officeView(ctx: OfficeContext, sessionId: string): OfficeView {
  const st = ctx.status(sessionId);
  const base = {
    request: st.request, roles: st.roles, costUsd: st.costUsd, costEstimated: st.costEstimated, costUnknown: st.costUnknown,
    sessionCostUsd: st.sessionCostUsd, routing: st.routing, stepAdjust: st.stepAdjust,
    limits: ctx.ledger ? latestLimits(ctx.ledger.db, sessionId) : null,
    project: ctx.project?.(sessionId) ?? null,
  };
  const ledger = ctx.ledger;
  if (!st.request || !ledger) return { ...base, subtasks: [] };
  const signals = ledger.listSignals(st.request.id);
  const subtasks = ledger.listSubtasks(st.request.id).map((s): OfficeSubtask => {
    const mine = signals.filter(x => x.subtaskId === s.id);
    const last = mine.reduce((m, x) => Math.max(m, x.attempt), 0);
    // one entry per kind of check (checks.ts): two commands of a kind are one check
    const checks = checksByKind(mine.filter(x => x.attempt === last && !NOT_A_CHECK.has(x.kind))).map((x): OfficeCheck => ({
      kind: x.kind,
      result: x.result,
      ...(x.testsPassed !== undefined ? { testsPassed: x.testsPassed } : {}),
      ...(x.testsFailed !== undefined ? { testsFailed: x.testsFailed } : {}),
    }));
    const planned = ladderStep(s.step as Step);
    return {
      id: s.id, role: s.role, slot: s.slot, step: s.step, model: planned.alias, effort: planned.effort,
      ...(planned.estimated ? { estimated: true } : {}), ...(s.difficulty ? { difficulty: s.difficulty, difficultySource: s.difficultySource } : {}),
      status: s.status, verdict: s.verdict, attempts: s.attempts, agentId: s.agentId ?? null, scope: s.writeScope,
      checks,
      repro: s.repro ? { required: s.repro.required, state: s.repro.state ?? (s.repro.required ? 'pending' : 'off'), ...(s.repro.reason ? { reason: s.repro.reason } : {}) } : null,
    };
  });
  return { ...base, subtasks };
}

/** The route: GET only, `session_id` required. Returns the status code and the JSON body. */
export function officeRoute(ctx: OfficeContext, method: string | undefined, params: URLSearchParams): { status: number; body: unknown } {
  if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };
  const sessionId = params.get('session_id') ?? '';
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) return { status: 400, body: { error: 'session_id is required' } };
  return { status: 200, body: officeView(ctx, sessionId) };
}
