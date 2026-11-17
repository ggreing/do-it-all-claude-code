// The team office's helper (decision 186 ③ as changed): one long-lived Node process per open office pane. It reads
// the router home itself (config, endpoint, token), makes sealed calls to the daemon with hooks/seal.mjs
// (node:crypto, decision 156), and writes what it read as one JSON object per line on stdout. The office module
// never sees the token. Dependency-free, like the other plugin programs.
//
//   node bridge.mjs --session <id> [--tab office|history|cost|routing] [--period 24h|7d|30d] [--detail <request id>]
//                   [--interval <ms>]
//
// Lines (v 1), written only when what they say changed:
//   {"v":1,"type":"office","reach":"ok"|"down"|"setup"|"refused","view":{…}|null}
//   {"v":1,"type":"history"|"cost"|"routing"|"detail","data":{…}|null,"error"?:"…"}
//   {"v":1,"type":"alive"} every 5 s, so a closed stdout is noticed
// Never in a line: the token, a prompt's text (a request detail's prompt is dropped), the machine's paths.
//
// It ends when its parent is gone, when stdout is closed, or on a signal. While the daemon does not answer it waits
// 1 s, 5 s, then 30 s between tries.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealedCall } from '../hooks/seal.mjs';

export const LINE_VERSION = 1;
export const BACKOFF_MS = [1000, 5000, 30_000];
const TAB_REFRESH_MS = 10_000;
const PERIOD_MS = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

export function parseArgs(argv) {
  const o = { session: '', tab: 'office', period: '7d', detail: '', interval: 1200 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--session' && v) { o.session = v; i++; }
    else if (k === '--tab' && v) { o.tab = v; i++; }
    else if (k === '--period' && v) { o.period = v; i++; }
    else if (k === '--detail' && v) { o.detail = v; i++; }
    else if (k === '--interval' && v) { o.interval = Math.max(200, Math.min(60_000, Number(v) || 1200)); i++; }
  }
  if (!['office', 'history', 'cost', 'routing'].includes(o.tab)) o.tab = 'office';
  if (!(o.period in PERIOD_MS)) o.period = '7d';
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(o.session)) o.session = '';
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(o.detail)) o.detail = '';
  return o;
}

/**
 * The router home, in order: the folder above the plugin when it runs from the home marketplace (<home>/plugin),
 * DO_IT_ALL_CLAUDE_CODE_HOME, then ~/.do-it-all-claude-code. The first that holds config.json is it.
 */
export function findHome(env = process.env, here = path.dirname(fileURLToPath(import.meta.url))) {
  const candidates = [path.resolve(here, '..', '..'), env.DO_IT_ALL_CLAUDE_CODE_HOME, path.join(os.homedir(), '.do-it-all-claude-code')];
  for (const c of candidates) if (c && fs.existsSync(path.join(c, 'config.json'))) return c;
  return null;
}

