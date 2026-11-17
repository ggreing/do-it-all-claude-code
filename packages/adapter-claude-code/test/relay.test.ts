import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from '@do-it-all-claude-code/core';
import * as relayMod from '../../../plugin/hooks/relay.mjs';
import { sealedFake, type WireRecord } from '../../core/test/sealed-fake.ts';

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ar-relay-')); }
function spoolFiles(home: string): string[] {
  const d = path.join(home, 'spool');
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
}

test('fallbackOutput is empty for PreCompact and "{}" otherwise', () => {
  assert.equal(relayMod.fallbackOutput('PreCompact'), '');
  assert.equal(relayMod.fallbackOutput('UserPromptSubmit'), '{}');
  assert.equal(relayMod.fallbackOutput('Stop'), '{}');
});

test('redact masks Anthropic keys, bearer tokens, GitHub/AWS keys and ANTHROPIC_* env', () => {
  const secrets = [
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'sk-ant-api03-SECRETSECRET',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'AKIAIOSFODNN7EXAMPLE',
    'ANTHROPIC_API_KEY=supersecretvalue',
  ];
  const masked = relayMod.redact(secrets.join(' | '));
  for (const needle of ['abcdefghijklmnopqrstuvwxyz', 'SECRETSECRET', 'MNOPQRSTUVWXYZ0123456789', 'IOSFODNN7EXAMPLE', 'supersecretvalue'])
    assert.ok(!masked.includes(needle), `masked: ${needle}`);
});

test('relay.redact stays in sync with core.redact (no drift)', () => {
  const samples = [
    'nothing to see here',
    'x-api-key: deadbeefdeadbeef',
    'Bearer abcdefghijklmnop token',
    'sk-ant-api03-ZZZZZZZZ and ANTHROPIC_AUTH_TOKEN=abc123xyz',
    'header {"authorization":"Basic Zm9vOmJhcg=="}',
  ];
  for (const s of samples)
    assert.equal(relayMod.redact(s), core.redact(s), `redact drift on: ${s}`);
});

