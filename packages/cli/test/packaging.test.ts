// Packaged-install wiring: the local-marketplace install/uninstall flow (with the `claude plugin …` calls
// stubbed — no test runs claude), the apiKeyHelper model, the stop() child-identify check, and the version
// source. The bundled key-helper is checked statically (no execution, no keychain) to guard the H1 fix. The layout resolver itself
// is tested in core/test/layout.test.ts.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import {
  MARKETPLACE_NAME, PLUGIN_NAME, installPlan, installPlugin, marketplaceFile, marketplaceRoot, uninstallPlugin,
  writeHomeMarketplace, type ClaudeRunner,
} from '../src/marketplace.ts';
import { copyHelpersToHome, keyHelper, localTokenHelper, proxyEntry } from '../src/apimode.ts';
import { cliEntry, daemonEntry, isOurChildCmd } from '../src/daemonctl.ts';
import { CLI_VERSION } from '../src/update.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let home = '';
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'diacc-mkt-')); });

function stub(codes: number[] = []): { run: ClaudeRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: ClaudeRunner = async args => { calls.push(args); return { code: codes[calls.length - 1] ?? 0, out: '' }; };
  return { run, calls };
}

test('the local marketplace lives inside the plugin folder (not the whole home) with a distinct name', () => {
  const file = writeHomeMarketplace(home);
  assert.equal(marketplaceRoot(home), path.join(home, 'plugin'));                 // M3: the plugin folder, not the home
  assert.equal(file, path.join(home, 'plugin', '.claude-plugin', 'marketplace.json'));
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(m.name, MARKETPLACE_NAME);
  assert.notEqual(m.name, 'do-it-all');                                           // M4: different from the repo marketplace
  assert.deepEqual(m.plugins, [{ name: PLUGIN_NAME, source: './' }]);
  if (process.platform !== 'win32') assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');   // M3: 0600 (Windows ignores Unix modes)
});

test('installPlugin writes the manifest and runs add (the plugin folder) then install, user-scoped', async () => {
  const s = stub();
  const ok = await installPlugin({ home, run: s.run, out: () => {} });
  assert.equal(ok, true);
  assert.ok(fs.existsSync(marketplaceFile(home)));
  assert.deepEqual(s.calls, [
    ['plugin', 'marketplace', 'add', marketplaceRoot(home), '--scope', 'user'],
    ['plugin', 'install', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--scope', 'user'],
  ]);
});

test('installPlugin stops and reports when adding the marketplace fails (install not attempted)', async () => {
  const s = stub([1]);
  const out: string[] = [];
  const ok = await installPlugin({ home, run: s.run, out: l => out.push(l) });
  assert.equal(ok, false);
  assert.equal(s.calls.length, 1);
  assert.match(out.join('\n'), /Could not add the local marketplace/);
  assert.match(out.join('\n'), /--plugin-dir/);
});

test('uninstallPlugin removes the plugin and the local marketplace', async () => {
  const s = stub();
  await uninstallPlugin({ home, run: s.run, out: () => {} });
  assert.deepEqual(s.calls, [
    ['plugin', 'uninstall', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--scope', 'user'],
    ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--scope', 'user'],
  ]);
});

test('installPlan names the two commands, pointing at the plugin folder', () => {
  const plan = installPlan(home);
  assert.match(plan[0]!, /^claude plugin marketplace add ".*[\\/]plugin" --scope user$/);
  assert.equal(plan[1], `claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME} --scope user`);
});

test('in the workspace the helpers are used in place (copyHelpersToHome is a no-op; the command points at the checkout)', () => {
  assert.deepEqual(copyHelpersToHome(home), []);                                  // workspace: nothing copied
  assert.ok(!fs.existsSync(path.join(home, 'key-helper.mjs')));
  // the command points at the in-place proxy helper (which resolves ../src/vault.ts there), not the home
  assert.match(keyHelper(home), /packages[\\/]proxy[\\/]bin[\\/]key-helper\.mjs"$/);
  assert.match(localTokenHelper(home), /packages[\\/]proxy[\\/]bin[\\/]local-token\.mjs"$/);
});

test('H1: the bundled key-helper is self-contained — every specifier it keeps is a node builtin (no dangling import; no keychain read)', async () => {
  // Bundle the helper the way build-npm does — so CI guards this too (N2) — but do NOT run it: running the helper
  // reads the OS keychain (service do-it-all-claude-code). Assert statically that the only specifiers the bundle
  // keeps are node builtins; zod and yaml must be inlined and nothing relative may dangle.
  const esbuild = (await import('esbuild')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diacc-helper-'));
  const out = path.join(dir, 'key-helper.mjs');
  await esbuild.build({ entryPoints: [path.join(REPO, 'packages', 'proxy', 'bin', 'key-helper.mjs')], outfile: out,
    bundle: true, platform: 'node', format: 'esm', target: 'node24', splitting: false, logLevel: 'silent' });
  const code = fs.readFileSync(out, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  const builtins = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)]);
  const specs = [...code.matchAll(/(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
  const external = [...new Set(specs)].filter(s => !builtins.has(s));
  assert.deepEqual(external, [], `the bundled key-helper still imports non-builtins (not inlined): ${external.join(', ')}`);
});

test('isOurChildCmd matches THIS install\'s daemon/proxy entries, not an arbitrary dist/daemon.js or the CLI', () => {
  assert.ok(isOurChildCmd(`node "${daemonEntry()}"`));
  assert.ok(isOurChildCmd(`node ${proxyEntry()}`));
  assert.ok(!isOurChildCmd(`node ${cliEntry()}`));                               // the CLI is not a child to force-kill
  assert.ok(!isOurChildCmd('node /some/other/install/dist/daemon.js'));         // L1: not another install's entry
});

test('the version command source is a semver string', () => {
  assert.equal(typeof CLI_VERSION, 'string');
  assert.match(CLI_VERSION, /^\d+\.\d+\.\d+/);
});

test('the removed `dashboard` command prints a one-line /office pointer and exits 0', () => {
  const index = path.join(REPO, 'packages', 'cli', 'src', 'index.ts');
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'diacc-dash-'));
  // execFileSync throws on a non-zero exit, so returning (no throw) proves exit 0; the stdout names /office.
  const out = execFileSync(process.execPath, [index, 'dashboard'], { encoding: 'utf8', env: { ...process.env, DO_IT_ALL_CLAUDE_CODE_HOME: h } });
  fs.rmSync(h, { recursive: true, force: true });
  assert.match(out, /\/office/);
});
