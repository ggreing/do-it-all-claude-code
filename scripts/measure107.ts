// Decision 107: direct vs L2 team vs L3 team on the same tasks, lead Opus 5.5, API key, own $50 budget.
// Output: bench/results/measure107/{runs.jsonl,tasks.jsonl,ledger.jsonl}
// in the format the triage scorer reads (packages/core/src/triage-eval-cli.ts regret runs.jsonl --tasks tasks.jsonl).
//
//   node scripts/measure107.ts --api-key-helper "<keychain cmd>" [--tasks id,id] [--arrangements direct,team-L2,team-L3,auto]
//        [--lead opus] [--effort high] [--budget 50] [--cap-scale 1] [--out dir] [--work dir] [--dry-run] [--setup-only] [--only-plan]
//        [--reproduce-first on|observe|off] [--profile save|balanced|quality] [--direct-no-agent-tool] [--no-router-mcp]
//        [--daemon-port <n>]
//   node scripts/measure107.ts --subscription --out <a folder of its own> [--max-percent 80] [--no-meter] [--no-transcripts] [the options above]
//
// - direct   : plain Claude Code, no plugin (the lead does the work alone) = router OFF. It has the Agent tool, as
//              a user's session has (decision 213): the tool's definition is in every call of a session with or
//              without the router, so leaving it out made the router look about 5 points more expensive on small
//              requests. --direct-no-agent-tool runs it without the tool, as the measurements before decision 213
//              did; each direct record says which (`agentTool`).
// - team-L2/3: plugin + daemon with config.forceLevel = L2 / L3 (decision 107 harness switch)
// - auto     : plugin + daemon as a user runs it (Phase-3 KPI): automatic triage, the lead's own choice of roles,
//              the default budgets and step rules, no forced level; holdoutRate 0 so no request is held out.
// The router arrangements (team-L2/3, auto) load the plugin's MCP server, as a user's session does (decision 213):
// its tool definitions are part of what the router adds to every call, and the brief of a request of unclear
// size asks the lead to call router_report_triage. No other MCP server is loaded: the run has a config directory
// of its own, and a run whose session lists another server, or not the router's, stops the measurement.
// --no-router-mcp runs them with --strict-mcp-config and no server, as the measurements before decision 213 did;
// each router record says which (`routerMcp`) and what the session listed (`mcp`). Before a router run starts,
// the server is started once on its own and asked for its tools and one call to the daemon (no model call).
// --reproduce-first sets the router's reproduceFirst in every router arrangement (the quality baseline, decisions
// 175 and 177); left out, the router's default.
// --profile sets the router's profile (save, balanced or quality) in every router arrangement; left out, the
// router's default. A direct run has no router, so the flag does not touch it. Each router record says which
// profile ran (`profile`). A run is keyed by task and arrangement only: give a second profile its own --out.
// Decision 222: every run, router on or off, may use `echo`, `pwd` and `wc` in Bash without a prompt. Workers ask
// for them, a -p run refused them (a refused call costs a turn), and a user at the terminal allows such commands.
// The measurements before decision 222 ran without the three; each record says so (`allowedSince222`).
// The lead's model reaches the router through ANTHROPIC_MODEL, set to the value of --model (decision 218): a -p
// run has no other way to name it on the first prompt, and without it the router plans for an unknown lead.
// --daemon-port sets the port of each run's daemon. Left out, init picks the first free port from 47800 on when
// the run is set up; two measurements set up at the same moment then pick the same one, and the second daemon
// does not start. Runs of one invocation come one after the other and can share a port.
// --dry-run prints the plan and a cost and time estimate from the earlier measurements of the same lead
// (bench/results/measure107-sonnet for Sonnet, decision 123; measure107 for Opus, decision 107) and exits:
// no workspace, no daemon, no API call. --setup-only prepares the workspaces and starts the daemons, no API call.
// Auth: isolated CLAUDE_CONFIG_DIR + apiKeyHelper via --settings (the key never passes through this script).
// No --bare in team runs: hooks must run. Transcripts are kept (the daemon reads them for costs).
// --subscription (decision 226) runs on the login of this machine's Claude Code instead of a key, isolated as
// bench/src/subscription/isolation.ts has it: the run gets an allow-listed environment (no credential variable
// reaches it), no config folder of ours (Claude Code reads its own login; this script reads no credential), and
// the user's settings are not loaded. Every run's init message must show apiKeySource "none"; a run that shows a
// key, or another plugin, leaves no record and stops the measurement, and so does a run that hit a limit. A run
// that drew on paid extra usage is recorded and stops it. Before each run `/usage` is read (no model request):
// no run starts with a meter at --max-percent or more (--no-meter leaves the readings out; then a limit warning
// in a run stops the measurement after it). Costs are then the API-priced estimate Claude Code reports
// (total_cost_usd); the budget, the per-run caps and --max-budget-usd count in it as they do with a key. Each
// record and ledger entry says `subscription: true`, and a record carries what `/usage` moved by around the run
// (`meters`: other use of the login in that time is in it too). Subscription runs need an --out of their own.
// Every run works in one workspace folder (<work>/sub-ws), so Claude Code keeps one project entry for them; a
// run's changes are kept in <out>/patches/. A router run keeps its transcript, which the daemon reads for costs
// and for what a worker touched: it lands in Claude Code's own projects folder, under that workspace's name.
// The measurement's last line names that folder (the path Claude Code gave the router when a worker ran, else
// the name by Claude Code's naming rule); removing it is left to the user.
// --no-transcripts runs the router arrangements without one too (the router then works from estimates), and a
// direct run never writes one. A router run that was to keep its transcript and left none stops the measurement
// and gets no record: the router could not read the request or the lead's cost in it.
// Decision 174: each run's record carries `phases` (bench/src/kpi/phases.ts), from its stream-json, stamped on
// arrival and kept in <out>/streams/, and the daemon ledger; `node scripts/kpi-phases.ts` reports them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { prepare } from '../bench/src/workspace.ts';
import { loadTasks } from '../bench/src/tasks.ts';
import { gradeNodeTest } from '../bench/src/graders/node-test.ts';
import { gradeSwebench, workspacePatch } from '../bench/src/graders/swebench.ts';
import { childEnv, CREDENTIAL_DENY } from '../bench/src/secrets.ts';
import { loadPublicManifest } from '../bench/src/tasks.ts';
import type { Task } from '../bench/src/types.ts';
import { claudeBin, runCaptured } from '../bench/src/kpi/capture.ts';
import { ALLOWED_SINCE_222, claudeArgs } from '../bench/src/kpi/run-args.ts';
import { analysePhases, type LedgerTiming, type StreamLine } from '../bench/src/kpi/phases.ts';
import { mcpSeen, routerMcpReady } from '../bench/src/kpi/router-mcp.ts';
import { leadTurns } from '../bench/src/kpi/session.ts';
import { loginSeen, meterLine, meterMoved, meterStop, readMeter, subscriptionRunEnv, subscriptionRunSettings, transcriptUnread, transcriptsLine } from '../bench/src/kpi/subscription.ts';
import type { Reading } from '../bench/src/subscription/meter.ts';
import { loadSubConfig } from '../bench/src/subscription/plan.ts';
import { redact } from '../bench/src/secrets.ts';
import { DEFAULT_PROFILE, PROFILES, profileOf } from '../packages/core/src/profiles.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : d; };
// --out for smoke tests, so their spend does not enter the decision-107 ledger
const OUT = path.resolve(arg('out', path.join(ROOT, 'bench', 'results', 'measure107'))!);
// short path: Windows MAX_PATH with worktrees (--work moves it, for smoke tests)
const WORK = path.resolve(arg('work', path.join(path.parse(ROOT).root, 'ar-m107'))!);
const flag = (k: string) => argv.includes(`--${k}`);

