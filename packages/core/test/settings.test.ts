// Decision 168: the settings write core for config.json and teams.yaml: validation that rejects (never clamps) and
// keeps the previous content, atomic 0600 writes, one audit line per change without secret values, revisions.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SettingsRejected, applyConfigChange, applyPresetsChange, configView, mergePresetLevel, parseConfigInput, presetLevelText, presetsView,
  readAudit, revisionOf, settingsLogFile, validateConfigReplace, validateConfigSet, validatePresetsText,
} from '../src/index.ts';

let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-settings-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: 47800, fableOptIn: false, pluginDir: '/x/plugin', budgetsUsd: { L0: 0.5, L1: 2, L2: 5, L3: 15 }, legacyKey: 1 }, null, 2) + '\n');
});
afterEach(() => { mock.restoreAll(); fs.rmSync(home, { recursive: true, force: true }); });
const cfgText = () => fs.readFileSync(path.join(home, 'config.json'), 'utf8');
const rejected = (fn: () => unknown): SettingsRejected => {
  try { fn(); } catch (e) { if (e instanceof SettingsRejected) return e; throw e; }
  assert.fail('not rejected');
};

test('decision 168: config set validates every key and rejects the whole change on any problem (never clamps)', () => {
  const cur = JSON.parse(cfgText()) as Record<string, unknown>;
  const ok = validateConfigSet(cur, { holdoutRate: 0.15, 'budgetsUsd.L2': 7, autoRelease: 'on', 'delegateFrom.haiku': 'L1', forceLevel: null });
  assert.deepEqual([ok.next.holdoutRate, (ok.next.budgetsUsd as Record<string, number>).L2, ok.next.autoRelease, ok.next.delegateFrom], [0.15, 7, 'on', { haiku: 'L1' }]);
  assert.deepEqual(ok.changes.map(c => c.path), ['budgetsUsd.L2', 'delegateFrom.haiku', 'autoRelease', 'holdoutRate']);
  const e = rejected(() => validateConfigSet(cur, {
    holdoutRate: 0.5, eventRetentionDays: 1.5, 'budgetsUsd.L2': 0, 'budgetsUsd.L9': 1, autoRelease: 'maybe', daemonPort: 1, apiMode: 'direct', nope: 1, 'stepDown.x': 'on',
  }));
  assert.deepEqual(e.errors.map(x => x.path).sort(), ['apiMode', 'autoRelease', 'budgetsUsd.L2', 'budgetsUsd.L9', 'daemonPort', 'eventRetentionDays', 'holdoutRate', 'nope', 'stepDown.x']);
  assert.match(e.errors.find(x => x.path === 'holdoutRate')!.message, /from 0 to 0\.2/);
  assert.match(e.errors.find(x => x.path === 'apiMode')!.message, /changed with `do-it-all-claude-code mode`: not editable here/);
  assert.match(e.errors.find(x => x.path === 'budgetsUsd.L2')!.message, /above 0/);
  assert.equal(rejected(() => validateConfigSet(cur, {})).errors[0]!.path, 'set');
  // decision 175: reproduce first is a setting (on, observe, off)
  assert.equal(validateConfigSet(cur, { reproduceFirst: 'observe' }).next.reproduceFirst, 'observe');
  assert.match(rejected(() => validateConfigSet(cur, { reproduceFirst: 'yes' })).errors[0]!.message, /one of on, observe, off/);
  // typed input from the command line
  assert.deepEqual([parseConfigInput('holdoutRate', '0.1'), parseConfigInput('recordPrompts', 'on'), parseConfigInput('budgetsUsd', '{"L2":7}'), parseConfigInput('forceLevel', 'default'), parseConfigInput('holdoutRate', 'lots')],
    [0.1, true, { L2: 7 }, null, 'lots']);
});

test('decision 168: config edit (the whole file): settings validated, init-owned and unknown keys as they were', () => {
  const cur = JSON.parse(cfgText()) as Record<string, unknown>;
  const r = validateConfigReplace(cur, { ...cur, stepDown: 'off' });
  assert.deepEqual([r.next.stepDown, r.next.daemonPort, r.next.legacyKey], ['off', 47800, 1], 'what is not a setting stays');
  const e = rejected(() => validateConfigReplace(cur, { ...cur, daemonPort: 1, legacyKey: 2, newKey: true, stepDown: 'sideways' }));
  assert.deepEqual(e.errors.map(x => x.path).sort(), ['daemonPort', 'legacyKey', 'newKey', 'stepDown']);
  assert.match(rejected(() => validateConfigReplace(cur, [])).errors[0]!.message, /JSON object/);
});

test('decision 168: an applied change is written atomically (0600) and logged once; a refused one changes nothing', () => {
  const before = cfgText();
  const r = applyConfigChange(home, { set: { holdoutRate: 0.2, recordPrompts: true } }, 'cli-direct', new Date('2026-11-13T10:00:00Z'));
  assert.deepEqual([r.changed, r.nextStart], [['holdoutRate', 'recordPrompts'], ['recordPrompts']]);
  const after = JSON.parse(cfgText()) as Record<string, unknown>;
  assert.deepEqual([after.holdoutRate, after.recordPrompts, after.daemonPort, after.legacyKey], [0.2, true, 47800, 1]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, 'config.json')).mode & 0o777, 0o600);
  const log = readAudit(home);
  assert.equal(log.length, 1);
  const { id, ...entry } = log[0]!;
  assert.match(String(id), /^[0-9a-f]{12}$/);
  assert.deepEqual(entry, { at: '2026-11-13T10:00:00.000Z', source: 'cli-direct', kind: 'config', changes: [{ path: 'holdoutRate', from: null, to: 0.2 }, { path: 'recordPrompts', from: null, to: true }] });
  if (process.platform !== 'win32') assert.equal(fs.statSync(settingsLogFile(home)).mode & 0o777, 0o600);
  // refused: the file and the log stay as they were
  const now = cfgText();
  rejected(() => applyConfigChange(home, { set: { holdoutRate: 9 } }, 'cli'));
  assert.equal(cfgText(), now);
  assert.equal(readAudit(home).length, 1);
  // no change, no line
  assert.deepEqual(applyConfigChange(home, { set: { holdoutRate: 0.2 } }, 'cli').changed, []);
  assert.equal(readAudit(home).length, 1);
  assert.notEqual(before, now);
});

