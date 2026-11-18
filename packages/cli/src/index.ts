#!/usr/bin/env node
// do-it-all-claude-code <init|start|stop|status|doctor|routing|data|policy|uninstall|supervise|mode|token|key|proxy>
import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINDOWS_TERMINAL_HINT, classicWindowsConsole, effectivePluginDir, generateEffectivePlugin, paths, resolveLayout, routerHome, templateDirProblem, type Level } from '@do-it-all-claude-code/core';
import { copyAppToHome } from './appcopy.ts';
import { projectCommand } from './project.ts';
import { configCommand, presetCommand, reloadCommand, roleCommand, type SettingsDeps } from './settings.ts';
import { SettingsParseError, daemonPlanLine, defaultClaudeSettings, ensureLocalState, planBackupClean, planProject, planStatusLine, promptStorageSummary, readConfig, writeConfig, type PlannedChange } from './setup.ts';
import { CLI_VERSION, UPDATE_QUESTION, updateCommand } from './update.ts';
import { start, status, stop } from './daemonctl.ts';
import { MIN_CLAUDE, doctor, installedClaudeVersion, versionAtLeast } from './doctor.ts';
import { copyHelpersToHome, keyHelper, localTokenHelper, planApiSettings } from './apimode.ts';
import { installPlan, installPlugin, uninstallPlugin, writeHomeMarketplace } from './marketplace.ts';
import { migrateHome, realKeys } from './migrate.ts';
import { allowUpstream, configureApi, keySet, modeApi, modeSubscription, preflightApi, realLogin, realReload, realVault, setMode, tlsChoice, tokenRotate, type ApiDeps } from './apicmds.ts';
import { dataExport, dataPurge, realDataDeps } from './data.ts';
import { uninstall } from './uninstall.ts';
import { loadGuard, policyCommand } from './policy.ts';
import { deleteKey, keyStatus } from '@do-it-all-claude-code/proxy';
import { autoReleaseSummary, configuredAutoRelease, routingReset } from './routing.ts';
import { runSupervisor } from './supervise.ts';

export { doctor, ladderBreakers, versionAtLeast } from './doctor.ts';
export * from './setup.ts';

function flags(argv: string[]): Record<string, string | boolean> {
  const f: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { f[a.slice(2)] = next; i++; } else f[a.slice(2)] = true;
  }
  return f;
}

async function confirm(changes: PlannedChange[], yes: boolean): Promise<boolean> {
  if (!changes.length) return false;
  console.log('\nThese files outside ~/.do-it-all-claude-code will change:');
  for (const c of changes) console.log(`  - ${c.file}: ${c.summary}`);
  if (yes) return true;
  if (!process.stdin.isTTY) { console.log('Not a terminal: re-run with --yes to apply.'); return false; }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question('Apply? [y/N] ')).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

/** A question whose default is yes (Enter answers yes). */
async function askDefaultYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return a === '' || a === 'y' || a === 'yes';
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const apiDeps = (f: Record<string, string | boolean>): ApiDeps => ({
  settingsFile: typeof f['claude-settings'] === 'string' ? f['claude-settings'] : defaultClaudeSettings(),
  confirm, login: realLogin, vault: realVault, isTTY: process.stdin.isTTY === true, readStdin, out: line => console.log(line),
});

