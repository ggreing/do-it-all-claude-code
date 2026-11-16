// Decision 168: the one validated write core for settings, shared by both front doors (the daemon's sealed routes
// for the CLI and its dashboard routes) and by the CLI when the daemon is down: config.json and teams.yaml here,
// the role overrides in role-overrides.ts. Every change is validated and rejected as a whole (never clamped; the
// previous content stays), written atomically (temp file + rename, 0600), and logged as one audit line of what
// changed (values redacted; free text only as "changed"). The audit line is written before the change itself, and a
// change that then fails to write gets a second line marking it failed, so no applied change is missing from the log.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Document, parseDocument } from 'yaml';
import { ZodError } from 'zod';
import { DEFAULT_DELEGATE_FROM, DEFAULT_PRESETS, PROVISIONAL_BUDGET_USD, applyPresetFile, parsePresetsText, type PresetFile } from './presets.ts';
import { DEFAULT_AUTO_RELEASE, DEFAULT_HOLDOUT_RATE, MAX_HOLDOUT_RATE } from './release.ts';
import { redactJson } from './security.ts';
import type { Level, TeamPreset } from './types.ts';

export const DEFAULT_EVENT_RETENTION_DAYS = 30;
export const MAX_EVENT_RETENTION_DAYS = 3650;
/** The largest body a settings write may carry (a whole role file or teams.yaml). */
export const MAX_SETTINGS_BODY = 256 * 1024;

// ------------------------------------------------------------------ errors, results, files

export interface SettingsError { path: string; message: string; line?: number }

/** A refused change: nothing was written. 400 for invalid input, 409 for a stale revision or a missing precondition. */
export class SettingsRejected extends Error {
  readonly errors: SettingsError[];
  readonly status: 400 | 409;
  constructor(errors: SettingsError[], status: 400 | 409 = 400) {
    super(errors.map(e => `${e.path}: ${e.message}`).join('; '));
    this.errors = errors;
    this.status = status;
  }
}

export type SettingsSource = 'cli' | 'cli-direct' | 'dashboard';
export interface WriteResult { ok: true; changed: string[]; nextStart: string[]; notes: string[] }

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Writes through a temp file and a rename (a crash leaves the old file), mode 0600. A linked file is written at its
 * target; with followLinks false (the generated plugin), the rename replaces whatever is at `file`, a link included.
 */
export function writeFileAtomic(file: string, content: string | Buffer, mode = 0o600, opts: { followLinks?: boolean } = {}): void {
  let target = file;
  if (opts.followLinks !== false) { try { target = fs.realpathSync(file); } catch { /* a new file */ } }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  if (process.platform !== 'win32') fs.chmodSync(tmp, mode);
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, target); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // Windows: a reader (an indexer, a status line run) holding the file fails the rename for a moment
      if (attempt < 20 && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) { sleep(100); continue; }
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }
}

export const readText = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
/** A short content hash: what a writer passes back to say "the version I saw" (a stale one answers 409). */
export const revisionOf = (text: string | null): string => createHash('sha256').update(text ?? '').digest('hex').slice(0, 16);
export const normalizeText = (t: string): string => t.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

export function checkRevision(given: unknown, current: string | null): void {
  if (given === undefined || given === null) return;
  if (given !== revisionOf(current)) throw new SettingsRejected([{ path: 'revision', message: 'changed since you loaded it: reload and try again' }], 409);
}

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** zod issues as settings errors: one per unknown key (zod reports those at the parent), the path as editors show it. */
export function zodErrors(e: ZodError, fallback: string): SettingsError[] {
  return e.issues.flatMap(i => {
    const keys = (i as { keys?: unknown }).keys;
    if (i.code === 'unrecognized_keys' && Array.isArray(keys)) return keys.map(k => ({ path: issuePath([...i.path, String(k)]), message: 'not a field here' }));
    return [{ path: i.path.length ? issuePath(i.path) : fallback, message: i.message }];
  });
}

