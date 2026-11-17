// `do-it-all-claude-code config get|set|list|edit|history`, `preset show|edit`, `role show|edit|reset`, `reload` (decision 168).
// One write core (core settings.ts and role-overrides.ts) behind two ways in: when the daemon is up, the change
// goes to it as a sealed call and it validates, writes, reloads and audits; when it is down, the CLI writes with
// the same core and the daemon reads the files at its next start. A rejected change shows every problem and keeps
// the file as it was; an edit in $EDITOR that does not hold can be reopened with what was typed.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  SettingsRejected, TOOLS_RULE, applyConfigChange, applyPresetsChange, applyRoleChange, configView, generateEffectivePlugin, isRoleName, mergePresetLevel,
  parseConfigInput, paths, presetLevelText, presetsView, readAudit, readText, revisionOf, rolesView, routerHome,
  type AuditEntry, type ConfigView, type PresetsView, type RolesView, type SettingsError,
} from '@do-it-all-claude-code/core';
import { daemonIdentity, daemonProcessAlive, daemonRequest } from './daemonctl.ts';
import { readConfig } from './setup.ts';

type Kind = 'config' | 'presets' | 'role' | 'reload';
interface View { config: ConfigView; presets: PresetsView; roles: RolesView }
type Answer = [status: number, body: { ok?: boolean; changed?: string[]; nextStart?: string[]; notes?: string[]; errors?: SettingsError[]; reloaded?: string[] }];

/** Where a settings call goes: the daemon (sealed) when it runs, else the files with the same core. */
export interface SettingsTransport {
  via: 'daemon' | 'direct';
  view(): Promise<View>;
  /** The settings change log, newest first (decision 168); the daemon's route or, without it, the files. */
  history(limit: number): Promise<AuditEntry[]>;
  write(kind: Kind, body: Record<string, unknown>): Promise<Answer>;
}

/** The files, with the core: what the daemon does, without it (source "cli-direct"; the daemon reads them at its next start). */
export function directTransport(home: string = routerHome()): SettingsTransport {
  const cfg = () => readConfig() ?? undefined;
  const answer = (fn: () => object): Answer => {
    try { return [200, fn() as Answer[1]]; } catch (e) { if (e instanceof SettingsRejected) return [e.status, { ok: false, errors: e.errors }]; throw e; }
  };
  return {
    via: 'direct',
    async view() {
      const c = cfg();
      return { config: configView(readText(path.join(home, 'config.json'))), presets: presetsView(home), roles: rolesView(home, c?.pluginTemplateDir, c?.pluginDir) };
    },
    async history(limit) { return readAudit(home, limit); },
    async write(kind, body) {
      if (kind === 'config') return answer(() => { const { config: _c, ...r } = applyConfigChange(home, body, 'cli-direct'); return r; });
      if (kind === 'presets') return answer(() => applyPresetsChange(home, body, 'cli-direct'));
      if (kind === 'role') return answer(() => { const { generated: _g, ...r } = applyRoleChange(home, cfg()?.pluginTemplateDir, body, 'cli-direct'); return r; });
      const c = cfg();
      const notes: string[] = [];
      if (c?.pluginTemplateDir) {
        const g = generateEffectivePlugin(home, c.pluginTemplateDir);
        if (g.written.length + g.removed.length) notes.push(`the effective plugin: ${g.written.length + g.removed.length} file(s) updated`);
        for (const r of g.refused) notes.push(`${r.role}: its override does not hold (${r.errors.map(e => `${e.path}: ${e.message}`).join('; ')}); the role uses the template's file until it is fixed`);
      }
      return [200, { ok: true, reloaded: ['roles'], notes }];
    },
  };
}

const ROUTES: Record<Kind, string> = { config: '/router/v1/config', presets: '/router/v1/presets', role: '/router/v1/role', reload: '/router/v1/reload' };