async function init(f: Record<string, string | boolean>) {
  const mode = f.mode;
  if (mode !== undefined && mode !== 'api') { console.error('--mode takes "api" (subscription mode is the default)'); process.exitCode = 2; return; }
  const api = mode === 'api' ? apiDeps(f) : undefined;
  // decision 186: the team office needs a recent Claude Code; init points at an update when the installed one is
  // older. doctor's `claude code` check is the blocking one — this is a heads-up so a fresh setup is not surprised.
  const claudeVersion = installedClaudeVersion();
  if (claudeVersion && !versionAtLeast(claudeVersion, MIN_CLAUDE))
    console.log(`note: your Claude Code is ${claudeVersion}; the team office needs >= ${MIN_CLAUDE.join('.')}. Update it (e.g. \`claude update\`), then run \`do-it-all-claude-code doctor\` to re-check.`);
  // decision 168: the plugin as shipped is the template; Claude Code and the daemon use the effective plugin generated
  // from it (and the role overrides) in the router home
  const templateDir = typeof f['plugin-dir'] === 'string' ? path.resolve(f['plugin-dir']) : resolveLayout(import.meta.url).pluginTemplateDir;
  const pluginDir = effectivePluginDir(routerHome());
  const templateProblem = templateDirProblem(routerHome(), templateDir);   // review L5: never a folder inside the home
  if (templateProblem) { console.error(`init: ${templateProblem}`); process.exitCode = 2; return; }
  // decision 161: the previous release's home is moved first (everything below works on the new one)
  const migrated = await migrateHome({
    env: process.env, settingsFile: typeof f['claude-settings'] === 'string' ? f['claude-settings'] : defaultClaudeSettings(),
    statusLine: `node "${path.join(pluginDir, 'statusline.mjs')}"`, helpers: { localToken: localTokenHelper(), key: keyHelper() },
    yes: f.yes === true, isTTY: process.stdin.isTTY === true, ask, out: line => console.log(line), keys: realKeys,
  });
  if (migrated === 'stop') { process.exitCode = 1; return; }
  // API-key mode checks the login and the keychain before anything is written
  if (api) {
    const pre = await preflightApi(f, api);
    if (!pre.ok) { process.exitCode = pre.code; return; }
  }
  const budgets: Partial<Record<Level, number>> = {};
  for (const l of ['L0', 'L1', 'L2', 'L3'] as Level[]) {
    const raw = f[`budget-${l}`];
    if (raw === undefined) continue;
    const v = typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(v) || v <= 0) { console.error(`--budget-${l} must be a positive number of USD (got ${JSON.stringify(raw)})`); process.exitCode = 2; return; }
    budgets[l] = v;
  }
  const local = await ensureLocalState(budgets, pluginDir, { newPort: f['new-port'] === true });
  // The apiKeyHelper and status-line scripts live in the router home, not the package folder (which moves
  // with the Node version / plugin cache). Copy them now so both survive updates.
  try { copyHelpersToHome(routerHome()); } catch (e) { console.log(`note: could not copy the API-mode helpers into the router home (${(e as Error).message}); API-key mode will set them up later`); }
  try {
    const g = generateEffectivePlugin(routerHome(), templateDir);
    for (const r of g.refused) console.log(`role ${r.role}: your override does not hold against this template (${r.errors.map(e => `${e.path}: ${e.message}`).join('; ')}); the role uses the template's file until it is fixed. \`do-it-all-claude-code role edit ${r.role}\` fixes it.`);
  } catch (e) { console.error(`could not generate the plugin from ${templateDir}: ${(e as Error).message}`); process.exitCode = 1; return; }
  if (local.config.pluginTemplateDir !== templateDir) { local.config.pluginTemplateDir = templateDir; writeConfig(local.config); }
  const token = local.token;
  const config = api ? await configureApi(local.config, api) : local.config;
  console.log(`local state ready: daemon port ${config.daemonPort}, token ${token}, plugin ${pluginDir} (generated from ${templateDir})`);
  console.log(`per-request budgets (provisional): ${Object.entries(config.budgetsUsd).map(([k, v]) => `${k} $${v}`).join(', ')}`);
  // decision 138: the holdout changes how some requests are handled, so init says so
  const ar = configuredAutoRelease(config);
  console.log(`auto-release: ${autoReleaseSummary(ar.mode, ar.rate)}`);
  console.log(`prompt text: ${promptStorageSummary(config.recordPrompts)}`);   // decision 142
  // decision 163: the update check is opt-in and asked once; a choice made before is kept
  if (config.updateCheck === undefined) {
    if (f.yes === true || process.stdin.isTTY === true) {
      const on = f.yes === true || await askDefaultYes(`${UPDATE_QUESTION} [Y/n] `);
      const saved = readConfig() ?? config;
      config.updateCheck = saved.updateCheck = on ? 'on' : 'off';
      writeConfig(saved);
    }
  }
  console.log(`update check: ${config.updateCheck === 'on' ? 'on (once a day; `do-it-all-claude-code update off` stops it)' : config.updateCheck === 'off' ? 'off (`do-it-all-claude-code update on` turns it on)' : 'not set (not a terminal); `do-it-all-claude-code update on` turns it on'}`);
  const changes: PlannedChange[] = [];
  // A settings file we cannot parse skips only that step (review #12); nothing is overwritten.
  const step = (name: string, plan: () => PlannedChange[]) => {
    try { changes.push(...plan()); }
    catch (e) {
      if (!(e instanceof SettingsParseError)) throw e;
      console.log(`skipped ${name}: ${e.message}. Fix the file and re-run init, or set it up by hand (README).`);
    }
  };
  step('status line', () => {
    const sl = planStatusLine(typeof f['claude-settings'] === 'string' ? f['claude-settings'] : defaultClaudeSettings(), path.join(pluginDir, 'statusline.mjs'), config);
    return sl ? [sl] : [];
  });
  step('project settings', () => planProject(typeof f.project === 'string' ? f.project : process.cwd()));
  // decision 142: a backup made before it may hold an API key or token in plain text
  step('settings backup', () => { const c = planBackupClean(typeof f['claude-settings'] === 'string' ? f['claude-settings'] : defaultClaudeSettings()); return c ? [c] : []; });
  // decision 157: local TLS when openssl is there and the environment allows it (the certificate is made now; the
  // settings change is shown with the rest)
  if (api) step('API-key mode settings', () => { const c = planApiSettings(api.settingsFile, 'proxy', config.proxyPort!, undefined, process.env, tlsChoice(api.settingsFile, readConfig() ?? config)); return c ? [c] : []; });
  if (await confirm(changes, f.yes === true)) {
    for (const c of changes) c.apply();
    // L1: a running supervisor restarts the proxy when its TLS setting changed (as mode api does)
    if (api && realReload()) console.log('The supervisor applies the new API-key settings to the running proxy.');
  }
  // --no-plugin: nothing is registered in Claude Code (no `claude plugin` call at all). For a caller that loads the
  // generated folder itself with --plugin-dir: the bench and the end-to-end scripts, whose router home is a
  // temporary folder that must never become a marketplace in the user's Claude Code settings.
  if (f['no-plugin'] === true) {
    console.log(`\nPlugin not installed in Claude Code (--no-plugin). Load it with: claude --plugin-dir "${pluginDir}"`);
    return;
  }
  // Install the generated plugin as a local marketplace from the router home: no --plugin-dir, and the user's
  // role edits survive plugin updates (the local directory loads in place).
  writeHomeMarketplace(routerHome());
  const plan = installPlan(routerHome());
  console.log('\nInstall the plugin in Claude Code (a local marketplace in your router home; role edits survive updates):');
  for (const c of plan) console.log(`  - ${c}`);
  let installed = false;
  if (f.yes === true || (process.stdin.isTTY === true && await askDefaultYes('Install it now? [Y/n] '))) {
    installed = await installPlugin({ out: line => console.log(line) });
  }
  console.log(installed
    ? 'Plugin installed; `do-it-all-claude-code role edit <role>` changes a role in the generated folder, and the edit survives updates.'
    : `Not installed yet — run the two commands above when ready, or load it directly with: claude --plugin-dir "${pluginDir}"`);
  // decision 186: in an already-open session the plugin loads with /reload-plugins; then /office opens the team office
  if (installed) console.log('In an open Claude Code session run /reload-plugins to load it now (or start a new session); then /office opens the team office.');
  if (api) console.log('API-key mode: run `do-it-all-claude-code start` (daemon and proxy), then start new Claude Code sessions. `do-it-all-claude-code doctor` checks the setup.');
}