/** A zod issue path as the editors show it: L2.roles[0].count. */
export function issuePath(p: ReadonlyArray<PropertyKey>, prefix = ''): string {
  let out = prefix;
  for (const k of p) out += typeof k === 'number' ? `[${k}]` : `${out ? '.' : ''}${String(k)}`;
  return out || prefix || 'value';
}

// ------------------------------------------------------------------ the audit log

export interface AuditChange { path: string; from?: unknown; to?: unknown; changed?: true }
export interface AuditEntry {
  at: string; source: SettingsSource; kind: 'config' | 'presets' | 'role'; target?: string; changes: AuditChange[];
  /** Ties a change to its failure line. */
  id?: string;
  /** Set by readAudit when the write after the line failed: the change did not apply. */
  failed?: true;
  error?: string;
}
export const SETTINGS_LOG_FILE = 'settings.jsonl';
export const settingsLogFile = (home: string): string => path.join(home, 'logs', SETTINGS_LOG_FILE);

// review M3: walk the parsed value (redactJson); redact() over serialized JSON can break the document
const masked = (v: unknown): unknown => redactJson(v);

function appendLine(home: string, line: object): void {
  const file = settingsLogFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch { /* best effort */ } }
}

/** One line per change, user-only, written before the change. Values pass through the redactor; free text is logged only as changed. */
export function appendAudit(home: string, e: AuditEntry): string {
  const id = e.id ?? randomBytes(6).toString('hex');
  appendLine(home, { ...e, id, changes: e.changes.map(c => (c.changed ? { path: c.path, changed: true } : { path: c.path, from: masked(c.from ?? null), to: masked(c.to ?? null) })) });
  return id;
}

/**
 * Review M3: the audit line first, then the write. If the line cannot be written, nothing is changed (the error
 * goes to the caller); if the write fails after it, a failure line marks that change as not applied.
 */
export function auditedWrite<T>(home: string, e: AuditEntry, write: () => T): T {
  const id = appendAudit(home, e);
  try { return write(); }
  catch (err) {
    const error = err instanceof SettingsRejected ? err.message : err instanceof Error ? `${(err as NodeJS.ErrnoException).code ?? 'error'}: ${err.message}` : String(err);
    try { appendLine(home, { at: new Date().toISOString(), source: e.source, kind: e.kind, ...(e.target ? { target: e.target } : {}), changes: [], failedId: id, error: error.slice(0, 300) }); }
    catch { /* the write's own error is what the caller sees */ }
    throw err;
  }
}

const SOURCES: ReadonlySet<string> = new Set(['cli', 'cli-direct', 'dashboard']);
const KINDS: ReadonlySet<string> = new Set(['config', 'presets', 'role']);
/** The latest entries, newest first, a failed change marked; a line that is not one this code wrote is skipped. */
export function readAudit(home: string, limit = 50): AuditEntry[] {
  const text = readText(settingsLogFile(home));
  if (!text) return [];
  const out: AuditEntry[] = [];
  const failures = new Map<string, string>();
  for (const line of text.split('\n').reverse()) {
    if (out.length >= Math.max(1, Math.min(500, limit))) break;
    try {
      const e = JSON.parse(line) as AuditEntry & { failedId?: unknown };
      if (typeof e.failedId === 'string') { failures.set(e.failedId, typeof e.error === 'string' ? e.error : 'the write failed'); continue; }
      if (typeof e.at === 'string' && SOURCES.has(e.source) && KINDS.has(e.kind) && Array.isArray(e.changes)) {
        const f = e.id !== undefined ? failures.get(e.id) : undefined;
        out.push(f !== undefined ? { ...e, failed: true, error: f } : e);
      }
    } catch { /* not a line of ours */ }
  }
  return out;
}

// ------------------------------------------------------------------ config.json

const LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
const LEAD_CLASSES = ['opus', 'sonnet', 'haiku', 'other'] as const;
export type ConfigKeyType = 'boolean' | 'number' | 'integer' | 'enum' | 'levels' | 'byLeadClass';
export interface ConfigKeySpec {
  key: string;
  type: ConfigKeyType;
  default: unknown;
  options?: readonly string[];
  min?: number;
  max?: number;
  /** The minimum itself is not allowed (budgets must be above 0). */
  minExclusive?: boolean;
  appliesAt: 'now' | 'next start';
  advanced?: boolean;
  deprecated?: boolean;
  description: string;
}

