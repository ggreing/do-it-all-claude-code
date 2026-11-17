// The router's MCP server in a measured run (decision 213).
//
// A user's session with the plugin has the router's MCP server: its six tool definitions are in every call the
// lead makes, and the brief of a request of unclear size asks the lead to call one of them
// (router_report_triage). A run that leaves the server out measures less than a user pays and cannot take
// that path. So a router run loads the plugin's own declaration (plugin/.mcp.json), under the name a session
// gives it, which is the name the plugin's hooks and the daemon expect.
//
// Other MCP servers must stay out. The run has a config directory of its own, so there are no user servers
// to load; what the session did load is read from its first line, and a run with any other server, or without
// the router's, stops the measurement instead of being counted.
import { spawn } from 'node:child_process';
import type { StreamLine } from './phases.ts';

/** `mcp__plugin_<plugin>_<server>__`: how Claude Code names the tools of the plugin's server (core ROUTER_TOOL_PREFIX). */
export const ROUTER_TOOL_PREFIX = 'mcp__plugin_do-it-all-claude-code_router__';
/** The server's name in a session's list: "plugin:do-it-all-claude-code:router". */
const isRouterServer = (name: string) => /do-it-all-claude-code/.test(name) && /router/.test(name);

export interface McpSeen {
  /** False when the stream has no init line (claude did not start): nothing can be said. */
  seen: boolean;
  servers: Array<{ name: string; status: string }>;
  /** The router's tools in the session's tool list. */
  routerTools: number;
  /** Why this run is not the arrangement that was asked for; undefined when it is, or when nothing can be said. */
  problem?: string;
}

/** What the session loaded, from its init line, against what the run asked for. */
export function mcpSeen(lines: readonly StreamLine[], wantRouter: boolean): McpSeen {
  const init = lines.find(l => l.m.type === 'system' && l.m.subtype === 'init')?.m;
  if (!init) return { seen: false, servers: [], routerTools: 0 };
  const servers = (Array.isArray(init.mcp_servers) ? init.mcp_servers : [])
    .map(s => ({ name: String((s as { name?: unknown })?.name ?? ''), status: String((s as { status?: unknown })?.status ?? '') }));
  const routerTools = (Array.isArray(init.tools) ? init.tools : []).filter(t => typeof t === 'string' && t.startsWith(ROUTER_TOOL_PREFIX)).length;
  const others = servers.filter(s => !isRouterServer(s.name)).map(s => s.name);
  const router = servers.find(s => isRouterServer(s.name));
  const list = servers.map(s => `${s.name} (${s.status})`).join(', ') || 'none';
  let problem: string | undefined;
  if (others.length) problem = `other MCP servers are in the session: ${others.join(', ')}`;
  else if (!wantRouter && router) problem = `the router's MCP server is in a run that asked for none (${list})`;
  else if (wantRouter && !router) problem = `the router's MCP server is not in the session (mcp_servers: ${list})`;
  else if (wantRouter && router && /fail|error/i.test(router.status)) problem = `the router's MCP server did not connect (${list})`;
  // connected, yet none of its tools is listed: the lead cannot call them (a server still connecting is not judged)
  else if (wantRouter && router && router.status === 'connected' && routerTools === 0) problem = `the router's MCP server is connected but its tools are not in the session's tool list (${list})`;
  return { seen: true, servers, routerTools, ...(problem ? { problem } : {}) };
}

export interface Preflight { tools: string[]; daemonAnswered: boolean; reply: string }

/**
 * Starts the plugin's MCP server as a session would (node <serverFile>, the run's environment), asks for its
 * tools and makes one read-only call without a session (router_get_plan). The daemon refuses that call, and
 * a refusal is the point: it shows the server reached the daemon. No request is opened and no model is called.
 */
export function routerMcpPreflight(serverFile: string, env: Record<string, string | undefined>, timeoutMs = 15_000): Promise<Preflight> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [serverFile], { env: env as NodeJS.ProcessEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const done = (fn: () => void) => { clearTimeout(timer); try { p.stdin.end(); } catch { /* ignore */ } try { p.kill(); } catch { /* ignore */ } fn(); };
    const timer = setTimeout(() => done(() => reject(new Error(`the router MCP server did not answer within ${timeoutMs} ms`))), timeoutMs);
    let buf = '';
    let tools: string[] | undefined;
    p.on('error', e => done(() => reject(e)));
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m: { id?: number; result?: { tools?: Array<{ name?: string }>; content?: Array<{ text?: string }>; isError?: boolean } };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) tools = (m.result?.tools ?? []).map(t => String(t.name ?? ''));
        if (m.id === 3) {
          const reply = (m.result?.content ?? []).map(c => c.text ?? '').join(' ').slice(0, 300);
          done(() => resolve({ tools: tools ?? [], daemonAnswered: !/daemon_unreachable/.test(reply), reply }));
        }
      }
    });
    const send = (msg: unknown) => p.stdin.write(JSON.stringify(msg) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench-preflight', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'router_get_plan', arguments: {} } });
  });
}