/** The daemon, through sealed calls. */
export function daemonTransport(port: number, token: string): SettingsTransport {
  return {
    via: 'daemon',
    async view() {
      const r = await daemonRequest(port, 'GET', '/router/v1/settings', { token, timeoutMs: 10_000 });
      if (!r || r.status !== 200) throw new Error(r?.status === 404 ? 'this daemon has no settings routes: restart it with `do-it-all-claude-code stop` and `start`' : 'the daemon did not answer');
      return JSON.parse(r.body) as View;
    },
    async history(limit) {
      const r = await daemonRequest(port, 'GET', `/router/v1/settings/history?limit=${encodeURIComponent(String(limit))}`, { token, timeoutMs: 10_000 });
      if (!r || r.status !== 200) throw new Error(r?.status === 404 ? 'this daemon has no settings routes: restart it with `do-it-all-claude-code stop` and `start`' : 'the daemon did not answer');
      return (JSON.parse(r.body) as { entries: AuditEntry[] }).entries;
    },
    async write(kind, body) {
      const r = await daemonRequest(port, 'POST', ROUTES[kind], { token, body: JSON.stringify(body), timeoutMs: 60_000 });
      if (!r) throw new Error('the daemon did not answer');
      if (r.status === 404) throw new Error('this daemon has no settings routes: restart it with `do-it-all-claude-code stop` and `start`');
      try { return [r.status, JSON.parse(r.body) as Answer[1]]; } catch { return [r.status, { ok: false, errors: [{ path: 'answer', message: `HTTP ${r.status}` }] }]; }
    },
  };
}

/** The daemon when it answers as ours; the files when nothing runs; refused when the daemon runs but does not answer. */
export async function settingsTransport(): Promise<SettingsTransport> {
  const cfg = readConfig();
  if (!cfg) throw new Error('not set up yet: run `do-it-all-claude-code init` first');
  let token = '';
  try { token = fs.readFileSync(paths.token(), 'utf8').trim(); } catch { /* below */ }
  const id = await daemonIdentity(cfg.daemonPort, token);
  if (id.who === 'ours') return daemonTransport(cfg.daemonPort, token);
  if (id.who === 'other') throw new Error(`port ${cfg.daemonPort} is answered by something that is not this router's daemon: stop it, or run \`do-it-all-claude-code doctor\``);
  if (daemonProcessAlive()) throw new Error('the daemon runs but does not answer: try again, or stop it first (a direct write would race it)');
  return directTransport();
}

export interface SettingsDeps {
  out(line: string): void;
  transport?: () => Promise<SettingsTransport>;
  /** Opens `file` in the user's editor and returns when it is closed (tests pass their own). */
  edit?: (file: string) => void;
  isTTY: boolean;
  ask(question: string): Promise<boolean>;
  /** Where edit buffers go (inside the router home: user-only). */
  home?: string;
}

/** $VISUAL, else $EDITOR, else notepad (Windows) or vi. The command may carry arguments ("code --wait"). */
export function openInEditor(file: string): void {
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
  const r = spawnSync(`${editor} "${file}"`, { shell: true, stdio: 'inherit' });
  if (r.error) throw new Error(`could not start the editor (${editor}): ${r.error.message}`);
  if (r.status !== 0 && r.status !== null) throw new Error(`the editor (${editor}) exited with ${r.status}`);
}

function printErrors(d: SettingsDeps, errors: SettingsError[] | undefined): void {
  d.out('Not saved; nothing was changed:');
  for (const e of errors ?? [{ path: 'answer', message: 'refused' }]) d.out(`  ${e.path}${e.line ? ` (line ${e.line})` : ''}: ${e.message}`);
}

function printSaved(d: SettingsDeps, t: SettingsTransport, a: Answer[1]): void {
  if (!a.changed?.length) { d.out('No change.'); return; }
  d.out(`Saved: ${a.changed.join(', ')}${t.via === 'daemon' ? ' (the daemon uses it now)' : ' (the daemon is not running: it reads the change at its next start)'}.`);
  if (a.nextStart?.length) d.out(`  ${a.nextStart.join(', ')}: takes effect at the next daemon start.`);
  for (const n of a.notes ?? []) if (n !== 'no change') d.out(`  ${n}`);
}

/**
 * The $EDITOR loop: the buffer goes to the editor (a 0600 file in the router home), then to `save`. Refused: the
 * problems are shown and, in a terminal, the user may reopen what they typed; the live file is never touched.
 */
/** Edit buffers kept from refused edits go after a day (review L6), at the next edit. */
export const EDIT_BUFFER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export function sweepEditBuffers(dir: string, now = Date.now()): string[] {
  const removed: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return removed; }
  for (const e of entries) {
    if (!e.isFile() || !/^[0-9a-f]{12}\.(json|yaml|md)$/.test(e.name)) continue;     // only buffers this code made
    const p = path.join(dir, e.name);
    try { if (now - fs.statSync(p).mtimeMs > EDIT_BUFFER_MAX_AGE_MS) { fs.rmSync(p, { force: true }); removed.push(e.name); } } catch { /* gone */ }
  }
  return removed;
}