const DEFAULT_TASKS = [
  'c-l1-01', 'c-l1-02', 'c-l1-03', 'c-l1-04', 'c-l1-05',
  'c-l2-01', 'c-l2-02', 'c-l2-03', 'p-l2-astropy__astropy-7671', 'p-l2-pydata__xarray-4966',
  // L3: 3 public (widest by gold-patch file count) + 2 custom broad tasks (decision 114)
  'c-l3-01', 'c-l3-02', 'p-l3-sympy__sympy-16597', 'p-l3-django__django-16263', 'p-l3-pylint-dev__pylint-4551',
];
const taskIds = (arg('tasks') ?? [...DEFAULT_TASKS, ...(arg('public-l3') ?? '').split(',').filter(Boolean)].join(',')).split(',').filter(Boolean);
const arrangements = (arg('arrangements') ?? 'direct,team-L2,team-L3').split(',') as Arrangement[];
const LEAD = arg('lead', 'opus')!;
const EFFORT = arg('effort', 'high')!;
const BUDGET = Number(arg('budget', '50'));
const HELPER = arg('api-key-helper');
// decision 226: the login of this machine's Claude Code instead of a key
const SUB = flag('subscription');
if (SUB && HELPER) { console.error('--subscription and --api-key-helper are two ways to pay for a run: pass one of them'); process.exit(2); }
const METER = SUB && !flag('no-meter');
const TRANSCRIPTS = !flag('no-transcripts');
const MAX_PERCENT = Number(arg('max-percent', String(loadSubConfig().maxPercent)));
if (!(MAX_PERCENT >= 1 && MAX_PERCENT <= 95)) { console.error('--max-percent must be a number from 1 to 95'); process.exit(2); }
// --cap-scale shrinks the per-run caps (and so the budget-stop threshold) for a cheaper lead model
const CAP_SCALE = Number(arg('cap-scale', '1'));
// decision 213: router off has the Agent tool unless the flag asks for the earlier arrangement
const DIRECT_AGENT_TOOL = !flag('direct-no-agent-tool');
// decision 213: a router run has the plugin's MCP server unless the flag asks for the earlier arrangement
const ROUTER_MCP = !flag('no-router-mcp');
const REPRO = arg('reproduce-first');
if (REPRO !== undefined && !['on', 'observe', 'off'].includes(REPRO)) { console.error(`--reproduce-first must be on, observe or off, not ${REPRO}`); process.exit(2); }
const DAEMON_PORT = arg('daemon-port') === undefined ? undefined : Number(arg('daemon-port'));
if (flag('daemon-port') && !(Number.isInteger(DAEMON_PORT) && DAEMON_PORT! >= 1024 && DAEMON_PORT! <= 65535)) { console.error('--daemon-port must be a port number from 1024 to 65535'); process.exit(2); }
const PROFILE = arg('profile');
if (flag('profile') && PROFILE === undefined) { console.error(`--profile needs a value: ${PROFILES.join(', ')}`); process.exit(2); }
if (PROFILE !== undefined && !(PROFILES as readonly string[]).includes(PROFILE)) { console.error(`--profile must be one of ${PROFILES.join(', ')}, not ${PROFILE}`); process.exit(2); }
const CAP: Record<string, number> = Object.fromEntries(Object.entries({ L1: 2, L2: 5, L3: 10 }).map(([k, v]) => [k, v * CAP_SCALE]));
type Arrangement = 'direct' | 'team-L2' | 'team-L3' | 'auto';
const KNOWN: Arrangement[] = ['direct', 'team-L2', 'team-L3', 'auto'];
const unknownArr = arrangements.filter(a => !KNOWN.includes(a));
if (unknownArr.length) { console.error(`unknown arrangements: ${unknownArr.join(', ')} (known: ${KNOWN.join(', ')})`); process.exit(2); }

