// A stand-in for `claude` in the subscription tests (BENCH_CLAUDE_BIN). Its state.json sits next to it (the test
// copies both into a temp folder): the meters' starting values, how much a task moves them, and the bench folder, so
// a task run can apply the task's reference solution (and pass grading). A task run appends what it did to
// ledger.jsonl (one append per run, so runs in parallel do not race) and /usage adds the ledger to the starting
// values. Every call is logged to calls.jsonl with its arguments, the names of the environment variables it got
// (never their values), its working folder, and when it started and ended.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(here, 'state.json'), 'utf8'));
const args = process.argv.slice(2);
const line = o => process.stdout.write(JSON.stringify(o) + '\n');
const started = Date.now();
const logCall = (input) => fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ args, env: Object.keys(process.env).sort(), cwd: process.cwd(), input: input.slice(0, 40), started, ended: Date.now() }) + '\n');

let input = '';
if (args[1] === '/usage') input = '/usage';            // the prompt as an argument, right after -p
else if (!args.includes('--version')) { try { input = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ } }
if (args.includes('--version')) { logCall(''); process.stdout.write(`${state.version} (Claude Code)\n`); process.exit(0); }

const router = args.includes('--plugin-dir');
const model = args[args.indexOf('--model') + 1];
// Claude Code's built-in plugins load in every session, as 2.1.323 showed (state.builtins), plus any the test adds
const builtins = (state.builtins ?? ['cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-privacy', 'cc-plugin-plugin-authoring']).map(name => ({ name, path: 'builtin', source: `${name}@builtin` }));   // the marker 2.1.323 sends
const userPlugins = (state.userPlugins ?? []).map(name => ({ name, path: `/plugins/${name}` }));
line({
  type: 'system', subtype: 'init', session_id: 's', apiKeySource: state.apiKeySource ?? 'none', claude_code_version: state.version,
  model, tools: [], skills: [], agents: [],
  plugins: [...builtins, ...userPlugins, ...(router ? [{ name: 'do-it-all-claude-code', path: args[args.indexOf('--plugin-dir') + 1] }] : [])],
  mcp_servers: router ? [{ name: 'plugin:do-it-all-claude-code:router', status: 'connected' }] : [],
});

const ledgerFile = path.join(here, 'ledger.jsonl');
const ledger = () => (fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

if (input.trim() === '/usage') {
  const sum = k => ledger().reduce((a, e) => a + e[k], 0);
  // state.noSession: an account without the 5-hour row; state.integer: whole-number percents, as the server sent them
  const pct = v => (state.integer ? Math.round(v) : Math.round(v * 100) / 100);
  const limits = [
    ...(state.noSession ? [] : [{ kind: 'session', group: 'session', percent: pct(state.session + sum('session')), resets_at: state.sessionReset, severity: 'normal', is_active: true }]),
    { kind: 'weekly_all', group: 'weekly', percent: pct(state.weekly + sum('weekly')), resets_at: state.weeklyReset, severity: 'normal', is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: pct(state.opus + sum('scoped')), resets_at: state.weeklyReset, scope: { model: { display_name: state.scopedName ?? 'Opus' } }, severity: 'normal', is_active: false },
  ];
  line({ type: 'assistant', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'usage text' }] }, ...(state.noUsageReport ? {} : { usage_report: { session: {}, rate_limits: { limits, extra_usage: { is_enabled: false } } } }) });
  line({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} });
  logCall(input);
  process.exit(0);
}

// a task: solve it with the reference solution, take a while (state.taskMs), move the meters, maybe run the status line
for (const id of fs.readdirSync(path.join(state.benchDir, 'tasks', 'custom'))) {
  const f = path.join(state.benchDir, 'tasks', 'custom', id, 'task.json');
  if (!fs.existsSync(f)) continue;
  const t = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (t.prompt === input) fs.cpSync(path.join(state.benchDir, 'tasks', 'custom', id, t.oracle), process.cwd(), { recursive: true });
}
if (state.taskMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.taskMs);
const family = /haiku/.test(model) ? 'haiku' : /sonnet/.test(model) ? 'sonnet' : 'opus';
const cost = state.costByModel?.[family] ?? 0.4;
// a background helper model inside the session (a share of the cost billed to Haiku), as Claude Code may use one
const helper = family !== 'haiku' && state.helperHaikuShare ? cost * state.helperHaikuShare : 0;
const step = router ? state.routerStep : state.directStep;
const ppd = state.pointsPerDollar;   // { opus, haiku }: the weekly meter moving with API-priced dollars per model
const weekly = ppd ? (cost - helper) * (ppd[family] ?? 0) + helper * (ppd.haiku ?? 0) : (state.weeklyStep ?? step / 10);
fs.appendFileSync(ledgerFile, JSON.stringify({ session: step, weekly, scoped: state.scopedStep ?? step / 8 }) + '\n');
if (state.runStatusLine) {
  const s = JSON.parse(args[args.indexOf('--settings') + 1]);
  execSync(s.statusLine.command, { input: JSON.stringify({ cwd: process.cwd(), session_id: 's', rate_limits: { five_hour: { used_percentage: state.session } }, model: { id: model } }), shell: true });
}
const usage = (usd) => ({ inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200, costUSD: usd });
line({
  type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, num_turns: 5, usage: { input_tokens: 100, output_tokens: 50 },
  modelUsage: { [model]: usage(cost - helper), ...(helper ? { 'claude-haiku-5-5': usage(helper) } : {}) },
});
logCall(input);