// node:sqlite and the built-in proxy support the egress code needs (distribution note).
const MIN_NODE = [24, 5, 0] as const;

/**
 * decision 192: the npm one-command install. `npx do-it-all-claude-code setup` (or `npm i -g` then `setup`).
 * It checks Node, copies the bundled app into the router home (so the daemon/proxy survive an evicted npx cache
 * or a switched Node), sets up subscription mode with the fewest questions (one Enter), installs the plugin and
 * starts the daemon; auto-start then keeps it running. Project settings are NOT asked here (decision 192 Q3) —
 * they are asked the first time the router delegates in a project.
 */
async function setup(f: Record<string, string | boolean>) {
  if (!versionAtLeast(process.versions.node, MIN_NODE)) {
    console.error(`do-it-all-claude-code needs Node ${MIN_NODE.join('.')} or newer, but this is Node ${process.versions.node}. Install a newer Node (nodejs.org, or your version manager), then run \`do-it-all-claude-code setup\` again.`);
    process.exitCode = 1; return;
  }
  const mode = f.mode;
  if (mode !== undefined && mode !== 'api') { console.error('--mode takes "api" (subscription mode is the default)'); process.exitCode = 2; return; }
  const api = mode === 'api' ? apiDeps(f) : undefined;
  const home = routerHome();
  const settingsFile = typeof f['claude-settings'] === 'string' ? f['claude-settings'] : defaultClaudeSettings();
  // Copy the bundled app into <home>/app so the daemon/proxy spawn from a stable path (a no-op in the workspace).
  try { const r = copyAppToHome(home); if (r.copied) console.log(`app installed in ${r.root}`); }
  catch (e) { console.error(`setup: could not copy the app into ${home} (${(e as Error).message})`); process.exitCode = 1; return; }
  const pluginDir = effectivePluginDir(home);
  // decision 161: move a previous release's home first (as init does)
  const migrated = await migrateHome({
    env: process.env, settingsFile,
    statusLine: `node "${path.join(pluginDir, 'statusline.mjs')}"`, helpers: { localToken: localTokenHelper(), key: keyHelper() },
    yes: f.yes === true, isTTY: process.stdin.isTTY === true, ask, out: line => console.log(line), keys: realKeys,
  });
  if (migrated === 'stop') { process.exitCode = 1; return; }
  if (api) { const pre = await preflightApi(f, api); if (!pre.ok) { process.exitCode = pre.code; return; } }
  // decision 168 / review L5: the template is the plugin shipped with the package (outside the router home, so
  // generation into <home>/plugin is never a template subfolder); the daemon/proxy still spawn from <home>/app.
  const templateDir = typeof f['plugin-dir'] === 'string' ? path.resolve(f['plugin-dir']) : resolveLayout(import.meta.url).pluginTemplateDir;
  const templateProblem = templateDirProblem(home, templateDir);
  if (templateProblem) { console.error(`setup: ${templateProblem}`); process.exitCode = 2; return; }
  const local = await ensureLocalState({}, pluginDir, { newPort: f['new-port'] === true });
  try { copyHelpersToHome(home); } catch (e) { console.log(`note: could not copy the API-mode helpers into the router home (${(e as Error).message}); API-key mode will set them up later`); }
  try {
    const g = generateEffectivePlugin(home, templateDir);
    for (const rr of g.refused) console.log(`role ${rr.role}: your override does not hold against this template (${rr.errors.map(e => `${e.path}: ${e.message}`).join('; ')}); the role uses the template's file until it is fixed. \`do-it-all-claude-code role edit ${rr.role}\` fixes it.`);
  } catch (e) { console.error(`could not generate the plugin from ${templateDir}: ${(e as Error).message}`); process.exitCode = 1; return; }
  if (local.config.pluginTemplateDir !== templateDir) { local.config.pluginTemplateDir = templateDir; writeConfig(local.config); }
  const config = api ? await configureApi(local.config, api) : local.config;
  console.log(`local state ready: daemon port ${config.daemonPort}, plugin ${pluginDir}`);
  // The one confirmation (Enter = yes): the settings changes, the plugin install and the daemon start.
  const changes: PlannedChange[] = [];
  const step = (name: string, plan: () => PlannedChange[]) => {
    try { changes.push(...plan()); }
    catch (e) { if (!(e instanceof SettingsParseError)) throw e; console.log(`skipped ${name}: ${e.message}. Fix the file and re-run setup, or set it up by hand (README).`); }
  };
  step('status line', () => { const sl = planStatusLine(settingsFile, path.join(pluginDir, 'statusline.mjs'), config); return sl ? [sl] : []; });
  if (api) step('API-key mode settings', () => { const c = planApiSettings(api.settingsFile, 'proxy', config.proxyPort!, undefined, process.env, tlsChoice(api.settingsFile, readConfig() ?? config)); return c ? [c] : []; });
  // --no-plugin: the plugin is already installed from the marketplace (the `/do-it-all-setup` path); do not
  // re-install it from the local home marketplace, which would load every hook twice.
  const installPluginStep = f['no-plugin'] !== true;
  console.log('\nSetup will:');
  for (const c of changes) console.log(`  - ${c.file}: ${c.summary}`);
  if (installPluginStep) console.log(`  - install the plugin in Claude Code (a local marketplace in ${home})`);
  else console.log('  - (the plugin is already installed from the marketplace; leaving it as is)');
  console.log(`  - ${daemonPlanLine(f['no-start'] === true)}`);
  let go = f.yes === true;
  if (!go) {
    if (process.stdin.isTTY !== true) { console.log('Not a terminal: re-run with --yes to finish setup.'); return; }
    go = await askDefaultYes('Proceed? [Y/n] ');
  }
  if (!go) { console.log('Nothing changed.'); return; }
  for (const c of changes) c.apply();
  if (installPluginStep) {
    writeHomeMarketplace(home);
    const installed = await installPlugin({ out: line => console.log(line) });
    if (!installed) {
      console.log('The plugin was not installed automatically. Run these when ready:');
      for (const c of installPlan(home)) console.log(`  - ${c}`);
    }
  }
  // --no-start: do everything but launch the daemon (the package smoke test; auto-start brings it up on the
  // next session, or run `do-it-all-claude-code start`).
  if (f['no-start'] === true) console.log('Daemon not started (--no-start); it starts itself on the next Claude Code session, or run `do-it-all-claude-code start`.');
  else console.log(await start());
  console.log('\nSetup complete. Now run `claude` — then `/office demo` previews the team office.');
  console.log('The daemon starts itself when a Claude Code session starts; turn that off with `do-it-all-claude-code config set autoStart off`.');
  if (classicWindowsConsole(process.env)) console.log(`\n${WINDOWS_TERMINAL_HINT}`);   // decision 206
  if (api) console.log('API-key mode: `do-it-all-claude-code doctor` checks the key and the proxy.');
}

