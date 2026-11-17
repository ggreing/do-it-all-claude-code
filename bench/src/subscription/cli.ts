// `bench sub`: the subscription-limit measurement (docs/design/subscription-measurement.md). It drives the user's own
// Claude Code on the user's subscription login, so it runs only with --subscription; --dry-run prints the plan and the
// estimated limit spend without starting claude. The harness never reads a credential: Claude Code reads its own.
//   sub --pilot --dry-run                       the pilot's plan
//   sub --pilot --subscription --plan max-20x   the pilot: 4 tasks, the direct arm, the three checks
//   sub [--levels L2,L3] [--tasks ...] [--pairs N] [--arms direct,router] --dry-run | --subscription
//   sub --calibrate --dry-run | --subscription  points per API-priced dollar per model on the weekly meter
//       [--configs s5,s2] [--concurrency 4 | s5=1,s2=4] [--target-points 5] [--max-total-points 12] [--cap-tasks N]
//       [--read-every-seconds 60]
//   sub-report                                  the report over results/subscription
// Also: --lead s5 (a config of bench/config/matrix.json), --plugin-dir <effective plugin> (router arm),
// --setting-sources <list>, --results-dir <dir>, --lag-seconds, --late-seconds, --read-gap-seconds, --max-percent,
// --no-stop-early.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { exec, git, parseList, RESULTS } from '../util.ts';
import { prepare } from '../workspace.ts';
import { gradeNodeTest } from '../graders/node-test.ts';
import { ARMS, DEFAULT_SETTING_SOURCES, type Arm } from './isolation.ts';
import { formatPlan, fullPlan, lastKnownMeters, leadConfig, loadPilotMeasured, loadSubConfig, pilotPlan, type SubConfig } from './plan.ts';
import { calibrationReport, formatCalibrationPlan, loadCalConfig, runCalibration, type CalConfig } from './calibrate.ts';
import { writeSubReport } from './report.ts';
import { runFull, runPilot, type SubDeps, type SubOptions } from './run.ts';

type Flags = Record<string, string | boolean>;

const resultsDir = (f: Flags): string => (typeof f['results-dir'] === 'string' ? path.resolve(f['results-dir']) : path.join(RESULTS, 'subscription'));

/** config/subscription.json with the pacing flags applied; an invalid value is an error, not a fallback. */
export function subConfig(f: Flags): SubConfig {
  const cfg = loadSubConfig();
  const nums: Array<[string, keyof SubConfig, number, number]> = [
    ['lag-seconds', 'lagSeconds', 0, 3600], ['late-seconds', 'lateSeconds', 0, 7200], ['read-gap-seconds', 'readGapSeconds', 0, 600], ['max-percent', 'maxPercent', 1, 95],
  ];
  for (const [flag, key, min, max] of nums) {
    if (f[flag] === undefined) continue;
    const v = Number(f[flag]);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`--${flag} must be a number from ${min} to ${max}`);
    (cfg[key] as number) = v;
  }
  return cfg;
}

/** The claude command: BENCH_CLAUDE_BIN when set (a script runs with this node), else "claude" on the PATH. */
export function claudeCommand(env: NodeJS.ProcessEnv = process.env): SubDeps['claude'] {
  const bin = env.BENCH_CLAUDE_BIN;
  if (!bin) return { cmd: 'claude', prefix: [] };
  return /\.(mjs|cjs|js|ts)$/.test(bin) ? { cmd: process.execPath, prefix: [bin] } : { cmd: bin, prefix: [] };
}

function healthy(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/router/v1/health', timeout: 3000 }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => { try { resolve(res.statusCode === 200 && (JSON.parse(body) as { ok?: boolean }).ok === true); } catch { resolve(false); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

export function realDeps(): SubDeps {
  return {
    exec: (cmd, args, o) => exec(cmd, args, o),
    claude: claudeCommand(),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => new Date(),
    prepare: async (task, root) => ({ repo: (await prepare(task, root)).repo }),
    grade: gradeNodeTest,
    patch: async repo => { await git(repo, 'add', '-A'); return (await git(repo, 'diff', '--cached', '--binary')).stdout; },
    daemonHealthy: healthy,
    out: line => console.log(line),
    env: process.env,
  };
}

/** The router's own config (its home: DO_IT_ALL_CLAUDE_CODE_HOME or ~/.do-it-all-claude-code), for the router arm. */
export function routerSide(f: Flags, env: NodeJS.ProcessEnv = process.env): NonNullable<SubOptions['router']> {
  const v = env.DO_IT_ALL_CLAUDE_CODE_HOME;
  const home = v && path.isAbsolute(v) ? v : path.join(os.homedir(), '.do-it-all-claude-code');
  let cfg: { daemonPort?: unknown; pluginDir?: unknown } = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as typeof cfg; } catch { /* not set up */ }
  const notes: string[] = [];
  if (fs.existsSync(path.join(home, 'teams.yaml'))) notes.push('teams.yaml in the router home applies: the router arm does not run on the default presets');
  let overrides: string[] = [];
  try { overrides = fs.readdirSync(path.join(home, 'roles')).filter(n => n.endsWith('.json')); } catch { /* none */ }
  if (overrides.length) notes.push(`role overrides apply: ${overrides.join(', ')}`);
  return {
    pluginDir: typeof f['plugin-dir'] === 'string' ? path.resolve(f['plugin-dir']) : typeof cfg.pluginDir === 'string' ? cfg.pluginDir : undefined,
    daemonPort: typeof cfg.daemonPort === 'number' ? cfg.daemonPort : undefined,
    notes,
  };
}

