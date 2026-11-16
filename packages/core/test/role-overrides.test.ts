// Decision 168: role edits as overrides in the router home and the generated effective plugin. A copy of the repository's
// plugin serves as the templates (so a "git pull" can be simulated); temp homes only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENERATED_STAMP, ROLE_NAMES, SettingsRejected, applyRoleChange, effectivePluginDir, generateEffectivePlugin, pluginRoleProblems, readAudit,
  readRoleOverride, roleFloorProblems, rolesView, templateHash,
} from '../src/index.ts';

const PLUGIN = fileURLToPath(new URL('../../../plugin/', import.meta.url));
let tmp = '', home = '', templates = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-roles-'));
  home = path.join(tmp, 'home');
  templates = path.join(tmp, 'plugin');
  fs.mkdirSync(home);
  fs.cpSync(PLUGIN, templates, { recursive: true });
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const eff = (role: string) => fs.readFileSync(path.join(effectivePluginDir(home), 'agents', `${role}.md`), 'utf8');
const tpl = (role: string) => fs.readFileSync(path.join(templates, 'agents', `${role}.md`), 'utf8');
const refused = (fn: () => unknown): SettingsRejected => {
  try { fn(); } catch (e) { if (e instanceof SettingsRejected) return e; throw e; }
  assert.fail('not refused');
};

test('decision 168: the shipped role files hold the floor (the contract the templates keep)', () => {
  for (const role of ROLE_NAMES) assert.deepEqual(roleFloorProblems(fs.readFileSync(path.join(PLUGIN, 'agents', `${role}.md`), 'utf8'), role), [], role);
});

test('decision 168: without overrides the effective plugin is the templates, byte for byte; a second run writes nothing', () => {
  const g = generateEffectivePlugin(home, templates);
  assert.deepEqual(g.refused, []);
  for (const rel of g.written.filter(r => r !== GENERATED_STAMP)) {
    assert.ok(fs.readFileSync(path.join(templates, rel)).equals(fs.readFileSync(path.join(effectivePluginDir(home), rel))), rel);
  }
  assert.ok(g.written.includes('.claude-plugin/plugin.json') && g.written.includes('hooks/guard.mjs') && g.written.includes('agents/coder.md'));
  assert.deepEqual(generateEffectivePlugin(home, templates).written, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(effectivePluginDir(home), GENERATED_STAMP), 'utf8')).templateHash, templateHash(templates));
  assert.deepEqual(pluginRoleProblems(effectivePluginDir(home)), [], 'the runtime floor holds over the effective files');
});

test('decision 168: an edit is kept as the changed fields only, and survives a template change ("git pull")', () => {
  generateEffectivePlugin(home, templates);
  const edited = eff('coder').replace('model: haiku', 'model: sonnet').replace('effort: low', 'effort: high');
  const r = applyRoleChange(home, templates, { role: 'coder', text: edited }, 'cli-direct');
  assert.deepEqual(r.changed, ['model', 'effort']);
  assert.deepEqual(readRoleOverride(home, 'coder').override, { version: 1, role: 'coder', fields: { model: 'sonnet', effort: 'high' } });
  assert.match(eff('coder'), /^model: sonnet$/m);
  // upstream changes the coder's instructions and its turn limit: both arrive, the user's model and effort stay
  fs.writeFileSync(path.join(templates, 'agents', 'coder.md'), tpl('coder').replace('maxTurns: 40', 'maxTurns: 45') + '\nA new paragraph from upstream.\n');
  const g = generateEffectivePlugin(home, templates);
  assert.deepEqual([g.written.includes('agents/coder.md'), g.refused], [true, []]);
  assert.match(eff('coder'), /^model: sonnet$/m);
  assert.match(eff('coder'), /^effort: high$/m);
  assert.match(eff('coder'), /^maxTurns: 45$/m);
  assert.match(eff('coder'), /A new paragraph from upstream\./);
  // a file the template no longer has goes
  fs.rmSync(path.join(templates, 'skills', 'router'), { recursive: true });
  assert.ok(generateEffectivePlugin(home, templates).removed.includes('skills/router/SKILL.md'));
  // the generated file edited by hand: the next generation puts it back
  fs.writeFileSync(path.join(effectivePluginDir(home), 'agents', 'coder.md'), eff('coder').replace('tools: Read, Edit, Write, Bash, Grep, Glob', 'tools: Read, WebFetch'));
  assert.equal(pluginRoleProblems(effectivePluginDir(home))[0]?.role, 'coder', 'the runtime check sees it');
  generateEffectivePlugin(home, templates);
  assert.deepEqual(pluginRoleProblems(effectivePluginDir(home)), []);
  assert.match(eff('coder'), /^model: sonnet$/m);
});

