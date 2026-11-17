// Decision 178: the real size of each bench task's change, for the triage regret table's one-file policies.
// Custom tasks: the reference solution (oracle/) against the fixture; public tasks: the gold patch from the local
// SWE-bench dataset cache. One JSON line per task: { taskId, level, prompt, files, lines } (lines added plus removed).
//   node scripts/task-sizes.ts [--tasks id,id] > sizes.jsonl
//   node packages/core/src/triage-eval-cli.ts regret <runs.jsonl> --tasks sizes.jsonl
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPublicManifest, loadTasks } from '../bench/src/tasks.ts';
import type { Task } from '../bench/src/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const ids = (() => { const i = argv.indexOf('--tasks'); return i >= 0 ? argv[i + 1]!.split(',') : undefined; })();
const PUBLIC_PROMPT = 'Resolve the following GitHub issue by editing the repository source code. Do not modify or add tests.\n\n';

function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r)); else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Files and lines the oracle changes against the fixture (git diff --no-index --numstat per file). */
function customSize(t: Task): { files: number; lines: number } {
  const oracle = path.join(t.dir!, t.oracle!);
  const fixture = path.join(ROOT, 'bench', 'fixtures', t.fixture!);
  let files = 0, lines = 0;
  for (const rel of listFiles(oracle)) {
    const a = path.join(fixture, rel), b = path.join(oracle, rel);
    let out = '';
    try { out = execFileSync('git', ['diff', '--no-index', '--numstat', fs.existsSync(a) ? a : (process.platform === 'win32' ? 'NUL' : '/dev/null'), b], { encoding: 'utf8' }); }
    catch (e) { out = String((e as { stdout?: string }).stdout ?? ''); }       // exit 1 means "differs"
    const n = out.trim().split('\n').filter(Boolean).reduce((s, l) => s + (Number(l.split('\t')[0]) || 0) + (Number(l.split('\t')[1]) || 0), 0);
    if (n > 0) { files++; lines += n; }
  }
  return { files, lines };
}

function publicSize(t: Task, dataset: string): { files: number; lines: number; prompt: string } | null {
  const f = path.join(ROOT, 'bench', '.cache', 'swebench', dataset.replace('/', '__'), `${t.instance_id}.json`);
  if (!fs.existsSync(f)) return null;
  const r = JSON.parse(fs.readFileSync(f, 'utf8')) as { patch: string; problem_statement: string };
  return { files: (r.patch.match(/^diff --git /gm) ?? []).length, lines: (r.patch.match(/^[+-](?![+-])/gm) ?? []).length, prompt: PUBLIC_PROMPT + r.problem_statement };
}

const manifest = loadPublicManifest();
for (const t of loadTasks(ids ? { ids } : {})) {
  if (t.source === 'custom') { const s = customSize(t); console.log(JSON.stringify({ taskId: t.id, level: t.level, prompt: t.prompt, ...s })); continue; }
  const s = manifest ? publicSize(t, manifest.dataset) : null;
  if (s) console.log(JSON.stringify({ taskId: t.id, level: t.level, ...s }));
  else console.error(`${t.id}: not in the local dataset cache (run bench validate --public once)`);
}