test('decision 168: a crash between writing the new file and putting it in place leaves the old one, and the log says it failed', () => {
  const before = cfgText();
  mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('power cut'), { code: 'EIO' }); });
  assert.throws(() => applyConfigChange(home, { set: { stepDown: 'off' } }, 'cli'), /power cut/);
  mock.restoreAll();
  assert.equal(cfgText(), before);
  assert.deepEqual(fs.readdirSync(home).filter(f => f.endsWith('.tmp')), [], 'no temp file left');
  // review M3: the line was written first; the failure line marks it as not applied
  const log = readAudit(home);
  assert.equal(log.length, 1);
  assert.deepEqual([log[0]!.failed, log[0]!.changes[0]!.path], [true, 'stepDown']);
  assert.match(log[0]!.error!, /EIO: power cut/);
});

test('decision 168: a stale revision is refused (409); the current one goes through', () => {
  const rev = configView(cfgText()).revision;
  assert.equal(rev, revisionOf(cfgText()));
  applyConfigChange(home, { set: { stepDown: 'off' }, revision: rev }, 'cli');
  const e = rejected(() => applyConfigChange(home, { set: { stepDown: 'on' }, revision: rev }, 'cli'));
  assert.deepEqual([e.status, e.errors[0]!.path], [409, 'revision']);
});

test('decision 168: the config view lists every setting with its value and default, and what init and mode own', () => {
  const v = configView(cfgText());
  const k = Object.fromEntries(v.keys.map(x => [x.key, x]));
  assert.deepEqual([k.holdoutRate!.value, k.holdoutRate!.set, k.budgetsUsd!.set, k.bearerApi!.deprecated, k.eventRetentionDays!.appliesAt], [0.1, false, true, true, 'next start']);
  assert.ok(v.managed.some(m => m.key === 'daemonPort') && v.managed.some(m => m.key === 'apiMode'));
});

test('decision 168: teams.yaml: YAML errors with their line, schema errors with their path, nothing written on error', () => {
  let e = rejected(() => validatePresetsText('L2:\n  budget_usd: [unclosed\n'));
  assert.equal(e.errors[0]!.path, 'yaml');
  assert.ok(e.errors[0]!.line! >= 2);
  e = rejected(() => validatePresetsText('L2:\n  roles:\n    - { role: coder, count: 9, start: s1 }\n  budget_usd: -1\nL7: {}\n'));
  assert.deepEqual(e.errors.map(x => x.path).sort(), ['L2.budget_usd', 'L2.roles[0].count', 'L7']);
  rejected(() => applyPresetsChange(home, { text: 'L2:\n  surprise: 1\n' }, 'cli'));
  assert.ok(!fs.existsSync(path.join(home, 'teams.yaml')));
  // valid: written, logged per level; the view puts it on the defaults, with config budgets winning
  const r = applyPresetsChange(home, { text: 'L1:\n  lead_direct: false\nL2:\n  budget_usd: 9\n' }, 'cli');
  assert.deepEqual(r.changed, ['L1', 'L2']);
  const v = presetsView(home);
  assert.deepEqual([v.effective.L1.leadDirect, v.effective.L2.budgetUsd], [undefined, 5], 'config.json budgetsUsd.L2 (5) wins over budget_usd');
  assert.deepEqual(readAudit(home)[0]!.changes, [{ path: 'L1', changed: true }, { path: 'L2', changed: true }]);
  // empty text removes the file
  assert.deepEqual(applyPresetsChange(home, { text: '' }, 'cli').changed, ['L1', 'L2']);
  assert.ok(!fs.existsSync(path.join(home, 'teams.yaml')));
});

test('decision 168: one level of teams.yaml edited on its own, merged back without touching the others', () => {
  const full = '# my teams\nL1:\n  lead_direct: false\nL2:\n  budget_usd: 9\n';
  assert.equal(presetLevelText(full, 'L2').trim(), 'L2:\n  budget_usd: 9');
  assert.equal(presetLevelText(full, 'L3').trim(), 'L3: null');
  const merged = mergePresetLevel(full, 'L2', 'L2:\n  budget_usd: 11\n  lead_direct: true\n');
  assert.match(merged, /L1:\n {2}lead_direct: false/);
  assert.match(merged, /L2:\n {2}budget_usd: 11\n {2}lead_direct: true/);
  assert.ok(!/L2:[\s\S]*L2:/.test(merged));
  assert.throws(() => mergePresetLevel(full, 'L2', 'L1:\n  lead_direct: true\n'), (e: unknown) => e instanceof SettingsRejected && /only L2 may be set here/.test(e.errors[0]!.message));
  assert.ok(!/L2:/.test(mergePresetLevel(full, 'L2', 'L2:\n')), 'an empty level is taken out');
});
