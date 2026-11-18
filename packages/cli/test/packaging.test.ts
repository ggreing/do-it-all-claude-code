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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtinModules } from 'node:module';
import {
  MARKETPLACE_NAME, PLUGIN_NAME, installPlan, installPlugin, marketplaceFile, marketplaceRoot, uninstallPlugin,
  writeHomeMarketplace, type ClaudeRunner,
} from '../src/marketplace.ts';
import { copyHelpersToHome, keyHelper, localTokenHelper, proxyEntry } from '../src/apimode.ts';
import { cliEntry, daemonEntry, isOurChildCmd } from '../src/daemonctl.ts';
import { homeAppCheck, windowsTerminalCheck } from '../src/doctor.ts';
import { copyAppFiles, copyTreeIfChanged } from '../src/appcopy.ts';
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

// ------------------------------------------------------------------ decision 206: the Windows terminal hint
test('windowsTerminalCheck: an info item on the classic Windows console, nothing elsewhere', () => {
  assert.equal(windowsTerminalCheck({ OS: 'Windows_NT', WT_SESSION: '1' } as NodeJS.ProcessEnv), null, 'Windows Terminal: no item');
  assert.equal(windowsTerminalCheck({} as NodeJS.ProcessEnv), null, 'not Windows: no item');
  const c = windowsTerminalCheck({ OS: 'Windows_NT' } as NodeJS.ProcessEnv);
  assert.ok(c);
  assert.equal(c!.ok, true, 'an info item, not a warning or failure');
  assert.equal(c!.blocking, false);
  assert.match(c!.detail, /Windows Terminal/);
});

// ------------------------------------------------------------------ decision 192: the home app copy
test('homeAppCheck: no check in the workspace; packaged warns only when the home copy is missing', () => {
  assert.equal(homeAppCheck('workspace', false), null, 'the workspace runs the checkout in place');
  const ok = homeAppCheck('packaged', true);
  assert.equal(ok?.ok, true);
  assert.equal(ok?.blocking, false);
  const missing = homeAppCheck('packaged', false);
  assert.equal(missing?.ok, false);
  assert.match(missing?.detail ?? '', /setup/);
});

test('copyTreeIfChanged copies only changed files and never follows a symlink at the destination', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'diacc-src-'));
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'diacc-dst-'));
  try {
    fs.mkdirSync(path.join(src, 'dist'));
    fs.writeFileSync(path.join(src, 'dist', 'cli.js'), 'one');
    fs.writeFileSync(path.join(src, 'top.txt'), 'top');
    const first = copyTreeIfChanged(src, dst);
    assert.equal(first.length, 2, 'both files written on the first copy');
    assert.equal(fs.readFileSync(path.join(dst, 'dist', 'cli.js'), 'utf8'), 'one');
    // a second copy with nothing changed writes nothing
    assert.deepEqual(copyTreeIfChanged(src, dst), []);
    // a changed file is rewritten
    fs.writeFileSync(path.join(src, 'top.txt'), 'changed');
    assert.deepEqual(copyTreeIfChanged(src, dst).map(p => path.basename(p)), ['top.txt']);
    assert.equal(fs.readFileSync(path.join(dst, 'top.txt'), 'utf8'), 'changed');
  } finally { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }); }
});

test('the home app copy carries package.json, so it reports its version (0.5.0 reported 0.0.0)', () => {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'diacc-pkg-'));
  const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diacc-home-')), 'app');
  try {
    fs.mkdirSync(path.join(pkg, 'dist'));
    fs.writeFileSync(path.join(pkg, 'dist', 'cli.js'), 'cli');
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'do-it-all-claude-code', version: '9.8.7', type: 'module' }));
    fs.mkdirSync(path.join(pkg, 'plugin'));
    fs.writeFileSync(path.join(pkg, 'plugin', 'x.md'), 'template');
    const first = copyAppFiles(pkg, app).map(p => path.relative(app, p).replace(/\\/g, '/')).sort();
    assert.deepEqual(first, ['dist/cli.js', 'package.json'], 'dist/ and package.json, not the plugin template');
    // what the CLI and the daemon read: ../package.json beside dist/
    const version = (JSON.parse(fs.readFileSync(new URL('../package.json', pathToFileURL(path.join(app, 'dist', 'cli.js'))), 'utf8')) as { version: string }).version;
    assert.equal(version, '9.8.7');
    assert.deepEqual(copyAppFiles(pkg, app), [], 'a repeat setup writes nothing');
  } finally { fs.rmSync(pkg, { recursive: true, force: true }); fs.rmSync(path.dirname(app), { recursive: true, force: true }); }
});