fs.mkdirSync(OUT, { recursive: true });
const ledgerFile = path.join(OUT, 'ledger.jsonl');
const runsFile = path.join(OUT, 'runs.jsonl');
const spent = () => fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).reduce((a, l) => a + Number(JSON.parse(l).costUsd || 0), 0) : 0;
const earlier = fs.existsSync(runsFile) ? fs.readFileSync(runsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { taskId: string; arrangement: string; budgetStop?: boolean; subscription?: boolean; transcript?: boolean }) : [];
const doneKeys = new Set(earlier.map(j => `${j.taskId}|${j.arrangement}`));
// a folder holds runs paid for one way: its ledger and budget are in one kind of dollar
if (earlier.some(j => !j.budgetStop && (j.subscription === true) !== SUB)) {
  console.error(SUB ? `${OUT} holds runs made with an API key: give the subscription runs an --out of their own` : `${OUT} holds runs made on the subscription login: give the API-key runs an --out of their own`);
  process.exit(2);
}

const tasks = loadTasks({ ids: taskIds });
const missing = taskIds.filter(id => !tasks.some(t => t.id === id));
if (missing.length) { console.error(`unknown tasks: ${missing.join(', ')}`); process.exit(2); }

// Run order: direct and team-L2 for every task first, then team-L3 for L3, L2, L1 tasks,
// so a budget stop drops the least informative cells.
const order: Array<[Task, Arrangement]> = [];
for (const t of tasks) for (const a of arrangements.filter(a => a !== 'team-L3')) order.push([t, a]);
if (arrangements.includes('team-L3')) for (const lv of ['L3', 'L2', 'L1']) for (const t of tasks.filter(t => t.level === lv)) order.push([t, 'team-L3']);

console.log(`plan: ${order.length} runs, lead ${LEAD}/${EFFORT}, budget $${BUDGET} (spent so far $${spent().toFixed(2)}), out ${OUT}`);
if (arrangements.includes('direct')) console.log(`  direct runs ${DIRECT_AGENT_TOOL ? 'with' : 'without'} the Agent tool`);
if (arrangements.some(a => a !== 'direct')) console.log(`  router runs ${ROUTER_MCP ? 'with' : 'without'} the router's MCP server, profile ${PROFILE ?? `${DEFAULT_PROFILE} (the router's default)`}`);
console.log(`  every run may also use ${ALLOWED_SINCE_222.join(', ')} without a prompt (decision 222; runs before it could not)`);
if (SUB) {
  console.log('  on the subscription login of this machine\'s Claude Code, no API key: every $ is the API-priced estimate Claude Code reports, and the budget and the caps count in it');
  console.log(METER ? `  /usage is read before each run: no run starts with a meter at ${MAX_PERCENT}% or more` : '  no /usage readings (--no-meter): a limit warning in a run stops the measurement after it');
  if (arrangements.some(a => a !== 'direct')) console.log(TRANSCRIPTS ? '  router runs keep their transcript (the daemon reads it), in Claude Code\'s own projects folder' : '  router runs write no transcript (--no-transcripts): the router works from estimates');
}
for (const [t, a] of order) console.log(`  ${t.id.padEnd(32)} ${t.level} ${a.padEnd(8)} cap $${CAP[t.level]}${doneKeys.has(`${t.id}|${a}`) ? '  (done)' : ''}`);
if (flag('only-plan')) process.exit(0);
if (flag('dry-run')) { printEstimate(); process.exit(0); }
fs.writeFileSync(path.join(OUT, 'tasks.jsonl'), '');      // rewritten with prompts as workspaces are prepared
if (!HELPER && !SUB && !flag('setup-only')) { console.error('pass --api-key-helper "<command>" (keychain helper), or --subscription to run on the login of this machine\'s Claude Code'); process.exit(2); }

// AGENTIC_ROUTER_HOME (the previous release) is left out: with it, init would move that folder into the temp home
const { AGENTIC_ROUTER_HOME: _previousHome, ...inherited } = process.env;
// The router's CLI never runs against the user's Claude Code settings: its CLAUDE_CONFIG_DIR is a folder of this
// run, beside the router home, and init gets --no-plugin (the run loads the plugin with --plugin-dir). Either one
// alone keeps `claude plugin marketplace add` away from the user's settings; without them init registered each
// run's temporary router home there as a marketplace.
const cliEnv = (home: string) => ({ ...inherited, DO_IT_ALL_CLAUDE_CODE_HOME: home, CLAUDE_CONFIG_DIR: path.join(path.dirname(home), 'claude-init') });
const cli = (home: string, ...a: string[]) => execFileSync(process.execPath, [path.join(ROOT, 'packages/cli/src/index.ts'), ...a],
  { env: cliEnv(home), encoding: 'utf8' });
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });

/** On the subscription login: a router run keeps its transcript unless --no-transcripts; a direct run has no reader of one. */
const keepsTranscript = (a: Arrangement): boolean => a !== 'direct' && TRANSCRIPTS;

function settingsFor(): string {
  return SUB ? subscriptionRunSettings() : JSON.stringify({ apiKeyHelper: HELPER, permissions: { deny: CREDENTIAL_DENY } });
}

async function runClaude(repo: string, configDir: string, prompt: string, a: Arrangement, capUsd: number, timeoutSec: number, home: string | undefined, streamFile: string)
  : Promise<{ code: number | null; out: any; ms: number; timedOut: boolean; stderr: string; lines: StreamLine[]; startedAt: string }> {
  // decision 174: stream-json with hook events and the workers' messages, each line stamped on arrival (phase timings);
  // its result message is what --output-format json printed
  // --strict-mcp-config loads no MCP server at all, the plugin's own included. A router run with ROUTER_MCP leaves
  // it out, so the plugin's declaration is loaded as in a user's session; the session's server list is checked
  // after the run (mcpSeen).
  // The command line itself is bench/src/kpi/run-args.ts, shared with scripts/measure-session.ts (what a run may
  // do without a prompt is there too, decision 222).
  const args = claudeArgs({ lead: LEAD, effort: EFFORT, capUsd, settings: settingsFor(), ...(a !== 'direct' ? { pluginDir: path.join(ROOT, 'plugin') } : {}),
    agentTool: a !== 'direct' || DIRECT_AGENT_TOOL, strictMcp: a === 'direct' || !ROUTER_MCP, noSessionPersistence: SUB && !keepsTranscript(a) });
  // decision 218: Claude Code names the model to the hooks of an interactive session only (SessionStart), so a
  // -p run tells the router through ANTHROPIC_MODEL, which the relay hook passes on with the prompt. It is the
  // value of --model, so the run itself is the same; every arrangement gets it, router off included.
  // decision 226: on the subscription login the run gets no config folder of ours and no credential variable
  const env = SUB ? subscriptionRunEnv(LEAD, home, process.env, keepsTranscript(a))
    : { ...childEnv(configDir, { kind: 'api-key-helper' } as never), ANTHROPIC_MODEL: LEAD, ...(home ? { DO_IT_ALL_CLAUDE_CODE_HOME: home } : {}) };
  const bin = claudeBin();
  const c = await runCaptured(bin.cmd, [...bin.prefix, ...args], { cwd: repo, env, input: prompt, timeoutSec, streamFile });
  return { code: c.code, out: c.result, ms: c.ms, timedOut: c.timedOut, stderr: c.stderr, lines: c.lines, startedAt: c.startedAt };
}

/** Decision 226: the transcript paths Claude Code gave the router for a run's workers (they lie in the session's folder). */
function workerTranscripts(home: string): string[] {
  const dbFile = path.join(home, 'router.db');
  if (!fs.existsSync(dbFile)) return [];
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try { return (db.prepare('SELECT transcript_path FROM agents WHERE transcript_path IS NOT NULL').all() as Array<{ transcript_path: unknown }>).map(r => String(r.transcript_path)); }
  catch { return []; }
  finally { db.close(); }
}

