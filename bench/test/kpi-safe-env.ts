// The environment of a measurement script started by a test. A test must never reach the user's Claude Code:
// the router's `init` can run `claude plugin marketplace add`, which writes the user's settings. So the child
// gets (1) a CLAUDE_CONFIG_DIR inside the test's temp folder and (2) a `claude` first on its PATH that only
// records how it was called (with the CLAUDE_CONFIG_DIR it was given) and prints a version. The run itself uses
// BENCH_CLAUDE_BIN (bench/test/kpi-fake-claude.mjs), not the PATH.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface SafeEnv { env: NodeJS.ProcessEnv; calls(): Array<{ configDir: string; args: string }> }

export function safeEnv(tmp: string, name: string, extra: Record<string, string> = {}): SafeEnv {
  const dir = path.join(tmp, `claude-on-path-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\n>>"%~dp0calls.log" echo %CLAUDE_CONFIG_DIR%^|%*\r\necho 2.1.326 (Claude Code)\r\nexit /b 0\r\n');
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\necho "${CLAUDE_CONFIG_DIR}|$*" >> "$(dirname "$0")/calls.log"\necho "2.1.326 (Claude Code)"\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, CLAUDE_CONFIG_DIR: path.join(tmp, `claude-config-${name}`) };
  // Windows names the variable Path; setting PATH beside it would leave two
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  env[key] = `${dir}${path.delimiter}${env[key] ?? ''}`;
  return {
    env,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => { const i = l.indexOf('|'); return { configDir: l.slice(0, i).trim(), args: l.slice(i + 1).trim() }; }) : []),
  };
}

/**
 * A port nothing listens on, for the daemon of one test's router home (--daemon-port). The router's init picks the
 * first free port from 47800 on, and the daemon binds it only later, at start: test files that run side by side
 * all pick the same one, and every daemon but the first fails to start. The operating system hands out a
 * different port to each caller here.
 */
export function freePort(): number {
  const r = spawnSync(process.execPath, ['-e', "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});"], { encoding: 'utf8', timeout: 30_000 });
  const port = Number(r.stdout.trim());
  if (!(Number.isInteger(port) && port >= 1024)) throw new Error(`no free port (${r.stderr.trim() || r.stdout.trim() || 'no output'})`);
  return port;
}

/** What a router run may have asked the `claude` on the PATH: its version, with the CLI's own config folder; never `plugin`. */
export function noPluginCalls(calls: Array<{ configDir: string; args: string }>): string | undefined {
  const bad = calls.find(c => /\bplugin\b/.test(c.args));
  return bad ? `claude ${bad.args} (CLAUDE_CONFIG_DIR ${bad.configDir || 'not set'})` : undefined;
}
