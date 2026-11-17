// Decision 174: the phase timings of a KPI run (scripts/measure107.ts records `phases` on each run), as a report:
// a table per task, totals per level, and the time delegation added against router-off runs of the same tasks.
//   node scripts/kpi-phases.ts --runs bench/results/kpi-phase4/runs.jsonl [--direct bench/results/kpi-phase3/runs.jsonl] [--write <file.md>]
// --direct defaults to the router-off runs in the --runs file itself, then to bench/results/kpi-phase3.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phaseReport, type PhaseRun } from '../bench/src/kpi/phases.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : undefined; };
const read = (f: string): PhaseRun[] => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as PhaseRun) : []);

const runsFile = arg('runs');
if (!runsFile) { console.error('usage: node scripts/kpi-phases.ts --runs <runs.jsonl> [--direct <runs.jsonl>] [--write <file.md>]'); process.exit(2); }
const runs = read(path.resolve(runsFile));
const on = runs.filter(r => r.arrangement !== 'direct');
let direct = runs.filter(r => r.arrangement === 'direct');
const directFile = arg('direct') ?? (direct.length ? undefined : path.join(ROOT, 'bench', 'results', 'kpi-phase3', 'runs.jsonl'));
if (directFile) direct = read(path.resolve(directFile)).filter(r => r.arrangement === 'direct');
const md = phaseReport(on, direct);
const out = arg('write');
if (out) fs.writeFileSync(path.resolve(out), md + '\n');
console.log(md);