async function apiCommand(cmd: string, args: string[], f: Record<string, string | boolean>): Promise<number> {
  const d = apiDeps(f);
  if (cmd === 'mode') {
    if (args[0] === 'subscription') return modeSubscription(f, d);
    if (args[0] === 'api') return modeApi(f, d);
    if (args[0] !== 'direct' && args[0] !== 'proxy') { console.log('usage: do-it-all-claude-code mode <subscription|api|direct|proxy> [--yes]'); return 2; }
    return setMode(args[0], f, d);
  }
  if (cmd === 'token' && args[0] === 'rotate') return tokenRotate(d, { grace: f['no-grace'] !== true });
  if (cmd === 'key' && args[0] === 'set') return keySet(f, d);
  if (cmd === 'proxy' && args[0] === 'allow-upstream') return allowUpstream(args[1], f, d, paths.config());
  console.log('usage: do-it-all-claude-code token rotate [--no-grace] | key set [--key-stdin] | proxy allow-upstream <https origin> [--use] [--yes]');
  return 2;
}

async function routingResetCommand(): Promise<number> {
  const cfg = readConfig();
  let token = '';
  try { token = fs.readFileSync(paths.token(), 'utf8').trim(); } catch { /* below */ }
  if (!cfg || !token) { console.log('Not set up yet: run `do-it-all-claude-code init` first.'); return 2; }
  return routingReset({ port: cfg.daemonPort, token });
}