export async function cmdSub(f: Flags, deps: () => SubDeps = realDeps): Promise<number> {
  let cfg: SubConfig;
  try { cfg = subConfig(f); } catch (e) { console.error((e as Error).message); return 2; }
  const account = typeof f.plan === 'string' ? f.plan : 'plan not given';
  if (f.calibrate) {
    let cal: CalConfig;
    try { cal = calConfig(f); } catch (e) { console.error((e as Error).message); return 2; }
    const dir = resultsDir(f);
    const command = `node bench/src/cli.ts sub --calibrate --subscription --plan ${typeof f.plan === 'string' ? f.plan : '<your plan, e.g. max-20x>'}`;
    if (f['dry-run']) { for (const l of formatCalibrationPlan(cal, cfg, dir, { account, command })) console.log(l); return 0; }
    if (f.subscription !== true) {
      console.error('This runs your own Claude Code on your subscription login, and uses part of its weekly limit.');
      console.error('Look at the plan first with --dry-run, then add --subscription to run it.');
      return 2;
    }
    return runCalibration(deps(), { resultsDir: dir, account, cfg, settingSources: typeof f['setting-sources'] === 'string' ? f['setting-sources'] : DEFAULT_SETTING_SOURCES, stopEarly: false }, cal);
  }
  const lead = typeof f.lead === 'string' ? f.lead : cfg.lead;
  const arms = parseList(f.arms as string) as Arm[] | undefined;
  if (arms && (!arms.length || arms.some(a => !ARMS.includes(a)))) { console.error('--arms takes direct, router or both'); return 2; }
  const pairs = Number(f.pairs ?? 1);
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 50) { console.error('--pairs must be a whole number from 1 to 50'); return 2; }
  const plan = f.pilot ? pilotPlan(cfg, lead) : fullPlan(cfg, { levels: parseList(f.levels as string), tasks: parseList(f.tasks as string), pairs, arms, leadId: lead });
  if (!plan.blocks.length) { console.error('no custom tasks match the selection'); return 2; }
  const dir = resultsDir(f);
  const command = ['node bench/src/cli.ts sub', f.pilot ? '--pilot' : [f.levels ? `--levels ${f.levels}` : '', f.pairs ? `--pairs ${pairs}` : ''].filter(Boolean).join(' '),
    '--subscription', `--plan ${typeof f.plan === 'string' ? f.plan : '<your plan, e.g. max-20x>'}`].filter(Boolean).join(' ');
  if (f['dry-run']) {
    for (const l of formatPlan(plan, cfg, { measured: loadPilotMeasured(dir), account, command, known: lastKnownMeters(dir) })) console.log(l);
    return 0;
  }
  if (f.subscription !== true) {
    console.error('This runs your own Claude Code on your subscription login, and uses part of its 5-hour and weekly limits.');
    console.error('Look at the plan first with --dry-run, then add --subscription to run it.');
    return 2;
  }
  const o: SubOptions = {
    resultsDir: dir, account, cfg, leadId: lead,
    settingSources: typeof f['setting-sources'] === 'string' ? f['setting-sources'] : DEFAULT_SETTING_SOURCES,
    ...(plan.blocks.some(b => b.arm === 'router') ? { router: routerSide(f) } : {}),
    stopEarly: f['no-stop-early'] !== true,
  };
  return f.pilot ? runPilot(deps(), o) : runFull(deps(), o, plan);
}

/** config/subscription.json's calibrate section with the flags applied; an invalid value is an error. */
export function calConfig(f: Flags): CalConfig {
  const cal = loadCalConfig();
  if (typeof f.configs === 'string') {
    cal.configs = parseList(f.configs) ?? [];
    if (cal.configs.length !== 2) throw new Error('--configs takes two configs of bench/config/matrix.json, e.g. s5,s2');
    for (const id of cal.configs) leadConfig(id);
  }
  if (typeof f.concurrency === 'string') {
    for (const part of f.concurrency.split(',')) {
      const [k, v] = part.includes('=') ? part.split('=') : [null, part];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 8) throw new Error('--concurrency takes 1 to 8 (for the blocks after the first), or config=N pairs');
      if (k) cal.concurrency[k] = n; else for (const id of cal.configs.slice(1)) cal.concurrency[id] = n;
    }
  }
  const nums: Array<[string, (n: number) => void, number, number]> = [
    ['target-points', n => { cal.targetPoints = n; }, 1, 20], ['max-total-points', n => { cal.maxTotalPoints = n; }, 2, 40],
    ['read-every-seconds', n => { cal.readEverySeconds = n; }, 0, 3600],
    ['cap-tasks', n => { for (const id of cal.configs) cal.caps[id] = { ...(cal.caps[id] ?? { usd: 10, tasks: 100, minutes: 120 }), tasks: n }; }, 1, 5000],
  ];
  for (const [flag, set, min, max] of nums) {
    if (f[flag] === undefined) continue;
    const n = Number(f[flag]);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${flag} must be a number from ${min} to ${max}`);
    set(n);
  }
  if (cal.targetPoints >= cal.maxTotalPoints) throw new Error('--target-points must be below --max-total-points');
  return cal;
}

export function cmdSubReport(f: Flags): string {
  const dir = resultsDir(f);
  writeSubReport(dir, subConfig(f));
  const md = [fs.readFileSync(path.join(dir, 'report.md'), 'utf8').trimEnd(), '', ...calibrationReport(dir, loadCalConfig())].join('\n');
  fs.writeFileSync(path.join(dir, 'report.md'), md + '\n');
  return md;
}