export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  { key: 'budgetsUsd', type: 'levels', default: PROVISIONAL_BUDGET_USD, min: 0, minExclusive: true, appliesAt: 'now', description: 'The budget in USD of one request at each level' },
  { key: 'delegateFrom', type: 'byLeadClass', options: LEVELS, default: DEFAULT_DELEGATE_FROM, appliesAt: 'now', description: 'The first level that gets a team, per lead model class' },
  { key: 'autoRelease', type: 'enum', options: ['on', 'observe', 'off'], default: DEFAULT_AUTO_RELEASE, appliesAt: 'now', description: 'Hand a delegated level back to the lead when its teams cost more per accepted task (observe only reports)' },
  { key: 'holdoutRate', type: 'number', min: 0, max: MAX_HOLDOUT_RATE, default: DEFAULT_HOLDOUT_RATE, appliesAt: 'now', description: 'The share of delegated-level requests the lead handles alone, as the baseline for auto-release' },
  { key: 'stepDown', type: 'enum', options: ['on', 'off'], default: 'on', appliesAt: 'now', description: 'Move a slot one step down after two easy passes in a row' },
  { key: 'recordPrompts', type: 'boolean', default: false, appliesAt: 'next start', description: 'Keep a redacted copy of each prompt in its request record (switching it off deletes them at the next start)' },
  { key: 'eventRetentionDays', type: 'integer', min: 0, max: MAX_EVENT_RETENTION_DAYS, default: DEFAULT_EVENT_RETENTION_DAYS, appliesAt: 'next start', description: 'Days hook events are kept (0 keeps them)' },
  { key: 'updateCheck', type: 'enum', options: ['on', 'off'], default: 'off', appliesAt: 'now', description: 'Check GitHub once a day for a newer release (only reads the public release list)' },
  { key: 'forceLevel', type: 'enum', options: LEVELS, default: null, appliesAt: 'now', advanced: true, description: 'Benchmarks and debugging only: plan every new request at this level' },
  { key: 'fableOptIn', type: 'boolean', default: false, appliesAt: 'now', advanced: true, description: 'Let the ladder go up to the Fable step' },
  { key: 'bearerApi', type: 'enum', options: ['on', 'off'], default: 'off', appliesAt: 'next start', advanced: true, deprecated: true, description: 'Deprecated, to be removed: let the daemon accept the token as a Bearer header' },
];
const SPEC = new Map(CONFIG_KEYS.map(s => [s.key, s]));

/** Keys init and mode own, with the reason shown when someone tries to change them here. */
export const MANAGED_CONFIG_KEYS: Readonly<Record<string, string>> = {
  daemonPort: 'set by init (init --new-port picks another)',
  proxyPort: 'set by init --mode api',
  pluginDir: 'set by init',
  pluginTemplateDir: 'set by init',
  apiMode: 'changed with `do-it-all-claude-code mode`',
  proxy: 'changed with `do-it-all-claude-code mode api` and `proxy allow-upstream`',
  wrappedStatusLine: 'set by init (your own status line, kept)',
  apiEnvAdded: 'kept by `mode` to undo its changes',
  noProxyAdded: 'kept by `mode` to undo its changes',
  localTls: 'kept by `mode api`',
};

/** Settings the dashboard may show but not change: each lowers the router's protection when switched (decision 168 review). */
export const CLI_ONLY_CONFIG_KEYS: Readonly<Record<string, string>> = {
  bearerApi: 'lowers protection; change it with the CLI',
  recordPrompts: 'lowers protection; change it with the CLI',
};
/** Never a config key, whatever a file says (review L7: these would reach the prototype). */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

const range = (s: ConfigKeySpec) => `${s.minExclusive ? 'above' : 'from'} ${s.min} ${s.max !== undefined ? `to ${s.max}` : ''}`.trim();

