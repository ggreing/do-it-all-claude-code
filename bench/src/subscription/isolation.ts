// How a subscription-mode run is started. The user's own Claude Code login is used as configured: no --bare (it
// never reads the login) and no CLAUDE_CONFIG_DIR of ours (the login lives in the user's config). The harness never
// reads, copies or passes on a credential: the child gets an allow-listed environment (so ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN and the like never reach it, and the init message's apiKeySource must
// say "none", a claude.ai login), and Claude Code reads its own login.
//
// What keeps a run from using or touching the user's setup otherwise:
//  - --setting-sources project,local: the user's settings.json (hooks, enabled plugins, status line, env, permission
//    rules, apiKeyHelper, model) is not loaded; the workspace is a fresh fixture with no .claude folder
//  - CLAUDE_CODE_DISABLE_CLAUDE_MDS, CLAUDE_CODE_DISABLE_AUTO_MEMORY: no CLAUDE.md or auto memory is read or written
//  - --no-session-persistence, CLAUDE_CODE_SKIP_PROMPT_HISTORY: no transcript or prompt history on disk
//  - ENABLE_CLAUDEAI_MCP_SERVERS=false, and --strict-mcp-config in the direct arm: no MCP servers (the router arm
//    loads only the plugin's own; --strict-mcp-config would drop that too, so another server there is refused)
//  - DISABLE_AUTOUPDATER: the Claude Code version cannot change in the middle of a measurement
//  - permissions as the API bench has them: credential reads and environment dumps denied, no web tools, Bash only
//    for listed commands, acceptEdits
//  - one fixed workspace path for every run, so Claude Code keeps at most one project entry for it
// Telemetry is left as the user has it: DISABLE_TELEMETRY also turns off feature flags, which would make the run
// unlike the user's normal sessions (and usage_report is experimental).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASH_ALLOW, CREDENTIAL_DENY, TOOLS } from '../secrets.ts';
import type { InitInfo } from './stream.ts';

export type Arm = 'direct' | 'router';
export const ARMS: readonly Arm[] = ['direct', 'router'];
export const ROUTER_PLUGIN = 'do-it-all-claude-code';
export const ROUTER_TOOLS_RULE = 'mcp__plugin_do-it-all-claude-code_router__*';
export const DEFAULT_SETTING_SOURCES = 'project,local';
export const PROBE = fileURLToPath(new URL('./statusline-probe.mjs', import.meta.url));

const ENV_ALLOW = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'USERNAME', 'LOGNAME',
  'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR',
  // the user's own choices, passed on as they are (never set by the harness)
  'CLAUDE_CONFIG_DIR', 'DISABLE_TELEMETRY', 'DO_NOT_TRACK',
];

/** The child's environment: allow-listed, plus the switches above. The router arm also gets the router home's location. */
export function subscriptionEnv(arm: Arm, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) { const v = parent[k]; if (v !== undefined) env[k] = v; }
  if (arm === 'router' && parent.DO_IT_ALL_CLAUDE_CODE_HOME) env.DO_IT_ALL_CLAUDE_CODE_HOME = parent.DO_IT_ALL_CLAUDE_CODE_HOME;
  Object.assign(env, {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1',
  });
  return env;
}

/** Settings passed with --settings: the credential deny rules, and a status line that only records rate_limits. */
export function subscriptionSettings(probeOut: string): string {
  return JSON.stringify({
    permissions: { deny: CREDENTIAL_DENY },
    statusLine: { type: 'command', command: `node "${PROBE}" "${probeOut}"` },
    autoMemoryEnabled: false,
  });
}

export interface ArmOptions { arm: Arm; pluginDir?: string; settingSources: string; probeOut: string }

function common(o: ArmOptions): string[] {
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--setting-sources', o.settingSources, '--settings', subscriptionSettings(o.probeOut),
    ...(o.arm === 'router' ? ['--plugin-dir', o.pluginDir ?? ''] : ['--strict-mcp-config']),
  ];
}