/** The session transcripts Claude Code named to the router in a run (the hook input of a session start or a prompt). */
function sessionTranscripts(home: string): string[] {
  const dbFile = path.join(home, 'router.db');
  if (!fs.existsSync(dbFile)) return [];
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT payload FROM events WHERE type IN ('session_start', 'prompt_submit') AND agent_id IS NULL`).all() as Array<{ payload: unknown }>;
    const named = new Set<string>();
    for (const r of rows) { try { const p = JSON.parse(String(r.payload)) as { transcript_path?: unknown }; if (typeof p.transcript_path === 'string' && p.transcript_path) named.add(p.transcript_path); } catch { /* not JSON */ } }
    return [...named];
  } catch { return []; }
  finally { db.close(); }
}

/** Decision 174: the daemon ledger's timing rows (verify commands, workers, subtasks, hook events) for the phases. */
function routerTiming(home: string, startedAt: string): LedgerTiming | null {
  const dbFile = path.join(home, 'router.db');
  if (!fs.existsSync(dbFile)) return null;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const q = (sql: string) => { try { return db.prepare(sql).all() as any[]; } catch { return []; } };
  const t: LedgerTiming = {
    startedAt,
    events: q('SELECT type, tool_name, agent_id, received_at FROM events').map(e => ({ type: String(e.type), toolName: e.tool_name ?? null, agentId: e.agent_id ?? null, at: String(e.received_at) })),
    signals: q('SELECT agent_id, subtask_id, kind, duration_ms, attempt, created_at FROM signals').map(s => ({ agentId: s.agent_id ?? null, subtaskId: s.subtask_id ?? null, kind: String(s.kind), durationMs: s.duration_ms ?? null, attempt: Number(s.attempt ?? 0), at: String(s.created_at) })),
    agents: q('SELECT agent_id, role, subtask_id, started_at, stopped_at, worktree_path FROM agents').map(x => ({ agentId: String(x.agent_id), role: x.role ?? null, subtaskId: x.subtask_id ?? null, startedAt: String(x.started_at), stoppedAt: x.stopped_at ?? null, worktreePath: x.worktree_path ?? null })),
    subtasks: q('SELECT id, attempts, up_count FROM subtasks').map(s => ({ id: String(s.id), attempts: Number(s.attempts ?? 0), upCount: Number(s.up_count ?? 0) })),
  };
  db.close();
  return t;
}

function diffStats(repo: string, base: string) {
  const ns = git(repo, 'diff', '--numstat', base, '--', '.', ':(exclude).claude', ':(exclude).bench-hidden').trim().split('\n').filter(Boolean);
  const untracked = git(repo, 'ls-files', '--others', '--exclude-standard').trim().split('\n').filter(Boolean)
    .filter(f => !f.startsWith('.claude/') && !f.startsWith('.bench-hidden/'));
  let added = 0, removed = 0; const files = new Set<string>();
  for (const l of ns) { const [a, r, f] = l.split('\t'); added += Number(a) || 0; removed += Number(r) || 0; files.add(f!); }
  for (const f of untracked) { files.add(f); try { added += fs.readFileSync(path.join(repo, f), 'utf8').split('\n').length; } catch { /* binary */ } }
  const dirs = new Set([...files].map(f => path.posix.dirname(f.replace(/\\/g, '/'))));
  return { changedFiles: files.size, changedDirs: dirs.size, linesAdded: added, linesRemoved: removed };
}

function routerFacts(home: string) {
  const dbFile = path.join(home, 'router.db');
  if (!fs.existsSync(dbFile)) return {};
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const q = (sql: string) => { try { return db.prepare(sql).all() as any[]; } catch { return []; } };
  const reqs = q('SELECT * FROM requests');
  const subs = q('SELECT * FROM subtasks');
  const costs = q('SELECT * FROM costs');
  const records = q('SELECT * FROM request_records');
  db.close();
  const sum = (rows: any[]) => rows.reduce((a, r) => a + (Number(r.usd) || 0), 0);
  return {
    costLeadUsd: sum(costs.filter(c => c.source === 'lead')) || undefined,
    costSubagentsUsd: sum(costs.filter(c => c.source !== 'lead' && c.source !== 'agent_result')),
    subtasks: subs.map(s => ({ role: s.role, step: s.step, verdict: s.verdict, status: s.status, attempts: s.attempts,
      costUsd: sum(costs.filter(c => c.agent_id === s.agent_id && c.source !== 'agent_result')) })),
    replanned: reqs.some(r => r.replanned_from),
    requests: reqs.map(r => ({ level: r.level, preset: r.preset, outcome: r.outcome, forced_from: r.forced_from, replanned_from: r.replanned_from, lead_class: r.lead_class, lead_edits: r.lead_edits })),
    records: records.length,
    // Phase-3 KPI fields, from the run's first request (a bench task is one request)
    levelChosen: reqs[0]?.level ?? null,
    triageSource: (() => { try { return JSON.parse(String(reqs[0]?.triage)).source ?? null; } catch { return null; } })(),
    leadClass: reqs[0]?.lead_class ?? null,
    outcome: reqs[0]?.outcome ?? null,                                   // delegated | direct | no_delegation | lead_takeover
    leadEdits: Number(reqs[0]?.lead_edits ?? 0),                         // decision 145: the lead's own edits after delegating
    noChanges: subs.filter(s => s.verdict === 'no_changes').length,      // decision 145: writers that changed nothing
  };
}

/**
 * --dry-run: each planned cell priced from the earlier measurement with the same lead model (Sonnet: decision
 * 123; Opus: decision 107). `auto` has no earlier run of its own: it is priced as team-L2, the closest measured
 * arrangement (auto plans an L1 request with one coder, so for L1 that is an upper bound). A cell without a
 * measurement takes the level's average for its arrangement.
 */
function printEstimate(): void {
  const priorFile = path.join(ROOT, 'bench', 'results', LEAD === 'opus' ? 'measure107' : 'measure107-sonnet', 'runs.jsonl');
  const prior = fs.existsSync(priorFile) ? fs.readFileSync(priorFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { taskId: string; arrangement: string; level: string; costUsd: number; wallSeconds: number }) : [];
  const basisOf = (a: Arrangement) => (a === 'auto' ? 'team-L2' : a);
  const levelAvg = (level: string, a: string) => {
    const rs = prior.filter(r => r.level === level && r.arrangement === a);
    return rs.length ? { usd: rs.reduce((s, r) => s + Number(r.costUsd), 0) / rs.length, sec: rs.reduce((s, r) => s + Number(r.wallSeconds), 0) / rs.length } : { usd: CAP[level]! / 4, sec: 300 };
  };
  const totals: Record<string, { usd: number; sec: number; n: number }> = {};
  console.log(`\nestimate from ${path.relative(ROOT, priorFile)} (lead ${LEAD}${LEAD === 'opus' || LEAD === 'sonnet' ? '' : ': no measurement of this lead, Sonnet numbers used'}):`);
  for (const [t, a] of order) {
    if (doneKeys.has(`${t.id}|${a}`)) continue;
    const basis = basisOf(a);
    const hit = prior.find(r => r.taskId === t.id && r.arrangement === basis);
    const e = hit ? { usd: Number(hit.costUsd), sec: Number(hit.wallSeconds) } : levelAvg(t.level, basis);
    const tot = (totals[a] ??= { usd: 0, sec: 0, n: 0 });
    tot.usd += e.usd; tot.sec += e.sec; tot.n++;
    console.log(`  ${t.id.padEnd(32)} ${t.level} ${a.padEnd(8)} ~$${e.usd.toFixed(2).padStart(5)} ~${String(Math.round(e.sec)).padStart(4)} s  (${hit ? `measured ${basis}` : `${t.level} average of ${basis}`})`);
  }
  const all = Object.values(totals).reduce((s, x) => ({ usd: s.usd + x.usd, sec: s.sec + x.sec, n: s.n + x.n }), { usd: 0, sec: 0, n: 0 });
  for (const [a, x] of Object.entries(totals)) console.log(`  ${a.padEnd(8)} ${String(x.n).padStart(2)} runs  ~$${x.usd.toFixed(2)}  ~${(x.sec / 60).toFixed(0)} min`);
  console.log(`  total    ${String(all.n).padStart(2)} runs  ~$${all.usd.toFixed(2)}  ~${(all.sec / 60).toFixed(0)} min run time (sequential, plus grading)`);
  console.log(`  suggested --budget ${Math.ceil(all.usd * 1.5)} (one run per cell varies; the per-run caps stop a runaway: ${Object.entries(CAP).map(([k, v]) => `${k} $${v}`).join(', ')})`);
}

const manifest = loadPublicManifest();
// decision 226: every subscription run works in this one folder, and the /usage readings run there too
const SUB_WS = path.join(WORK, 'sub-ws');
const meter = (purpose: string): Promise<Reading> => readMeter({ claude: claudeBin(), cwd: path.join(SUB_WS, 'repo'), out: OUT, purpose });
let reading: Reading | null = null;   // the latest /usage reading: the one after a run is the one before the next
// Router runs on the subscription login leave their transcripts in Claude Code's own projects folder. However
// the measurement ends (done, a stop, an error), its last line names that folder, for the user to remove it.
let keptTranscripts = earlier.some(j => j.transcript === true);   // runs of an earlier invocation count too
const transcriptPaths = new Set<string>();
process.on('exit', () => {
  if (!keptTranscripts) return;
  const cwd = path.join(SUB_WS, 'repo');
  let real = cwd;
  try { real = fs.realpathSync.native(cwd); } catch { /* removed meanwhile: the name from the path as given */ }
  console.log(transcriptsLine(real, transcriptPaths));
});
for (const [task, a] of order) {
  const key = `${task.id}|${a}`;
  if (doneKeys.has(key)) continue;
  const remaining = BUDGET - spent();
  const cap = Math.min(CAP[task.level]!, remaining);
  if (cap < CAP[task.level]! / 2) { console.log(`budget stop before ${key}: $${remaining.toFixed(2)} left`); fs.appendFileSync(runsFile, JSON.stringify({ taskId: task.id, arrangement: a, level: task.level, budgetStop: true, passed: false, costUsd: 0, wallSeconds: 0, ...(SUB ? { subscription: true } : {}) }) + '\n'); continue; }
  if (METER && !flag('setup-only')) {
    if (!reading) {
      reading = await meter(`before ${key}`);
      console.log(`/usage: ${meterLine(reading)}`);
      if (reading.extraUsageEnabled) console.log('  note: usage credits are on for this login: past a limit, use would be charged. No run starts at the guard or above, and a run that draws on them stops the measurement.');
    }
    const stop = meterStop(reading, MAX_PERCENT);
    if (stop) { console.error(`stopped before ${key}: ${stop}`); process.exit(3); }
  }
  const root = path.join(WORK, `${task.id.slice(0, 40)}-${a}`.replace(/[^A-Za-z0-9_.-]/g, '_'));
  // on the subscription login the workspace is the shared one; the run's own folder holds its router home and grading
  if (SUB) { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); }
  const ws = await prepare(task, SUB ? SUB_WS : root);
  fs.appendFileSync(path.join(OUT, 'tasks.jsonl'), JSON.stringify({ taskId: task.id, level: task.level, prompt: ws.prompt }) + '\n');
  const base = git(ws.repo, 'rev-parse', 'HEAD').trim();
  // Harness files stay out of the diff: router project settings, worktrees, hidden tests.
  fs.appendFileSync(path.join(ws.repo, '.git', 'info', 'exclude'), '\n.claude/\n.bench-hidden/\n');
  let home: string | undefined;
  let ranProfile: string | undefined;   // the profile in the run's router config (router arrangements only)
  if (a !== 'direct') {
    home = path.join(root, 'router-home');
    cli(home, 'init', '--yes', '--no-plugin', '--claude-settings', path.join(root, 'cs.json'), '--project', root);
    const cfgFile = path.join(home, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    if (a === 'auto') {
      // as a user runs it: no forced level, the default budgets, steps and auto-release mode; only no holdout,
      // so every request is routed by its own triage
      cfg.holdoutRate = 0;
    } else {
      cfg.forceLevel = a === 'team-L2' ? 'L2' : 'L3';
      cfg.budgetsUsd = { L0: cap, L1: cap, L2: cap, L3: cap };
    }
    if (REPRO) cfg.reproduceFirst = REPRO;
    if (PROFILE) cfg.profile = PROFILE;
    if (DAEMON_PORT) cfg.daemonPort = DAEMON_PORT;
    ranProfile = profileOf(cfg);
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
    fs.mkdirSync(path.join(ws.repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ws.repo, '.claude', 'settings.local.json'), JSON.stringify({ worktree: { baseRef: 'head' } }, null, 2));
    console.log(cli(home, 'start').trim());
    if (ROUTER_MCP) {
      // before any model call: the server starts, lists the tool the brief names, and reaches this run's daemon
      const pre = await routerMcpReady(path.join(ROOT, 'plugin', 'mcp', 'server.mjs'), cliEnv(home));
      const ok = pre.ok;
      console.log(`router MCP server: ${pre.tools.length} tools${ok ? ', the daemon answered' : ` — NOT READY after ${pre.attempts} tries (${pre.reply})`}`);
      if (!ok) { cli(home, 'stop'); console.error(`stopped before ${key}: the router's MCP server is not ready; fix it, or pass --no-router-mcp for the earlier arrangement`); process.exit(3); }
    }
  }
  if (flag('setup-only')) { console.log(`setup-only ${key} in ${ws.repo}`); if (home) cli(home, 'stop'); continue; }
  console.log(`run ${key} (cap $${cap.toFixed(2)})`);
  const streamFile = path.join(OUT, 'streams', `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`);
  const r = await runClaude(ws.repo, ws.configDir, ws.prompt, a, cap, task.limits.timeoutSec, home, streamFile);
  const costUsd = Number(r.out?.total_cost_usd ?? 0);
  fs.appendFileSync(ledgerFile, JSON.stringify({ key, costUsd, at: new Date().toISOString(), ...(SUB ? { subscription: true } : {}) }) + '\n');
  if (home) { try { cli(home, 'stop'); } catch { /* already down */ } }
  if (SUB && home && keepsTranscript(a)) { keptTranscripts = true; for (const p of workerTranscripts(home)) transcriptPaths.add(p); }
  // decision 226: a run that was not on the subscription login as asked for, or that reached a limit (it may have
  // been cut short), is not the run being measured: no record, so it is run again, and the measurement stops here
  const login = SUB ? loginSeen(r.lines) : null;
  const notOnLogin = login?.problems.length ? login.problems.join('; ') : login?.limit;
  if (notOnLogin) { console.error(`stopped after ${key} ($${costUsd.toFixed(3)} counted for it): ${notOnLogin}`); process.exit(3); }
  // The router reads the session's transcript: the request it hands its workers, the lead's cost, the workers'
  // cost. A router run that was to keep one and left none is not the arrangement being measured: no record (so it
  // is run again), and the measurement stops here.
  const unread = home && (!SUB || keepsTranscript(a)) ? transcriptUnread(sessionTranscripts(home)) : null;
  if (unread) { console.error(`stopped after ${key} ($${costUsd.toFixed(3)} ${SUB ? 'counted for' : 'spent on'} it): ${unread}`); process.exit(3); }
  // decision 213: the session must hold the router's MCP server in a router run that asked for it, and no other
  // server in any run. A run that does not is not the arrangement being measured: its cost is in the ledger, it
  // gets no record (so it is run again), and the measurement stops here.
  const mcp = mcpSeen(r.lines, a !== 'direct' && ROUTER_MCP);
  if (mcp.problem) { console.error(`stopped after ${key} ($${costUsd.toFixed(3)} spent on it): ${mcp.problem}`); process.exit(3); }
  const facts = home ? routerFacts(home) : {};
  const phases = analysePhases(r.lines, r.ms, home ? routerTiming(home, r.startedAt) : null);
  const stats = diffStats(ws.repo, base);
  let graded;
  const patch = SUB || task.source !== 'custom' ? await workspacePatch(ws.repo, base) : '';
  // the shared workspace is wiped for the next run: its changes are kept beside the record
  if (SUB) { fs.mkdirSync(path.join(OUT, 'patches'), { recursive: true }); fs.writeFileSync(path.join(OUT, 'patches', `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.diff`), redact(patch)); }
  if (task.source === 'custom') graded = await gradeNodeTest(task, ws.repo);
  else graded = await gradeSwebench(task, manifest!.dataset, manifest!.split, patch, path.join(root, 'grade'), `m107-${task.id}-${a}`);
  // the reading after the run (grading gave the meter time to catch up) is the next run's reading before
  const before = reading;
  if (METER) { reading = await meter(`after ${key}`); console.log(`/usage: ${meterLine(reading)}`); }
  const models = Object.entries(r.out?.modelUsage ?? {}).map(([m, u]: [string, any]) => ({ model: m, costUsd: Number(u.costUSD ?? 0) }));
  const rec = {
    taskId: task.id, arrangement: a, level: task.level, leadModel: LEAD, leadEffort: EFFORT, rep: 1, allowedSince222: true,
    passed: graded.pass, grade: graded.detail, costUsd, wallSeconds: Math.round(r.ms / 1000),
    costLeadUsd: a === 'direct' ? costUsd : (facts as any).costLeadUsd, costSubagentsUsd: a === 'direct' ? 0 : (facts as any).costSubagentsUsd,
    // over every result line of the run: a lead woken by its background workers writes one per turn, and num_turns counts one turn
    leadCalls: leadTurns(r.lines), models, ...stats, ...(a === 'direct' ? { outcome: 'router-off', levelChosen: null, agentTool: DIRECT_AGENT_TOOL } : { routerMcp: ROUTER_MCP, profile: ranProfile }), ...facts,
    mcp: { seen: mcp.seen, servers: mcp.servers.map(s => `${s.name} (${s.status})`), routerTools: mcp.routerTools },
    // decision 226: costUsd and the other $ of this record are then API-priced estimates
    ...(login ? { subscription: true, apiKeySource: login.apiKeySource, claudeVersion: login.version, transcript: keepsTranscript(a), limitEvents: login.limitEvents, meters: METER ? meterMoved(before, reading) : null } : {}),
    timedOut: r.timedOut, error: r.out?.is_error ? String(r.out?.subtype ?? r.out?.result ?? '').slice(0, 300) : (r.out ? undefined : r.stderr.slice(-300)),
    phases,
  };
  fs.appendFileSync(runsFile, JSON.stringify(rec) + '\n');
  const f = facts as { levelChosen?: string | null; outcome?: string | null; leadEdits?: number; noChanges?: number };
  const routed = a === 'direct' ? '' : ` ${f.levelChosen ?? '?'} ${f.outcome ?? '?'}${f.leadEdits ? ` lead-edits=${f.leadEdits}` : ''}${f.noChanges ? ` no-changes=${f.noChanges}` : ''}`
    // the router's own rows: the lead's from its transcript (none read, none recorded), the workers' from theirs or an estimate
    + ` lead ${rec.costLeadUsd === undefined ? 'not recorded' : `$${Number(rec.costLeadUsd).toFixed(3)}`} / workers $${Number(rec.costSubagentsUsd ?? 0).toFixed(3)}`;
  console.log(`  -> ${graded.pass ? 'PASS' : 'FAIL'} ${graded.detail} $${costUsd.toFixed(3)} ${rec.wallSeconds}s${routed}; spent $${spent().toFixed(2)} / $${BUDGET}`);
  const ws1 = phases.workers;
  console.log(`     phases: startup ${phases.startupSeconds ?? '?'}s, lead before 1st worker ${phases.leadBeforeFirstWorkerSeconds ?? '-'}s, ${ws1.length} worker(s) active ${phases.workersActiveSeconds ?? '-'}s (start delays ${ws1.map(w => w.startDelaySeconds ?? '?').join('/') || '-'}s), lead wrap-up ${phases.leadFinishSeconds ?? '-'}s, verify ${phases.verify.totalSeconds}s, hooks ${phases.hooks.totalSeconds}s x${phases.hooks.count}`);
  // decision 226: the run is recorded; what it showed about the login's limits decides whether another may start
  if (login?.warning) console.log(`     ${login.warning}`);
  const enough = login?.overage ?? (METER ? null : login?.warning);
  if (enough) { console.error(`stopped after ${key} (recorded): ${enough}`); process.exit(3); }
}
console.log(`done. spent $${spent().toFixed(2)} of $${BUDGET}. runs: ${runsFile}`);