async function editLoop(d: SettingsDeps, initial: string, ext: string, save: (text: string) => Promise<Answer>, t: SettingsTransport): Promise<number> {
  const dir = path.join(d.home ?? routerHome(), 'edit');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepEditBuffers(dir);
  const file = path.join(dir, `${randomBytes(6).toString('hex')}${ext}`);
  fs.writeFileSync(file, initial, { mode: 0o600 });
  try {
    for (;;) {
      (d.edit ?? openInEditor)(file);
      const text = fs.readFileSync(file, 'utf8');
      if (text === initial) { d.out('No change.'); fs.rmSync(file, { force: true }); return 0; }
      const [status, a] = await save(text);
      if (status === 200 && a.ok !== false) { printSaved(d, t, a); fs.rmSync(file, { force: true }); return 0; }
      printErrors(d, a.errors);
      if (!d.isTTY || !await d.ask('Edit again? [Y/n] ')) { d.out(`What you typed is kept in ${file}.`); return 1; }
    }
  } catch (e) { d.out(`What you typed is kept in ${file}.`); throw e; }
}

const asJson = (v: unknown) => JSON.stringify(v);

export async function configCommand(sub: string | undefined, args: string[], d: SettingsDeps): Promise<number> {
  const t = await (d.transport ?? settingsTransport)();
  if (sub === 'list' || sub === undefined) {
    const v = (await t.view()).config;
    for (const k of v.keys) {
      const marks = [k.set ? '' : 'default', k.appliesAt === 'next start' ? 'applies at the next start' : '', k.advanced ? 'advanced' : '', k.deprecated ? 'deprecated' : ''].filter(Boolean).join(', ');
      d.out(`${k.key.padEnd(20)} ${asJson(k.value)}${marks ? `  (${marks})` : ''}`);
    }
    d.out(`Set by init or mode, not here: ${v.managed.map(m => m.key).join(', ')}.`);
    return 0;
  }
  if (sub === 'get') {
    const key = args[0];
    if (!key) { d.out('usage: do-it-all-claude-code config get <key>'); return 2; }
    const [base, part] = key.split('.');
    const k = (await t.view()).config.keys.find(x => x.key === base);
    if (!k) { d.out(`${key}: not a setting (see \`do-it-all-claude-code config list\`)`); return 2; }
    const value = part !== undefined ? (k.value as Record<string, unknown> | null)?.[part] : k.value;
    d.out(asJson(value ?? null));
    return 0;
  }
  if (sub === 'set') {
    if (args.length < 2 || args.length % 2) { d.out('usage: do-it-all-claude-code config set <key> <value> [<key> <value> …] ("default" puts a key back)'); return 2; }
    const set: Record<string, unknown> = {};
    for (let i = 0; i < args.length; i += 2) set[args[i]!] = parseConfigInput(args[i]!, args[i + 1]!);
    const [status, a] = await t.write('config', { set });
    if (status !== 200 || a.ok === false) { printErrors(d, a.errors); return 1; }
    printSaved(d, t, a);
    return 0;
  }
  if (sub === 'edit') {
    const live = readText(paths.config());
    const initial = live ?? '{}\n';
    // review L6: the revision of what was opened, so a change made meanwhile (dashboard, another CLI) is not overwritten
    const revision = revisionOf(live);
    return editLoop(d, initial, '.json', async text => {
      let replace: unknown;
      try { replace = JSON.parse(text); } catch (e) { return [400, { ok: false, errors: [{ path: 'json', message: e instanceof Error ? e.message : 'not JSON' }] }]; }
      return t.write('config', { replace, revision });
    }, t);
  }
  if (sub === 'history') {
    const raw = args[0];
    const limit = raw === undefined ? 50 : Number(raw);
    if (raw !== undefined && (!Number.isInteger(limit) || limit <= 0)) { d.out('usage: do-it-all-claude-code config history [<limit>]  (a positive whole number; default 50)'); return 2; }
    const entries = await t.history(limit);
    if (!entries.length) { d.out('No settings changes recorded.'); return 0; }
    for (const e of entries) d.out(formatAudit(e));
    return 0;
  }
  d.out('usage: do-it-all-claude-code config list | get <key> | set <key> <value> | edit | history [<limit>]');
  return 2;
}

/** One line for a settings-change log entry: time, source as recorded, what changed, and whether it did not apply. */
function formatAudit(e: AuditEntry): string {
  const what = e.changes.length
    ? e.changes.map(c => (c.changed ? `${c.path}: changed` : `${c.path}: ${asJson(c.from ?? null)} -> ${asJson(c.to ?? null)}`)).join('; ')
    : '(no change)';
  const head = `${e.at}  ${e.source}  ${e.kind}${e.target ? ` ${e.target}` : ''}`;
  return `${head}  ${what}${e.failed ? `  [not applied: ${e.error ?? 'the write failed'}]` : ''}`;
}

