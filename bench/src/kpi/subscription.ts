// A measured run on the subscription login of this machine's Claude Code instead of an API key (decision 226).
// The isolation is bench/src/subscription/isolation.ts: the child gets an allow-listed environment, so no
// credential variable reaches it; no config folder of ours is set, so Claude Code reads its own login; the
// user's settings are not loaded. Nothing here reads a credential. What this file adds for the KPI scripts:
//  - the run's environment and --settings
//  - what a finished run's stream says about the login: the init message must show apiKeySource "none", and the
//    rate-limit events say whether a limit was hit or paid extra usage was drawn on
//  - a `/usage` reading before a run (no model request), so no run starts with a meter at the guard or above
// A run's cost on a subscription is the API-priced estimate Claude Code reports (total_cost_usd); the login is
// not billed per run. --max-budget-usd compares the same figure, with or without a key.
import fs from 'node:fs';
import path from 'node:path';
import { CREDENTIAL_DENY, redactDeep } from '../secrets.ts';
import { exec } from '../util.ts';
import { DEFAULT_SETTING_SOURCES, ROUTER_PLUGIN, meterArgs, subscriptionEnv } from '../subscription/isolation.ts';
import { meterDeltas, parseReading, type MeterDelta, type Reading } from '../subscription/meter.ts';
import { parseStream } from '../subscription/stream.ts';
import type { StreamLine } from './phases.ts';

/**
 * The child's environment: the allow-list and switches of a subscription run, the lead's model for the router's
 * hooks, the run's router home. A run whose transcript the router reads (`transcript`) goes without
 * CLAUDE_CODE_SKIP_PROMPT_HISTORY: that switch turns session persistence off as a whole (Claude Code 2.1.327,
 * the same as --no-session-persistence), so with it no transcript is written whatever the command line says.
 * A print-mode run writes no prompt history without the switch either: the API-key runs never had it, and their
 * config folders hold none.
 */
export function subscriptionRunEnv(lead: string, home: string | undefined, parent: NodeJS.ProcessEnv = process.env, transcript = false): Record<string, string> {
  const env: Record<string, string> = { ...subscriptionEnv('direct', parent), ANTHROPIC_MODEL: lead, ...(home ? { DO_IT_ALL_CLAUDE_CODE_HOME: home } : {}) };
  if (transcript) delete env.CLAUDE_CODE_SKIP_PROMPT_HISTORY;
  return env;
}

/**
 * Why a router run is not the arrangement being measured: Claude Code named the session's transcript to the
 * router and the file is not on disk. The router then has no request text to give its workers (it refuses the
 * first Agent call for that), records no cost of the lead, and counts its workers by an estimate. Null when
 * every named transcript is there, or none was named.
 */
export function transcriptUnread(named: Iterable<string>, exists: (file: string) => boolean = fs.existsSync): string | null {
  const missing = [...new Set(named)].filter(file => !exists(file));
  return missing.length ? `the router could not read the session's transcript (not on disk: ${missing.join(', ')}): it had no request text for its workers and recorded no cost of the lead` : null;
}

/** --settings of a subscription run: the credential deny rules and no auto memory; no key helper. */
export const subscriptionRunSettings = (): string => JSON.stringify({ permissions: { deny: CREDENTIAL_DENY }, autoMemoryEnabled: false });

export interface LimitEvent { status: string; type: string | null; utilization: number | null; resetsAt: number | null; usingOverage: boolean }

export interface LoginSeen {
  apiKeySource: string | null;
  version: string | null;
  limitEvents: LimitEvent[];
  /** Why the run is not a run on the subscription login as asked for (no record is kept of such a run). */
  problems: string[];
  /** A limit was reached: the run may have been cut short, so it is not kept, and nothing more may start. */
  limit: string | null;
  /** Paid extra usage was drawn on: the run was served, and nothing more may start. */
  overage: string | null;
  /** A warning threshold was passed (the run itself was served). */
  warning: string | null;
}

const when = (epochSeconds: number | null): string => (epochSeconds ? `, resets ${new Date(epochSeconds * 1000).toISOString()}` : '');

