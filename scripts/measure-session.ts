// Decision 221: a long session. The requests of a scenario (bench/tasks/sessions/<id>/scenario.json) are put to
// ONE session, one after the other, each building on the one before, with the router on (auto) and off (direct).
// It measures what the single-request runs of scripts/measure107.ts cannot: the session's total cost and time,
// how many of the steps pass, and how the lead's context grows from request to request.
//
//   node scripts/measure-session.ts --api-key-helper "<keychain cmd>" [--scenario taskboard-01] [--arrangements auto,direct]
//        [--reps 3] [--lead sonnet] [--effort high] [--profile save|balanced|quality] [--reproduce-first on|observe|off]
//        [--budget 30] [--cap-scale 1] [--out dir] [--work dir] [--only-plan] [--setup-only]
//        [--direct-no-agent-tool] [--no-router-mcp] [--daemon-port <n>]
//   node scripts/measure-session.ts --recompute --out dir
//
// - One step is one `claude -p` process: the first starts the session (--session-id <uuid>), every later one
//   resumes it (--resume <uuid>). The router's daemon stays up for the whole session, and the session's requests
//   add up in its ledger, one per step. A step whose process ran in another session id stops the measurement.
// - The arrangements, the tools, what may run without a prompt, the router's MCP server and the lead's model in
//   the environment are those of measure107 (bench/src/kpi/run-args.ts; decisions 213, 218, 222).
// - Grading: after each step the working tree is copied, and the copy is graded with the hidden tests of that
//   step and of every step before it. The session's own repository never holds a hidden test (the next step's
//   model could read it), and the harness changes nothing in it: no commit, no reset.
// - A failed step does not stop the session: the next request goes to whatever state there is, as with a user
//   who did not notice. Each step says whether it is the first failure or comes after one, and whether an
//   earlier step's tests broke (a regression).
// - Cost: a resumed process reports the session's running total (total_cost_usd and modelUsage go on from what
//   the transcript saved), so a step's cost is its total minus the total of the step before, and its per-model
//   tokens likewise; the session's cost is the last total. The budget and the ledger count the step's own cost.
//   --max-budget-usd counts only what the process itself spent, so a step's cap is the step's. Beside it each
//   step keeps the total as reported, what the process counted itself (model_usage_since_last_result over its
//   result lines) and the input side of its own stream at list price (bench/src/kpi/session.ts, stepCost).
// - The lead's context: per step, the tokens its first, last and largest call read, what the first call took
//   from the cache, and compactions.
// --daemon-port sets the port of each session's daemon. Left out, init picks the first free port from 47800 on
// when the session is set up; two measurements set up at the same moment then pick the same one, and the second
// daemon does not start. Sessions of one invocation come one after the other and can share a port.
// --only-plan prints the plan and exits; --setup-only prepares the workspace and starts the daemon, no API call.
// --arrangements direct (or auto) runs only those sessions; with the --out of an earlier measurement they are
// added to its sessions.jsonl, and sessions already there are skipped. A session that was stopped is run again
// from its first step; what its steps cost stays in the ledger.
// --recompute rewrites an --out folder written while a step's reported total was counted as the step's cost
// (bench/src/kpi/session-recompute.ts) and exits: no session is run.
// Auth: an isolated CLAUDE_CONFIG_DIR per session and apiKeyHelper via --settings (the key never passes through
// this script).
// Output: <out>/{sessions.jsonl,ledger.jsonl,streams/}. A session is keyed by scenario, arrangement and rep.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { prepare } from '../bench/src/workspace.ts';
import { childEnv, CREDENTIAL_DENY } from '../bench/src/secrets.ts';
import type { Task } from '../bench/src/types.ts';
import { claudeBin, runCaptured } from '../bench/src/kpi/capture.ts';
import { analysePhases } from '../bench/src/kpi/phases.ts';
import { mcpSeen, routerMcpReady } from '../bench/src/kpi/router-mcp.ts';
import { ALLOWED_SINCE_222, claudeArgs } from '../bench/src/kpi/run-args.ts';
import { recompute } from '../bench/src/kpi/session-recompute.ts';
import { gradeStep, leadContext, leadTurns, loadScenario, reported, sessionCost, sessionIdSeen, snapshot, snapshotDiff, stepCost, stepStatus, streamFileOf, type Reported, type StepCost } from '../bench/src/kpi/session.ts';
import { DEFAULT_PROFILE, PROFILES, profileOf } from '../packages/core/src/profiles.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : d; };
const flag = (k: string) => argv.includes(`--${k}`);
const fail = (msg: string): never => { console.error(msg); process.exit(2); };

