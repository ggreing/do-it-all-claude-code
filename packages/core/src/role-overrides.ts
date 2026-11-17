// Decision 168: role edits as overrides in the router home, merged with the plugin's role files (now templates)
// into a generated, effective plugin folder that Claude Code and the daemon both use.
//   <home>/roles/<role>.json   the fields the user changed (only those), so a template update (git pull) still
//                              reaches every field the user did not change
//   <home>/plugin/             the effective plugin: the template folder copied, its agents/*.md merged with the
//                              overrides; regenerated on edit, at init and at daemon start (only changed files are
//                              written), so a template change or a hand edit of the generated files is undone
// The floor (roleFloorProblems) holds for every role file written, generated or read: only the front matter keys a
// router role may set; no "---" inside the front matter; name and x-router.role stay the role; tools never empty
// and only from an allow list; disallowedTools and isolation as the template has them. It is checked on write, on
// generation and at runtime (the daemon), so no override ships a role that weakens the guard. At runtime the
// generated file must also be exactly what generation makes of (template, override); otherwise it is regenerated.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';
import { z, ZodError } from 'zod';
import { FORBIDDEN_ROLE_TOOLS, ROLE_TOOL_ALLOWLIST, parseRoleFile, verifyEntrySchema, type VerifyEntry } from './roles.ts';
import {
  SettingsRejected, auditedWrite, checkRevision, issuePath, normalizeText, readText, revisionOf, writeFileAtomic,
  zodErrors, type AuditChange, type SettingsError, type SettingsSource, type WriteResult,
} from './settings.ts';
import type { Role } from './types.ts';

export const ROLE_NAMES: readonly Role[] = ['architect', 'ui-designer', 'coder', 'reviewer', 'tester'];
export const ROLE_MODEL_ALIASES = ['haiku', 'sonnet', 'opus', 'fable', 'inherit'] as const;
export const ROLE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const MAX_ROLE_TURNS = 500;
const MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]{1,60}$/;

/** Front matter keys: the ones a user may change, the ones that stay as the template has them. Nothing else is allowed. */
export const EDITABLE_ROLE_KEYS = ['description', 'tools', 'model', 'effort', 'maxTurns'] as const;
export const LOCKED_ROLE_KEYS = ['name', 'disallowedTools', 'isolation'] as const;
export const LOCKED_REASONS: Readonly<Record<string, string>> = {
  name: 'the role\'s identity: the daemon and the guard map on it',
  'x-router.role': 'the role\'s identity: the daemon and the guard map on it',
  disallowedTools: 'keeps the router\'s lead-only tools away from subagents',
  isolation: 'set by the template',
};
export const TOOLS_RULE = `only ${ROLE_TOOL_ALLOWLIST.join(', ')}, each optionally with a rule in parentheses such as Bash(npm test); never empty (an empty list means every tool)`;
export const VERIFY_NOTE = 'These commands run on your machine, as you, when a subtask is verified. You vouch for them.';

export const EFFECTIVE_PLUGIN_DIR = 'plugin';
export const ROLE_OVERRIDES_DIR = 'roles';
export const GENERATED_STAMP = '.generated.json';
/** The CLI registers the generated plugin folder as a local marketplace by writing this manifest inside it; the
 *  generator keeps it (it is not a template file) so a regenerate/reload does not remove the install. */
export const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json';
export const effectivePluginDir = (home: string): string => path.join(home, EFFECTIVE_PLUGIN_DIR);
export const roleOverrideFile = (home: string, role: string): string => path.join(home, ROLE_OVERRIDES_DIR, `${role}.json`);
export const isRoleName = (v: unknown): v is Role => typeof v === 'string' && (ROLE_NAMES as readonly string[]).includes(v);

// The closing line is exactly "---" (then a newline or the end of the file).
const SPLIT = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** A whole tools entry: a tool name, optionally with one rule in parentheses on the same line (review M1). */
const TOOL_ENTRY = /^([A-Za-z][A-Za-z0-9_]{0,63})(\([^()\r\n]*\))?$/;
const firstLine = (s: string) => s.split('\n')[0]!;

