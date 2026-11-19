// Runs claude with --output-format stream-json and stamps every line with the milliseconds since the process was
// started, as it arrives (decision 174: the phase timings come from these stamps). The final result message is the
// same object `--output-format json` prints, so callers keep reading total_cost_usd, modelUsage and num_turns from it.
// The stream is kept (redacted) next to the run's record when `streamFile` is given.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../secrets.ts';
import type { StreamLine } from './phases.ts';

/** Flags that make the stream carry what the phase timings need: hook start and end, and the workers' messages. */
export const TIMING_FLAGS = ['--output-format', 'stream-json', '--verbose', '--include-hook-events', '--forward-subagent-text'];

/** The claude command: BENCH_CLAUDE_BIN when set (a script runs with this node), else "claude" on the PATH. */
export function claudeBin(env: NodeJS.ProcessEnv = process.env): { cmd: string; prefix: string[] } {
  const bin = env.BENCH_CLAUDE_BIN;
  if (!bin) return { cmd: 'claude', prefix: [] };
  return /\.(mjs|cjs|js|ts)$/.test(bin) ? { cmd: process.execPath, prefix: [bin] } : { cmd: bin, prefix: [] };
}

export interface KilledWorker { taskId: string; agent: string | null; description: string | null; atSeconds: number }

/**
 * The workers Claude Code stopped before they finished: a `task_updated` line that sets a task's status to
 * "killed", for a task that started as an agent (a shell command of a worker is not a worker). Such a worker's
 * change may be half made, and no SubagentStop hook ran for it, so the router's ledger has no stop, no verify and
 * no full cost for it.
 */
export function killedWorkers(lines: readonly StreamLine[]): KilledWorker[] {
  const started = new Map<string, { type: string | null; agent: string | null; description: string | null }>();
  const killed: KilledWorker[] = [];
  const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  for (const l of lines) {
    const m = l.m;
    if (m.type !== 'system' || typeof m.task_id !== 'string') continue;
    if (m.subtype === 'task_started') started.set(m.task_id, { type: text(m.task_type), agent: text(m.subagent_type), description: text(m.description) });
    if (m.subtype !== 'task_updated' || (m.patch as { status?: unknown } | null)?.status !== 'killed') continue;
    const s = started.get(m.task_id);
    const isAgent = s ? s.type === 'local_agent' || (s.type === null && s.agent !== null) : true;   // a task with no start line is kept: better one too many
    if (isAgent && !killed.some(k => k.taskId === m.task_id)) killed.push({ taskId: m.task_id, agent: s?.agent ?? null, description: s?.description ?? null, atSeconds: Math.round(l.t / 100) / 10 });
  }
  return killed;
}

/**
 * The end of what the process wrote to stderr, for the run's record: redacted, and with the home folder written
 * as "~" (a record may be published). Undefined when it wrote nothing. Claude Code says there, among other things,
 * that it stopped background tasks.
 */
export function stderrTail(stderr: string, max = 600, home: string = os.homedir()): string | undefined {
  let s = redact(stderr);
  for (const h of new Set([home, home.replace(/\\/g, '/')])) if (h.length > 3) s = s.split(h).join('~');
  s = s.trim();
  return s ? s.slice(-max) : undefined;
}

export interface Captured { code: number | null; lines: StreamLine[]; result: Record<string, unknown> | null; ms: number; timedOut: boolean; stderr: string; startedAt: string }

export function runCaptured(cmd: string, args: string[], o: { cwd: string; env: Record<string, string>; input: string; timeoutSec: number; streamFile?: string }): Promise<Captured> {
  return new Promise(resolve => {
    const t0 = Date.now();
    const startedAt = new Date(t0).toISOString();
    if (o.streamFile) { fs.mkdirSync(path.dirname(o.streamFile), { recursive: true }); fs.writeFileSync(o.streamFile, ''); }
    const p = spawn(cmd, args, { cwd: o.cwd, env: o.env, windowsHide: true });
    const lines: StreamLine[] = [];
    let partial = '', stderr = '', timedOut = false;
    const take = (text: string, t: number) => {
      const s = text.trim();
      if (!s) return;
      let m: unknown;
      try { m = JSON.parse(s); } catch { return; }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      lines.push({ t, m: m as Record<string, unknown> });
      if (o.streamFile) fs.appendFileSync(o.streamFile, redact(JSON.stringify({ t, m })) + '\n');
    };
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => {
      const t = Date.now() - t0;
      const parts = (partial + d).split('\n');
      partial = parts.pop() ?? '';
      for (const part of parts) take(part, t);
    });
    p.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); else p.kill('SIGKILL');
    }, o.timeoutSec * 1000);
    p.on('error', e => { stderr += String(e); });
    p.on('close', code => {
      clearTimeout(timer);
      take(partial, Date.now() - t0);
      const result = [...lines].reverse().find(l => l.m.type === 'result')?.m ?? null;
      resolve({ code, lines, result, ms: Date.now() - t0, timedOut, stderr: stderr.slice(-1500), startedAt });
    });
    p.stdin.end(o.input);
  });
}