const LEVELS = ['L0', 'L1', 'L2', 'L3'];

export async function presetCommand(sub: string | undefined, args: string[], d: SettingsDeps): Promise<number> {
  const level = args[0];
  if (level !== undefined && !LEVELS.includes(level)) { d.out(`${level}: not a level (L0, L1, L2 or L3)`); return 2; }
  const t = await (d.transport ?? settingsTransport)();
  const v = (await t.view()).presets;
  if (sub === 'show' || sub === undefined) {
    if (v.error) d.out(`teams.yaml is not valid, so the defaults apply: ${v.error}`);
    d.out(level ? presetLevelText(v.text, level).trimEnd() : v.text ? v.text.trimEnd() : '# no teams.yaml: the defaults apply');
    d.out('');
    for (const l of level ? [level] : LEVELS) {
      const p = v.effective[l as keyof typeof v.effective];
      d.out(`${l}: ${p.leadDirect ? 'lead alone' : p.roles.map(r => `${r.role}${r.count > 1 ? `×${r.count}` : ''} ${r.start}`).join(', ')}; budget $${p.budgetUsd}${p.leadMayAdjust ? '; the lead may adjust' : ''}`);
    }
    return 0;
  }
  if (sub === 'edit') {
    const initial = level ? presetLevelText(v.text, level) : v.text || '# teams.yaml: what you set here goes on top of the defaults (see `preset show`)\n';
    return editLoop(d, initial, '.yaml', async text => {
      let full = text;
      if (level) {
        try { full = mergePresetLevel(readText(path.join(d.home ?? routerHome(), 'teams.yaml')) ?? '', level, text); }
        catch (e) { if (e instanceof SettingsRejected) return [400, { ok: false, errors: e.errors }]; throw e; }
      }
      return t.write('presets', { text: full, revision: v.revision });
    }, t);
  }
  d.out('usage: do-it-all-claude-code preset show [L0|L1|L2|L3] | edit [L0|L1|L2|L3]');
  return 2;
}

export async function roleCommand(sub: string | undefined, args: string[], d: SettingsDeps): Promise<number> {
  const role = args[0];
  if (sub !== 'show' && sub !== 'edit' && sub !== 'reset') { d.out('usage: do-it-all-claude-code role show <role> | edit <role> | reset <role>'); return 2; }
  if (!isRoleName(role)) { d.out('the role is one of architect, ui-designer, coder, reviewer, tester'); return 2; }
  const t = await (d.transport ?? settingsTransport)();
  if (sub === 'reset') {
    // decision 168: drop any override and put the role back to the template (409 when there is no generated plugin)
    const [status, a] = await t.write('role', { role, reset: true });
    if (status !== 200 || a.ok === false) { printErrors(d, a.errors); return 1; }
    if (a.changed?.length) printSaved(d, t, a); else d.out(`No change: ${role} already matches the template.`);
    return 0;
  }
  const v = (await t.view()).roles;
  const item = v.items.find(i => i.role === role);
  if (!item) { d.out(`no ${role}.md in the plugin`); return 1; }
  if (sub === 'show') {
    d.out(item.overridden ? `# ${role}: your changes to ${item.overriddenFields.join(', ')} on top of the template` : `# ${role}: as the template has it`);
    d.out(item.text.trimEnd());
    return 0;
  }
  if (!v.editable) { d.out('Role edits need the generated plugin: run `do-it-all-claude-code init` again (it points Claude Code at <home>/plugin; your current setup keeps working until then).'); return 1; }
  d.out(`Locked: name, x-router.role, disallowedTools, isolation. tools: ${TOOLS_RULE}. verify commands run as you.`);
  return editLoop(d, item.text, '.md', text => t.write('role', { role, text, revision: item.revision }), t);
}

export async function reloadCommand(d: SettingsDeps): Promise<number> {
  const t = await (d.transport ?? settingsTransport)();
  const [status, a] = await t.write('reload', {});
  if (status !== 200) { printErrors(d, a.errors); return 1; }
  d.out(t.via === 'daemon' ? `Reloaded: ${(a.reloaded ?? []).join(', ')}.` : 'The daemon is not running: it reads the files at its next start. The effective plugin was brought up to date.');
  for (const n of a.notes ?? []) d.out(`  ${n}`);
  return 0;
}