function checkScalar(s: ConfigKeySpec, type: ConfigKeyType, v: unknown, at: string, errors: SettingsError[]): unknown {
  const bad = (message: string) => { errors.push({ path: at, message }); return undefined; };
  if (type === 'boolean') return typeof v === 'boolean' ? v : bad('must be true or false');
  if (type === 'number' || type === 'integer') {
    if (typeof v !== 'number' || !Number.isFinite(v) || (type === 'integer' && !Number.isInteger(v))) return bad(`must be a ${type === 'integer' ? 'whole number' : 'number'} ${range(s)}`);
    if (s.min !== undefined && (s.minExclusive ? v <= s.min : v < s.min)) return bad(`must be ${range(s)}`);
    if (s.max !== undefined && v > s.max) return bad(`must be ${range(s)}`);
    return v;
  }
  return typeof v === 'string' && s.options!.includes(v) ? v : bad(`must be one of ${s.options!.join(', ')}`);
}

/** An element of a levels / byLeadClass object. */
function checkElement(s: ConfigKeySpec, v: unknown, at: string, errors: SettingsError[]): unknown {
  return s.type === 'levels' ? checkScalar(s, 'number', v, at, errors) : checkScalar(s, 'enum', v, at, errors);
}

function checkValue(s: ConfigKeySpec, v: unknown, at: string, errors: SettingsError[]): unknown {
  if (s.type !== 'levels' && s.type !== 'byLeadClass') return checkScalar(s, s.type, v, at, errors);
  if (!isObject(v)) { errors.push({ path: at, message: `must be an object of ${s.type === 'levels' ? 'levels (L0-L3)' : 'lead classes (opus, sonnet, haiku, other)'}` }); return undefined; }
  const keys: readonly string[] = s.type === 'levels' ? LEVELS : LEAD_CLASSES;
  const out: Record<string, unknown> = {};
  let ok = true;
  for (const [k, x] of Object.entries(v)) {
    if (!keys.includes(k)) { errors.push({ path: `${at}.${k}`, message: `not one of ${keys.join(', ')}` }); ok = false; continue; }
    const r = checkElement(s, x, `${at}.${k}`, errors);
    if (r === undefined) ok = false; else out[k] = r;
  }
  return ok ? out : undefined;
}

function refuseKey(key: string, at: string): SettingsError {
  const managed = Object.hasOwn(MANAGED_CONFIG_KEYS, key) ? MANAGED_CONFIG_KEYS[key] : undefined;   // review L7
  return { path: at, message: managed ? `${managed}: not editable here` : 'not a setting (see `do-it-all-claude-code config list`)' };
}

/** The changes between two configs, per key (and per level or lead class for the objects). */
export function configChanges(before: Record<string, unknown>, after: Record<string, unknown>): AuditChange[] {
  const out: AuditChange[] = [];
  for (const s of CONFIG_KEYS) {
    const a = before[s.key], b = after[s.key];
    if (deepEqual(a, b)) continue;
    if ((s.type === 'levels' || s.type === 'byLeadClass') && (isObject(a) || a === undefined) && (isObject(b) || b === undefined)) {
      const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
      for (const k of keys) {
        const x = (a as Record<string, unknown> | undefined)?.[k], y = (b as Record<string, unknown> | undefined)?.[k];
        if (!deepEqual(x, y)) out.push({ path: `${s.key}.${k}`, from: x ?? null, to: y ?? null });
      }
    } else out.push({ path: s.key, from: a ?? null, to: b ?? null });
  }
  return out;
}

/**
 * `set` applied to the config: keys by name (dotted for one level or lead class: budgetsUsd.L2), null for "back to
 * the default". Every problem is reported; any problem rejects the whole change.
 */
