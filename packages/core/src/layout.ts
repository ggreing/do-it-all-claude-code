// Packaged-vs-workspace layout resolver (one-command install; distribution note, option A). The same code
// runs from two trees:
//
//   workspace (dev / tsc):   <root>/packages/<pkg>/<src|dist>/<entry>.<ts|js>, plugin at <root>/plugin,
//                            proxy helpers at <root>/packages/proxy/bin/*.mjs
//   packaged (published npm): <root>/dist/{cli,proxy,daemon}.js and <root>/dist/*.mjs, plugin at
//                            <root>/plugin
//
// Callers resolve against their OWN module with resolveLayout(import.meta.url): the CLI finds the daemon and
// proxy entries it spawns and the helper scripts. This is pure path arithmetic — no filesystem access and
// nothing is executed — so it is cheap and fully testable for both layouts without a real install.
//
// It replaces the workspace-only guesses the CLI/daemon used before (import.meta.resolve of the sibling
// packages, ../../../plugin, proxyEntry -> src/main.ts), which do not hold once the
// three entries are bundled to flat files. Existence/trust checks stay with the caller; this only says where.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type LayoutMode = 'workspace' | 'packaged';

export interface ResolvedLayout {
  readonly mode: LayoutMode;
  /** The directory that holds `plugin/` (and `packages/` in the workspace). */
  readonly root: string;
  /** The runnable entries, as `node <entry>` arguments. */
  readonly cliEntry: string;
  readonly daemonEntry: string;
  readonly proxyEntry: string;
  /** The plugin template folder shipped with the product (the `init`/`start` default template dir). */
  readonly pluginTemplateDir: string;
  /** API-key mode helper scripts (apiKeyHelper targets). */
  readonly localTokenHelper: string;
  readonly keyHelper: string;
}

// A workspace module lives at <root>/packages/<pkg>/(src|dist)/…; anything else is treated as the packaged
// (flat) layout. The regex matches the module's directory, so the package segment and the src|dist segment
// must both be present — a plain `<root>/dist` (packaged) does not match.
const WORKSPACE_DIR = /[\\/]packages[\\/][^\\/]+[\\/](src|dist)$/;

/**
 * Resolve every product path for the layout the given module is running in. `moduleUrl` is the caller's
 * `import.meta.url`. `exists` is injectable for tests; by default a workspace is confirmed on disk (review L4:
 * a `<root>/packages/<pkg>/src` path alone, e.g. `~/packages/foo/src`, is not taken for the workspace unless
 * `<root>/packages/cli` is actually there).
 */
export function resolveLayout(moduleUrl: string, exists: (p: string) => boolean = fs.existsSync): ResolvedLayout {
  const dir = path.dirname(fileURLToPath(moduleUrl));
  const m = WORKSPACE_DIR.exec(dir);
  const wsRoot = m ? path.resolve(dir, '..', '..', '..') : '';
  if (m && exists(path.join(wsRoot, 'packages', 'cli'))) {
    // workspace: dir = <root>/packages/<pkg>/<sub>. The compiled ext follows the sub-folder (src -> .ts via
    // Node type stripping, dist -> .js from `tsc -b`), mirroring the running module.
    const sub = m[1] as 'src' | 'dist';
    const ext = sub === 'src' ? 'ts' : 'js';
    const root = wsRoot;
    const pkg = (name: string) => path.join(root, 'packages', name);
    const entry = (name: string, file: string) => path.join(pkg(name), sub, `${file}.${ext}`);
    return {
      mode: 'workspace',
      root,
      cliEntry: entry('cli', 'index'),
      daemonEntry: entry('daemon', 'main'),
      proxyEntry: entry('proxy', 'main'),
      pluginTemplateDir: path.join(root, 'plugin'),
      localTokenHelper: path.join(pkg('proxy'), 'bin', 'local-token.mjs'),
      keyHelper: path.join(pkg('proxy'), 'bin', 'key-helper.mjs'),
    };
  }
  // packaged: dir = <root>/dist, everything bundled flat beside the entries.
  const distDir = dir;
  const root = path.resolve(distDir, '..');
  return {
    mode: 'packaged',
    root,
    cliEntry: path.join(distDir, 'cli.js'),
    daemonEntry: path.join(distDir, 'daemon.js'),
    proxyEntry: path.join(distDir, 'proxy.js'),
    pluginTemplateDir: path.join(root, 'plugin'),
    localTokenHelper: path.join(distDir, 'local-token.mjs'),
    keyHelper: path.join(distDir, 'key-helper.mjs'),
  };
}
