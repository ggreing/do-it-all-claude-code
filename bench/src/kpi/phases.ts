// Decision 174: where the time of a router-on run goes. The sources, most reliable first:
//  - the run's own stream (claude -p --output-format stream-json --verbose --include-hook-events
//    --forward-subagent-text), each line stamped by the harness with the milliseconds since claude was started:
//    hook start/end (hook_started / hook_response), the lead's tool calls, each worker's messages (parent_tool_use_id),
//    the Agent results (with the Agent tool's own totalDurationMs when Claude Code sends it), background workers'
//    task_started / task_notification, and the final result
//  - the daemon's ledger: verify commands (signals.duration_ms per kind), workers (agents: start, stop, worktree),
//    subtasks (attempts, step-ups), hook events as the daemon received them
// Phases that neither source shows are listed in `notMeasured`, never guessed.

export interface StreamLine { t: number; m: Record<string, unknown> }

export interface LedgerTiming {
  /** When claude was started (ISO): turns the ledger's timestamps into seconds since the start. */
  startedAt: string;
  events: Array<{ type: string; toolName: string | null; agentId: string | null; at: string }>;
  signals: Array<{ agentId: string | null; subtaskId: string | null; kind: string; durationMs: number | null; attempt: number; at: string }>;
  agents: Array<{ agentId: string; role: string | null; subtaskId: string | null; startedAt: string; stoppedAt: string | null; worktreePath: string | null }>;
  subtasks: Array<{ id: string; attempts: number; upCount: number }>;
}

export interface WorkerTiming {
  toolUseId: string;
  subagentType: string;
  subtask: string | null;
  /** A second dispatch of the same subtask (a retry, or after a step up). */
  retry: boolean;
  background: boolean;
  /** Seconds since the start: the lead's Agent call, the worker's first message, its first tool call, its end. */
  calledAt: number;
  firstMessageAt: number | null;
  firstToolAt: number | null;
  endedAt: number | null;
  /** Agent call to the worker's first tool call. */
  startDelaySeconds: number | null;
  /** First tool call to the end. */
  workSeconds: number | null;
  totalSeconds: number | null;
  /** The Agent tool's own figure, when Claude Code sent it. */
  agentTotalSeconds: number | null;
  toolCalls: number;
  /** Files the worker Read that the lead had already Read before calling it. */
  rereads: number;
  /** The daemon's verify commands after this worker, by kind. */
  verifySeconds: number;
}