export function validateConfigSet(current: Record<string, unknown>, set: unknown): { next: Record<string, unknown>; changes: AuditChange[] } {
  if (!isObject(set) || !Object.keys(set).length) throw new SettingsRejected([{ path: 'set', message: 'nothing to set' }]);
  const next: Record<string, unknown> = structuredClone(current);
  const errors: SettingsError[] = [];
  for (const [p, value] of Object.entries(set)) {
    const [key = '', sub, extra] = p.split('.');
    const s = SPEC.get(key);
    if (!s) { errors.push(refuseKey(key, p)); continue; }
    if (extra !== undefined || (sub !== undefined && s.type !== 'levels' && s.type !== 'byLeadClass')) { errors.push({ path: p, message: 'no such field' }); continue; }
    if (sub !== undefined) {
      const keys: readonly string[] = s.type === 'levels' ? LEVELS : LEAD_CLASSES;
      if (!keys.includes(sub)) { errors.push({ path: p, message: `not one of ${keys.join(', ')}` }); continue; }
      const obj: Record<string, unknown> = { ...(isObject(next[key]) ? next[key] as Record<string, unknown> : {}) };
      if (value === null) delete obj[sub];
      else { const v = checkElement(s, value, p, errors); if (v === undefined) continue; obj[sub] = v; }
      if (Object.keys(obj).length) next[key] = obj; else delete next[key];
    } else if (value === null) delete next[key];
    else { const v = checkValue(s, value, p, errors); if (v !== undefined) next[key] = v; }
  }
  if (errors.length) throw new SettingsRejected(errors);
  return { next, changes: configChanges(current, next) };
}

/**
 * A whole config.json as edited (`config edit`): the settings are validated; what init and mode own, and keys this
 * release does not know, must be as they were.
 */
export function validateConfigReplace(current: Record<string, unknown>, edited: unknown): { next: Record<string, unknown>; changes: AuditChange[] } {
  if (!isObject(edited)) throw new SettingsRejected([{ path: 'config', message: 'must be a JSON object' }]);
  const errors: SettingsError[] = [];
  const next: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(current), ...Object.keys(edited)])) {
    const s = SPEC.get(key);
    if (RESERVED_KEYS.has(key)) errors.push(refuseKey(key, key));
    else if (s) {
      if (!Object.hasOwn(edited, key)) continue;
      const v = checkValue(s, edited[key], key, errors);
      if (v !== undefined) next[key] = v;
    } else if (!deepEqual(own(current, key), own(edited, key))) errors.push(refuseKey(key, key));
    else if (Object.hasOwn(current, key)) next[key] = current[key];
  }
  if (errors.length) throw new SettingsRejected(errors);
  return { next, changes: configChanges(current, next) };
}

/** A value typed on the command line, as the key's type reads it; "default" means back to the default. */
export function parseConfigInput(p: string, text: string): unknown {
  if (text === 'default') return null;
  const [key = '', sub] = p.split('.');
  const s = SPEC.get(key);
  if (!s) return text;
  const type = sub !== undefined ? (s.type === 'levels' ? 'number' : 'enum') : s.type;
  if (type === 'boolean') return /^(true|on|yes)$/i.test(text) ? true : /^(false|off|no)$/i.test(text) ? false : text;
  if (type === 'number' || type === 'integer') { const n = Number(text); return text.trim() !== '' && Number.isFinite(n) ? n : text; }
  if (type === 'levels' || type === 'byLeadClass') { try { return JSON.parse(text); } catch { return text; } }
  return text;
}

export interface ConfigKeyView extends ConfigKeySpec { value: unknown; set: boolean; cliOnly?: true; reason?: string }
export interface ConfigView { revision: string; keys: ConfigKeyView[]; managed: Array<{ key: string; reason: string }> }

/** Each setting with its effective value (the default where it is not set); the CLI-only ones marked with the reason. */
export function configView(text: string | null): ConfigView {
  let cur: Record<string, unknown> = {};
  try { const j = text ? JSON.parse(text) as unknown : {}; if (isObject(j)) cur = j; } catch { /* shown as defaults */ }
  const keys = CONFIG_KEYS.map(s => {
    const raw = own(cur, s.key);
    const set = raw !== undefined;
    const value = s.type === 'levels' || s.type === 'byLeadClass' ? { ...(s.default as object), ...(isObject(raw) ? raw as object : {}) } : set ? raw : s.default;
    const cli = Object.hasOwn(CLI_ONLY_CONFIG_KEYS, s.key) ? { cliOnly: true as const, reason: CLI_ONLY_CONFIG_KEYS[s.key]! } : {};
    return { ...s, value, set, ...cli };
  });
  return { revision: revisionOf(text), keys, managed: Object.entries(MANAGED_CONFIG_KEYS).map(([key, reason]) => ({ key, reason })) };
}

