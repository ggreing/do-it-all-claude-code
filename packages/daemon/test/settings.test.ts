// Decision 168: the daemon's two front doors for settings, on one write core: sealed /router/v1 routes (the CLI) and the
// dashboard's session + CSRF + same-origin routes. Validate, write, reload, audit; the metrics surface stays read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyConfigChange, effectivePluginDir, readAudit } from '@do-it-all-claude-code/core';
import { call, makeHome, makeRepo, postHook, request, rmrf, startTestDaemon, tmpDir, write, type HookInput, type TestDaemon } from './helpers.ts';

const PLUGIN = fileURLToPath(new URL('../../../plugin/', import.meta.url));
const json = (body: unknown) => JSON.stringify(body);
const post = (d: TestDaemon, p: string, body: unknown) => call(d.port, { method: 'POST', path: p, body: json(body) });

/** A daemon whose config names the templates (an install made by this release's init) and the effective plugin. */
async function withDaemon(fn: (d: TestDaemon, templates: string) => Promise<void>, config: Record<string, unknown> = {}): Promise<void> {
  const templates = tmpDir('ar-tpl-');
  fs.cpSync(PLUGIN, templates, { recursive: true });
  const home = makeHome({ pluginTemplateDir: templates, ...config });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...cfg, pluginDir: effectivePluginDir(home) }));
  const d = await startTestDaemon({ home });
  try { await fn(d, templates); } finally { await d.close(); rmrf(home); rmrf(templates); }
}