export interface Phases {
  wallSeconds: number;
  /** claude started to its init message (process start, plugin and MCP loading). */
  startupSeconds: number | null;
  /** init to the lead's first Agent call: reading, triage (UserPromptSubmit hook) and planning. */
  leadBeforeFirstWorkerSeconds: number | null;
  /** The lead's first Agent call to the last worker's end. */
  delegationSeconds: number | null;
  /** Inside delegation: seconds when at least one worker ran, and the lead's own time between them. */
  workersActiveSeconds: number | null;
  leadBetweenWorkersSeconds: number | null;
  /** The last worker's end to the result: the lead's wrap-up. */
  leadFinishSeconds: number | null;
  leadRanTestsAtEnd: boolean;
  leadTestSecondsAtEnd: number;
  /** The result to the process exit. */
  exitSeconds: number | null;
  hooks: { source: 'stream' | 'none'; count: number; totalSeconds: number; byEvent: Record<string, { count: number; seconds: number }>; names: string[]; daemonEvents: number };
  workers: WorkerTiming[];
  verify: { source: 'daemon' | 'none'; totalSeconds: number; byKind: Record<string, { count: number; seconds: number }> };
  worktrees: { count: number; mergeSeconds: number; mergeCalls: number };
  retries: { workers: number; seconds: number; stepUps: number; attempts: number };
  leadToolCalls: number;
  notMeasured: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const sec = (ms: number) => Math.round(ms / 100) / 10;
const blocks = (m: Obj): Obj[] => {
  const msg = m.message;
  return isObj(msg) && Array.isArray(msg.content) ? msg.content.filter(isObj) : [];
};
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TEST_COMMAND = /\b(npm (run )?test|node --test|npx (vitest|jest)|pytest|python3? -m pytest|tox|go test|cargo test)\b/;
const MERGE_COMMAND = /\bgit (merge|cherry-pick|worktree|rebase)\b/;

/** Union length of [start, end] intervals. */
function unionLength(iv: Array<[number, number]>): number {
  const s = iv.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0, cur: [number, number] | null = null;
  for (const [a, b] of s) {
    if (!cur || a > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b);
  }
  return total + (cur ? cur[1] - cur[0] : 0);
}

export function analysePhases(lines: StreamLine[], wallMs: number, ledger: LedgerTiming | null = null): Phases {
  const notMeasured: string[] = [];
  const init = lines.find(l => l.m.type === 'system' && l.m.subtype === 'init');
  const result = lines.find(l => l.m.type === 'result');
  // tool calls of the lead (parent_tool_use_id null) and of workers (keyed by their Agent call's id)
  const leadCalls = new Map<string, { id: string; name: string; input: Obj; t: number }>();
  const workerCalls = new Map<string, Array<{ id: string; name: string; input: Obj; t: number }>>();
  const results = new Map<string, { t: number; extra: unknown }>();
  const firstMessage = new Map<string, number>();
  const taskOf = new Map<string, string>();          // background task id -> Agent call id
  const taskEnd = new Map<string, number>();
  const hookStart = new Map<string, { t: number; event: string; name: string }>();
  const hooks: Phases['hooks'] = { source: 'none', count: 0, totalSeconds: 0, byEvent: {}, names: [], daemonEvents: ledger?.events.length ?? 0 };
  const hookNames = new Set<string>();
  let hookMs = 0;
  for (const { t, m } of lines) {
    const parent = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : null;
    if (m.type === 'assistant') {
      if (parent && !firstMessage.has(parent)) firstMessage.set(parent, t);
      for (const b of blocks(m)) {
        if (b.type !== 'tool_use' || typeof b.id !== 'string') continue;
        const call = { id: b.id, name: String(b.name ?? ''), input: isObj(b.input) ? b.input : {}, t };
        if (parent) workerCalls.set(parent, [...(workerCalls.get(parent) ?? []), call]); else leadCalls.set(b.id, call);
      }
    } else if (m.type === 'user') {
      if (parent && !firstMessage.has(parent)) firstMessage.set(parent, t);
      for (const b of blocks(m)) if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && !results.has(b.tool_use_id)) results.set(b.tool_use_id, { t, extra: m.tool_use_result });
    } else if (m.type === 'system' && m.subtype === 'task_started' && typeof m.task_id === 'string' && typeof m.tool_use_id === 'string') {
      taskOf.set(m.task_id, m.tool_use_id);
    } else if (m.type === 'system' && m.subtype === 'task_notification' && typeof m.task_id === 'string') {
      const id = taskOf.get(m.task_id);
      if (id && !taskEnd.has(id)) taskEnd.set(id, t);
    } else if (m.type === 'system' && m.subtype === 'hook_started' && typeof m.hook_id === 'string') {
      hookStart.set(m.hook_id, { t, event: String(m.hook_event ?? ''), name: String(m.hook_name ?? '') });
    } else if (m.type === 'system' && m.subtype === 'hook_response' && typeof m.hook_id === 'string') {
      const s = hookStart.get(m.hook_id);
      if (!s) continue;
      hookStart.delete(m.hook_id);
      const e = (hooks.byEvent[s.event] ??= { count: 0, seconds: 0 });
      e.count++; e.seconds += (t - s.t) / 1000;
      hooks.count++; hookMs += t - s.t; hookNames.add(s.name);
    }
  }
  if (hooks.count) { hooks.source = 'stream'; hooks.totalSeconds = sec(hookMs); for (const e of Object.values(hooks.byEvent)) e.seconds = Math.round(e.seconds * 10) / 10; hooks.names = [...hookNames].slice(0, 20); }
  else notMeasured.push('hooks: the stream has no hook_started/hook_response (run with --include-hook-events)');

