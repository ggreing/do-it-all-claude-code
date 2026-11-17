// Decision 168, review fixes: the tools allow list and whole-entry match (M1), no "---" inside the front matter (M2),
// the audit written with redactJson before the change and marked when the write fails (M3), the dashboard's CLI-only
// keys, override files type-checked (L1), edits built on (template, override) (L2), the runtime rule (L3), no links
// in the generated folder (L4), no templates inside the home (L5), own keys only (L7). Temp homes only.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROLE_NAMES, ROLE_TOOL_ALLOWLIST, SettingsRejected, applyConfigChange, applyRoleChange, configView, effectivePluginDir, effectiveRoleText,
  expectedRole, generateEffectivePlugin, parseRoleFile, pluginRoleProblems, readAudit, readRoleOverride, roleFloorProblems, rolesView,
  settingsLogFile, templateDirProblem, validateConfigReplace, validateConfigSet,
} from '../src/index.ts';
import { withFields } from './role-fields.ts';

const PLUGIN = fileURLToPath(new URL('../../../plugin/', import.meta.url));
let tmp = '', home = '', templates = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-review-'));
  home = path.join(tmp, 'home');
  templates = path.join(tmp, 'plugin');
  fs.mkdirSync(home);
  fs.cpSync(PLUGIN, templates, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: 47800, pluginDir: effectivePluginDir(home) }, null, 2) + '\n');
});
afterEach(() => { mock.restoreAll(); fs.rmSync(tmp, { recursive: true, force: true }); });
const effFile = (role: string) => path.join(effectivePluginDir(home), 'agents', `${role}.md`);
const eff = (role: string) => fs.readFileSync(effFile(role), 'utf8');
const tpl = (role: string) => fs.readFileSync(path.join(templates, 'agents', `${role}.md`), 'utf8');
/** What an editor opens for a role: what (template, override) gives, never a hand edit of the generated file. */
const cur = (role: string) => rolesView(home, templates, effectivePluginDir(home)).items.find(i => i.role === role)!.text;
const refused = (fn: () => unknown): SettingsRejected => {
  try { fn(); } catch (e) { if (e instanceof SettingsRejected) return e; throw e; }
  assert.fail('not refused');
};