/** The dashboard page's session: a code (sealed, as the CLI gets it), the cookie, and the CSRF token. */
async function login(d: TestDaemon): Promise<{ cookie: string; csrf: string; page: Record<string, string> }> {
  const { code } = (await call(d.port, { path: '/dashboard/register-code', method: 'POST' })).body as { code: string };
  const page = { origin: `http://127.0.0.1:${d.port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const auth = await request(d.port, { method: 'POST', path: '/dashboard/auth', headers: page, body: json({ code }) });
  assert.equal(auth.status, 200, auth.text);
  const csrf = (auth.body as { csrf: string }).csrf;
  assert.match(csrf, /^[A-Za-z0-9_-]{40,}$/);
  return { cookie: String(auth.headers['set-cookie']?.[0] ?? '').split(';')[0]!, csrf, page };
}

test('decision 168: the CLI\'s sealed front door: read, write (applied at once), reject with every problem, reload', () => withDaemon(async (d, templates) => {
  // the daemon generated the effective plugin at start
  assert.ok(fs.existsSync(path.join(effectivePluginDir(d.home), 'agents', 'coder.md')));
  const view = (await call(d.port, { path: '/router/v1/settings' })).body as { config: { revision: string }; roles: { editable: boolean; items: unknown[] } };
  assert.deepEqual([view.roles.editable, view.roles.items.length], [true, 5]);
  assert.equal(d.router.routing().mode, 'observe');
  let r = await post(d, '/router/v1/config', { set: { autoRelease: 'on', holdoutRate: 0.05 } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((r.body as { changed: string[] }).changed, ['autoRelease', 'holdoutRate']);
  assert.deepEqual([d.router.routing().mode, d.router.routing().holdoutRate], ['on', 0.05], 'the router uses it now');
  // refused as a whole; the file keeps the previous content
  const before = fs.readFileSync(path.join(d.home, 'config.json'), 'utf8');
  r = await post(d, '/router/v1/config', { set: { autoRelease: 'sometimes', holdoutRate: 0.07, daemonPort: 1 } });
  assert.equal(r.status, 400);
  assert.deepEqual((r.body as { errors: Array<{ path: string }> }).errors.map(e => e.path).sort(), ['autoRelease', 'daemonPort']);
  assert.equal(fs.readFileSync(path.join(d.home, 'config.json'), 'utf8'), before);
  assert.equal(d.router.routing().holdoutRate, 0.05);
  // a stale revision
  r = await post(d, '/router/v1/config', { set: { stepDown: 'off' }, revision: view.config.revision });
  assert.equal(r.status, 409);
  // presets and a role
  assert.equal((await post(d, '/router/v1/presets', { text: 'L2:\n  budget_usd: 9\n' })).status, 200);
  assert.equal((await post(d, '/router/v1/presets', { text: 'L2:\n  roles: nope\n' })).status, 400);
  const coder = fs.readFileSync(path.join(effectivePluginDir(d.home), 'agents', 'coder.md'), 'utf8');
  r = await post(d, '/router/v1/role', { role: 'coder', text: coder.replace('effort: low', 'effort: medium') });
  assert.equal(r.status, 200, r.text);
  assert.match(fs.readFileSync(path.join(effectivePluginDir(d.home), 'agents', 'coder.md'), 'utf8'), /^effort: medium$/m);
  r = await post(d, '/router/v1/role', { role: 'coder', text: coder.replace(/^tools: .*$/m, 'tools: Read, WebSearch') });
  assert.equal(r.status, 400);
  // an edit outside the tools (config.json by hand), then reload; and a template change regenerated by reload
  const cfg = JSON.parse(fs.readFileSync(path.join(d.home, 'config.json'), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(path.join(d.home, 'config.json'), JSON.stringify({ ...cfg, autoRelease: 'off' }));
  fs.appendFileSync(path.join(templates, 'agents', 'reviewer.md'), '\nUpstream note.\n');
  r = await post(d, '/router/v1/reload', {});
  assert.equal(r.status, 200);
  assert.equal(d.router.routing().mode, 'off');
  assert.match(fs.readFileSync(path.join(effectivePluginDir(d.home), 'agents', 'reviewer.md'), 'utf8'), /Upstream note\./);
  // one audit line per applied change, from the CLI
  assert.deepEqual(readAudit(d.home).map(e => `${e.source}:${e.kind}`).reverse(), ['cli:config', 'cli:presets', 'cli:role']);
  // the history route
  const h = (await call(d.port, { path: '/router/v1/settings/history?limit=2' })).body as { entries: Array<{ kind: string }> };
  assert.deepEqual(h.entries.map(e => e.kind), ['role', 'presets']);
}));

test('decision 168: the dashboard\'s front door: a session, its CSRF token and the page\'s Origin on every write; the same core', () => withDaemon(async d => {
  const { cookie, csrf, page } = await login(d);
  const write = (p: string, body: unknown, h: Record<string, string> = {}) => request(d.port, { method: 'POST', path: `/dashboard/settings/${p}`, headers: { ...page, cookie, 'x-csrf-token': csrf, ...h }, body: json(body) });
  // reading
  const v = await request(d.port, { path: '/dashboard/settings', headers: { cookie, ...page } });
  assert.equal(v.status, 200, v.text);
  // review M4: the token comes only with the code exchange; no request that carries just the cookie gets it
  const s = await request(d.port, { path: '/dashboard/session', headers: { cookie, ...page } });
  assert.deepEqual([s.status, s.body], [200, { ok: true }]);
  for (const p of ['/dashboard/settings', '/dashboard/session', '/dashboard/settings/history', '/dashboard/metrics/summary', '/dashboard/metrics/now']) {
    const r = await request(d.port, { path: p, headers: { cookie } });
    assert.ok(!r.text.includes(csrf), `${p} must not carry the CSRF token`);
    assert.ok(!/csrf/i.test(r.text), `${p}: no csrf field`);
  }
  assert.ok(!/csrf/i.test(v.text));
  assert.equal((await request(d.port, { path: '/dashboard/settings', headers: page })).status, 401, 'no session');
  // the guards on a write
  const before = fs.readFileSync(path.join(d.home, 'config.json'), 'utf8');
  assert.equal((await write('config', { set: { stepDown: 'off' } }, { 'x-csrf-token': '' })).status, 403, 'no CSRF token');
  assert.equal((await write('config', { set: { stepDown: 'off' } }, { 'x-csrf-token': 'x'.repeat(43) })).status, 403, 'a wrong one');
  assert.equal((await write('config', { set: { stepDown: 'off' } }, { origin: 'https://evil.example' })).status, 403, 'another origin');
  const noOrigin = { ...page, cookie, 'x-csrf-token': csrf } as Record<string, string>;
  delete noOrigin.origin;
  assert.equal((await request(d.port, { method: 'POST', path: '/dashboard/settings/config', headers: noOrigin, body: json({ set: { stepDown: 'off' } }) })).status, 403, 'no Origin');
  assert.equal((await write('config', { set: { stepDown: 'off' } }, { 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site');
  assert.equal((await request(d.port, { method: 'POST', path: '/dashboard/settings/config', headers: { ...page, 'x-csrf-token': csrf }, body: json({ set: { stepDown: 'off' } }) })).status, 401, 'no session');
  assert.equal((await write('config', { set: { stepDown: 'off' } }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(fs.readFileSync(path.join(d.home, 'config.json'), 'utf8'), before, 'nothing written');
  // a worker-shaped request (no cookie, no CSRF, its own tools' headers) reaches no write
  assert.equal((await request(d.port, { method: 'POST', path: '/dashboard/settings/role', headers: { 'content-type': 'application/json' }, body: json({ role: 'coder', reset: true }) })).status, 401);
  // the read-only metrics surface has no write handler
  assert.equal((await request(d.port, { method: 'POST', path: '/dashboard/metrics/summary', headers: { ...page, cookie, 'x-csrf-token': csrf }, body: '{}' })).status, 405);
  // valid: written, the router uses it, audited as the dashboard
  const ok = await write('config', { set: { stepDown: 'off' } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([d.router.status().stepAdjust.down, readAudit(d.home)[0]!.source], ['off', 'dashboard']);
  // the same invalid input gives the same answer at both front doors
  const bad = { set: { holdoutRate: 2, 'budgetsUsd.L1': -1 } };
  const viaDashboard = await write('config', bad);
  const viaCli = await post(d, '/router/v1/config', bad);
  assert.deepEqual([viaDashboard.status, viaDashboard.body], [viaCli.status, viaCli.body]);
  assert.equal(viaCli.status, 400);
  // bearerApi and recordPrompts are CLI-only: refused here with the reason, the file unchanged
  const view = (v.body as { config: { keys: Array<{ key: string; cliOnly?: boolean; reason?: string }> } }).config.keys;
  assert.deepEqual(view.filter(k => k.cliOnly).map(k => [k.key, k.reason]), [['recordPrompts', 'lowers protection; change it with the CLI'], ['bearerApi', 'lowers protection; change it with the CLI']]);
  const cfgBefore = fs.readFileSync(path.join(d.home, 'config.json'), 'utf8');
  for (const set of [{ bearerApi: 'on' }, { recordPrompts: true }, { recordPrompts: true, stepDown: 'on' }]) {
    const r = await write('config', { set });
    assert.equal(r.status, 400, JSON.stringify(set));
    assert.match((r.body as { errors: Array<{ message: string }> }).errors[0]!.message, /lowers protection; change it with the CLI/);
  }
  assert.equal(fs.readFileSync(path.join(d.home, 'config.json'), 'utf8'), cfgBefore);
  assert.equal((await post(d, '/router/v1/config', { set: { recordPrompts: true } })).status, 200, 'the CLI may');
  // a role through the form, and the history
  assert.equal((await write('role', { role: 'reviewer', fields: { maxTurns: 20 } })).status, 200);
  assert.equal((await write('role', { role: 'reviewer', fields: { tools: ['Read', 'Agent'] } })).status, 400);
  const h = await request(d.port, { path: '/dashboard/settings/history', headers: { cookie, ...page } });
  assert.deepEqual((h.body as { entries: Array<{ kind: string; source: string }> }).entries.map(e => `${e.source}:${e.kind}`), ['dashboard:role', 'cli:config', 'dashboard:config']);
}));

test('decision 168: a direct write while the daemon is down is what the daemon uses at its next start; the start regenerates the plugin', async () => {
  const templates = tmpDir('ar-tpl-');
  fs.cpSync(PLUGIN, templates, { recursive: true });
  const home = makeHome({ pluginTemplateDir: templates });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...cfg, pluginDir: effectivePluginDir(home) }));
  try {
    applyConfigChange(home, { set: { autoRelease: 'off' } }, 'cli-direct');
    let d = await startTestDaemon({ home });
    assert.equal(d.router.routing().mode, 'off');
    await d.close();
    // the generated file edited by hand while the daemon was down (a forbidden tool): the next start puts it back
    const file = path.join(effectivePluginDir(home), 'agents', 'coder.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^tools: .*$/m, 'tools: Read, WebFetch'));
    d = await startTestDaemon({ home });
    assert.ok(!/WebFetch/.test(fs.readFileSync(file, 'utf8')));
    await d.close();
  } finally { rmrf(home); rmrf(templates); }
});

test('decision 168: an install from before (no templates recorded) keeps working; its roles are shown, not editable', async () => {
  const home = makeHome({ pluginDir: PLUGIN });
  const d = await startTestDaemon({ home });
  try {
    assert.ok(!fs.existsSync(effectivePluginDir(home)), 'nothing generated');
    const v = (await call(d.port, { path: '/router/v1/settings' })).body as { roles: { editable: boolean } };
    assert.equal(v.roles.editable, false);
    const r = await post(d, '/router/v1/role', { role: 'coder', reset: true });
    assert.equal(r.status, 409);
    assert.match(JSON.stringify(r.body), /run do-it-all-claude-code init again/);
  } finally { await d.close(); rmrf(home); }
});

test('decision 168 review L3: the router never uses a generated role file that is not what (template, override) gives', () => withDaemon(async d => {
  // a hand edit that holds the floor: the reviewer would write, and as a scoped writer on other/** it would excuse coder A
  const file = path.join(effectivePluginDir(d.home), 'agents', 'reviewer.md');
  const generated = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, generated.replace(/^tools: .*$/m, 'tools: Read, Grep, Glob, Edit'));
  const repo = makeRepo({ 'src/a/x.ts': 'a\n', 'other/y.ts': 'y\n' });
  try {
    const hook = async (h: HookInput) => {
      const r = await postHook(d.port, { session_id: 'l3', cwd: repo, transcript_path: path.join(d.home, 'l3.jsonl'), ...h });
      assert.equal(r.status, 200, r.text);
      return r.body as { decision?: string; reason?: string };
    };
    const agentCall = (tag: string, scope: string | null, type: string, model: string, effort: string) => ({
      hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_${tag}`,
      tool_input: { subagent_type: type, prompt: `[subtask:${tag}] work${scope === null ? '' : `\n[scope: ${scope}]`}`, model, effort },
    });
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Refactor the validation module across multiple files and add an audit log' });
    await hook(agentCall('R', 'other/**', 'do-it-all-claude-code:reviewer', 'sonnet', 'medium'));
    await hook({ hook_event_name: 'SubagentStart', agent_id: 'r1', agent_type: 'do-it-all-claude-code:reviewer' });
    await hook(agentCall('A', 'src/a/**', 'do-it-all-claude-code:coder', 'haiku', 'low'));
    await hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'do-it-all-claude-code:coder' });
    write(repo, 'other/y.ts', 'changed by coder A, outside its scope\n');
    const out = await hook({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false });
    assert.equal(out.decision, 'block', 'the reviewer is read-only as its template has it');
    assert.equal(fs.readFileSync(file, 'utf8'), generated, 'and the generated file was put back');
  } finally { rmrf(repo); }
}));