const OUT = path.resolve(arg('out', path.join(ROOT, 'bench', 'results', 'measure-session'))!);
if (flag('recompute')) {
  if (!fs.existsSync(path.join(OUT, 'sessions.jsonl')) && !fs.existsSync(path.join(OUT, 'ledger.jsonl'))) fail(`--recompute: no sessions.jsonl or ledger.jsonl in ${OUT} (pass --out)`);
  const r = recompute(OUT);
  for (const n of r.notes) console.log(`  ${n}`);
  console.log(`recomputed ${r.sessions} session record(s) (${r.sessionsLeft} already had step costs) and ${r.ledgerEntries} ledger entries in ${OUT}: the ledger adds up to $${r.ledgerAfterUsd.toFixed(3)}, before $${r.ledgerBeforeUsd.toFixed(3)}`);
  if (r.sessions || r.ledgerEntries) console.log('  the files as they were: sessions.jsonl.before-recompute, ledger.jsonl.before-recompute');
  process.exit(0);
}
// short path: Windows MAX_PATH with worktrees
const WORK = path.resolve(arg('work', path.join(path.parse(ROOT).root, 'ar-sess'))!);
const SCENARIO = loadScenario(arg('scenario', 'taskboard-01')!) ?? fail(`unknown scenario: ${arg('scenario')} (bench/tasks/sessions/<id>/scenario.json)`);
type Arrangement = 'direct' | 'auto';
const KNOWN: Arrangement[] = ['auto', 'direct'];
const arrangements = (arg('arrangements') ?? 'auto,direct').split(',').filter(Boolean) as Arrangement[];
const unknownArr = arrangements.filter(a => !KNOWN.includes(a));
if (unknownArr.length) fail(`unknown arrangements: ${unknownArr.join(', ')} (known: ${KNOWN.join(', ')})`);
const REPS = Number(arg('reps', '3'));
if (!(Number.isInteger(REPS) && REPS >= 1 && REPS <= 20)) fail(`--reps must be a whole number from 1 to 20, not ${arg('reps')}`);
const LEAD = arg('lead', 'sonnet')!;
const EFFORT = arg('effort', 'high')!;
const BUDGET = Number(arg('budget', '30'));
const HELPER = arg('api-key-helper');
const CAP_SCALE = Number(arg('cap-scale', '1'));
const CAP: Record<string, number> = Object.fromEntries(Object.entries({ L0: 1, L1: 2, L2: 5, L3: 10 }).map(([k, v]) => [k, v * CAP_SCALE]));
const DIRECT_AGENT_TOOL = !flag('direct-no-agent-tool');
const ROUTER_MCP = !flag('no-router-mcp');
const REPRO = arg('reproduce-first');
if (REPRO !== undefined && !['on', 'observe', 'off'].includes(REPRO)) fail(`--reproduce-first must be on, observe or off, not ${REPRO}`);
const DAEMON_PORT = arg('daemon-port') === undefined ? undefined : Number(arg('daemon-port'));
if (flag('daemon-port') && !(Number.isInteger(DAEMON_PORT) && DAEMON_PORT! >= 1024 && DAEMON_PORT! <= 65535)) fail('--daemon-port must be a port number from 1024 to 65535');
const PROFILE = arg('profile');
if (flag('profile') && PROFILE === undefined) fail(`--profile needs a value: ${PROFILES.join(', ')}`);
if (PROFILE !== undefined && !(PROFILES as readonly string[]).includes(PROFILE)) fail(`--profile must be one of ${PROFILES.join(', ')}, not ${PROFILE}`);

