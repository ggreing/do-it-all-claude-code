// Decision 168: the CLI's settings commands: field-level `config set`, $EDITOR edits re-validated on save (refused:
// the problems shown, the file kept, the buffer reopened or kept), and the direct path when no daemon runs. A temp
// router home and a fake editor; the daemon path is covered by the daemon's settings tests.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectivePluginDir, generateEffectivePlugin, readAudit } from '@do-it-all-claude-code/core';
import { configCommand, directTransport, presetCommand, reloadCommand, roleCommand, settingsTransport, type SettingsDeps } from '../src/settings.ts';
import { ensureLocalState, readConfig, writeConfig } from '../src/setup.ts';

const PLUGIN = fileURLToPath(new URL('../../../plugin/', import.meta.url));
let tmp = '', home = '', templates = '';
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cli-set-'));
  home = path.join(tmp, 'home');
  templates = path.join(tmp, 'plugin');
  fs.cpSync(PLUGIN, templates, { recursive: true });
  process.env.DO_IT_ALL_CLAUDE_CODE_HOME = home;
  // as this release's init leaves it: the effective plugin generated, the templates recorded
  await ensureLocalState({}, effectivePluginDir(home));
  generateEffectivePlugin(home, templates);
  writeConfig({ ...readConfig()!, pluginTemplateDir: templates });
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Deps with a fake editor: each call applies the next edit to the file it is given. */
function deps(edits: Array<(text: string) => string> = [], o: { tty?: boolean; answers?: boolean[] } = {}) {
  const lines: string[] = [];
  const opened: string[] = [];
  const answers = [...(o.answers ?? [])];
  const d: SettingsDeps = {
    out: l => { lines.push(l); }, transport: async () => directTransport(home), isTTY: o.tty ?? false, home,
    ask: async () => answers.shift() ?? false,
    edit: file => { opened.push(fs.readFileSync(file, 'utf8')); const next = edits.shift(); if (next) fs.writeFileSync(file, next(fs.readFileSync(file, 'utf8'))); },
  };
  return { d, lines, opened, text: () => lines.join('\n') };
}
const cfg = () => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as Record<string, unknown>;

test('decision 168: no daemon running: the CLI writes with the core directly (and says the daemon reads it at its next start)', async () => {
  assert.equal((await settingsTransport()).via, 'direct');
  const s = deps();
  assert.equal(await configCommand('set', ['holdoutRate', '0.15', 'budgetsUsd.L2', '7'], s.d), 0);
  assert.match(s.text(), /^Saved: budgetsUsd\.L2, holdoutRate \(the daemon is not running: it reads the change at its next start\)\.$/m);
  assert.deepEqual([cfg().holdoutRate, (cfg().budgetsUsd as Record<string, number>).L2], [0.15, 7]);
  assert.equal(readAudit(home)[0]!.source, 'cli-direct');
  const g = deps();
  assert.equal(await configCommand('get', ['budgetsUsd.L2'], g.d), 0);
  assert.equal(g.text(), '7');
  const bad = deps();
  assert.equal(await configCommand('set', ['holdoutRate', '0.9', 'apiMode', 'direct'], bad.d), 1);
  assert.match(bad.text(), /Not saved; nothing was changed:\n {2}holdoutRate: must be from 0 to 0\.2\n {2}apiMode: changed with `do-it-all-claude-code mode`: not editable here/);
  assert.equal(cfg().holdoutRate, 0.15);
  const l = deps();
  await configCommand('list', [], l.d);
  assert.match(l.text(), /^holdoutRate +0\.15$/m);
  assert.match(l.text(), /^stepDown +"on" +\(default\)$/m);
  assert.match(l.text(), /^eventRetentionDays +30 +\(default, applies at the next start\)$/m);
  assert.match(l.text(), /Set by init or mode, not here: daemonPort/);
});