/** What a run's stream says about the login it ran on. */
export function loginSeen(lines: StreamLine[]): LoginSeen {
  const s = parseStream(lines.map(l => JSON.stringify(l.m)).join('\n'));
  const problems: string[] = [];
  if (!s.init) problems.push('no init message: Claude Code did not start a session');
  else {
    if (s.init.apiKeySource !== 'none') problems.push(`apiKeySource is ${JSON.stringify(s.init.apiKeySource)}: the run did not use the subscription login`);
    const builtin = new Set(s.init.builtinPlugins);
    const others = s.init.plugins.filter(n => n !== ROUTER_PLUGIN && !builtin.has(n));
    if (others.length) problems.push(`other plugins are loaded: ${others.join(', ')}`);
  }
  const limitEvents: LimitEvent[] = [];
  for (const l of lines) {
    const i = l.m.type === 'rate_limit_event' ? l.m.rate_limit_info : null;
    if (!i || typeof i !== 'object') continue;
    const e = i as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    limitEvents.push({ status: String(e.status ?? ''), type: typeof e.rateLimitType === 'string' ? e.rateLimitType : null, utilization: num(e.utilization), resetsAt: num(e.resetsAt), usingOverage: e.isUsingOverage === true || e.overageInUse === true });
  }
  const name = (e: LimitEvent) => `${e.type ?? 'a limit'}${e.utilization === null ? '' : ` at ${Math.round(e.utilization * 100)}%`}${when(e.resetsAt)}`;
  const over = limitEvents.find(e => e.usingOverage);
  const rejected = limitEvents.find(e => e.status === 'rejected');
  const warned = limitEvents.find(e => e.status !== 'allowed' && e.status !== 'rejected');
  return {
    apiKeySource: s.init?.apiKeySource ?? null, version: s.init?.version ?? null, limitEvents, problems,
    limit: rejected ? `the login reached a limit (${name(rejected)})` : null,
    overage: over ? `paid extra usage was drawn on (${name(over)})` : null,
    warning: warned ? `the login passed a warning threshold (${name(warned)})` : null,
  };
}

/**
 * The name of the folder Claude Code keeps a working directory's transcripts in, under `projects` in its config
 * folder (2.1.326): every character that is not a letter or a digit becomes "-". A name over 200 characters is
 * cut there and gets a hash, which is not worked out here: `cut` says so.
 */
export function projectFolderName(cwd: string): { name: string; cut: boolean } {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return name.length <= 200 ? { name, cut: false } : { name: name.slice(0, 200), cut: true };
}

/** The `projects/<name>` folder a transcript path lies in, as Claude Code gave the path; null when it has none. */
export function projectFolderOf(transcriptPath: string): string | null {
  const parts = transcriptPath.split(/[\\/]/);
  const at = parts.lastIndexOf('projects');
  return at >= 0 && parts.length > at + 2 ? parts.slice(0, at + 2).join(path.sep) : null;
}

/** The line that says where the transcripts of the router runs are, for the user to remove them. */
export function transcriptsLine(cwd: string, recorded: Iterable<string>): string {
  const exact = [...new Set([...recorded].map(projectFolderOf).filter((d): d is string => d !== null))];
  if (exact.length) return `transcripts of the router runs: ${exact.join(', ')} (the folder Claude Code named to the router; nothing here removes it)`;
  const { name, cut } = projectFolderName(cwd);
  return `transcripts of the router runs: projects${path.sep}${name}${cut ? '… (a long name: Claude Code cuts it here and adds a hash)' : ''} in Claude Code's config folder`
    + ` (the name by Claude Code's rule for ${cwd}; the router recorded no transcript path in these runs; nothing here removes it)`;
}

export interface MeterOptions {
  claude: { cmd: string; prefix: string[] };
  /** Where the reading runs (no workspace is needed; the same folder every time). */
  cwd: string;
  /** The measurement's output folder: readings.jsonl and the status line probe's files go there. */
  out: string;
  purpose: string;
  env?: NodeJS.ProcessEnv;
}

let seq = 0;

/** One `/usage` reading on the login, appended to <out>/readings.jsonl. No model request is made. */
export async function readMeter(o: MeterOptions): Promise<Reading> {
  const at = new Date();
  const id = `read-${at.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${++seq}`;
  fs.mkdirSync(o.cwd, { recursive: true });
  fs.mkdirSync(path.join(o.out, 'statusline'), { recursive: true });
  const args = meterArgs({ arm: 'direct', settingSources: DEFAULT_SETTING_SOURCES, probeOut: path.join(o.out, 'statusline', `${id}.jsonl`) });
  const r = await exec(o.claude.cmd, [...o.claude.prefix, ...args], { cwd: o.cwd, env: subscriptionEnv('direct', o.env ?? process.env), timeoutSec: 120 });
  const reading = parseReading(r, { id, at, purpose: o.purpose, arm: 'direct', blockId: null });
  fs.appendFileSync(path.join(o.out, 'readings.jsonl'), JSON.stringify(redactDeep(reading)) + '\n');
  return reading;
}

export const meterLine = (r: Reading): string => (r.ok ? r.rows.map(x => `${x.key} ${x.percent}%`).join(', ') : `not usable: ${r.problems.join('; ')}`);

/** Why no run may start on this reading (null when one may): the reading itself, or a meter at the guard or above. */
export function meterStop(r: Reading, maxPercent: number): string | null {
  if (!r.ok) return `the /usage reading is not usable: ${r.problems.join('; ')}`;
  const high = r.rows.find(x => x.percent >= maxPercent);
  return high ? `${high.key} is at ${high.percent}%: no run starts at ${maxPercent}% or more${high.resetsAt ? ` (it resets ${high.resetsAt})` : ''}` : null;
}

/** Each meter's change between the reading before a run and the one after it; null when either is not usable. */
export function meterMoved(before: Reading | null, after: Reading | null): Record<string, MeterDelta> | null {
  return before?.ok && after?.ok ? meterDeltas(before, after) : null;
}
