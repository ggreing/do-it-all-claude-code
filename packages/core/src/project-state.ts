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

/** Record a project's answer (atomically, 0600). Creates the projects directory (0700) if needed. */
export function writeProjectState(state: ProjectState, home: string = routerHome()): void {
  const dir = projectsDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = projectStateFile(state.path, home);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
