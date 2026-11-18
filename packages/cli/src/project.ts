// `do-it-all-claude-code project <enable|disable|status>` (decision 192, Q3). Whether a project isolates
// parallel subagent work in per-subtask git worktrees is asked the first time the router delegates there (the
// lead asks the user and applies it with the router MCP tool `router_project_isolation`). This command is the
// terminal alternative, and how to turn it on or off later.
//
//   enable   turns worktree isolation on (writes worktree.baseRef + the ".claude/worktrees/" .gitignore line),
//   disable  turns it off (removes them; the team still works here, shared-tree edits take turns),
//   status   prints the current state.
//
// The file writes and the router-home state are the shared core `setProjectWorktree`, so this and the MCP tool
// never diverge. The state lives in the router home, keyed by the git work-tree ROOT, never in the project tree.
import path from 'node:path';
import { getProjectWorktree, readProjectState, routerHome, setProjectWorktree, workTreeRoot } from '@do-it-all-claude-code/core';

export interface ProjectDeps {
  dir: string;
  ask(q: string): Promise<boolean>;
  isTTY: boolean;
  out(line: string): void;
  yes?: boolean;
  /** The router home; defaults to routerHome(). Injected by tests so they need not mutate the environment. */
  home?: string;
}

async function confirmAndApply(root: string, enable: boolean, home: string, d: ProjectDeps): Promise<number> {
  const plan = setProjectWorktree(root, enable, home, { dryRun: true });
  if (!plan.changed.length) {
    setProjectWorktree(root, enable, home);   // record the choice even when the project files already match
    d.out(enable ? 'Worktree isolation is already on.' : 'Worktree isolation is already off (edits to the shared tree take turns).');
    return 0;
  }
  d.out('These files in your project will change:');
  for (const f of plan.changed) d.out(`  - ${f}`);
  let go = d.yes === true;
  if (!go) {
    if (!d.isTTY) { d.out('Not a terminal: re-run with --yes.'); return 1; }
    go = await d.ask('Apply? [Y/n] ');
  }
  if (!go) { d.out('Nothing changed.'); return 1; }
  setProjectWorktree(root, enable, home);
  d.out(enable
    ? 'Worktree isolation on: writers sent together may each get a git worktree when none needs an uncommitted file (writers share one checkout either way).'
    : 'Worktree isolation off: the team still works here, but edits to the shared tree take turns.');
  return 0;
}

export async function projectCommand(sub: string | undefined, d: ProjectDeps): Promise<number> {
  const home = d.home ?? routerHome();
  const root = workTreeRoot(d.dir);
  if (sub !== 'enable' && sub !== 'disable' && sub !== 'status') {
    d.out('usage: do-it-all-claude-code project enable | disable | status');
    return 2;
  }
  if (!root) {
    d.out(`${path.resolve(d.dir)} is not inside a git repository; worktree isolation (and so project setup) needs git. Run this from a git project, or `
      + '`git init` here first.');
    return 2;
  }
  if (sub === 'status') {
    const state = readProjectState(root, home);
    const w = getProjectWorktree(home, root);
    d.out(`project: ${root}`);
    d.out(w === 'on'
      ? 'worktree isolation: on (writers sent together may each get a git worktree when none needs an uncommitted file; writers share one checkout either way)'
      : w === 'off'
        ? 'worktree isolation: off (the team still works here; edits to the shared tree take turns)'
        : state
          ? 'worktree isolation: asked, not answered yet — `do-it-all-claude-code project enable` turns it on (or `disable` keeps it off)'
          : 'worktree isolation: not set yet — asked the first time the team is used here; `do-it-all-claude-code project enable` turns it on now');
    return 0;
  }
  return confirmAndApply(root, sub === 'enable', home, d);
}
