// Layout resolver (one-command install): the CLI/daemon/proxy entries, plugin template, dashboard dist and
// helper scripts for both the workspace (dev/tsc) and the packaged (flat npm) trees. Pure path arithmetic, so
// these feed crafted import.meta.url values and assert the resolved paths — no real install, no filesystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveLayout } from '../src/layout.ts';

const WS = path.resolve('diacc-ws-root');      // absolute on the current OS
const PK = path.resolve('diacc-pkg-root');
const urlOf = (...segs: string[]) => pathToFileURL(path.join(...segs)).href;

// a workspace is confirmed by <root>/packages/cli existing; the tests feed synthetic paths, so they stub it.
const yes = () => true;

test('workspace (src): resolves every path from a .ts module, mirroring src/.ts', () => {
  const r = resolveLayout(urlOf(WS, 'packages', 'cli', 'src', 'index.ts'), yes);
  assert.equal(r.mode, 'workspace');
  assert.equal(r.root, WS);
  assert.equal(r.cliEntry, path.join(WS, 'packages', 'cli', 'src', 'index.ts'));
  assert.equal(r.daemonEntry, path.join(WS, 'packages', 'daemon', 'src', 'main.ts'));
  assert.equal(r.proxyEntry, path.join(WS, 'packages', 'proxy', 'src', 'main.ts'));
  assert.equal(r.pluginTemplateDir, path.join(WS, 'plugin'));
  assert.equal(r.localTokenHelper, path.join(WS, 'packages', 'proxy', 'bin', 'local-token.mjs'));
  assert.equal(r.keyHelper, path.join(WS, 'packages', 'proxy', 'bin', 'key-helper.mjs'));
});

test('workspace (dist): a tsc build resolves to dist/.js entries', () => {
  const r = resolveLayout(urlOf(WS, 'packages', 'daemon', 'dist', 'main.js'), yes);
  assert.equal(r.mode, 'workspace');
  assert.equal(r.root, WS);
  assert.equal(r.cliEntry, path.join(WS, 'packages', 'cli', 'dist', 'index.js'));
  assert.equal(r.daemonEntry, path.join(WS, 'packages', 'daemon', 'dist', 'main.js'));
  assert.equal(r.proxyEntry, path.join(WS, 'packages', 'proxy', 'dist', 'main.js'));
});

test('packaged: flat dist/ with plugin beside it', () => {
  const r = resolveLayout(urlOf(PK, 'dist', 'cli.js'));
  assert.equal(r.mode, 'packaged');
  assert.equal(r.root, PK);
  assert.equal(r.cliEntry, path.join(PK, 'dist', 'cli.js'));
  assert.equal(r.daemonEntry, path.join(PK, 'dist', 'daemon.js'));
  assert.equal(r.proxyEntry, path.join(PK, 'dist', 'proxy.js'));
  assert.equal(r.pluginTemplateDir, path.join(PK, 'plugin'));
  assert.equal(r.localTokenHelper, path.join(PK, 'dist', 'local-token.mjs'));
  assert.equal(r.keyHelper, path.join(PK, 'dist', 'key-helper.mjs'));
});

test('packaged: the daemon resolves the same root and entries as the CLI', () => {
  const fromCli = resolveLayout(urlOf(PK, 'dist', 'cli.js'));
  const fromDaemon = resolveLayout(urlOf(PK, 'dist', 'daemon.js'));
  assert.equal(fromDaemon.mode, 'packaged');
  assert.equal(fromDaemon.root, fromCli.root);
  assert.equal(fromDaemon.daemonEntry, fromCli.daemonEntry);
});

test('packaged: a global node_modules install (path contains no packages/<pkg>/src|dist) is not mistaken for workspace', () => {
  const r = resolveLayout(urlOf(PK, 'lib', 'node_modules', 'do-it-all-claude-code', 'dist', 'cli.js'));
  assert.equal(r.mode, 'packaged');
  assert.equal(r.root, path.join(PK, 'lib', 'node_modules', 'do-it-all-claude-code'));
  assert.equal(r.daemonEntry, path.join(PK, 'lib', 'node_modules', 'do-it-all-claude-code', 'dist', 'daemon.js'));
});

test('L4: a packages/<pkg>/src path is NOT taken for the workspace when <root>/packages/cli is absent', () => {
  // e.g. a user whose home happens to contain ~/packages/foo/src — packages/cli is not there, so: packaged.
  const r = resolveLayout(urlOf(WS, 'packages', 'foo', 'src', 'thing.js'), () => false);
  assert.equal(r.mode, 'packaged');
});