function splitRole(text: string): { fm: string; body: string } | null {
  const m = SPLIT.exec(normalizeText(text));
  return m ? { fm: m[1]!, body: m[2] ?? '' } : null;
}
function frontMatter(text: string): Record<string, unknown> {
  const s = splitRole(text);
  const v = s ? parseYaml(s.fm) as unknown : null;
  return isObject(v) ? v : {};
}

/**
 * Every problem with a role file against the floor; [] when it holds. With `template`, the locked keys must also be
 * as the template has them. Used on write, on generation and when the daemon reads a role.
 */
export function roleFloorProblems(text: string, role: Role, template?: string): SettingsError[] {
  const s = splitRole(text);
  if (!s) return [{ path: 'front matter', message: 'the file needs YAML front matter between --- lines' }];
  // review M2: Claude Code's own front matter pattern may end the front matter at any "---", which would leave
  // tools and disallowedTools in the body (no tools line: every tool). So it may not appear in there at all.
  if (s.fm.includes('---')) return [{ path: 'front matter', message: '"---" may not appear inside the front matter (Claude Code could end the front matter there)' }];
  const doc = parseDocument(s.fm);
  if (doc.errors.length) return doc.errors.map(e => ({ path: 'front matter', message: firstLine(e.message), ...(e.linePos?.[0]?.line ? { line: e.linePos[0].line + 1 } : {}) }));
  const fm = doc.toJS() as unknown;
  if (!isObject(fm)) return [{ path: 'front matter', message: 'must be a YAML mapping' }];
  const errors: SettingsError[] = [];
  const allowed: readonly string[] = [...EDITABLE_ROLE_KEYS, ...LOCKED_ROLE_KEYS, 'x-router'];
  for (const k of Object.keys(fm)) if (!allowed.includes(k)) errors.push({ path: `front matter.${k}`, message: 'not a field a router role may set' });
  const xr = fm['x-router'];
  if (!isObject(xr)) errors.push({ path: 'x-router', message: 'the x-router mapping (role, verify) is missing' });
  else for (const k of Object.keys(xr)) if (k !== 'role' && k !== 'verify') errors.push({ path: `x-router.${k}`, message: 'not a field a router role may set' });
  let rf: ReturnType<typeof parseRoleFile>;
  try { rf = parseRoleFile(text); }
  catch (e) {
    if (e instanceof ZodError) return [...errors, ...zodErrors(e, 'front matter')];
    return [...errors, { path: 'front matter', message: e instanceof Error ? firstLine(e.message) : String(e) }];
  }
  if (rf.name !== role) errors.push({ path: 'name', message: `must stay "${role}" (${LOCKED_REASONS.name})` });
  if (rf.role !== role) errors.push({ path: 'x-router.role', message: `must stay "${role}" (${LOCKED_REASONS['x-router.role']})` });
  if (fm.tools === undefined || !rf.tools.length) errors.push({ path: 'tools', message: 'needs at least one tool: without a tools line the subagent gets every tool' });
  for (const t of rf.tools) {
    const m = TOOL_ENTRY.exec(t);
    const name = m?.[1] ?? '';
    if (!m) errors.push({ path: 'tools', message: `${JSON.stringify(t)} is not one tool entry (a tool name, optionally with a rule in parentheses)` });
    else if (FORBIDDEN_ROLE_TOOLS.includes(name)) errors.push({ path: 'tools', message: `${name} is never allowed for a router role` });
    else if (/^mcp__/i.test(name)) errors.push({ path: 'tools', message: `${name}: MCP tools are not allowed for a router role` });
    else if (!(ROLE_TOOL_ALLOWLIST as readonly string[]).includes(name)) errors.push({ path: 'tools', message: `${name} is not one of the tools a router role may use (${ROLE_TOOL_ALLOWLIST.join(', ')})` });
  }
  if (rf.model !== undefined && !(ROLE_MODEL_ALIASES as readonly string[]).includes(rf.model) && !MODEL_ID.test(rf.model)) {
    errors.push({ path: 'model', message: `must be one of ${ROLE_MODEL_ALIASES.join(', ')} or a model id (claude-…)` });
  }
  if (rf.effort !== undefined && !(ROLE_EFFORTS as readonly string[]).includes(rf.effort)) errors.push({ path: 'effort', message: `must be one of ${ROLE_EFFORTS.join(', ')}` });
  if (rf.maxTurns !== undefined && rf.maxTurns > MAX_ROLE_TURNS) errors.push({ path: 'maxTurns', message: `must be 1 to ${MAX_ROLE_TURNS}` });
  if (template !== undefined) {
    const t = frontMatter(template);
    for (const k of LOCKED_ROLE_KEYS) {
      if (k !== 'name' && !deepEqual(fm[k], t[k])) errors.push({ path: k, message: `locked (${LOCKED_REASONS[k]}): it must stay as the template has it` });
    }
  }
  return errors;
}