  // workers: one per lead Agent call
  const leadReads: Array<{ t: number; file: string }> = [...leadCalls.values()].filter(c => c.name === 'Read' && typeof c.input.file_path === 'string').map(c => ({ t: c.t, file: String(c.input.file_path) }));
  const seenSubtasks = new Set<string>();
  const workers: WorkerTiming[] = [];
  const signals = ledger?.signals ?? [];
  const agents = ledger?.agents ?? [];
  for (const c of [...leadCalls.values()].filter(c => AGENT_TOOLS.has(c.name)).sort((a, b) => a.t - b.t)) {
    const prompt = String(c.input.prompt ?? '');
    const subtask = /\[subtask:([^\]\s]+)\]/.exec(prompt)?.[1] ?? null;
    const retry = subtask !== null && seenSubtasks.has(subtask);
    if (subtask) seenSubtasks.add(subtask);
    const r = results.get(c.id);
    const extra = isObj(r?.extra) ? r!.extra as Obj : {};
    const background = extra.isAsync === true || taskEnd.has(c.id) || extra.status === 'async_launched';
    const endT = taskEnd.get(c.id) ?? (background ? null : r?.t ?? null);
    const calls = workerCalls.get(c.id) ?? [];
    const firstTool = calls.length ? calls[0]!.t : null;
    const reads = new Set(calls.filter(x => x.name === 'Read' && typeof x.input.file_path === 'string').map(x => String(x.input.file_path)));
    const before = new Set(leadReads.filter(x => x.t < c.t).map(x => x.file));
    const agentId = typeof extra.agentId === 'string' ? extra.agentId : null;
    const verifyMs = signals.filter(s => (agentId && s.agentId === agentId) || (!agentId && subtask && s.subtaskId === subtask)).reduce((a, s) => a + (s.durationMs ?? 0), 0);
    workers.push({
      toolUseId: c.id, subagentType: String(c.input.subagent_type ?? ''), subtask, retry, background,
      calledAt: sec(c.t), firstMessageAt: firstMessage.has(c.id) ? sec(firstMessage.get(c.id)!) : null, firstToolAt: firstTool !== null ? sec(firstTool) : null, endedAt: endT !== null ? sec(endT) : null,
      startDelaySeconds: firstTool !== null ? sec(firstTool - c.t) : null, workSeconds: firstTool !== null && endT !== null ? sec(endT - firstTool) : null,
      totalSeconds: endT !== null ? sec(endT - c.t) : null, agentTotalSeconds: typeof extra.totalDurationMs === 'number' ? sec(extra.totalDurationMs) : null,
      toolCalls: calls.length, rereads: [...reads].filter(f => before.has(f)).length, verifySeconds: sec(verifyMs),
    });
  }
  if (!workers.length) notMeasured.push('workers: the lead made no Agent call');
  else if (workers.every(w => w.firstToolAt === null)) notMeasured.push('worker start delay: no worker messages in the stream (run with --forward-subagent-text)');
  const firstCall = workers[0]?.calledAt ?? null;
  const ends = workers.map(w => w.endedAt).filter((x): x is number => x !== null);
  const lastEnd = ends.length ? Math.max(...ends) : null;
  const intervals = workers.filter(w => w.endedAt !== null).map(w => [w.calledAt, w.endedAt!] as [number, number]);
  const active = intervals.length ? Math.round(unionLength(intervals) * 10) / 10 : null;
  const resultAt = result ? sec(result.t) : null;
  // the lead's tool calls after the last worker: a test run is the lead checking the workers' result again
  const leadAfter = lastEnd !== null ? [...leadCalls.values()].filter(c => c.t / 1000 > lastEnd && c.name === 'Bash') : [];
  const testsAfter = leadAfter.filter(c => TEST_COMMAND.test(String(c.input.command ?? '')));
  const durOf = (c: { id: string; t: number }) => { const r = results.get(c.id); return r ? (r.t - c.t) / 1000 : 0; };
  const merges = [...leadCalls.values()].filter(c => c.name === 'Bash' && MERGE_COMMAND.test(String(c.input.command ?? '')));
  // the daemon's verify commands, by kind
  const verify: Phases['verify'] = { source: ledger ? 'daemon' : 'none', totalSeconds: 0, byKind: {} };
  for (const s of signals) {
    if (s.durationMs === null) continue;
    const k = (verify.byKind[s.kind] ??= { count: 0, seconds: 0 });
    k.count++; k.seconds = Math.round((k.seconds + s.durationMs / 1000) * 10) / 10;
    verify.totalSeconds = Math.round((verify.totalSeconds + s.durationMs / 1000) * 10) / 10;
  }
  if (!ledger) notMeasured.push('verify, worktrees, step ups: no daemon ledger (a router-off run, or the ledger could not be read)');
  const retried = workers.filter(w => w.retry);
  if (!agents.some(a => a.worktreePath)) notMeasured.push('worktree creation: no worker ran in a worktree (or it falls inside the worker start delay, which includes it)');
  else notMeasured.push('worktree creation: not timed on its own; it falls inside the worker start delay');
  return {
    wallSeconds: sec(wallMs),
    startupSeconds: init ? sec(init.t) : null,
    leadBeforeFirstWorkerSeconds: init && firstCall !== null ? Math.round((firstCall - sec(init.t)) * 10) / 10 : null,
    delegationSeconds: firstCall !== null && lastEnd !== null ? Math.round((lastEnd - firstCall) * 10) / 10 : null,
    workersActiveSeconds: active,
    leadBetweenWorkersSeconds: firstCall !== null && lastEnd !== null && active !== null ? Math.round((lastEnd - firstCall - active) * 10) / 10 : null,
    leadFinishSeconds: lastEnd !== null && resultAt !== null ? Math.round((resultAt - lastEnd) * 10) / 10 : null,
    leadRanTestsAtEnd: testsAfter.length > 0, leadTestSecondsAtEnd: Math.round(testsAfter.reduce((a, c) => a + durOf(c), 0) * 10) / 10,
    exitSeconds: resultAt !== null ? Math.round((wallMs / 1000 - resultAt) * 10) / 10 : null,
    hooks, workers, verify,
    worktrees: { count: agents.filter(a => a.worktreePath).length, mergeSeconds: Math.round(merges.reduce((a, c) => a + durOf(c), 0) * 10) / 10, mergeCalls: merges.length },
    retries: { workers: retried.length, seconds: Math.round(retried.reduce((a, w) => a + (w.totalSeconds ?? 0), 0) * 10) / 10, stepUps: (ledger?.subtasks ?? []).reduce((a, s) => a + s.upCount, 0), attempts: (ledger?.subtasks ?? []).reduce((a, s) => a + s.attempts, 0) },
    leadToolCalls: leadCalls.size,
    notMeasured,
  };
}

