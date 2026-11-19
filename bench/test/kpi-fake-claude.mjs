// A stand-in for `claude` in the KPI tests (BENCH_CLAUDE_BIN): it prints the lines of scenario.json (next to it)
// with the given pauses, writing each line synchronously so it leaves when written, and logs its arguments, the
// model in its environment, the names of the environment variables it got (never their values, but for the config
// folder's and the print-mode background wait ceiling's) and the start of the prompt on stdin to calls.jsonl. A
// step's `stderr` text is written to stderr. A line's text may carry {{t}} for the
// milliseconds since it started, {{session}} for the session id on its command line, and {{task}} for the prompt
// on stdin after a "--- task ---" line (the whole prompt when it has none), as a session that hands its task on
// would repeat it.
// scenario.json is a list of steps, or { calls: [steps of the 1st call, steps of the 2nd, ...] } for a session of
// several processes (the last list repeats). A step may `copy` a folder onto the working directory before its
// line, which stands in for the edits a real session makes.
// `claude -p /usage ...` (a meter reading of a subscription run) is answered from the scenario's `usage` list in
// the same way, { calls: [...], usage: [steps of the 1st reading, ...] }, and does not count as a call of `calls`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
const callsFile = path.join(here, 'calls.jsonl');
const args = process.argv.slice(2);
const usage = args[1] === '/usage';
const earlier = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const nth = earlier.filter(c => Boolean(c.usage) === usage).length;
let prompt = '';
if (!usage) { try { prompt = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ } }
fs.appendFileSync(callsFile, JSON.stringify({ args, cwd: process.cwd(), anthropicModel: process.env.ANTHROPIC_MODEL ?? null, prompt: prompt.slice(0, 80),
  usage, env: Object.keys(process.env).sort(), configDir: process.env.CLAUDE_CONFIG_DIR ?? null, bgWaitCeiling: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ?? null }) + '\n');
const scenario = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
const lists = usage ? scenario.usage ?? [[]] : Array.isArray(scenario) ? [scenario] : scenario.calls;
const steps = lists[Math.min(nth, lists.length - 1)];
const flagAt = Math.max(args.indexOf('--session-id'), args.indexOf('--resume'));
const session = flagAt >= 0 ? args[flagAt + 1] ?? '' : '';
const MARK = '--- task ---\n';
const task = JSON.stringify(prompt.includes(MARK) ? prompt.slice(prompt.indexOf(MARK) + MARK.length) : prompt).slice(1, -1);
for (const step of steps) {
  if (step.pauseMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step.pauseMs);
  if (step.copy) fs.cpSync(step.copy, process.cwd(), { recursive: true, force: true });
  if (step.stderr) fs.writeSync(2, step.stderr);
  if (step.line) fs.writeSync(1, JSON.stringify(step.line).replace('{{t}}', String(Date.now() - t0)).replace('{{session}}', session).replace('{{task}}', () => task) + '\n');
}