// ------------------------------------------------------------------ overrides

export interface RoleOverrideFields {
  description?: string;
  tools?: string[];
  model?: string;
  effort?: string;
  maxTurns?: number;
  verify?: VerifyEntry[];
  body?: string;
}
export interface RoleOverride { version: 1; role: Role; fields: RoleOverrideFields }
const FIELD_NAMES = ['description', 'tools', 'model', 'effort', 'maxTurns', 'verify', 'body'] as const;

function fieldsOf(text: string): Required<Pick<RoleOverrideFields, 'tools' | 'verify' | 'body'>> & Omit<RoleOverrideFields, 'tools' | 'verify' | 'body'> {
  const rf = parseRoleFile(normalizeText(text));
  return {
    tools: rf.tools.map(t => t.trim()), verify: rf.verify, body: rf.body,
    ...(rf.description !== undefined ? { description: rf.description } : {}),
    ...(rf.model !== undefined ? { model: rf.model } : {}), ...(rf.effort !== undefined ? { effort: rf.effort } : {}),
    ...(rf.maxTurns !== undefined ? { maxTurns: rf.maxTurns } : {}),
  };
}
const sameBody = (a: string, b: string) => a.replace(/\s+$/, '') === b.replace(/\s+$/, '');

/** The fields of an edited role that differ from the template (an empty `fields` means: no override). */
export function overrideFromText(role: Role, text: string, template: string): RoleOverride {
  const e = fieldsOf(text), t = fieldsOf(template);
  const fields: RoleOverrideFields = {};
  if ((e.description ?? '') !== (t.description ?? '')) fields.description = e.description ?? '';
  if (!deepEqual(e.tools, t.tools)) fields.tools = e.tools;
  if (e.model !== undefined && e.model !== t.model) fields.model = e.model;
  if (e.effort !== undefined && e.effort !== t.effort) fields.effort = e.effort;
  if (e.maxTurns !== undefined && e.maxTurns !== t.maxTurns) fields.maxTurns = e.maxTurns;
  if (!deepEqual(e.verify, t.verify)) fields.verify = e.verify;
  if (!sameBody(e.body, t.body)) fields.body = e.body.endsWith('\n') ? e.body : `${e.body}\n`;
  return { version: 1, role, fields };
}

/** The template with the override's fields put in (the template unchanged when there are none). */
export function applyRoleOverride(template: string, o: RoleOverride | null): string {
  if (!o || !Object.keys(o.fields).length) return template;
  const s = splitRole(template);
  if (!s) return template;
  const doc = parseDocument(s.fm);
  const f = o.fields;
  if (f.description !== undefined) doc.set('description', f.description);
  if (f.tools) doc.set('tools', f.tools.join(', '));
  if (f.model !== undefined) doc.set('model', f.model);
  if (f.effort !== undefined) doc.set('effort', f.effort);
  if (f.maxTurns !== undefined) doc.set('maxTurns', f.maxTurns);
  if (f.verify) doc.setIn(['x-router', 'verify'], doc.createNode(f.verify));
  return `---\n${doc.toString({ lineWidth: 0 }).replace(/\n+$/, '')}\n---\n${f.body ?? s.body}`;
}

