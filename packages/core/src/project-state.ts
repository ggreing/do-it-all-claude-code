// Per-project setup state (decision 192, Q3). Whether a project uses git-worktree isolation for parallel
// subagent work is no longer decided at install time. It is asked ONCE, the first time the router delegates in
// that project: the lead asks the user, and `do-it-all-claude-code project enable` (accept) or a recorded
// decline writes the answer here. Until then there is no file and the state is null ("not asked yet").
//
// The state lives in the ROUTER HOME, never in the user's project — the project tree is left untouched until the
// user accepts (only then are worktree.baseRef and the .gitignore line written, by the CLI). One file per
// project, keyed by the project's WORK-TREE ROOT path, so a session opened in a subfolder maps to the same
// project. The daemon reads this (getProjectWorktree) to decide whether to isolate; the CLI writes it.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { routerHome } from './paths.ts';

/** Whether a project isolates parallel work in per-subtask git worktrees. */
export type Worktree = 'on' | 'off';

export interface ProjectState {
  /** The project's work-tree root (absolute), kept for readability and to show which project a file is for. */
  path: string;
  /** The decided setting; undefined means "asked but not answered yet" (the router then treats it as off). */
  worktree?: Worktree;
  /** When the user was first asked (ISO), and when they answered. */
  askedAt?: string;
  decidedAt?: string;
  /** How it was decided: by the user (tool/CLI) or inferred from the project's existing settings (decision 192). */
  source?: 'user' | 'project-settings';
}

/**
 * The git work-tree root for `dir` (the nearest ancestor with a `.git`), or undefined when `dir` is not inside
 * a git repository. Filesystem-only (no `git` process). This is the key path for a project's state, so the CLI
 * (`project`), the daemon (first-delegation prompt) and the office all resolve it the same way and agree.
 */
export function workTreeRoot(dir: string): string | undefined {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

/**
 * Whether the project already has git-worktree isolation set up in its Claude Code settings — worktree.baseRef in
 * .claude/settings.local.json or .claude/settings.json (written by an earlier `init`, or by hand). When it does,
 * the router does not ask again (decision 192); it records the choice as already decided.
 */
export function projectHasWorktreeBaseRef(root: string): boolean {
  for (const name of ['settings.local.json', 'settings.json']) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(root, '.claude', name), 'utf8').replace(/^﻿/, '')) as { worktree?: { baseRef?: unknown } };
      if (s?.worktree && typeof s.worktree.baseRef === 'string' && s.worktree.baseRef) return true;
    } catch { /* missing or unparseable: look at the next file */ }
  }
  return false;
}

export const projectsDir = (home: string = routerHome()): string => path.join(home, 'projects');

/**
 * A stable file key for a project, from its work-tree root path. The path is resolved, its separators and any
 * trailing slash normalised, and lower-cased on Windows (its file system is case-insensitive), so the same root
 * always maps to one file. The hash keeps the file name short and free of path characters.
 */
export function projectKey(projectPath: string): string {
  let norm = path.resolve(projectPath).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') norm = norm.toLowerCase();
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

export const projectStateFile = (projectPath: string, home: string = routerHome()): string =>
  path.join(projectsDir(home), `${projectKey(projectPath)}.json`);

/** The recorded state for a project, or null when there is no file for it (never asked). A file with no decided
 *  `worktree` (asked, not answered) is still returned — so the daemon does not ask again. */
export function readProjectState(projectPath: string, home: string = routerHome()): ProjectState | null {
  try {
    const s = JSON.parse(fs.readFileSync(projectStateFile(projectPath, home), 'utf8')) as ProjectState;
    return s && typeof s.path === 'string' ? s : null;
  } catch { return null; }
}

/**
 * Whether a project isolates parallel work: 'on' / 'off', or null when it is not decided yet (never asked, or
 * asked and not answered). The daemon calls this at dispatch, and the office shows it; `home` is passed
 * explicitly because the daemon may serve more than the default.
 */
export function getProjectWorktree(home: string, projectPath: string): Worktree | null {
  const w = readProjectState(projectPath, home)?.worktree;
  return w === 'on' || w === 'off' ? w : null;
}

// --------------------------------------------------------------- applying the choice to the project (decision 192)
// The worktree-isolation settings written INTO the project when the user turns it on: worktree.baseRef = "head"
// (parallel workers branch from the current commit) and a ".claude/worktrees/" line in .gitignore. Turning it off
// removes both. This is the one writer, shared by the CLI (`project enable|disable`) and the router MCP tool
// (`router_project_isolation`), so the two never diverge. The caller has confirmed the change (a CLI prompt or
// Claude Code's tool-permission check); this just writes.

const WORKTREES_GITIGNORE_RE = /^\.claude\/worktrees\/?\r?$/m;

function readJsonObject(file: string): Record<string, any> {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}; }
  catch { return {}; }
}
function writeJsonObject(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export interface SetWorktreeResult { worktree: Worktree; changed: string[] }

/**
 * Turn git-worktree isolation on or off for a project and record the choice. `root` is the work-tree root.
 * Returns the project files it changed (absolute paths). With `dryRun`, it writes nothing and returns the files
 * that WOULD change (for a confirmation prompt) — but never records state. The home state file is always updated
 * on a real run, even when no project file changed (so the project is not asked again).
 */
export function setProjectWorktree(root: string, enable: boolean, home: string = routerHome(), opts: { dryRun?: boolean } = {}): SetWorktreeResult {
  const changed: string[] = [];
  const local = path.join(root, '.claude', 'settings.local.json');
  const s = readJsonObject(local);
  const hasBaseRef = s.worktree?.baseRef === 'head';
  if (enable && !hasBaseRef) {
    changed.push(local);
    if (!opts.dryRun) writeJsonObject(local, { ...s, worktree: { ...(s.worktree ?? {}), baseRef: 'head' } });
  } else if (!enable && hasBaseRef) {
    changed.push(local);
    if (!opts.dryRun) {
      const worktree = { ...s.worktree }; delete worktree.baseRef;
      const next: Record<string, unknown> = { ...s };
      if (Object.keys(worktree).length) next.worktree = worktree; else delete next.worktree;
      writeJsonObject(local, next);
    }
  }
  const gi = path.join(root, '.gitignore');
  const text = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const hasLine = WORKTREES_GITIGNORE_RE.test(text);
  if (enable && !hasLine) {
    changed.push(gi);
    if (!opts.dryRun) fs.writeFileSync(gi, text + (text && !text.endsWith('\n') ? '\n' : '') + '.claude/worktrees/\n');
  } else if (!enable && hasLine) {
    changed.push(gi);
    if (!opts.dryRun) fs.writeFileSync(gi, text.replace(/^\.claude\/worktrees\/?\r?\n?/m, ''));
  }
  const worktree: Worktree = enable ? 'on' : 'off';
  if (!opts.dryRun) {
    const prev = readProjectState(root, home);
    writeProjectState({ path: root, worktree, ...(prev?.askedAt ? { askedAt: prev.askedAt } : {}), decidedAt: new Date().toISOString() }, home);
  }
  return { worktree, changed };
}

/** Record a project's answer (atomically, 0600). Creates the projects directory (0700) if needed. */
export function writeProjectState(state: ProjectState, home: string = routerHome()): void {
  const dir = projectsDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = projectStateFile(state.path, home);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