test('D5: before init (no config/token) the hook passes WITHOUT spooling', async () => {
  const home = tmpHome();
  try {
    const out: string[] = [];
    await relayMod.relay(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi' }), { home, write: s => out.push(s) });
    assert.deepEqual(out, ['{}']);
    assert.equal(spoolFiles(home).length, 0, 'nothing to replay to -> no spool');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('unparseable stdin passes through with no spool', async () => {
  const home = tmpHome();
  try {
    const out: string[] = [];
    await relayMod.relay('not json {', { home, write: s => out.push(s) });
    assert.deepEqual(out, ['{}']);
    assert.equal(spoolFiles(home).length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a daemon response is written to stdout verbatim and nothing is spooled', async () => {
  const home = tmpHome();
  const received: { body?: string; path?: string; method?: string } = {};
  const wire: WireRecord[] = [];
  // the daemon side of a sealed call (decision 156): opens the envelope with the token as the shared secret
  const server = http.createServer(sealedFake('tok-123', r => {
    Object.assign(received, r);
    return { body: '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"L2"}}' };
  }, wire));
  try {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: port, fableOptIn: false }));
    fs.writeFileSync(path.join(home, 'token'), 'tok-123\n');

    const out: string[] = [];
    const input = { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi MARKER-IN-THE-PROMPT' };
    await relayMod.relay(JSON.stringify(input), { home, write: s => out.push(s) });

    assert.equal(out.length, 1);
    assert.equal(JSON.parse(out[0]!).hookSpecificOutput.additionalContext, 'L2');
    assert.deepEqual([received.method, received.path], ['POST', '/router/v1/hooks/claude-code']);
    assert.equal(JSON.parse(received.body!).prompt, 'hi MARKER-IN-THE-PROMPT');
    // on the wire: one sealed request, no Authorization header, neither the token nor the prompt in the clear
    assert.equal(wire.length, 1);
    assert.deepEqual([wire[0]!.method, wire[0]!.url, wire[0]!.headers.authorization, wire[0]!.headers.host], ['POST', '/router/v1/sealed', undefined, `127.0.0.1:${port}`]);
    assert.ok(!JSON.stringify(wire[0]).includes('tok-123') && !JSON.stringify(wire[0]).includes('MARKER-IN-THE-PROMPT'));
    assert.equal(spoolFiles(home).length, 0, 'success => no spool');
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a daemon error status spools and falls back to "{}"', async () => {
  const home = tmpHome();
  const server = http.createServer((_req, res) => { res.writeHead(500); res.end('boom'); });
  try {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: port, fableOptIn: false }));
    fs.writeFileSync(path.join(home, 'token'), 'tok');

    const out: string[] = [];
    await relayMod.relay(JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }), { home, write: s => out.push(s) });
    assert.deepEqual(out, ['{}']);
    assert.equal(spoolFiles(home).length, 1, 'error status => spooled');
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- D2 / D4: body augmentation (via the real entry point)
const RELAY_PATH = fileURLToPath(new URL('../../../plugin/hooks/relay.mjs', import.meta.url));
/** Runs `node relay.mjs <event>` against a one-shot local server and returns the body the daemon received. */
async function bodyReceived(event: string, input: object, env: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const home = tmpHome();
  let received: Record<string, unknown> = {};
  const server = http.createServer(sealedFake('tok', r => { try { received = JSON.parse(r.body ?? ''); } catch { /* ignore */ } return { body: '{}' }; }));
  try {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: port, fableOptIn: false }));
    fs.writeFileSync(path.join(home, 'token'), 'tok');
    await new Promise<void>((resolve) => {
      const c = spawn(process.execPath, [RELAY_PATH, event], { env: { ...process.env, DO_IT_ALL_CLAUDE_CODE_HOME: home, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
      c.stdin.end(JSON.stringify(input));
      c.on('close', () => resolve());
    });
    return received;
  } finally { server.close(); fs.rmSync(home, { recursive: true, force: true }); }
}

test('D2: SessionStart adds routerClient (node path/version, routerHome, port) to the body', async () => {
  const body = await bodyReceived('SessionStart', { hook_event_name: 'SessionStart', session_id: 's', source: 'startup' });
  const rc = body.routerClient as Record<string, unknown> | undefined;
  assert.ok(rc, 'routerClient present');
  assert.equal(typeof rc!.node, 'string');
  assert.equal(rc!.nodeVersion, process.versions.node);
  assert.equal(typeof rc!.port, 'number');
});

test('D4: SubagentStart adds a filtered verifyEnv to the body', async () => {
  const body = await bodyReceived('SubagentStart',
    { hook_event_name: 'SubagentStart', session_id: 's', agent_id: 'a', agent_type: 'do-it-all-claude-code:coder' },
    { LANG: 'en_US.UTF-8', SOME_SECRET_TOKEN: 'nope' });
  const ve = body.verifyEnv as Record<string, string> | undefined;
  assert.ok(ve, 'verifyEnv present');
  assert.equal(ve!.LANG, 'en_US.UTF-8');
  assert.equal('SOME_SECRET_TOKEN' in ve!, false, 'secret-looking name excluded');
});

test('other events do not carry routerClient or verifyEnv', async () => {
  const body = await bodyReceived('Stop', { hook_event_name: 'Stop', session_id: 's' });
  assert.equal('routerClient' in body, false);
  assert.equal('verifyEnv' in body, false);
});

test('VERIFY_ENV_PASSTHROUGH stays in sync with core', () => {
  assert.deepEqual(relayMod.VERIFY_ENV_PASSTHROUGH, core.VERIFY_ENV_PASSTHROUGH);
});

test('D4: buildVerifyEnv keeps allowed names present in env and drops secret-looking ones + NODE_OPTIONS', () => {
  const env = { PATH: '/usr/bin', LANG: 'en_US.UTF-8', NODE_OPTIONS: '--max-old-space-size=8192', MY_API_KEY: 'x', GH_TOKEN: 'y', ABSENT: undefined } as Record<string, string | undefined>;
  const got = relayMod.buildVerifyEnv(env, ['MY_API_KEY', 'GH_TOKEN', 'LANG']);
  assert.equal(got.PATH, '/usr/bin');
  assert.equal(got.LANG, 'en_US.UTF-8');
  assert.equal('NODE_OPTIONS' in got, false, 'NODE_OPTIONS dropped');
  assert.equal('MY_API_KEY' in got, false, 'secret name dropped');
  assert.equal('GH_TOKEN' in got, false, 'secret name dropped');
});

test('D5: cleanSpool deletes >24h files and trims to the size cap (oldest first)', () => {
  const home = tmpHome();
  const dir = path.join(home, 'spool');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const mk = (name: string, ageMs: number, size: number) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, 'x'.repeat(size));
      const t = Date.now() - ageMs; fs.utimesSync(p, t / 1000, t / 1000);
    };
    mk('old.jsonl', 25 * 60 * 60 * 1000, 10); // older than 24h -> deleted
    mk('a.jsonl', 3 * 60 * 60 * 1000, 12 * 1024 * 1024);
    mk('b.jsonl', 1 * 60 * 60 * 1000, 12 * 1024 * 1024); // total 24MB > 20MB -> oldest (a) trimmed
    relayMod.cleanSpool(dir);
    const left = fs.readdirSync(dir).sort();
    assert.equal(left.includes('old.jsonl'), false, '24h+ file deleted');
    assert.equal(left.includes('a.jsonl'), false, 'oldest trimmed to meet size cap');
    assert.equal(left.includes('b.jsonl'), true, 'newest kept');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- auto-start (decision 192)
async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(r => s.close(() => r()));
  return p;   // nothing listens here now
}

test('auto-start: SessionStart with the daemon down spawns start once, spools, and shows the router-off note', async () => {
  const home = tmpHome();
  try {
    const port = await freePort();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: port, fableOptIn: false }));
    fs.writeFileSync(path.join(home, 'token'), 'tok');
    const starts: string[] = [];
    const out: string[] = [];
    await relayMod.relay(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }),
      { home, write: s => out.push(s), autoStart: h => { starts.push(h); return true; } });
    assert.match(JSON.parse(out[0]!).hookSpecificOutput.additionalContext, /not responding|do-it-all-claude-code start/);
    assert.deepEqual(starts, [home], 'auto-start was asked once, for this home');
    assert.equal(spoolFiles(home).length, 1, 'the event is still spooled for replay');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('router off: a team-worker Agent call is denied at PreToolUse, and not spooled', async () => {
  const home = tmpHome();
  try {
    const port = await freePort();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: port, fableOptIn: false }));
    fs.writeFileSync(path.join(home, 'token'), 'tok');
    const out: string[] = [];
    await relayMod.relay(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'do-it-all-claude-code:coder' }, session_id: 's' }), { home, write: s => out.push(s) });
    const o = JSON.parse(out[0]!).hookSpecificOutput;
    assert.equal(o.permissionDecision, 'deny');
    assert.match(o.permissionDecisionReason, /router is not running|do-it-all-claude-code start/);
    assert.equal(spoolFiles(home).length, 0, 'a denied worker call is not spooled');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('router off: a non-router Agent call is NOT denied (fail-open)', async () => {
  const home = tmpHome();
  try {
    const port = await freePort();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: port, fableOptIn: false }));
    fs.writeFileSync(path.join(home, 'token'), 'tok');
    const out: string[] = [];
    await relayMod.relay(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' }, session_id: 's' }), { home, write: s => out.push(s) });
    assert.deepEqual(out, ['{}'], 'a non-router agent passes through');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('not set up: a team-worker Agent call is denied with a setup reason', async () => {
  const home = tmpHome();
  try {
    const out: string[] = [];
    await relayMod.relay(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'do-it-all-claude-code:reviewer' }, session_id: 's' }), { home, write: s => out.push(s) });
    const o = JSON.parse(out[0]!).hookSpecificOutput;
    assert.equal(o.permissionDecision, 'deny');
    assert.match(o.permissionDecisionReason, /not set up|do-it-all-setup/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('isRouterWorkerAgentCall matches the plugin workers only', () => {
  for (const r of ['coder', 'tester', 'reviewer', 'architect', 'ui-designer'])
    assert.ok(relayMod.isRouterWorkerAgentCall({ tool_name: 'Agent', tool_input: { subagent_type: `do-it-all-claude-code:${r}` } }), r);
  assert.equal(relayMod.isRouterWorkerAgentCall({ tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' } }), false);
  assert.equal(relayMod.isRouterWorkerAgentCall({ tool_name: 'Agent', tool_input: { subagent_type: 'do-it-all-claude-code:unknown' } }), false);
  assert.equal(relayMod.isRouterWorkerAgentCall({ tool_name: 'Bash' }), false);
});

test('auto-start: a non-SessionStart event with the daemon down does NOT auto-start', async () => {
  const home = tmpHome();
  try {
    const port = await freePort();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: port, fableOptIn: false }));
    fs.writeFileSync(path.join(home, 'token'), 'tok');
    const starts: string[] = [];
    await relayMod.relay(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi' }),
      { home, write: () => {}, autoStart: h => { starts.push(h); return true; } });
    assert.deepEqual(starts, [], 'only SessionStart auto-starts');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('auto-start: config autoStart=off suppresses it', async () => {
  const home = tmpHome();
  try {
    const port = await freePort();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: port, fableOptIn: false, autoStart: 'off' }));
    fs.writeFileSync(path.join(home, 'token'), 'tok');
    const starts: string[] = [];
    await relayMod.relay(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }),
      { home, write: () => {}, autoStart: h => { starts.push(h); return true; } });
    assert.deepEqual(starts, [], 'autoStart off => no spawn');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('auto-start: a reachable daemon at SessionStart does NOT auto-start', async () => {
  const home = tmpHome();
  const server = http.createServer(sealedFake('tok', () => ({ body: '{}' })));
  try {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: port, fableOptIn: false }));
    fs.writeFileSync(path.join(home, 'token'), 'tok');
    const starts: string[] = [];
    await relayMod.relay(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }),
      { home, write: () => {}, autoStart: h => { starts.push(h); return true; } });
    assert.deepEqual(starts, [], 'daemon up => nothing to start');
  } finally { server.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('setup hint: SessionStart with no config points at setup once, and never creates the router home', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-hint-'));
  const home = path.join(base, 'no-home');      // does NOT exist; the hint must not create it
  const hintDir = path.join(base, 'plugindata');
  try {
    const out: string[] = [];
    await relayMod.relay(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }), { home, write: s => out.push(s), hintDir });
    assert.match(JSON.parse(out[0]!).hookSpecificOutput.additionalContext as string, /do-it-all-setup|setup/);
    assert.equal(fs.existsSync(home), false, 'the hint must not create the router home');
    assert.ok(fs.readdirSync(hintDir).some(f => f.includes('setup-hint-shown')), 'the marker is written to the hint dir, outside the home');
    const out2: string[] = [];
    await relayMod.relay(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }), { home, write: s => out2.push(s), hintDir });
    assert.deepEqual(out2, ['{}'], 'shown once');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('minimalSpawnEnv keeps ordinary vars but drops credentials, secret names and NODE_OPTIONS', () => {
  const env = relayMod.minimalSpawnEnv('/the/home', {
    PATH: '/usr/bin', FOO: 'bar',
    ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://x', CLAUDE_CODE_OAUTH_TOKEN: 't',
    MY_SECRET: 's', GH_TOKEN: 'y', NODE_OPTIONS: '--max-old-space-size=8', ABSENT: undefined,
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.FOO, 'bar');
  assert.equal(env.DO_IT_ALL_CLAUDE_CODE_HOME, '/the/home');
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'MY_SECRET', 'GH_TOKEN', 'NODE_OPTIONS', 'ABSENT'])
    assert.equal(k in env, false, `${k} dropped`);
});

test('a daemon error spools a MASKED copy of the event', async () => {
  const home = tmpHome();
  const server = http.createServer((_req, res) => { res.writeHead(500); res.end('x'); });
  try {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: port, fableOptIn: false }));
    fs.writeFileSync(path.join(home, 'token'), 'tok');
    const out: string[] = [];
    await relayMod.relay(JSON.stringify({ hook_event_name: 'Stop', session_id: 's', prompt: 'leak sk-ant-api03-SECRETSECRET' }), { home, write: s => out.push(s) });
    assert.deepEqual(out, ['{}']);
    const files = spoolFiles(home);
    assert.equal(files.length, 1);
    assert.ok(!fs.readFileSync(path.join(home, 'spool', files[0]!), 'utf8').includes('SECRETSECRET'), 'secret masked in spool');
  } finally { server.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