// ------------------------------------------------------------------ the report

export interface PhaseRun { taskId: string; level: string; arrangement: string; wallSeconds: number; passed?: boolean; phases?: Phases }

const f1 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(1));
const sum = (xs: Array<number | null | undefined>) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);

/** The overheads of delegation in one run, in seconds (they can overlap: a hook runs inside a worker's time). */
export function overheads(p: Phases): Record<string, number> {
  return {
    'lead before the first worker': p.leadBeforeFirstWorkerSeconds ?? 0,
    'worker start delays': sum(p.workers.map(w => w.startDelaySeconds)),
    'lead between workers': p.leadBetweenWorkersSeconds ?? 0,
    'daemon verify': p.verify.totalSeconds,
    hooks: p.hooks.totalSeconds,
    'worktree merges': p.worktrees.mergeSeconds,
    'lead wrap-up': p.leadFinishSeconds ?? 0,
    'retries and step ups': p.retries.seconds,
  };
}

/**
 * Markdown: a table of phases per task, totals per level, and, against the router-off runs of the same tasks, the
 * time delegation added and each overhead's share of it.
 */
export function phaseReport(runs: PhaseRun[], direct: PhaseRun[] = []): string {
  const withPhases = runs.filter(r => r.phases);
  const lines: string[] = ['# Where the time of a router-on run goes (decision 174)', ''];
  if (!withPhases.length) return [...lines, 'No run with phase timings yet.'].join('\n');
  lines.push('Seconds. "workers active" is the time at least one worker ran; "start delay" is from the lead\'s Agent call to the worker\'s first tool call (it includes a worktree\'s creation); verify and hooks run inside the other phases.', '');
  lines.push('| task | level | wall | startup | lead before 1st worker | workers active | lead between | lead wrap-up | workers | start delay (sum) | worker tool calls | re-reads | verify | hooks (count) | merges | retries | lead re-ran tests |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of withPhases) {
    const p = r.phases!;
    lines.push(`| ${r.taskId} | ${r.level} | ${f1(p.wallSeconds)} | ${f1(p.startupSeconds)} | ${f1(p.leadBeforeFirstWorkerSeconds)} | ${f1(p.workersActiveSeconds)} | ${f1(p.leadBetweenWorkersSeconds)} | ${f1(p.leadFinishSeconds)} | ${p.workers.length} | ${f1(sum(p.workers.map(w => w.startDelaySeconds)))} | ${sum(p.workers.map(w => w.toolCalls))} | ${sum(p.workers.map(w => w.rereads))} | ${f1(p.verify.totalSeconds)} | ${f1(p.hooks.totalSeconds)} (${p.hooks.count}) | ${f1(p.worktrees.mergeSeconds)} | ${f1(p.retries.seconds)} | ${p.leadRanTestsAtEnd ? `yes (${f1(p.leadTestSecondsAtEnd)})` : 'no'} |`);
  }
  const levels = [...new Set(withPhases.map(r => r.level))].sort();
  lines.push('', '## Totals per level', '', '| level | runs | wall | lead before 1st worker | workers active | lead between | lead wrap-up | start delays | verify | hooks | merges | retries |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const lv of [...levels, 'all']) {
    const rs = withPhases.filter(r => lv === 'all' || r.level === lv).map(r => r.phases!);
    lines.push(`| ${lv} | ${rs.length} | ${f1(sum(rs.map(p => p.wallSeconds)))} | ${f1(sum(rs.map(p => p.leadBeforeFirstWorkerSeconds)))} | ${f1(sum(rs.map(p => p.workersActiveSeconds)))} | ${f1(sum(rs.map(p => p.leadBetweenWorkersSeconds)))} | ${f1(sum(rs.map(p => p.leadFinishSeconds)))} | ${f1(sum(rs.flatMap(p => p.workers.map(w => w.startDelaySeconds))))} | ${f1(sum(rs.map(p => p.verify.totalSeconds)))} | ${f1(sum(rs.map(p => p.hooks.totalSeconds)))} | ${f1(sum(rs.map(p => p.worktrees.mergeSeconds)))} | ${f1(sum(rs.map(p => p.retries.seconds)))} |`);
  }
  // against router off: the added time and each overhead's share of it
  const paired = withPhases.map(r => ({ r, d: direct.find(x => x.taskId === r.taskId) })).filter((x): x is { r: PhaseRun; d: PhaseRun } => !!x.d);
  if (paired.length) {
    lines.push('', '## The time delegation added (router on minus router off, same task)', '');
    lines.push('A share is an overhead\'s seconds over the added seconds. Overheads overlap (a hook runs inside a worker), and some of the added time is the work itself moved into workers, so the shares need not add up to 100%.', '');
    const names = Object.keys(overheads(paired[0]!.r.phases!));
    lines.push(`| level | runs | router off | router on | added | ${names.join(' | ')} |`, `|---|---|---|---|---|${names.map(() => '---|').join('')}`);
    for (const lv of [...new Set(paired.map(x => x.r.level))].sort().concat(['all'])) {
      const ps = paired.filter(x => lv === 'all' || x.r.level === lv);
      const off = sum(ps.map(x => x.d.wallSeconds)), on = sum(ps.map(x => x.r.phases!.wallSeconds));
      const added = on - off;
      const ov = names.map(n => sum(ps.map(x => overheads(x.r.phases!)[n])));
      lines.push(`| ${lv} | ${ps.length} | ${f1(off)} | ${f1(on)} | ${f1(added)} | ${ov.map(v => `${f1(v)}${added > 0 ? ` (${Math.round((v / added) * 100)}%)` : ''}`).join(' | ')} |`);
    }
  }
  const nm = [...new Set(withPhases.flatMap(r => r.phases!.notMeasured))];
  if (nm.length) lines.push('', '## Not measured', '', ...nm.map(n => `- ${n}`));
  return lines.join('\n');
}
