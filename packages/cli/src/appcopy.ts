// Copy the bundled app into <home>/app (decision 192). The one-command install (`setup`) runs this so the
// daemon and proxy are spawned from a stable location the router owns, beside its config and token — not from
// wherever the CLI happened to run. That matters because `npx do-it-all-claude-code setup` runs from the npx
// cache, which is ephemeral (it can be cleared between the one-off setup and the next session's auto-start), and
// a Node version manager moves the global install folder when the user switches Node. `appLayout` then prefers
// this copy (core/layout.ts); `resolveHomeApp` reports it present.
//
// Packaged only: in the workspace there is no bundled dist to copy and `appLayout` uses the checkout in place, so
// this is a no-op. Bytes are compared and unchanged files skipped, so a repeat `setup`/`start` is cheap. Copies
// are additive (a downgrade may leave a newer file behind; harmless — spawning only needs dist/*.js).
//
// Only `dist/` and `package.json` are copied: that is all the spawn paths need, and the version is read from
// package.json. The plugin TEMPLATE for generating <home>/plugin
// still comes from the package (outside the home — review L5 forbids a template inside the router home).
import fs from 'node:fs';
import path from 'node:path';
import { homeAppDir, resolveLayout, routerHome } from '@do-it-all-claude-code/core';

/**
 * Recursively copy `from` into `to`, writing only files whose bytes differ (atomic temp + rename, 0600 files /
 * 0700 dirs). A symlink at a destination path is removed first (never followed). Returns the files (re)written.
 */
export function copyTreeIfChanged(from: string, to: string): string[] {
  const written: string[] = [];
  const walk = (srcDir: string, dstDir: string): void => {
    fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, ent.name);
      const dstPath = path.join(dstDir, ent.name);
      if (ent.isDirectory()) { walk(srcPath, dstPath); continue; }
      if (!ent.isFile()) continue;                       // skip symlinks and special files in the source
      if (copyFileIfChanged(srcPath, dstPath)) written.push(dstPath);
    }
  };
  walk(from, to);
  return written;
}

/** Copy one file the way copyTreeIfChanged does (skip when the bytes match, never follow a link). True when written. */
export function copyFileIfChanged(srcPath: string, dstPath: string): boolean {
  const data = fs.readFileSync(srcPath);
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(dstPath); } catch { /* missing */ }
  if (st?.isSymbolicLink()) { fs.rmSync(dstPath, { force: true }); st = null; }   // never follow a link
  if (st?.isFile()) { try { if (fs.readFileSync(dstPath).equals(data)) return false; } catch { /* rewrite */ } }
  fs.mkdirSync(path.dirname(dstPath), { recursive: true, mode: 0o700 });
  const tmp = `${dstPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, dstPath);
  return true;
}

export interface AppCopyResult {
  /** True when a copy was made (packaged); false in the workspace (nothing to copy). */
  copied: boolean;
  /** <home>/app, whether or not a copy was made. */
  root: string;
  /** Files (re)written this run. */
  written: string[];
}

/**
 * Copy this install's bundled `dist/` and its `package.json` into <home>/app. A no-op in the workspace. Run by
 * `setup` so the daemon and proxy spawn from a stable location the router owns.
 */
export function copyAppToHome(home: string = routerHome()): AppCopyResult {
  const src = resolveLayout(import.meta.url);
  const root = homeAppDir(home);
  if (src.mode !== 'packaged') return { copied: false, root, written: [] };
  return { copied: true, root, written: copyAppFiles(src.root, root) };
}

/**
 * The files of a packaged install the home copy needs: `dist/`, and `package.json`, which the CLI and the daemon
 * read their version from (`../package.json` beside `dist/`). Without it the copy reports 0.0.0, and an update
 * check offers the release that is already running (0.5.0).
 */
export function copyAppFiles(pkgRoot: string, appRoot: string): string[] {
  const written = copyTreeIfChanged(path.join(pkgRoot, 'dist'), path.join(appRoot, 'dist'));
  const pkgTo = path.join(appRoot, 'package.json');
  if (copyFileIfChanged(path.join(pkgRoot, 'package.json'), pkgTo)) written.push(pkgTo);
  return written;
}