test('decision 168: the floor: every edit that would weaken a role is refused, with its path, and nothing changes', () => {
  generateEffectivePlugin(home, templates);
  const base = eff('coder');
  const cases: Array<[string, string, RegExp]> = [
    ['tools', base.replace(/^tools: .*$/m, 'tools: Read, Edit, WebFetch'), /WebFetch is never allowed/],
    ['tools', base.replace(/^tools: .*$/m, 'tools: Read, Agent(coder)'), /Agent is never allowed/],
    ['tools', base.replace(/^tools: .*$/m, 'tools: Read, mcp__fetch__get'), /MCP tools are not allowed/],
    ['tools', base.replace(/^tools: .*\n/m, ''), /needs at least one tool/],
    ['tools', base.replace(/^tools: .*$/m, 'tools: ""'), /needs at least one tool/],
    ['name', base.replace('name: coder', 'name: boss'), /must stay "coder"/],
    ['x-router.role', base.replace('  role: coder', '  role: reviewer'), /must stay "coder"/],
    ['disallowedTools', base.replace(/^disallowedTools: .*\n/m, ''), /locked/],
    ['front matter.permissionMode', base.replace('model: haiku', 'model: haiku\npermissionMode: bypassPermissions'), /not a field a router role may set/],
    ['front matter.hooks', base.replace('model: haiku', 'model: haiku\nhooks: {}'), /not a field/],
    ['front matter.mcpServers', base.replace('model: haiku', 'model: haiku\nmcpServers: [web]'), /not a field/],
    ['x-router.extra', base.replace('  role: coder', '  role: coder\n  extra: 1'), /not a field/],
    ['model', base.replace('model: haiku', 'model: gpt-9'), /one of haiku/],
    ['effort', base.replace('effort: low', 'effort: ludicrous'), /one of low/],
    ['maxTurns', base.replace('maxTurns: 40', 'maxTurns: 9000'), /1 to 500/],
    ['x-router.verify[0].ifExists', base.replace('ifExists: package-lock.json', 'ifExists: /etc/passwd'), /repo-relative/],
    ['front matter', 'no front matter here', /YAML front matter/],
  ];
  for (const [p, text, message] of cases) {
    const e = refused(() => applyRoleChange(home, templates, { role: 'coder', text }, 'cli'));
    const hit = e.errors.find(x => x.path === p);
    assert.ok(hit, `${p}: ${JSON.stringify(e.errors)}`);
    assert.match(hit.message, message, p);
  }
  assert.equal(eff('coder'), base, 'nothing changed');
  assert.equal(readRoleOverride(home, 'coder').override, null);
  assert.equal(readAudit(home).length, 0);
  assert.equal(refused(() => applyRoleChange(home, templates, { role: 'boss', text: base }, 'cli')).errors[0]!.path, 'role');
  assert.equal(refused(() => applyRoleChange(home, undefined, { role: 'coder', text: base }, 'cli')).status, 409, 'an install without the generated plugin');
});