const [cmd, ...rest] = process.argv.slice(2);
const f = flags(rest);
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]!.startsWith('--') && f[rest[i - 1]!.slice(2)] === a));
// realpath on both sides: an npm bin is a symlink (POSIX) whose path differs from the module's (review #7).
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = !!process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
if (isMain) {
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') console.log(CLI_VERSION);
  else if (cmd === 'init') await init(f);
  else if (cmd === 'setup') await setup(f);   // decision 192: the one-command install
  else if (cmd === 'start') console.log(await start());
  else if (cmd === 'stop') console.log(await stop());
  else if (cmd === 'status') console.log(await status());
  else if (cmd === 'doctor') {
    const checks = await doctor();
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : c.blocking ? 'FAIL' : 'warn'} ${c.name.padEnd(36)} ${c.detail}`);
    if (checks.some(c => !c.ok && c.blocking)) process.exitCode = 1;
  } else if (cmd === 'supervise') await runSupervisor();
  else if (cmd === 'dashboard') { console.log('The browser dashboard has been removed — use the team office inside Claude Code: /office'); process.exitCode = 0; }
  else if (cmd === 'routing' && positional[0] === 'reset') process.exitCode = await routingResetCommand();
  else if (cmd === 'policy') {
    process.exitCode = await policyCommand(positional[0], f, {
      guard: await loadGuard(), dir: typeof f.project === 'string' ? path.resolve(f.project) : process.cwd(), ask, isTTY: process.stdin.isTTY === true, out: line => console.log(line),
    });
  } else if (cmd === 'uninstall') {
    process.exitCode = await uninstall(f, {
      settingsFile: typeof f['claude-settings'] === 'string' ? f['claude-settings'] : defaultClaudeSettings(),
      projectDir: typeof f.project === 'string' ? f.project : process.cwd(),
      stop, keyStatus: () => keyStatus(), deleteKey: () => deleteKey(),
      pluginUninstall: () => uninstallPlugin({ out: line => console.log(line) }),
      ask, isTTY: process.stdin.isTTY === true, out: line => console.log(line),
    });
  }
  else if (cmd === 'data' && (positional[0] === 'export' || positional[0] === 'purge')) {
    const d = realDataDeps({ confirm: ask, isTTY: process.stdin.isTTY === true });
    process.exitCode = positional[0] === 'export' ? await dataExport(f, d) : await dataPurge(f, d);
  }
  else if (cmd === 'mode' || cmd === 'token' || cmd === 'key' || cmd === 'proxy') process.exitCode = await apiCommand(cmd, positional, f);
  else if (cmd === 'update') process.exitCode = await updateCommand(positional[0], { out: line => console.log(line) });   // decision 163
  else if (cmd === 'project') process.exitCode = await projectCommand(positional[0], {   // decision 192 (Q3)
    dir: typeof f.project === 'string' ? path.resolve(f.project) : process.cwd(),
    ask: askDefaultYes, isTTY: process.stdin.isTTY === true, out: line => console.log(line), yes: f.yes === true,
  });
  else if (cmd === 'config' || cmd === 'preset' || cmd === 'role' || cmd === 'reload') {   // decision 168
    const d: SettingsDeps = { out: line => console.log(line), isTTY: process.stdin.isTTY === true, ask: q => askDefaultYes(q) };
    try {
      process.exitCode = cmd === 'config' ? await configCommand(positional[0], positional.slice(1), d)
        : cmd === 'preset' ? await presetCommand(positional[0], positional.slice(1), d)
        : cmd === 'role' ? await roleCommand(positional[0], positional.slice(1), d) : await reloadCommand(d);
    } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
  }
  else console.log('usage: do-it-all-claude-code <version|setup [--mode api]|init [--mode api]|start|stop|status|doctor|routing reset|data export|data purge|uninstall [--keep-key]|project enable|disable|status|policy show|accept|revoke|mode subscription|api|direct|proxy|token rotate [--no-grace]|key set|proxy allow-upstream <origin>|update on|off|check|config list|get|set|edit|history|preset show|edit|role show|edit|reset <role>|reload>');
}
