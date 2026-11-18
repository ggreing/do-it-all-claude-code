// The `claude -p` command line of a measured run, shared by scripts/measure107.ts (one request per session) and
// scripts/measure-session.ts (several requests in one session), so both measure the same arrangement.
import { TIMING_FLAGS } from './capture.ts';

/**
 * What a run may do without a permission prompt (a -p run denies everything else).
 * Decision 222: `echo`, `pwd` and `wc` are here because workers ask for them and a -p run refused them, while a
 * user at the terminal allows such commands; the measurements before decision 222 ran without the three.
 */
export const ALLOWED_TOOLS = ['Agent', 'Bash(npm *)', 'Bash(node *)', 'Bash(npx tsc *)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)',
  'Bash(git show*)', 'Bash(git add*)', 'Bash(git commit*)', 'Bash(git merge*)', 'Bash(git worktree*)', 'Bash(git branch*)',
  'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(grep *)', 'Bash(cd *)', 'Bash(python *)', 'Bash(pytest *)',
  'Bash(echo *)', 'Bash(pwd)', 'Bash(wc *)'];
/** The three commands decision 222 added, for the plan line and the record. */
export const ALLOWED_SINCE_222 = ['Bash(echo *)', 'Bash(pwd)', 'Bash(wc *)'];

// -p ends the session when the lead's turn ends; in the first measurement one lead ended 2 s after launching a
// background worker, which was then cut off. Interactive sessions do not have this problem. Every run that has
// the Agent tool gets the line, so both sides of a comparison carry the same text.
export const WAIT_FOR_SUBAGENTS = 'This is a non-interactive run: before you give your final answer, wait until every subagent you started has finished and you have read its result.';

export interface RunArgs {
  lead: string;
  effort: string;
  capUsd: number;
  /** --settings JSON (the key helper and the credential deny rules). */
  settings: string;
  /** The plugin folder of a router arrangement; undefined for router off. */
  pluginDir?: string;
  /** Router off with the Agent tool (decision 213); a router arrangement always has it. */
  agentTool: boolean;
  /** --strict-mcp-config: router off, or a router arrangement without the router's MCP server (decision 213). */
  strictMcp: boolean;
  /** A session of several steps (decision 221): the first step names the session id, the others resume it. */
  session?: { id: string; resume: boolean };
}

export function claudeArgs(o: RunArgs): string[] {
  const args = ['-p', ...(o.pluginDir ? ['--plugin-dir', o.pluginDir] : []), ...TIMING_FLAGS, '--model', o.lead, '--effort', o.effort, '--max-budget-usd', String(o.capUsd),
    '--permission-mode', 'acceptEdits', ...(o.strictMcp ? ['--strict-mcp-config'] : []), '--setting-sources', 'project,local', '--settings', o.settings,
    '--tools', o.agentTool ? 'Read,Edit,Write,Glob,Grep,Bash,Agent' : 'Read,Edit,Write,Glob,Grep,Bash',
    '--allowedTools', ...ALLOWED_TOOLS];
  if (o.agentTool) args.push('--append-system-prompt', WAIT_FOR_SUBAGENTS);
  if (o.session) args.push(...(o.session.resume ? ['--resume', o.session.id] : ['--session-id', o.session.id]));
  return args;
}