/** The shape of an override's fields (review L1): a file that does not match is refused for its role alone. */
const overrideFieldsSchema = z.object({
  description: z.string().optional(),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  verify: z.array(verifyEntrySchema).optional(),
  body: z.string().optional(),
}).strict();

/** The override stored for a role; null when there is none; `error` when the file is there but not one this code wrote. */
export function readRoleOverride(home: string, role: Role): { override: RoleOverride | null; error?: string } {
  const text = readText(roleOverrideFile(home, role));
  if (text === null) return { override: null };
  try {
    const j = JSON.parse(text) as Partial<RoleOverride>;
    if (!isObject(j) || j.version !== 1 || j.role !== role || !isObject(j.fields)) throw new Error('not an override file');
    const r = overrideFieldsSchema.safeParse(j.fields);
    if (!r.success) {
      const i = r.error.issues[0]!;
      const keys = (i as { keys?: unknown }).keys;
      throw new Error(i.code === 'unrecognized_keys' && Array.isArray(keys) ? `unknown field ${String(keys[0])}` : `${issuePath(i.path, 'fields')}: ${i.message}`);
    }
    return { override: { version: 1, role, fields: r.data as RoleOverrideFields } };
  } catch (e) { return { override: null, error: e instanceof Error ? e.message : String(e) }; }
}

/**
 * What generation writes for a role: the template with the override's fields when the result holds the floor; the
 * template itself when there is no override, the override file cannot be read, or the result does not hold (then
 * `refused` says why). Deterministic from (template, override), so the runtime check can compare against it.
 */
export function expectedRole(home: string, role: Role, template: string): { text: string; refused?: SettingsError[] } {
  const { override, error } = readRoleOverride(home, role);
  if (error) return { text: template, refused: [{ path: `roles/${role}.json`, message: error }] };
  if (!override) return { text: template };
  const merged = applyRoleOverride(template, override);
  const errors = roleFloorProblems(merged, role, template);
  return errors.length ? { text: template, refused: errors } : { text: merged };
}

export function writeRoleOverride(home: string, role: Role, o: RoleOverride | null): void {
  const file = roleOverrideFile(home, role);
  if (!o || !Object.keys(o.fields).length) { fs.rmSync(file, { force: true }); return; }
  writeFileAtomic(file, JSON.stringify(o, null, 2) + '\n');
}

/** What an override change changes, for the audit line (free text only as changed). */
function overrideChanges(before: RoleOverride | null, after: RoleOverride | null, template: string): AuditChange[] {
  const t = fieldsOf(template);
  const a = { ...t, ...(before?.fields ?? {}) } as Record<string, unknown>;
  const b = { ...t, ...(after?.fields ?? {}) } as Record<string, unknown>;
  const out: AuditChange[] = [];
  for (const k of FIELD_NAMES) {
    if (k === 'body' ? sameBody(String(a.body ?? ''), String(b.body ?? '')) : deepEqual(a[k], b[k])) continue;
    out.push(k === 'body' || k === 'description' || k === 'verify' ? { path: k === 'verify' ? 'x-router.verify' : k, changed: true } : { path: k, from: a[k] ?? null, to: b[k] ?? null });
  }
  return out;
}

// ------------------------------------------------------------------ the effective plugin

/** Relative paths (with /) of the regular files under `dir`, links and node_modules/.git left out (the template side). */
function listFiles(dir: string, rel = ''): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') out.push(...listFiles(dir, r)); }
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

export function templateHash(templateDir: string): string {
  const h = createHash('sha256');
  for (const r of listFiles(templateDir)) h.update(r).update('\0').update(fs.readFileSync(path.join(templateDir, r))).update('\0');
  return h.digest('hex').slice(0, 16);
}

export interface GenerateResult {
  dir: string;
  written: string[];
  removed: string[];
  /** Overrides that do not hold against the (new) template: the role keeps its last good effective file or the template. */
  refused: Array<{ role: Role; errors: SettingsError[] }>;
  templateHash: string;
}

