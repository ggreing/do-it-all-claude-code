// A stand-in for `claude` in the KPI tests (BENCH_CLAUDE_BIN): it prints the lines of scenario.json (next to it)
// with the given pauses, writing each line synchronously so it leaves when written, and logs its arguments, the
// model in its environment and the start of the prompt on stdin to calls.jsonl. A line's text may carry {{t}} for
// the milliseconds since it started and {{session}} for the session id on its command line.
// scenario.json is a list of steps, or { calls: [steps of the 1st call, steps of the 2nd, ...] } for a session of
// several processes (the last list repeats). A step may `copy` a folder onto the working directory before its
// line, which stands in for the edits a real session makes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
const callsFile = path.join(here, 'calls.jsonl');
const nth = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).length : 0;
let prompt = '';
try { prompt = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
const args = process.argv.slice(2);
fs.appendFileSync(callsFile, JSON.stringify({ args, cwd: process.cwd(), anthropicModel: process.env.ANTHROPIC_MODEL ?? null, prompt: prompt.slice(0, 80) }) + '\n');
const scenario = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
const steps = Array.isArray(scenario) ? scenario : scenario.calls[Math.min(nth, scenario.calls.length - 1)];
const flagAt = Math.max(args.indexOf('--session-id'), args.indexOf('--resume'));
const session = flagAt >= 0 ? args[flagAt + 1] ?? '' : '';
for (const step of steps) {
  if (step.pauseMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step.pauseMs);
  if (step.copy) fs.cpSync(step.copy, process.cwd(), { recursive: true, force: true });
  if (step.line) fs.writeSync(1, JSON.stringify(step.line).replace('{{t}}', String(Date.now() - t0)).replace('{{session}}', session) + '\n');
}