export const configFile = (home: string): string => path.join(home, 'config.json');

function readConfigObject(home: string): { text: string | null; current: Record<string, unknown> } {
  const text = readText(configFile(home));
  if (text === null) return { text, current: {} };
  try {
    const j = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
    if (isObject(j)) return { text, current: j };
  } catch { /* below */ }
  throw new SettingsRejected([{ path: 'config.json', message: 'cannot be parsed: fix the file (or run init) first' }]);
}

/** Validate, write, audit: config.json. */
export function applyConfigChange(home: string, input: { set?: unknown; replace?: unknown; revision?: unknown }, source: SettingsSource, now = new Date()): WriteResult & { config: Record<string, unknown> } {
  const { text, current } = readConfigObject(home);
  checkRevision(input.revision, text);
  const { next, changes } = input.replace !== undefined ? validateConfigReplace(current, input.replace) : validateConfigSet(current, input.set);
  if (!changes.length) return { ok: true, changed: [], nextStart: [], notes: ['no change'], config: current };
  const keys = [...new Set(changes.map(c => c.path.split('.')[0]!))];
  if (source === 'dashboard') {
    const locked = keys.filter(k => Object.hasOwn(CLI_ONLY_CONFIG_KEYS, k));
    if (locked.length) throw new SettingsRejected(locked.map(k => ({ path: k, message: `locked here (${CLI_ONLY_CONFIG_KEYS[k]})` })));
  }
  auditedWrite(home, { at: now.toISOString(), source, kind: 'config', changes }, () => writeFileAtomic(configFile(home), JSON.stringify(next, null, 2) + '\n'));
  const nextStart = keys.filter(k => SPEC.get(k)?.appliesAt === 'next start');
  const notes = next.bearerApi === 'on' && current.bearerApi !== 'on' ? ['bearerApi is deprecated and will be removed: the router\'s own clients do not need it'] : [];
  return { ok: true, changed: changes.map(c => c.path), nextStart, notes, config: next };
}

// ------------------------------------------------------------------ teams.yaml

export const TEAMS_FILE_NAME = 'teams.yaml';
export const teamsFile = (home: string): string => path.join(home, TEAMS_FILE_NAME);

/** A teams.yaml text checked as the daemon reads it; every problem with its path (and line for YAML errors). */
export function validatePresetsText(text: string): PresetFile {
  const doc = parseDocument(text);
  if (doc.errors.length) {
    throw new SettingsRejected(doc.errors.map(e => ({ path: 'yaml', message: e.message.split('\n')[0]!, ...(e.linePos?.[0]?.line ? { line: e.linePos[0].line } : {}) })));
  }
  try { return parsePresetsText(text); }
  catch (e) {
    if (e instanceof ZodError) throw new SettingsRejected(zodErrors(e, 'teams.yaml'));
    throw new SettingsRejected([{ path: 'yaml', message: e instanceof Error ? e.message.split('\n')[0]! : String(e) }]);
  }
}

export interface PresetsView {
  revision: string;
  text: string;
  effective: Record<Level, Omit<TeamPreset, 'id' | 'level'>>;
  schema: { levels: readonly string[]; roles: readonly string[]; steps: readonly string[]; countMin: number; countMax: number };
  error?: string;
}