test('review M1: a tools entry is matched whole, and only the allow list passes (C\'s reproductions included)', () => {
  generateEffectivePlugin(home, templates);
  const base = eff('coder');
  const withTools = (line: string) => base.replace(/^tools: .*$/m, line);
  const bad: Array<[string, RegExp]> = [
    ['tools: ["Read", "Bash(x) Agent"]', /not one tool entry/],                 // C: a second tool after the rule
    ['tools: Read, Bash(x)WebFetch', /not one tool entry/],                       // C: glued on after the rule
    ['tools: ["Read", "Bash(x)\\nAgent"]', /not one tool entry/],                // C: a newline after the rule
    ['tools: ["Read", " Agent"]', /not one tool entry/],
    ['tools: Read, Bash(a(b))', /not one tool entry/],
    ['tools: Read, *', /not one tool entry/],
    ['tools: Read, PowerShell', /PowerShell is not one of the tools a router role may use/],   // not on the list: refused, not passed
    ['tools: Read, agent', /agent is not one of the tools/],
    ['tools: Read, LaterTool', /LaterTool is not one of the tools/],              // a tool Claude Code might add later
    ['tools: Read, WebFetch', /WebFetch is never allowed/],
    ['tools: Read, Agent(coder)', /Agent is never allowed/],
    ['tools: Read, mcp__x__y', /MCP tools are not allowed/],
  ];
  for (const [line, message] of bad) {
    const errs = roleFloorProblems(withTools(line), 'coder');
    assert.ok(errs.some(e => e.path === 'tools' && message.test(e.message)), `${line}: ${JSON.stringify(errs)}`);
    assert.equal(refused(() => applyRoleChange(home, templates, { role: 'coder', text: withTools(line) }, 'cli')).status, 400, line);
  }
  assert.equal(eff('coder'), base, 'nothing written');
  for (const line of ['tools: Read, Edit, Bash(npm test), Bash(git diff:*), TodoWrite', `tools: ${ROLE_TOOL_ALLOWLIST.join(', ')}`]) {
    assert.deepEqual(roleFloorProblems(withTools(line), 'coder'), [], line);
  }
  // the shipped templates use only tools on the list (the contract the list is derived against)
  for (const role of ROLE_NAMES) for (const t of parseRoleFile(tpl(role)).tools) assert.ok((ROLE_TOOL_ALLOWLIST as readonly string[]).includes(t), `${role}: ${t}`);
  // a hand-written override with such an entry is refused at generation, and the runtime check sees a hand edit
  fs.mkdirSync(path.join(home, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(home, 'roles', 'tester.json'), JSON.stringify({ version: 1, role: 'tester', fields: { tools: ['Read', 'Bash(x) Agent'] } }));
  assert.ok(generateEffectivePlugin(home, templates).refused.some(r => r.role === 'tester'));
  assert.equal(eff('tester'), tpl('tester'));
  fs.writeFileSync(effFile('reviewer'), withTools('tools: Read, Bash(x)WebFetch').replace(/name: coder/, 'name: reviewer'));
  assert.ok(pluginRoleProblems(effectivePluginDir(home)).some(p => p.role === 'reviewer'));
});

test('review M2: "---" anywhere inside the front matter is refused (write, generation, runtime); in the body it is fine', () => {
  generateEffectivePlugin(home, templates);
  const base = eff('coder');
  const desc = (d: string) => base.replace(/^description: .*$/m, d);
  for (const text of [
    desc('description: "a --- b"'),
    desc('description: x ---'),
    desc('description: |\n  first\n  ---\n  tools: Agent'),
    desc('description: "x\\n---\\ntools: Agent"'),
    base.replace('\n---\n## ', '\n----\n## '),                                 // a closing line that is not exactly ---
  ]) {
    const errs = roleFloorProblems(text, 'coder');
    assert.ok(errs.some(e => e.path === 'front matter'), `${text.slice(0, 200)}: ${JSON.stringify(errs)}`);
    assert.ok(refused(() => applyRoleChange(home, templates, { role: 'coder', text }, 'cli')).errors.some(e => e.path === 'front matter'));
  }
  // a field edit: a description carrying a front matter end
  const e = refused(() => applyRoleChange(home, templates, { role: 'coder', text: withFields(cur('coder'), { description: 'x\n---\ntools: Agent' }) }, 'cli'));
  assert.ok(e.errors.some(x => x.path === 'front matter'), JSON.stringify(e.errors));
  // an override file with one: refused at generation, the template is used
  fs.mkdirSync(path.join(home, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(home, 'roles', 'coder.json'), JSON.stringify({ version: 1, role: 'coder', fields: { description: 'a --- b' } }));
  assert.ok(generateEffectivePlugin(home, templates).refused.some(r => r.role === 'coder'));
  assert.equal(eff('coder'), tpl('coder'));
  fs.rmSync(path.join(home, 'roles', 'coder.json'));
  // runtime: a generated file edited to carry one
  fs.writeFileSync(effFile('coder'), desc('description: "a --- b"'));
  assert.ok(pluginRoleProblems(effectivePluginDir(home)).some(p => p.role === 'coder'));
  // a markdown rule in the body is not front matter
  assert.deepEqual(roleFloorProblems(base + '\n---\n\nMore notes.\n', 'coder'), []);
});

test('review M3: values that would break redact() over JSON are logged intact (redactJson); C\'s reproduction', () => {
  generateEffectivePlugin(home, templates);
  const tools = ['Read', 'Edit', 'Bash(curl -H "Cookie: a=b" x)'];
  const r = applyRoleChange(home, templates, { role: 'coder', text: withFields(cur('coder'), { tools }) }, 'cli');
  assert.deepEqual(r.changed, ['tools']);
  for (const line of fs.readFileSync(settingsLogFile(home), 'utf8').trim().split('\n')) JSON.parse(line);
  const c = readAudit(home)[0]!.changes[0]!;
  assert.equal((c.to as string[]).length, 3, 'the shape is kept');
  assert.ok(!JSON.stringify(c).includes('a=b'), 'the cookie value is masked');
  assert.match(String((c.to as string[])[2]), /Cookie: \[REDACTED\]/);
});

test('review M3: the audit line comes before the change; no line, no change; a failed write is marked', () => {
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  mock.method(fs, 'appendFileSync', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  assert.throws(() => applyConfigChange(home, { set: { stepDown: 'off' } }, 'cli'), /disk full/);
  mock.restoreAll();
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before, 'an audit that cannot be written stops the change');
  // the role write failing after its line: rolled back, and the line marked failed
  generateEffectivePlugin(home, templates);
  const real = fs.renameSync;
  mock.method(fs, 'renameSync', (a: fs.PathLike, b: fs.PathLike) => {
    if (String(b).endsWith('coder.json')) throw Object.assign(new Error('locked'), { code: 'EIO' });
    return real(a, b);
  });
  assert.throws(() => applyRoleChange(home, templates, { role: 'coder', text: withFields(cur('coder'), { maxTurns: 41 }) }, 'cli'), /locked/);
  mock.restoreAll();
  const log = readAudit(home);
  assert.deepEqual([log[0]!.kind, log[0]!.target, log[0]!.failed], ['role', 'coder', true]);
  assert.equal(readRoleOverride(home, 'coder').override, null);
  assert.equal(eff('coder'), tpl('coder'));
});

test('review L1: an override file is type-checked; a bad one is refused for its role alone and generation goes on', () => {
  fs.mkdirSync(path.join(home, 'roles'));
  const put = (role: string, fields: unknown) => fs.writeFileSync(path.join(home, 'roles', `${role}.json`), JSON.stringify({ version: 1, role, fields }));
  for (const [fields, message] of [
    [{ tools: 'Read' }, /fields\.tools/], [{ maxTurns: '5' }, /fields\.maxTurns/], [{ maxTurns: 2.5 }, /fields\.maxTurns/],
    [{ verify: [{}] }, /fields\.verify/], [{ verify: [{ command: 'x', ifExists: '/etc/passwd' }] }, /repo-relative/], [{ body: 7 }, /fields\.body/], [{ permissionMode: 'x' }, /unknown field permissionMode/],
  ] as Array<[unknown, RegExp]>) {
    put('tester', fields);
    const r = readRoleOverride(home, 'tester');
    assert.equal(r.override, null);
    assert.match(String(r.error), message, JSON.stringify(fields));
  }
  put('reviewer', { maxTurns: 22 });
  const g = generateEffectivePlugin(home, templates);
  assert.deepEqual(g.refused.map(r => r.role), ['tester']);
  assert.equal(eff('tester'), tpl('tester'));
  assert.match(eff('reviewer'), /^maxTurns: 22$/m, 'the other roles are generated as usual');
});

test('review L2: an edit builds on (template, override), never on a hand edit of the generated file', () => {
  generateEffectivePlugin(home, templates);
  applyRoleChange(home, templates, { role: 'coder', text: withFields(cur('coder'), { maxTurns: 41 }) }, 'cli');
  // a hand edit that holds the floor (so only the rule against promoting it can catch it)
  fs.writeFileSync(effFile('coder'), eff('coder').replace('effort: low', 'effort: max'));
  const v = rolesView(home, templates, effectivePluginDir(home)).items.find(i => i.role === 'coder')!;
  assert.doesNotMatch(v.text, /effort: max/, 'the view shows what (template, override) gives');
  const r = applyRoleChange(home, templates, { role: 'coder', text: withFields(cur('coder'), { model: 'sonnet' }), revision: v.revision }, 'cli');
  assert.deepEqual(r.changed, ['model']);
  assert.deepEqual(readRoleOverride(home, 'coder').override!.fields, { maxTurns: 41, model: 'sonnet' }, 'the hand edit is not promoted');
  assert.match(eff('coder'), /^effort: low$/m);
});

test('review L3: the runtime rule: a generated file that is not what (template, override) gives is not used and is regenerated', () => {
  generateEffectivePlugin(home, templates);
  assert.deepEqual(effectiveRoleText(home, templates, 'tester').regenerated, false);
  fs.writeFileSync(effFile('tester'), eff('tester').replace('model: haiku', 'model: opus'));   // holds the floor
  const r = effectiveRoleText(home, templates, 'tester');
  assert.equal(r.regenerated, true);
  assert.equal(r.text, tpl('tester'));
  assert.equal(eff('tester'), tpl('tester'), 'regenerated');
  // a template change not generated yet counts the same
  fs.appendFileSync(path.join(templates, 'agents', 'tester.md'), '\nUpstream line.\n');
  assert.equal(effectiveRoleText(home, templates, 'tester').regenerated, true);
  assert.match(eff('tester'), /Upstream line\./);
  assert.equal(expectedRole(home, 'tester', tpl('tester')).text, eff('tester'));
});

test('review L4: the generated folder keeps only regular files the template has; links are removed, never followed', (t) => {
  generateEffectivePlugin(home, templates);
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'keep me');
  fs.writeFileSync(path.join(outside, 'coder.md'), 'not a role');
  const dir = effectivePluginDir(home);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'stray');
  fs.mkdirSync(path.join(dir, 'extra', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extra', 'deep', 'x.txt'), 'stray');
  fs.symlinkSync(outside, path.join(dir, 'skills', 'linked'), 'junction');          // a folder link (a junction on Windows)
  fs.rmSync(path.join(dir, 'hooks'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'hooks'), 'junction');                     // a link where a template folder belongs
  let fileLinks = true;
  try {
    fs.rmSync(effFile('coder'));
    fs.symlinkSync(path.join(outside, 'coder.md'), effFile('coder'));               // a link where a role file belongs
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'agents', 'extra.md'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
    fileLinks = false;                                                               // Windows without the symlink privilege
    fs.writeFileSync(effFile('coder'), 'hand edit');
  }
  const g = generateEffectivePlugin(home, templates);
  for (const r of ['notes.txt', 'extra/deep/x.txt', 'skills/linked']) assert.ok(g.removed.includes(r), `${r}: ${JSON.stringify(g.removed)}`);
  assert.ok(!fs.existsSync(path.join(dir, 'extra')) && !fs.existsSync(path.join(dir, 'skills', 'linked')));
  for (const rel of ['hooks', 'agents/coder.md']) assert.ok(!fs.lstatSync(path.join(dir, rel)).isSymbolicLink(), rel);
  assert.ok(fs.lstatSync(path.join(dir, 'hooks')).isDirectory());
  assert.ok(fs.readFileSync(path.join(dir, 'hooks', 'guard.mjs')).equals(fs.readFileSync(path.join(templates, 'hooks', 'guard.mjs'))));
  assert.equal(eff('coder'), tpl('coder'));
  // what the links pointed at is untouched
  assert.deepEqual(fs.readdirSync(outside).sort(), ['coder.md', 'secret.txt']);
  assert.deepEqual([fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), fs.readFileSync(path.join(outside, 'coder.md'), 'utf8')], ['keep me', 'not a role']);
  if (fileLinks) assert.ok(!fs.existsSync(path.join(dir, 'agents', 'extra.md')));
  else t.diagnostic('file links need a privilege here: checked with folder links (junctions) only');
  assert.deepEqual(generateEffectivePlugin(home, templates).written, [], 'and then it is stable');
});

test('review L5: templates inside the router home are refused', () => {
  generateEffectivePlugin(home, templates);
  assert.match(String(templateDirProblem(home, effectivePluginDir(home))), /may not be inside the router home/);
  assert.match(String(templateDirProblem(home, home)), /may not be inside the router home/);
  assert.throws(() => generateEffectivePlugin(home, effectivePluginDir(home)), /may not be inside the router home/);
  assert.equal(templateDirProblem(home, templates), null);
  assert.match(String(templateDirProblem(home, path.join(tmp, 'nope'))), /not a plugin folder/);
});

test('review L7: keys are own keys only; prototype names are never settings', () => {
  const cur = { daemonPort: 1 } as Record<string, unknown>;
  for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
    const e = refused(() => validateConfigSet(cur, { [key]: 1 }));
    assert.match(e.errors[0]!.message, /^not a setting/, key);
  }
  const edited = JSON.parse('{"daemonPort": 1, "__proto__": {"stepDown": "off"}}') as Record<string, unknown>;
  const e = refused(() => validateConfigReplace(cur, edited));
  assert.deepEqual(e.errors.map(x => x.path), ['__proto__']);
  assert.equal(({} as Record<string, unknown>).stepDown, undefined, 'nothing reached the prototype');
});