test('decision 168: config edit in $EDITOR: saved when it holds; refused: the problems shown, the file kept, the buffer reopened or kept', async () => {
  const ok = deps([t => t.replace('"daemonPort"', '"stepDown": "off",\n  "daemonPort"')]);
  assert.equal(await configCommand('edit', [], ok.d), 0);
  assert.equal(cfg().stepDown, 'off');
  // refused, no terminal: the buffer is kept for the user
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  const bad = deps([t => t.replace('"stepDown": "off"', '"stepDown": "sideways"')]);
  assert.equal(await configCommand('edit', [], bad.d), 1);
  assert.match(bad.text(), /stepDown: must be one of on, off/);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
  const kept = /What you typed is kept in (.+)\.$/m.exec(bad.text())![1]!;
  assert.match(fs.readFileSync(kept, 'utf8'), /"sideways"/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
  // in a terminal: "edit again" reopens what was typed (not the original), and the fix is saved
  const again = deps([t => t.replace('"stepDown": "off"', '"stepDown": "sideways"'), t => t.replace('"sideways"', '"on"')], { tty: true, answers: [true] });
  assert.equal(await configCommand('edit', [], again.d), 0);
  assert.match(again.opened[1]!, /"sideways"/, 'the second open shows what was typed');
  assert.equal(cfg().stepDown, 'on');
  // not JSON at all
  const notJson = deps([() => '{ nope']);
  assert.equal(await configCommand('edit', [], notJson.d), 1);
  assert.match(notJson.text(), /json: /);
  // closed without a change
  const same = deps([t => t]);
  assert.equal(await configCommand('edit', [], same.d), 0);
  assert.match(same.text(), /No change\./);
});

test('decision 168: preset show and edit, the whole file or one level', async () => {
  const one = deps([t => t.replace('L2: null', 'L2:\n  budget_usd: 9\n  lead_direct: false')]);
  assert.equal(await presetCommand('edit', ['L2'], one.d), 0, one.text());
  assert.match(fs.readFileSync(path.join(home, 'teams.yaml'), 'utf8'), /L2:\n {2}budget_usd: 9/);
  const show = deps();
  await presetCommand('show', ['L2'], show.d);
  assert.match(show.text(), /^L2: architect s3, coder.*; budget \$5/m, 'config.json\'s budget wins over budget_usd');
  const bad = deps([t => t.replace('budget_usd: 9', 'budget_usd: -3')]);
  assert.equal(await presetCommand('edit', ['L2'], bad.d), 1);
  assert.match(bad.text(), /L2\.budget_usd: /);
  assert.match(fs.readFileSync(path.join(home, 'teams.yaml'), 'utf8'), /budget_usd: 9/);
  assert.equal(await presetCommand('edit', ['L9'], deps().d), 2);
});

test('decision 168: role show and edit: locked fields refused, verify flagged as running as you, saved into the effective plugin', async () => {
  const show = deps();
  await roleCommand('show', ['coder'], show.d);
  assert.match(show.text(), /^# coder: as the template has it\n---\nname: coder/);
  const ok = deps([t => t.replace('effort: low', 'effort: high').replace('    - { kind: test, command: npm test --if-present, ifExists: package.json }', '    - { kind: test, command: npm run test:fast, ifExists: package.json }')]);
  assert.equal(await roleCommand('edit', ['coder'], ok.d), 0, ok.text());
  assert.match(ok.text(), /Saved: effort, x-router\.verify/);
  assert.match(ok.text(), /run on your machine, as you/);
  assert.match(fs.readFileSync(path.join(effectivePluginDir(home), 'agents', 'coder.md'), 'utf8'), /npm run test:fast/);
  const locked = deps([t => t.replace('name: coder', 'name: chief')]);
  assert.equal(await roleCommand('edit', ['coder'], locked.d), 1);
  assert.match(locked.text(), /name: must stay "coder"/);
  const shown = deps();
  await roleCommand('show', ['coder'], shown.d);
  assert.match(shown.text(), /^# coder: your changes to effort, x-router\.verify on top of the template/);
  assert.equal(await roleCommand('edit', ['boss'], deps().d), 2);
});

test('decision 168: an install from before keeps working: roles are shown from the shipped plugin, an edit asks for init', async () => {
  writeConfig({ ...readConfig()!, pluginTemplateDir: undefined, pluginDir: PLUGIN } as never);
  const show = deps();
  assert.equal(await roleCommand('show', ['tester'], show.d), 0);
  assert.match(show.text(), /name: tester/);
  const edit = deps([t => t]);
  assert.equal(await roleCommand('edit', ['tester'], edit.d), 1);
  assert.match(edit.text(), /run `do-it-all-claude-code init` again/);
  assert.equal(edit.opened.length, 0, 'the editor is not opened');
});

test('decision 168: reload with the daemon down brings the effective plugin up to date', async () => {
  fs.appendFileSync(path.join(templates, 'agents', 'tester.md'), '\nNew upstream line.\n');
  const r = deps();
  assert.equal(await reloadCommand(r.d), 0);
  assert.match(r.text(), /The daemon is not running: it reads the files at its next start/);
  assert.match(fs.readFileSync(path.join(effectivePluginDir(home), 'agents', 'tester.md'), 'utf8'), /New upstream line\./);
});

test('decision 168: doctor checks the effective plugin (generated, current, floor held); the status line from it is recognised', async () => {
  const { effectivePluginCheck } = await import('../src/doctor.ts');
  const { isRouterStatusLine } = await import('../src/setup.ts');
  let c = effectivePluginCheck(readConfig()!);
  assert.deepEqual([c.ok, c.blocking], [true, false], c.detail);
  // a template change not generated yet: a warning to reload
  fs.appendFileSync(path.join(templates, 'agents', 'coder.md'), '\nlater\n');
  c = effectivePluginCheck(readConfig()!);
  assert.deepEqual([c.ok, c.blocking], [false, false]);
  assert.match(c.detail, /older templates: run do-it-all-claude-code reload/);
  generateEffectivePlugin(home, templates);
  // a generated role file edited by hand past the floor: blocking (Claude Code would load it)
  const file = path.join(effectivePluginDir(home), 'agents', 'reviewer.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^tools: .*$/m, 'tools: Read, WebSearch'));
  c = effectivePluginCheck(readConfig()!);
  assert.deepEqual([c.ok, c.blocking], [false, true]);
  assert.match(c.detail, /reviewer: tools: WebSearch is never allowed/);
  // an install from before
  c = effectivePluginCheck({ ...readConfig()!, pluginTemplateDir: undefined, pluginDir: PLUGIN });
  assert.match(c.detail, /as shipped\); run do-it-all-claude-code init again to use role edits/);
  // the status line init writes now points into the home: still the router's (and never wrapped)
  assert.equal(isRouterStatusLine(`node "${path.join(effectivePluginDir(home), 'statusline.mjs')}"`), true);
});

test('decision 168 review L6: config edit sends the revision it opened (a change made meanwhile is not overwritten); old buffers are swept', async () => {
  const { applyConfigChange } = await import('@do-it-all-claude-code/core');
  const { sweepEditBuffers, EDIT_BUFFER_MAX_AGE_MS } = await import('../src/settings.ts');
  // while the editor is open, the dashboard changes the file
  const s = deps([t => { applyConfigChange(home, { set: { holdoutRate: 0.01 } }, 'dashboard'); return t.replace('"daemonPort"', '"stepDown": "off",\n  "daemonPort"'); }]);
  assert.equal(await configCommand('edit', [], s.d), 1);
  assert.match(s.text(), /revision: changed since you loaded it/);
  assert.deepEqual([cfg().holdoutRate, cfg().stepDown], [0.01, undefined], 'the other change stays; the stale edit is not written');
  // buffers older than a day go at the next edit; fresh ones and other files stay
  const dir = path.join(home, 'edit');
  const old = path.join(dir, 'aaaaaaaaaaaa.json'), fresh = path.join(dir, 'bbbbbbbbbbbb.yaml'), other = path.join(dir, 'notes.txt');
  for (const f of [old, fresh, other]) fs.writeFileSync(f, 'x');
  const past = (Date.now() - EDIT_BUFFER_MAX_AGE_MS - 60_000) / 1000;
  fs.utimesSync(old, past, past);
  fs.utimesSync(other, past, past);
  const n = deps([t => t]);
  await configCommand('edit', [], n.d);
  assert.deepEqual([fs.existsSync(old), fs.existsSync(fresh), fs.existsSync(other)], [false, true, true]);
  assert.deepEqual(sweepEditBuffers(dir), []);
});

test('decision 168 review L3: doctor warns when a generated role file is not what its template and override give', async () => {
  const { effectivePluginCheck } = await import('../src/doctor.ts');
  const file = path.join(effectivePluginDir(home), 'agents', 'tester.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('model: haiku', 'model: opus'));   // holds the floor
  const c = effectivePluginCheck(readConfig()!);
  assert.deepEqual([c.ok, c.blocking], [false, false]);
  assert.match(c.detail, /^tester: not what the template and your changes give/);
  const r = deps();
  assert.equal(await reloadCommand(r.d), 0);
  assert.equal(effectivePluginCheck(readConfig()!).ok, true);
});

test('decision 168 review L5: init refuses a --plugin-dir inside the router home, before writing anything', async () => {
  const { spawnSync } = await import('node:child_process');
  const fresh = path.join(tmp, 'fresh-home');
  const cli = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  for (const dir of [path.join(fresh, 'plugin'), fresh]) {
    const r = spawnSync(process.execPath, [cli, 'init', '--yes', '--plugin-dir', dir, '--claude-settings', path.join(tmp, 'settings.json')], {
      env: { ...process.env, DO_IT_ALL_CLAUDE_CODE_HOME: fresh }, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /may not be inside the router home/);
  }
  assert.ok(!fs.existsSync(path.join(fresh, 'config.json')) && !fs.existsSync(path.join(tmp, 'settings.json')), 'nothing written');
});