function readWhere(home) {
  let cfg, token;
  try { cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { return null; }
  try { token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim(); } catch { return null; }
  const port = cfg && typeof cfg.daemonPort === 'number' && cfg.daemonPort > 0 ? cfg.daemonPort : 0;
  return token ? { port, token } : null;
}

const reachOf = e => (e && e.code === 'auth' ? 'refused' : 'down');

/** One sealed GET; { ok, status, body } or { ok: false, reach }. */
async function get(home, where, p) {
  try {
    const r = await sealedCall({ home, port: where.port, secret: where.token, method: 'GET', path: p });
    let body = r.body;
    try { body = JSON.parse(r.body); } catch { /* not JSON */ }
    return { ok: true, status: r.status, body };
  } catch (e) {
    return { ok: false, reach: reachOf(e) };
  }
}

const errorText = a => (!a.ok ? (a.reach === 'refused' ? 'the router refused the call — run do-it-all-claude-code doctor' : 'router daemon not reachable — run do-it-all-claude-code start')
  : a.status !== 200 ? `the router answered ${a.status}${a.body && typeof a.body === 'object' && typeof a.body.error === 'string' ? `: ${a.body.error}` : ''}` : undefined);

/** What a line may carry of a request detail: everything but the prompt's text. */
function withoutPrompt(detail) {
  if (!detail || typeof detail !== 'object') return detail;
  const { prompt, ...rest } = detail;
  return { ...rest, hasPrompt: typeof prompt === 'string' && prompt.length > 0 };
}

/**
 * The loop. `deps` lets a test give a clock and a writer; by default it runs until its parent is gone.
 * Returns a stop function.
 */
export function run(opts, deps = {}) {
  const write = deps.write ?? (line => { try { fs.writeSync(1, `${line}\n`); return true; } catch { return false; } });
  const now = deps.now ?? Date.now;
  const home = deps.home !== undefined ? deps.home : findHome();
  const last = new Map();
  let stopped = false, fails = 0, tabAt = 0, timer = null;
  const emit = (key, obj) => {
    const line = JSON.stringify({ v: LINE_VERSION, ...obj });
    if (last.get(key) === line) return;
    last.set(key, line);
    if (!write(line)) stop();          // nobody reads: end
  };
  const stop = () => { if (stopped) return; stopped = true; if (timer) clearTimeout(timer); clearInterval(beat); deps.onStop?.(); };
  // a reader that went away is seen only on a write: a short line every few seconds, which the office ignores
  const beat = setInterval(() => { if (!write(JSON.stringify({ v: LINE_VERSION, type: 'alive' }))) stop(); }, deps.heartbeatMs ?? 5000);

  async function tick() {
    if (stopped) return;
    let wait = opts.interval;
    const where = home ? readWhere(home) : null;
    if (!home || !where || !opts.session) {
      emit('office', { type: 'office', reach: 'setup', view: null });
      wait = 30_000;
    } else {
      const a = await get(home, where, `/router/v1/office?session_id=${encodeURIComponent(opts.session)}`);
      if (a.ok) {
        fails = 0;
        emit('office', { type: 'office', reach: a.status === 200 ? 'ok' : 'down', view: a.status === 200 ? a.body : null });
        if (opts.tab !== 'office' && now() - tabAt >= TAB_REFRESH_MS) {
          tabAt = now();
          await tabData(home, where);
        }
      } else {
        emit('office', { type: 'office', reach: a.reach, view: null });
        wait = BACKOFF_MS[Math.min(fails, BACKOFF_MS.length - 1)];
        fails++;
      }
    }
    if (!stopped) timer = setTimeout(() => { void tick(); }, wait);
  }

  async function tabData(home, where) {
    if (opts.tab === 'history') {
      const a = await get(home, where, '/router/v1/metrics/requests?limit=12');
      emit('history', { type: 'history', data: a.ok && a.status === 200 ? a.body : null, ...(errorText(a) ? { error: errorText(a) } : {}) });
      if (opts.detail) {
        const d = await get(home, where, `/router/v1/metrics/requests/${encodeURIComponent(opts.detail)}`);
        emit('detail', { type: 'detail', data: d.ok && d.status === 200 ? withoutPrompt(d.body) : null, ...(errorText(d) ? { error: errorText(d) } : {}) });
      }
    } else if (opts.tab === 'cost') {
      const since = new Date(now() - PERIOD_MS[opts.period]).toISOString();
      const a = await get(home, where, `/router/v1/metrics/summary?since=${encodeURIComponent(since)}`);
      emit('cost', { type: 'cost', period: opts.period, data: a.ok && a.status === 200 ? a.body : null, ...(errorText(a) ? { error: errorText(a) } : {}) });
    } else if (opts.tab === 'routing') {
      const a = await get(home, where, '/router/v1/metrics/triage-report');
      emit('routing', { type: 'routing', data: a.ok && a.status === 200 ? a.body : null, ...(errorText(a) ? { error: errorText(a) } : {}) });
    }
  }

  void tick();
  return stop;
}

/** True while the process that started this one still runs. */
export function parentAlive(ppid = process.ppid) {
  if (!ppid || ppid <= 1) return false;
  try { process.kill(ppid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

const isMain = (() => { try { return path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const ppid = process.ppid;
  const stop = run(opts, { onStop: () => process.exit(0) });
  // no orphans: the office ends this process when its pane closes; if the office itself is gone, this ends too
  setInterval(() => { if (!parentAlive(ppid)) stop(); }, 2000).unref?.();
  process.stdout.on('error', () => stop());
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => stop());
}