const realOrResolved = (p: string): string => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/** Whether `inner` is `outer` or inside it (links resolved where the paths exist). */
export function isInsideDir(outer: string, inner: string): boolean {
  const rel = path.relative(realOrResolved(outer), realOrResolved(inner));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Review L5: the templates come from the checkout; a folder inside the router home (the generated one, say) is refused. */
export function templateDirProblem(home: string, templateDir: string): string | null {
  if (isInsideDir(home, templateDir)) return `the plugin templates may not be inside the router home (${templateDir}): pass the checkout's plugin folder`;
  if (!fs.existsSync(path.join(templateDir, '.claude-plugin', 'plugin.json'))) return `not a plugin folder: ${templateDir}`;
  return null;
}

/** A real folder at `p`: a link, file or anything else there is removed (never followed) and the folder made. */
function ensureRealDir(p: string): void {
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(p); } catch { /* missing */ }
  if (st?.isDirectory()) return;                            // lstat: a link to a folder is not a folder here
  if (st) fs.rmSync(p, { recursive: true, force: true });   // removes a link itself, never what it points at
  fs.mkdirSync(p, { mode: 0o700 });
}

/**
 * Review L4: removes everything under `dir` that is not a regular file to keep, or a real folder on the way to one:
 * links (to files or folders), other files, and folders the template does not have. Links are never followed.
 */
function prune(dir: string, rel: string, keep: ReadonlySet<string>, keepDirs: ReadonlySet<string>, removed: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(rel ? path.join(dir, ...rel.split('/')) : dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const p = path.join(dir, ...r.split('/'));
    if (e.isFile() && keep.has(r)) continue;
    if (e.isDirectory()) {                                  // a real folder (a link reports isSymbolicLink instead)
      prune(dir, r, keep, keepDirs, removed);
      if (keepDirs.has(r)) continue;
    }
    fs.rmSync(p, { recursive: true, force: true });
    if (!e.isDirectory()) removed.push(r);
  }
}

/**
 * Generates <home>/plugin from the template folder and the overrides: the template's files as they are, its role
 * files as expectedRole makes them (an override that does not hold leaves the template's file, and is reported).
 * Only files that differ are written (each atomically, never through a link); anything the template does not have
 * is removed, links included.
 */