/**
 * A meter reading: `/usage` as the prompt, the documented `claude -p "/usage"` form, right after -p so no list-taking
 * flag reads it. Claude Code answers it itself; the caps are there in case it does not.
 */
export function meterArgs(o: ArmOptions): string[] {
  return ['-p', '/usage', ...common(o).slice(1), '--model', 'claude-haiku-5-5', '--max-turns', '1', '--max-budget-usd', '0.05', '--tools', ''];
}

/** A task run: the lead model and effort, the API bench's per-level cap, its tools and permission rules. */
export function taskArgs(o: ArmOptions, lead: { model: string; effort: string }, capUsd: number): string[] {
  const tools = o.arm === 'router' ? `${TOOLS},Agent` : TOOLS;
  const allowed = o.arm === 'router' ? [...BASH_ALLOW, 'Agent', ROUTER_TOOLS_RULE] : BASH_ALLOW;
  return [...common(o), '--model', lead.model, '--effort', lead.effort, '--max-budget-usd', String(capUsd),
    '--permission-mode', 'acceptEdits', '--tools', tools, '--allowedTools', ...allowed];
}

/**
 * What a run's init message must show: the subscription login (apiKeySource "none"); in the direct arm neither the
 * router plugin nor its MCP server, in the router arm both; in either arm no other plugin the user installed and no
 * other MCP server. Claude Code's built-in plugins (cc-plugin-*) are a baseline: allowed, recorded, and with
 * `builtinBaseline` (the first reading's set) required to be the same in every reading and run. Empty when it holds.
 */
export function loadoutProblems(init: InitInfo | null, arm: Arm, o: { lead?: { model: string }; builtinBaseline?: string[] | null } = {}): string[] {
  if (!init) return ['no init message: Claude Code did not print stream-json (is it too old, or did it fail to start?)'];
  const p: string[] = [];
  if (init.apiKeySource !== 'none') p.push(`apiKeySource is ${JSON.stringify(init.apiKeySource)}: the run would not use the subscription login`);
  const builtin = new Set(init.builtinPlugins);
  const others = init.plugins.filter(n => n !== ROUTER_PLUGIN && !builtin.has(n));
  if (others.length) p.push(`other plugins loaded: ${others.join(', ')}`);
  if (o.builtinBaseline && init.builtinPlugins.join(',') !== [...o.builtinBaseline].sort().join(',')) {
    p.push(`Claude Code's built-in plugins differ from the first reading (${init.builtinPlugins.join(', ') || 'none'} instead of ${o.builtinBaseline.join(', ') || 'none'})`);
  }
  const ofBuiltin = (name: string) => [...builtin].some(b => name.includes(b));
  const routerMcp = init.mcpServers.filter(s => s.name.includes(ROUTER_PLUGIN));
  const otherMcp = init.mcpServers.filter(s => !s.name.includes(ROUTER_PLUGIN) && !ofBuiltin(s.name));
  if (otherMcp.length) p.push(`other MCP servers loaded: ${otherMcp.map(s => s.name).join(', ')} (turn them off for the measurement)`);
  if (arm === 'direct') {
    if (init.plugins.includes(ROUTER_PLUGIN)) p.push('the router plugin is loaded in the direct arm');
    if (routerMcp.length) p.push('the router MCP server is loaded in the direct arm');
  } else {
    if (!init.plugins.includes(ROUTER_PLUGIN)) p.push('the router plugin did not load');
    if (!routerMcp.length) p.push('the router MCP server is missing');
    for (const s of routerMcp) if (/fail/i.test(s.status)) p.push(`the router MCP server ${s.name}: ${s.status}`);
  }
  for (const e of init.pluginErrors) p.push(`plugin error: ${e}`);
  if (o.lead && init.model && !init.model.startsWith(o.lead.model)) p.push(`the session model is ${init.model}, not ${o.lead.model}`);
  return p;
}

/** The fixed workspace every subscription run uses (inside the results folder). */
export const workspaceRoot = (resultsDir: string): string => path.join(resultsDir, 'ws');
