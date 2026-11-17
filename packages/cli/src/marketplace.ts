// Install the generated plugin from the router home as a local Claude Code marketplace (distribution note).
// init writes a marketplace manifest INSIDE the generated plugin folder (<home>/plugin/.claude-plugin/
// marketplace.json, source "./") and runs `claude plugin marketplace add <home>/plugin` + `claude plugin
// install <plugin>@do-it-all-local`; uninstall reverses it. A local-directory marketplace loads in place, so
// the user's role edits survive plugin updates with no version bump — no `--plugin-dir`, no GitHub access.
//
// Only the plugin folder is the marketplace root, never the whole router home (which also holds the token, the
// TLS key and the ledger). The generator keeps the manifest (core MARKETPLACE_MANIFEST) across a regenerate.
// The marketplace name is distinct from the repo's GitHub marketplace ("do-it-all") so install/remove here can
// never pick the GitHub copy.
//
// The `claude plugin …` calls run only on the user's machine at init/uninstall time, through an injected
// runner so tests stub them; nothing here runs `claude` on its own.
import { exec, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MARKETPLACE_MANIFEST, effectivePluginDir, routerHome } from '@do-it-all-claude-code/core';

export const MARKETPLACE_NAME = 'do-it-all-local';
export const PLUGIN_NAME = 'do-it-all-claude-code';

/** The marketplace root: the generated plugin folder itself (not the whole home). */
export const marketplaceRoot = (home = routerHome()): string => effectivePluginDir(home);
/** The manifest path inside that folder. */
export const marketplaceFile = (home = routerHome()): string => path.join(marketplaceRoot(home), ...MARKETPLACE_MANIFEST.split('/'));

/** Write (or refresh) the local marketplace manifest, atomically at mode 0600. The one plugin is the folder itself. */
export function writeHomeMarketplace(home = routerHome()): string {
  const file = marketplaceFile(home);
  const manifest = {
    name: MARKETPLACE_NAME,
    owner: { name: 'ggreing' },
    description: 'Do It All Claude Code (local install): difficulty-based team router.',
    plugins: [{ name: PLUGIN_NAME, source: './' }],
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** Runs `claude` with the given args; resolves its exit code and combined output. Injected so tests stub it. */
export type ClaudeRunner = (args: string[]) => Promise<{ code: number | null; out: string }>;

export const realClaude: ClaudeRunner = args => new Promise(resolve => {
  const done = (err: Error | null, stdout: string, stderr: string) =>
    resolve({ code: err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}` });
  if (process.platform !== 'win32') {
    // POSIX: no shell — args pass as an argv array, so spaces and shell metacharacters are inert.
    execFile('claude', args, { windowsHide: true, timeout: 60_000 }, done);
    return;
  }
  // Windows: `claude` is a .cmd shim that needs a shell. Quote each argument and refuse the characters we cannot
  // quote safely for cmd.exe (a double quote, %, or a newline), so a profile path with spaces or & is safe and
  // nothing is injected.
  const unsafe = args.find(a => /["%\r\n]/.test(a));
  if (unsafe !== undefined) { resolve({ code: 1, out: `refusing to run claude: unsafe character in argument ${JSON.stringify(unsafe)}` }); return; }
  const line = ['claude', ...args].map(a => (/[\s&|<>^()!,;=]/.test(a) ? `"${a}"` : a)).join(' ');
  exec(line, { windowsHide: true, timeout: 60_000 }, done);
});

export interface MarketplaceDeps { home?: string; run?: ClaudeRunner; out(line: string): void }

/** The commands init will run, for the confirmation text (human-readable; the quoting is illustrative). */
export function installPlan(home = routerHome()): string[] {
  return [
    `claude plugin marketplace add "${marketplaceRoot(home)}" --scope user`,
    `claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME} --scope user`,
  ];
}

/** Register the local marketplace (the plugin folder) and install the plugin from it. Returns success. */
export async function installPlugin(d: MarketplaceDeps): Promise<boolean> {
  const home = d.home ?? routerHome();
  const run = d.run ?? realClaude;
  const root = marketplaceRoot(home);
  writeHomeMarketplace(home);
  const add = await run(['plugin', 'marketplace', 'add', root, '--scope', 'user']);
  if (add.code !== 0) { d.out(`Could not add the local marketplace (${add.out.trim() || `exit ${add.code}`}). Load the plugin by hand: claude --plugin-dir "${root}".`); return false; }
  const inst = await run(['plugin', 'install', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--scope', 'user']);
  if (inst.code !== 0) { d.out(`Could not install the plugin (${inst.out.trim() || `exit ${inst.code}`}). Load it by hand: claude --plugin-dir "${root}".`); return false; }
  return true;
}

/** Uninstall the plugin and remove the local marketplace. Best effort; reports anything it could not do. */
export async function uninstallPlugin(d: MarketplaceDeps): Promise<void> {
  const run = d.run ?? realClaude;
  const un = await run(['plugin', 'uninstall', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--scope', 'user']);
  if (un.code !== 0) d.out(`Could not uninstall the plugin from Claude Code (${un.out.trim() || `exit ${un.code}`}); remove it with \`claude plugin uninstall ${PLUGIN_NAME}\`.`);
  const rm = await run(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--scope', 'user']);
  if (rm.code !== 0) d.out(`Could not remove the local marketplace (${rm.out.trim() || `exit ${rm.code}`}).`);
}