export function generateEffectivePlugin(home: string, templateDir: string, now = new Date()): GenerateResult {
  const problem = templateDirProblem(home, templateDir);
  if (problem) throw new Error(problem);
  const dir = effectivePluginDir(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  ensureRealDir(dir);
  const want = new Map<string, string | Buffer>();
  const refused: GenerateResult['refused'] = [];
  for (const rel of listFiles(templateDir)) {
    const content = fs.readFileSync(path.join(templateDir, rel));
    const m = /^agents\/([a-z-]+)\.md$/.exec(rel);
    if (!m || !isRoleName(m[1])) { want.set(rel, content); continue; }
    const e = expectedRole(home, m[1], content.toString('utf8'));
    if (e.refused) refused.push({ role: m[1], errors: e.refused });
    want.set(rel, e.text);
  }
  const keepDirs = new Set<string>();
  for (const rel of want.keys()) { const parts = rel.split('/'); for (let i = 1; i < parts.length; i++) keepDirs.add(parts.slice(0, i).join('/')); }
  const removed: string[] = [];
  prune(dir, '', new Set([...want.keys(), GENERATED_STAMP, MARKETPLACE_MANIFEST]), keepDirs, removed);
  const written: string[] = [];
  for (const [rel, content] of want) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) ensureRealDir(path.join(dir, ...parts.slice(0, i)));
    const target = path.join(dir, ...parts);
    let same = false;
    try { same = fs.lstatSync(target).isFile() && fs.readFileSync(target).equals(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')); } catch { /* new */ }
    if (!same) { writeFileAtomic(target, content, 0o600, { followLinks: false }); written.push(rel); }
  }
  const hash = templateHash(templateDir);
  const stamp = path.join(dir, GENERATED_STAMP);
  let prevStamp: { templateHash?: string } = {};
  try { if (fs.lstatSync(stamp).isFile()) prevStamp = JSON.parse(fs.readFileSync(stamp, 'utf8')) as { templateHash?: string }; } catch { /* first time */ }
  if (written.length || removed.length || prevStamp.templateHash !== hash) {
    writeFileAtomic(stamp, JSON.stringify({ version: 1, templateDir, templateHash: hash, generatedAt: now.toISOString() }, null, 2) + '\n', 0o600, { followLinks: false });
  }
  return { dir, written, removed, refused, templateHash: hash };
}

/**
 * Review L3, the runtime rule: the role text to use is what generation makes of (template, override). When the
 * generated file is anything else (a hand edit, a link, templates changed and not generated yet), it is not used:
 * the folder is regenerated, and the expected text is returned.
 */
export function effectiveRoleText(home: string, templateDir: string, role: Role, now = new Date()): { text: string; regenerated: boolean; refused?: SettingsError[] } {
  const template = readText(path.join(templateDir, 'agents', `${role}.md`));
  if (template === null) throw new Error(`the plugin templates have no ${role}.md`);
  const e = expectedRole(home, role, template);
  const file = path.join(effectivePluginDir(home), 'agents', `${role}.md`);
  let actual: string | null = null;
  try { if (fs.lstatSync(file).isFile()) actual = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
  const regenerated = actual !== e.text;
  if (regenerated) generateEffectivePlugin(home, templateDir, now);
  return { text: e.text, regenerated, ...(e.refused ? { refused: e.refused } : {}) };
}

/** The runtime check over a plugin folder's role files (no template needed): each role and what breaks the floor. */
export function pluginRoleProblems(pluginDir: string): Array<{ role: Role; errors: SettingsError[] }> {
  const out: Array<{ role: Role; errors: SettingsError[] }> = [];
  for (const role of ROLE_NAMES) {
    const text = readText(path.join(pluginDir, 'agents', `${role}.md`));
    if (text === null) continue;
    const errors = roleFloorProblems(text, role);
    if (errors.length) out.push({ role, errors });
  }
  return out;
}

// ------------------------------------------------------------------ the write and the view

export interface RoleFieldView { value: unknown; locked?: true; editable?: true; reason?: string; rule?: string; options?: readonly string[]; min?: number; max?: number; runsAsYou?: true; note?: string }
export interface RoleView { role: Role; revision: string; overridden: boolean; overriddenFields: string[]; text: string; template: string; fields: Record<string, RoleFieldView> }
export interface RolesView { editable: boolean; items: RoleView[] }

/**
 * The roles as they are used now. `templateDir` set (an install made by this release's init): the effective files and
 * the overrides; otherwise the plugin folder's files as they are, not editable until init is run again.
 */
export function rolesView(home: string, templateDir: string | undefined, pluginDir: string | undefined): RolesView {
  const editable = !!templateDir;
  const items: RoleView[] = [];
  for (const role of ROLE_NAMES) {
    const template = readText(path.join(templateDir ?? pluginDir ?? '', 'agents', `${role}.md`));
    if (template === null) continue;
    const { override } = editable ? readRoleOverride(home, role) : { override: null };
    // review L2/L3: what generation makes of (template, override), not whatever the generated file holds
    const text = editable ? expectedRole(home, role, template).text : template;
    let fm: Record<string, unknown> = {};
    let rf: ReturnType<typeof fieldsOf> | null = null;
    try { fm = frontMatter(text); rf = fieldsOf(text); } catch { /* shown as text only */ }
    const xr = isObject(fm['x-router']) ? fm['x-router'] : {};
    items.push({
      role, revision: revisionOf(text), overridden: !!override && Object.keys(override.fields).length > 0,
      overriddenFields: Object.keys(override?.fields ?? {}).map(k => (k === 'verify' ? 'x-router.verify' : k)), text, template,
      fields: {
        name: { value: fm.name ?? role, locked: true, reason: LOCKED_REASONS.name! },
        'x-router.role': { value: xr.role ?? role, locked: true, reason: LOCKED_REASONS['x-router.role']! },
        disallowedTools: { value: fm.disallowedTools ?? null, locked: true, reason: LOCKED_REASONS.disallowedTools! },
        isolation: { value: fm.isolation ?? null, locked: true, reason: LOCKED_REASONS.isolation! },
        tools: { value: rf?.tools ?? [], editable: true, rule: TOOLS_RULE },
        model: { value: rf?.model ?? null, editable: true, options: ROLE_MODEL_ALIASES, rule: 'or a full model id (claude-…)' },
        effort: { value: rf?.effort ?? null, editable: true, options: ROLE_EFFORTS },
        maxTurns: { value: rf?.maxTurns ?? null, editable: true, min: 1, max: MAX_ROLE_TURNS },
        description: { value: rf?.description ?? '', editable: true },
        'x-router.verify': { value: rf?.verify ?? [], editable: true, runsAsYou: true, note: VERIFY_NOTE },
        body: { value: rf?.body ?? '', editable: true },
      },
    });
  }
  return { editable, items };
}

/**
 * Validate, store, regenerate, audit: one role. `text` (the whole file), or `reset` (back to the template).
 * Needs an install made by this release's init (`templateDir`).
 */
export function applyRoleChange(home: string, templateDir: string | undefined, input: { role?: unknown; text?: unknown; reset?: unknown; revision?: unknown },
  source: SettingsSource, now = new Date()): WriteResult & { generated: GenerateResult } {
  if (!isRoleName(input.role)) throw new SettingsRejected([{ path: 'role', message: `must be one of ${ROLE_NAMES.join(', ')}` }]);
  const role = input.role;
  if (!templateDir) throw new SettingsRejected([{ path: 'roles', message: 'role edits need the generated plugin: run do-it-all-claude-code init again (it points Claude Code at <home>/plugin)' }], 409);
  const template = readText(path.join(templateDir, 'agents', `${role}.md`));
  if (template === null) throw new SettingsRejected([{ path: 'role', message: `the template has no ${role}.md` }], 409);
  const before = readRoleOverride(home, role).override;
  // review L2: an edit builds on what (template, override) gives, never on the generated file, so a hand edit of
  // that file is never promoted into an override; the folder is regenerated first when it differs
  const current = effectiveRoleText(home, templateDir, role, now).text;
  checkRevision(input.revision, current);
  let next: RoleOverride | null = null;
  if (input.reset !== true) {
    if (typeof input.text !== 'string') throw new SettingsRejected([{ path: 'text', message: 'send the role file (text) or reset' }]);
    const text = normalizeText(input.text);
    const errors = roleFloorProblems(text, role, template);
    if (errors.length) throw new SettingsRejected(errors);
    next = overrideFromText(role, text, template);
    if (!Object.keys(next.fields).length) next = null;
  }
  const changes = overrideChanges(before, next, template);
  if (!changes.length) {
    const generated = generateEffectivePlugin(home, templateDir, now);
    return { ok: true, changed: [], nextStart: [], notes: ['no change'], generated };
  }
  // review M3: the audit line goes first; a write that then fails is marked failed in the log
  const generated = auditedWrite(home, { at: now.toISOString(), source, kind: 'role', target: role, changes }, () => {
    try {
      writeRoleOverride(home, role, next);
      const g = generateEffectivePlugin(home, templateDir, now);
      const bad = g.refused.find(r => r.role === role);
      if (bad) throw new SettingsRejected(bad.errors);          // cannot happen after the check above; never leave it half-applied
      return g;
    } catch (e) {
      try { writeRoleOverride(home, role, before); generateEffectivePlugin(home, templateDir, now); } catch { /* the failure below is what counts */ }
      throw e;
    }
  });
  const notes = ['Claude Code sessions started before this keep the role as it was until they restart'];
  if (changes.some(c => c.path === 'x-router.verify')) notes.unshift(VERIFY_NOTE);
  return { ok: true, changed: changes.map(c => c.path), nextStart: [], notes, generated };
}
