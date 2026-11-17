// `do-it-all-claude-code project <enable|disable|status>` (decision 192, Q3). Whether a project isolates
// parallel subagent work in per-subtask git worktrees is no longer decided at install time. It is asked the
// first time the router delegates in a project (the lead asks the user); this command is how the answer is
// recorded and how it is turned on or off later.
//
//   enable   writes the worktree-isolation settings INTO the project (worktree.baseRef = "head" and the
//            ".claude/worktrees/" .gitignore line, shown first), and records 'on' in the router home.
//   disable  undoes those project settings and records 'off' (the team still works here; shared-tree edits
//            take turns — the existing overlapping-scope rule, decision 178).
//   status   prints the current state.
//
// The state lives in the router home (<home>/projects/<hash>.json), never in the project tree. Keyed by the
// git work-tree ROOT, the same key the daemon reads with getProjectWorktree, so a session opened in a subfolder
// is the same project.
import path from 'node:path';
import { getProjectWorktree, readProjectState, routerHome, workTreeRoot, writeProjectState } from '@do-it-all-claude-code/core';
import { planProject, type PlannedChange } from './setup.ts';
import { planProjectUndo } from './uninstall.ts';

export interface ProjectDeps {
  dir: string;
  ask(q: string): Promise<boolean>;
  isTTY: boolean;
  out(line: string): void;
  yes?: boolean;
  /** The router home; defaults to routerHome(). Injected by tests so they need not mutate the environment. */
  home?: string;
}

async function applyChanges(changes: PlannedChange[], d: ProjectDeps): Promise<boolean> {
  if (changes.length) {
    d.out('These files in your project will change:');
    for (const c of changes) d.out(`  - ${c.file}: ${c.summary}`);
    let go = d.yes === true;
    if (!go) {
      if (!d.isTTY) { d.out('Not a terminal: re-run with --yes.'); return false; }
      go = await d.ask('Apply? [Y/n] ');
    }
    if (!go) { d.out('Nothing changed.'); return false; }
    for (const c of changes) { try { c.apply(); } catch (e) { d.out(`Could not change ${c.file}: ${(e as Error).message}`); } }
  }
  return true;
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
      ? 'worktree isolation: on (subagents work in parallel, each in its own git worktree)'
      : w === 'off'
        ? 'worktree isolation: off (the team still works here; edits to the shared tree take turns)'
        : state
          ? 'worktree isolation: asked, not answered yet — `do-it-all-claude-code project enable` turns it on (or `disable` keeps it off)'
          : 'worktree isolation: not set yet — asked the first time the team is used here; `do-it-all-claude-code project enable` turns it on now');
    return 0;
  }
  if (sub === 'enable') {
    if (!await applyChanges(planProject(root), d)) return 1;
    const prev = readProjectState(root, home);
    writeProjectState({ path: root, worktree: 'on', ...(prev?.askedAt ? { askedAt: prev.askedAt } : {}), decidedAt: new Date().toISOString() }, home);
    d.out('Worktree isolation on: subagents work in parallel, each in its own git worktree.');
    return 0;
  }
  if (sub === 'disable') {
    if (!await applyChanges(planProjectUndo(root), d)) return 1;
    const prev = readProjectState(root, home);
    writeProjectState({ path: root, worktree: 'off', ...(prev?.askedAt ? { askedAt: prev.askedAt } : {}), decidedAt: new Date().toISOString() }, home);
    d.out('Worktree isolation off: the team still works here, but edits to the shared tree take turns.');
    return 0;
  }
  d.out('usage: do-it-all-claude-code project enable | disable | status');
  return 2;
}