/** The user's teams.yaml and what it gives on top of the defaults (with config.json's budgets, which win). */
export function presetsView(home: string): PresetsView {
  const text = readText(teamsFile(home));
  let presets: Record<Level, TeamPreset> = DEFAULT_PRESETS;
  let error: string | undefined;
  if (text) { try { presets = applyPresetFile(validatePresetsText(text)); } catch (e) { error = e instanceof Error ? e.message : String(e); } }
  let budgets: Record<string, unknown> = {};
  try { const c = JSON.parse(readText(configFile(home)) ?? '{}') as Record<string, unknown>; if (isObject(c.budgetsUsd)) budgets = c.budgetsUsd; } catch { /* none */ }
  const effective = Object.fromEntries(LEVELS.map(l => {
    const p = presets[l];
    const b = budgets[l];
    return [l, { roles: p.roles, leadMayAdjust: p.leadMayAdjust, ...(p.leadDirect ? { leadDirect: true } : {}), budgetUsd: typeof b === 'number' ? b : p.budgetUsd }];
  })) as PresetsView['effective'];
  return {
    revision: revisionOf(text), text: text ?? '', effective,
    schema: { levels: LEVELS, roles: ['architect', 'ui-designer', 'coder', 'reviewer', 'tester'], steps: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'], countMin: 0, countMax: 4 },
    ...(error ? { error } : {}),
  };
}

/** One level of a teams.yaml, as YAML text of its own (`L2:` and what it sets; just `L2:` when it sets nothing). */
export function presetLevelText(text: string, level: string): string {
  const node = text ? parseDocument(text).get(level, true) : undefined;
  const one = new Document({});
  one.set(level, node ?? one.createNode(null));
  return one.toString({ lineWidth: 0 });
}

/** A teams.yaml with one level replaced by the YAML text of that level (only that level may appear in it). */
export function mergePresetLevel(text: string, level: string, levelText: string): string {
  const part = parseDocument(normalizeText(levelText));
  if (part.errors.length) throw new SettingsRejected(part.errors.map(e => ({ path: 'yaml', message: e.message.split('\n')[0]!, ...(e.linePos?.[0]?.line ? { line: e.linePos[0].line } : {}) })));
  const js = part.toJS() as unknown;
  const keys = isObject(js) ? Object.keys(js) : [];
  if (js !== null && (!isObject(js) || keys.some(k => k !== level))) throw new SettingsRejected([{ path: 'yaml', message: `only ${level} may be set here (edit the whole file with \`preset edit\`)` }]);
  const doc = text.trim() ? parseDocument(text) : new Document({});
  // a level written as nothing (`L2:` or `L2: null`) is taken out: the defaults apply to it
  if (!isObject(js) || js[level] === null || js[level] === undefined) doc.delete(level); else doc.set(level, part.get(level, true));
  const out = doc.toString({ lineWidth: 0 });
  return out.trim() === '{}' ? '' : out;
}

/** Validate, write, audit: teams.yaml (empty text removes the file: the defaults apply). */
export function applyPresetsChange(home: string, input: { text?: unknown; revision?: unknown }, source: SettingsSource, now = new Date()): WriteResult {
  if (typeof input.text !== 'string') throw new SettingsRejected([{ path: 'text', message: 'the teams.yaml text is missing' }]);
  const file = teamsFile(home);
  const before = readText(file);
  checkRevision(input.revision, before);
  const text = normalizeText(input.text);
  const removing = text.trim() === '';
  const after = removing ? {} : validatePresetsText(text);
  let old: PresetFile = {};
  try { old = before ? validatePresetsText(before) : {}; } catch { /* an invalid file is replaced as a whole */ }
  const changes: AuditChange[] = LEVELS.filter(l => !deepEqual(old[l], after[l])).map(l => ({ path: l, changed: true }));
  if (!changes.length && (removing ? before === null : before === text)) return { ok: true, changed: [], nextStart: [], notes: ['no change'] };
  if (!changes.length) changes.push({ path: TEAMS_FILE_NAME, changed: true });   // formatting or comments only
  auditedWrite(home, { at: now.toISOString(), source, kind: 'presets', changes }, () => {
    if (removing) fs.rmSync(file, { force: true });
    else writeFileAtomic(file, text.endsWith('\n') ? text : `${text}\n`);
  });
  return { ok: true, changed: changes.map(c => c.path), nextStart: [], notes: ['the next request uses it'] };
}
