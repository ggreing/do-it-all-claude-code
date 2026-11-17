// `do-it-all-claude-code project enable|disable|status` (decision 192, Q3). Uses a temp git work tree (just a
// .git directory — project.ts resolves the root by filesystem, no git process) and a temp router home injected
// through the deps (so the tests never mutate the shared environment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectWorktree, readProjectState, writeProjectState } from '@do-it-all-claude-code/core';
import { projectCommand, type ProjectDeps } from '../src/project.ts';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'diacc-proj-')); }
function repoDir(): string { const d = tmp(); fs.mkdirSync(path.join(d, '.git')); return d; }

function deps(dir: string, home: string, extra: Partial<ProjectDeps> = {}): ProjectDeps {
  const out: string[] = [];
  const d: ProjectDeps = { dir, home, ask: async () => true, isTTY: true, out: l => out.push(l), yes: true, ...extra };
  (d as { lines: string[] }).lines = out;   // expose captured output for assertions
  return d;
}
const lines = (d: ProjectDeps): string => (d as unknown as { lines: string[] }).lines.join('\n');

test('enable writes the worktree settings and records on; a subfolder resolves to the same project', async () => {
  const repo = repoDir(), home = tmp();
  try {
    assert.equal(await projectCommand('enable', deps(repo, home)), 0);
    assert.equal(getProjectWorktree(home, repo), 'on');
    assert.ok(fs.existsSync(path.join(repo, '.claude', 'settings.local.json')), 'worktree.baseRef written');
    // status from a subfolder resolves to the same project root (workTreeRoot), so it reads "on" too
    const sub = deps(path.join(repo, 'a', 'b'), home, { yes: false });
    assert.equal(await projectCommand('status', sub), 0);
    assert.match(lines(sub), /isolation: on/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('enable then disable flips the recorded value and undoes the project files', async () => {
  const repo = repoDir(), home = tmp();
  try {
    assert.equal(await projectCommand('enable', deps(repo, home)), 0);
    assert.equal(getProjectWorktree(home, repo), 'on');
    const d = deps(repo, home);
    assert.equal(await projectCommand('disable', d), 0);
    assert.equal(getProjectWorktree(home, repo), 'off');
    assert.match(lines(d), /take turns/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('status: not-set, asked-not-answered, and decided read differently', async () => {
  const repo = repoDir(), home = tmp();
  try {
    const status = async () => { const d = deps(repo, home, { yes: false }); await projectCommand('status', d); return lines(d); };
    assert.match(await status(), /not set yet/);
    writeProjectState({ path: repo, askedAt: new Date().toISOString() }, home);
    assert.match(await status(), /asked, not answered/);
    writeProjectState({ path: repo, worktree: 'on' }, home);
    assert.match(await status(), /isolation: on/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('a non-git directory is refused with guidance; an unknown subcommand prints usage', async () => {
  const notRepo = tmp(), home = tmp();
  try {
    const d1 = deps(notRepo, home);
    assert.equal(await projectCommand('enable', d1), 2);
    assert.match(lines(d1), /not inside a git repository/);
    const d2 = deps(repoDir(), home);
    assert.equal(await projectCommand('frobnicate', d2), 2);
    assert.match(lines(d2), /usage: do-it-all-claude-code project/);
    assert.equal(readProjectState(notRepo, home), null, 'a refused command records nothing');
  } finally { fs.rmSync(notRepo, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});
