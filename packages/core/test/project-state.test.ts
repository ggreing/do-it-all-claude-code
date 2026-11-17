// Per-project setup state (decision 192, Q3): the key, the read/write, and getProjectWorktree's three states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectWorktree, projectKey, projectStateFile, readProjectState, workTreeRoot, writeProjectState } from '../src/project-state.ts';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'diacc-ps-')); }

test('projectKey: same root maps to one key regardless of trailing slash / separators (and case on Windows)', () => {
  const a = path.resolve('/tmp/proj');
  assert.equal(projectKey(a), projectKey(a + path.sep));
  assert.equal(projectKey(a), projectKey(a + '/'));
  if (process.platform === 'win32') assert.equal(projectKey('C:\\Repo\\App'), projectKey('c:/repo/app'));
  assert.match(projectKey(a), /^[0-9a-f]{16}$/);
});

test('getProjectWorktree: null when never asked, null when asked-but-undecided, then the decided value', () => {
  const home = tmp();
  try {
    const root = path.resolve('/tmp/proj-x');
    assert.equal(getProjectWorktree(home, root), null, 'no file -> null');
    assert.equal(readProjectState(root, home), null);

    writeProjectState({ path: root, askedAt: '2026-11-17T00:00:00.000Z' }, home);   // asked, not answered
    assert.equal(getProjectWorktree(home, root), null, 'asked but undecided -> null');
    assert.ok(readProjectState(root, home), 'but the record exists (so the daemon does not re-ask)');

    writeProjectState({ path: root, worktree: 'on', askedAt: '2026-11-17T00:00:00.000Z', decidedAt: '2026-11-17T01:00:00.000Z' }, home);
    assert.equal(getProjectWorktree(home, root), 'on');
    writeProjectState({ path: root, worktree: 'off' }, home);
    assert.equal(getProjectWorktree(home, root), 'off');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the state file lives in <home>/projects, keyed by the root, 0600', () => {
  const home = tmp();
  try {
    const root = path.resolve('/tmp/proj-y');
    writeProjectState({ path: root, worktree: 'off' }, home);
    const file = projectStateFile(root, home);
    assert.equal(path.dirname(file), path.join(home, 'projects'));
    assert.ok(fs.existsSync(file));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('workTreeRoot: the nearest ancestor with a .git, or undefined outside a repo', () => {
  const dir = tmp();
  try {
    const repo = path.join(dir, 'repo');
    const sub = path.join(repo, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(workTreeRoot(sub), undefined, 'no .git yet');
    fs.mkdirSync(path.join(repo, '.git'));
    assert.equal(workTreeRoot(sub), repo, 'found from a subfolder');
    assert.equal(workTreeRoot(repo), repo);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readProjectState tolerates a corrupt file (returns null)', () => {
  const home = tmp();
  try {
    const root = path.resolve('/tmp/proj-z');
    fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
    fs.writeFileSync(projectStateFile(root, home), 'not json');
    assert.equal(readProjectState(root, home), null);
    assert.equal(getProjectWorktree(home, root), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