fs.mkdirSync(OUT, { recursive: true });
const ledgerFile = path.join(OUT, 'ledger.jsonl');
const sessionsFile = path.join(OUT, 'sessions.jsonl');
const jsonl = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) : []);
const spent = () => jsonl(ledgerFile).reduce((a, l) => a + Number(l.costUsd || 0), 0);
const doneKeys = new Set(jsonl(sessionsFile).map(j => `${j.scenario}|${j.arrangement}|${j.rep}`));

// Run order: every arrangement of rep 1, then of rep 2, ...: a budget stop leaves whole pairs.
const order: Array<[Arrangement, number]> = [];
for (let rep = 1; rep <= REPS; rep++) for (const a of arrangements) order.push([a, rep]);
const sessionCap = SCENARIO.steps.reduce((s, st) => s + CAP[st.level]!, 0);

console.log(`plan: scenario ${SCENARIO.id} (${SCENARIO.steps.length} steps in one session), ${order.length} sessions, lead ${LEAD}/${EFFORT}, budget $${BUDGET} (spent so far $${spent().toFixed(2)}), out ${OUT}`);
if (arrangements.includes('direct')) console.log(`  direct sessions ${DIRECT_AGENT_TOOL ? 'with' : 'without'} the Agent tool`);
if (arrangements.includes('auto')) console.log(`  router sessions ${ROUTER_MCP ? 'with' : 'without'} the router's MCP server, profile ${PROFILE ?? `${DEFAULT_PROFILE} (the router's default)`}`);
console.log(`  every step may also use ${ALLOWED_SINCE_222.join(', ')} without a prompt (decision 222)`);
for (const s of SCENARIO.steps) console.log(`  step ${s.id} ${s.level} ${s.kind.padEnd(9)} cap $${CAP[s.level]}  ${s.title}`);
for (const [a, rep] of order) console.log(`  session ${a.padEnd(6)} rep ${rep}  caps add up to $${sessionCap}${doneKeys.has(`${SCENARIO.id}|${a}|${rep}`) ? '  (done)' : ''}`);
if (flag('only-plan')) process.exit(0);
if (!HELPER && !flag('setup-only')) fail('pass --api-key-helper "<command>" (keychain helper)');

// AGENTIC_ROUTER_HOME (the previous release) is left out: with it, init would move that folder into the temp home
const { AGENTIC_ROUTER_HOME: _previousHome, ...inherited } = process.env;
// The router's CLI never runs against the user's Claude Code settings: its CLAUDE_CONFIG_DIR is a folder of this
// session's workspace, beside the router home, and init gets --no-plugin (the steps load the plugin with
// --plugin-dir). Either one alone keeps `claude plugin marketplace add` away from the user's settings.
const cliEnv = (home: string) => ({ ...inherited, DO_IT_ALL_CLAUDE_CODE_HOME: home, CLAUDE_CONFIG_DIR: path.join(path.dirname(home), 'claude-init') });
const cli = (home: string, ...a: string[]) => execFileSync(process.execPath, [path.join(ROOT, 'packages/cli/src/index.ts'), ...a],
  { env: cliEnv(home), encoding: 'utf8' });
const settings = () => JSON.stringify({ apiKeyHelper: HELPER, permissions: { deny: CREDENTIAL_DENY } });

interface RouterStep { requests: Array<{ level: string; outcome: string | null; leadClass: string | null; leadModel: string | null; source: string | null; replannedFrom: string | null; leadEdits: number }>; costLeadUsd: number; costWorkersUsd: number }

/** What the daemon recorded for the requests opened from `from` up to `to` (one step's window). */
function routerStep(home: string, from: string, to: string): RouterStep | null {
  const dbFile = path.join(home, 'router.db');
  if (!fs.existsSync(dbFile)) return null;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const q = (sql: string, ...p: string[]) => { try { return db.prepare(sql).all(...p) as Array<Record<string, unknown>>; } catch { return []; } };
  const reqs = q('SELECT * FROM requests WHERE created_at >= ? AND created_at < ? ORDER BY created_at, rowid', from, to);
  const costs = reqs.flatMap(r => q('SELECT source, usd FROM costs WHERE request_id = ?', String(r.id)));
  db.close();
  const sum = (rows: Array<Record<string, unknown>>) => Math.round(rows.reduce((a, r) => a + (Number(r.usd) || 0), 0) * 1e6) / 1e6;
  return {
    requests: reqs.map(r => ({
      level: String(r.level), outcome: (r.outcome as string | null) ?? null, leadClass: (r.lead_class as string | null) ?? null, leadModel: (r.lead_model as string | null) ?? null,
      source: (() => { try { return (JSON.parse(String(r.triage)) as { source?: string }).source ?? null; } catch { return null; } })(),
      replannedFrom: (r.replanned_from as string | null) ?? null, leadEdits: Number(r.lead_edits ?? 0),
    })),
    costLeadUsd: sum(costs.filter(c => c.source === 'lead')),
    costWorkersUsd: sum(costs.filter(c => c.source !== 'lead' && c.source !== 'agent_result')),
  };
}

for (const [a, rep] of order) {
  const key = `${SCENARIO.id}|${a}|${rep}`;
  if (doneKeys.has(key)) continue;
  if (BUDGET - spent() < CAP[SCENARIO.steps[0]!.level]! / 2) { console.log(`budget stop before ${key}: $${(BUDGET - spent()).toFixed(2)} left`); break; }
  const root = path.join(WORK, `${SCENARIO.id}-${a}-r${rep}`.replace(/[^A-Za-z0-9_.-]/g, '_'));
  const ws = await prepare({ id: SCENARIO.id, level: 'L2', source: 'custom', title: SCENARIO.title, fixture: SCENARIO.fixture, prompt: '', limits: { maxTurns: 0, timeoutSec: 0 } } as Task, root);
  // Harness files stay out of the session's view of the diff: router project settings and worktrees.
  fs.appendFileSync(path.join(ws.repo, '.git', 'info', 'exclude'), '\n.claude/\n.bench-hidden/\n');
  const gradeRoot = path.join(root, 'grade');
  snapshot(ws.repo, path.join(gradeRoot, 'step-00'));
  let home: string | undefined;
  let ranProfile: string | undefined;
  if (a !== 'direct') {
    home = path.join(root, 'router-home');
    cli(home, 'init', '--yes', '--no-plugin', '--claude-settings', path.join(root, 'cs.json'), '--project', root);
    const cfgFile = path.join(home, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    cfg.holdoutRate = 0;   // as a user runs it, only no holdout: every request is routed by its own triage
    if (REPRO) cfg.reproduceFirst = REPRO;
    if (PROFILE) cfg.profile = PROFILE;
    if (DAEMON_PORT) cfg.daemonPort = DAEMON_PORT;
    ranProfile = profileOf(cfg);
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
    fs.mkdirSync(path.join(ws.repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ws.repo, '.claude', 'settings.local.json'), JSON.stringify({ worktree: { baseRef: 'head' } }, null, 2));
    console.log(cli(home, 'start').trim());
    if (ROUTER_MCP) {
      const pre = await routerMcpReady(path.join(ROOT, 'plugin', 'mcp', 'server.mjs'), cliEnv(home));
      const ok = pre.ok;
      console.log(`router MCP server: ${pre.tools.length} tools${ok ? ', the daemon answered' : ` — NOT READY after ${pre.attempts} tries (${pre.reply})`}`);
      if (!ok) { cli(home, 'stop'); console.error(`stopped before ${key}: the router's MCP server is not ready; fix it, or pass --no-router-mcp`); process.exit(3); }
    }
  }
  const stopDaemon = () => { if (home) { try { cli(home, 'stop'); } catch { /* already down */ } } };
  if (flag('setup-only')) { console.log(`setup-only ${key} in ${ws.repo}`); stopDaemon(); continue; }

  const sessionId = randomUUID();
  const steps: Array<Record<string, unknown>> = [];
  const passed: boolean[] = [];
  // what the last step with a total reported: a resumed step's total goes on from it
  let before: Reported | null = null;
  let stopped: string | undefined;
  let mcpLast: { seen: boolean; servers: string[]; routerTools: number } | undefined;
  console.log(`session ${key} (${sessionId})`);
  for (const [i, step] of SCENARIO.steps.entries()) {
    const remaining = BUDGET - spent();
    const cap = Math.min(CAP[step.level]!, remaining);
    if (cap < CAP[step.level]! / 2) { stopped = `budget stop before step ${step.id}: $${remaining.toFixed(2)} left`; break; }
    const stepKey = `${key}|${step.id}`;
    const streamFile = streamFileOf(OUT, stepKey);
    const args = claudeArgs({ lead: LEAD, effort: EFFORT, capUsd: cap, settings: settings(), ...(a !== 'direct' ? { pluginDir: path.join(ROOT, 'plugin') } : {}),
      agentTool: a !== 'direct' || DIRECT_AGENT_TOOL, strictMcp: a === 'direct' || !ROUTER_MCP, session: { id: sessionId, resume: i > 0 } });
    // decision 218: the lead's model for the router's hooks, as in measure107
    const env = { ...childEnv(ws.configDir, { kind: 'api-key-helper' } as never), ANTHROPIC_MODEL: LEAD, ...(home ? { DO_IT_ALL_CLAUDE_CODE_HOME: home } : {}) };
    const bin = claudeBin();
    console.log(`  step ${step.id} ${step.level} ${step.kind} (cap $${cap.toFixed(2)})`);
    const r = await runCaptured(bin.cmd, [...bin.prefix, ...args], { cwd: ws.repo, env, input: step.prompt, timeoutSec: step.limits.timeoutSec, streamFile });
    const endedAt = new Date().toISOString();
    const now = reported(r.lines, r.result);
    const cost: StepCost = stepCost(r.lines, now, before);
    if (cost.costBasis !== 'none') before = now;
    fs.appendFileSync(ledgerFile, JSON.stringify({ key: stepKey, costUsd: cost.costUsd, costBasis: cost.costBasis, reportedTotalUsd: cost.reportedTotalUsd, sessionId, at: endedAt }) + '\n');
    // the arrangement asked for, in the session asked for: otherwise this is not the measurement (cost in the ledger, no record)
    const mcp = mcpSeen(r.lines, a !== 'direct' && ROUTER_MCP);
    const sawSession = sessionIdSeen(r.lines);
    const problem = mcp.problem ?? (sawSession !== null && sawSession !== sessionId ? `the step ran in session ${sawSession}, not in ${sessionId}: it did not ${i > 0 ? 'resume' : 'start'} the session` : undefined);
    if (problem) { stopDaemon(); console.error(`stopped after ${stepKey} ($${cost.costUsd.toFixed(3)} spent on it): ${problem}`); process.exit(3); }
    mcpLast = { seen: mcp.seen, servers: mcp.servers.map(s => `${s.name} (${s.status})`), routerTools: mcp.routerTools };
    // grade a copy; the session's repository is left as the step left it
    const snap = path.join(gradeRoot, `step-${step.id}`);
    snapshot(ws.repo, snap);
    const diff = await snapshotDiff(path.join(gradeRoot, `step-${i === 0 ? '00' : SCENARIO.steps[i - 1]!.id}`), snap);
    const graded = await gradeStep(SCENARIO, i, snap);
    passed.push(graded.pass);
    const context = leadContext(r.lines);
    const router = home ? routerStep(home, r.startedAt, endedAt) : null;
    const out = r.result as { is_error?: boolean; subtype?: string; result?: string } | null;
    steps.push({
      id: step.id, kind: step.kind, level: step.level, resumed: i > 0,
      passed: graded.pass, status: stepStatus(passed, i), ownPassed: graded.own.ok, regressions: graded.regressions, fixtureFail: graded.fixtureFail, grade: graded.detail,
      ...cost, wallSeconds: Math.round(r.ms / 1000), leadTurns: leadTurns(r.lines), context, ...diff,
      ...(router ? { router } : {}),
      timedOut: r.timedOut, error: out?.is_error ? String(out.subtype ?? out.result ?? '').slice(0, 300) : (out ? undefined : r.stderr.slice(-300)),
      phases: analysePhases(r.lines, r.ms, null),
    });
    const routed = router ? ` ${router.requests.map(q => `${q.level} ${q.outcome ?? 'open'}`).join(' + ') || 'no request'} (lead ${router.requests[0]?.leadClass ?? '?'})` : '';
    const how = cost.costBasis === 'difference' ? `of the session's $${cost.reportedTotalUsd.toFixed(3)} so far` : cost.costBasis === 'own-total' ? 'its total did not go on from the step before' : cost.costBasis === 'none' ? 'no total reported' : 'the first total';
    const check = cost.sinceLastResultUsd !== null && Math.abs(cost.sinceLastResultUsd - cost.costUsd) > 0.001 ? `; the process itself counted $${cost.sinceLastResultUsd.toFixed(3)}` : '';
    console.log(`    -> ${graded.pass ? 'PASS' : 'FAIL'} ${graded.detail} $${cost.costUsd.toFixed(3)} (${how}${check}; stream input $${cost.streamInputUsd.toFixed(3)}) ${Math.round(r.ms / 1000)}s${routed}`);
    console.log(`       lead context: ${context.calls} calls, first ${context.firstTokens ?? '-'} (cache read ${context.firstCacheReadTokens ?? '-'}), last ${context.lastTokens ?? '-'}, max ${context.maxTokens ?? '-'} tokens${context.compactions ? `, ${context.compactions} compaction(s)` : ''}; spent $${spent().toFixed(2)} / $${BUDGET}`);
    if (!r.result && !r.lines.length) { stopped = `step ${step.id}: claude printed nothing (${r.stderr.slice(-200).trim() || `exit ${r.code}`})`; break; }
  }
  stopDaemon();
  if (stopped) { console.log(`session ${key} not recorded: ${stopped}`); if (/budget stop/.test(stopped)) break; continue; }
  const firstFailed = passed.indexOf(false);
  const ctx = steps.map(s => s.context as ReturnType<typeof leadContext>);
  const rec = {
    scenario: SCENARIO.id, arrangement: a, rep, leadModel: LEAD, leadEffort: EFFORT, sessionId, allowedSince222: true,
    ...(a === 'direct' ? { agentTool: DIRECT_AGENT_TOOL } : { routerMcp: ROUTER_MCP, profile: ranProfile }),
    mcp: mcpLast,
    steps,
    totals: {
      // the steps' own costs added up: the last reported total, unless a step's total started again (costReading 'mixed')
      ...sessionCost(steps as unknown as StepCost[]),
      streamInputUsd: Math.round(steps.reduce((s, x) => s + Number(x.streamInputUsd), 0) * 1e6) / 1e6,
      wallSeconds: steps.reduce((s, x) => s + Number(x.wallSeconds), 0),
      stepsPassed: passed.filter(Boolean).length, steps: steps.length,
      firstFailedStep: firstFailed < 0 ? null : SCENARIO.steps[firstFailed]!.id,
      failedAfterFailure: steps.filter(s => s.status === 'failed_after_failure').map(s => s.id),
      finalAllPass: passed.at(-1) === true,
      leadContextFirstStep: ctx[0]?.lastTokens ?? null, leadContextLastStep: ctx.at(-1)?.lastTokens ?? null,
      leadContextMax: Math.max(0, ...ctx.map(c => c.maxTokens ?? 0)) || null,
      leadCacheReadTokens: ctx.reduce((s, c) => s + c.cacheReadTokens, 0),
      compactions: ctx.reduce((s, c) => s + c.compactions, 0),
    },
  };
  fs.appendFileSync(sessionsFile, JSON.stringify(rec) + '\n');
  const t = rec.totals;
  console.log(`  session ${key}: ${t.stepsPassed}/${t.steps} steps pass${t.firstFailedStep ? ` (first failure: step ${t.firstFailedStep})` : ''}, final state ${t.finalAllPass ? 'passes' : 'fails'}, ${t.wallSeconds}s`);
  console.log(`    cost: $${t.costUsd.toFixed(3)}${t.costReading === 'mixed' ? ` (a step's total did not go on from the step before; the last reported total is $${t.lastReportedTotalUsd.toFixed(3)})` : ''}${t.sinceLastResultUsd === null ? '' : `, the processes themselves counted $${t.sinceLastResultUsd.toFixed(3)}`}`);
  console.log(`    lead context after step 1: ${t.leadContextFirstStep ?? '-'} tokens, after the last step: ${t.leadContextLastStep ?? '-'}, largest call: ${t.leadContextMax ?? '-'}`);
}
console.log(`done. spent $${spent().toFixed(2)} of $${BUDGET}. sessions: ${sessionsFile}`);
