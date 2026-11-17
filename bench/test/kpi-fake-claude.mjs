// A stand-in for `claude` in the KPI phase tests (BENCH_CLAUDE_BIN): it prints the lines of scenario.json (next to
// it) with the given pauses, writing each line synchronously so it leaves when written, and logs its arguments to
// calls.jsonl. A line's text may carry {{t}} for the milliseconds since it started.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\n');
try { fs.readFileSync(0); } catch { /* no stdin */ }
const scenario = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
for (const step of scenario) {
  if (step.pauseMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step.pauseMs);
  fs.writeSync(1, JSON.stringify(step.line).replace('{{t}}', String(Date.now() - t0)) + '\n');
}