test('decision 168: verify steps are editable (runs as you), partial fields and reset work, and the audit has no secret', () => {
  generateEffectivePlugin(home, templates);
  const fake = 'sk-ant-api03-abcdefghijklmnop';
  const r = applyRoleChange(home, templates, { role: 'tester', fields: { 'x-router.verify': [`API_KEY=${fake} npm test`], model: 'opus', body: 'Test it all.\n' } }, 'dashboard');
  assert.deepEqual(r.changed.sort(), ['body', 'model', 'x-router.verify']);
  assert.match(r.notes[0]!, /run on your machine, as you/);
  assert.match(eff('tester'), new RegExp(`API_KEY=${fake} npm test`));
  const log = fs.readFileSync(path.join(home, 'logs', 'settings.jsonl'), 'utf8');
  assert.ok(!log.includes(fake) && !log.includes('Test it all'), 'free text and secrets stay out of the log');
  assert.deepEqual(readAudit(home)[0]!.changes.find(c => c.path === 'model'), { path: 'model', from: 'haiku', to: 'opus' });
  // locked fields cannot be set through the form either
  assert.match(refused(() => applyRoleChange(home, templates, { role: 'tester', fields: { name: 'x' } }, 'dashboard')).errors[0]!.message, /locked/);
  // a stale revision; then reset: back to the template, the override gone
  const v = rolesView(home, templates, effectivePluginDir(home)).items.find(i => i.role === 'tester')!;
  assert.deepEqual([v.overridden, v.overriddenFields.sort(), v.fields['x-router.verify']!.runsAsYou, v.fields.name!.locked], [true, ['body', 'model', 'x-router.verify'], true, true]);
  applyRoleChange(home, templates, { role: 'tester', fields: { model: 'sonnet' }, revision: v.revision }, 'dashboard');
  assert.equal(refused(() => applyRoleChange(home, templates, { role: 'tester', reset: true, revision: v.revision }, 'dashboard')).status, 409);
  applyRoleChange(home, templates, { role: 'tester', reset: true }, 'dashboard');
  assert.equal(eff('tester'), tpl('tester'));
  assert.equal(readRoleOverride(home, 'tester').override, null);
  // editing back to the template's values removes the override too
  applyRoleChange(home, templates, { role: 'tester', fields: { model: 'opus' } }, 'cli');
  applyRoleChange(home, templates, { role: 'tester', fields: { model: 'haiku' } }, 'cli');
  assert.equal(readRoleOverride(home, 'tester').override, null);
});

test('decision 168: an override that no longer holds is refused at generation; the role uses the template file (deterministic, review L3)', () => {
  generateEffectivePlugin(home, templates);
  applyRoleChange(home, templates, { role: 'reviewer', fields: { maxTurns: 25 } }, 'cli');
  const good = eff('reviewer');
  // a hand-written override with a forbidden tool (not through the core)
  fs.writeFileSync(path.join(home, 'roles', 'reviewer.json'), JSON.stringify({ version: 1, role: 'reviewer', fields: { tools: ['Read', 'WebSearch'] } }));
  const g = generateEffectivePlugin(home, templates);
  assert.equal(g.refused[0]?.role, 'reviewer');
  assert.notEqual(eff('reviewer'), good);
  assert.equal(eff('reviewer'), tpl('reviewer'), 'what (template, override) gives when the override does not hold: the template');
  assert.deepEqual(pluginRoleProblems(effectivePluginDir(home)), []);
  // an override file that is not one of ours
  fs.writeFileSync(path.join(home, 'roles', 'architect.json'), '{"version":1,"role":"architect","fields":{"permissionMode":"x"}}');
  assert.ok(generateEffectivePlugin(home, templates).refused.some(r => r.role === 'architect'));
  assert.equal(eff('architect'), tpl('architect'));
});

test('decision 168: an install from before (no templates recorded) shows the shipped roles, not editable', () => {
  const v = rolesView(home, undefined, PLUGIN);
  assert.equal(v.editable, false);
  assert.equal(v.items.length, 5);
  assert.equal(v.items[0]!.text, v.items[0]!.template);
});
