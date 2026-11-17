// The team office's Settings tab (decision 194; docs/design/team-office.md section 8.5): what a person may change
// from the panel, each value with where it comes from (the default, the profile, the user's own setting, the
// project's file), and the one write. The write goes through the settings service, so it is validated as the CLI's
// is and lands in the same history, with source "office". The panel has no text input, so every item here can be
// drawn with buttons; what needs an editor is listed as text with the CLI line that edits it.
import {
  CONFIG_KEYS, DEFAULT_LADDER, DEFAULT_PRESETS, MANAGED_CONFIG_KEYS, PROFILES, PROFILE_INFO, PROFILE_LAYERS, SMALL_STAYS_WITH_LEAD, SettingsRejected, TEAM_PATH, applyTeamPaths, checkRevision,
  getProjectWorktree, ladderStep, profileOf, profilePresets, profileSets, readText, revisionOf, rolesView, teamsFile, validateConfigSet,
  type ConfigKeySpec, type LeadModelClass, type Level, type Profile, type SettingsError, type Step,
} from '@do-it-all-claude-code/core';
import { readConfigFile } from './config.ts';
import { headRef, repoRoot } from './git.ts';
import type { HomeLayout } from './home.ts';
import type { Ledger } from './ledger.ts';
import path from 'node:path';
import { PROJECT_TEAMS_FILE, workTreeRoot } from './presets.ts';
import type { SettingsAnswer, SettingsService } from './settings.ts';
import { ROLES, TEAM_LEVELS, delegateFromOf, sessionLeadClass, sourceOf, teamLayers, type Source } from './tabs.ts';
import { PROJECT_VERIFY_FILE, resolveVerifyCommands } from './verify-source.ts';

export interface OfficeSettingsContext {
  home: HomeLayout;
  settings: SettingsService;
  ledger?: Ledger;
  sessionCwd?: (sessionId: string) => string | undefined;
}

export type ItemGroup = 'profile' | 'team' | 'budget' | 'quality' | 'office' | 'privacy' | 'advanced';
export interface SettingsItem {
  path: string;
  group: ItemGroup;
  title: string;
  description: string;
  type: 'enum' | 'boolean' | 'number' | 'integer';
  options?: string[];
  /** A short word per option, for the ones that need one (a step's model and effort). */
  optionLabels?: Record<string, string>;
  min?: number; max?: number; step?: number;
  /** The values a number is stepped through, when plain steps would be too many. */
  choices?: number[];
  value: unknown;
  source: Source;
  /** How the source gave the value, when that is not plain ("profile x 0.6"). */
  sourceNote?: string;
  default: unknown;
  /** What the value would be without the person's own setting. */
  profileValue?: unknown;
  appliesAt: 'now' | 'next request' | 'next start' | 'next session';
  editable: boolean;
  why?: string;
}

export interface OfficeSettings {
  revision: { config: string; presets: string };
  profile: {
    value: Profile; source: 'default' | 'own';
    options: Array<{ id: Profile; title: string; summary: string; sets: Array<{ path: string; value: string }>; measured: string | null }>;
  };
  items: SettingsItem[];
  team: Array<{ level: Level; leadDirect: boolean; budgetUsd: number; roles: Array<{ role: string; count: number; step: Step; model: string; effort: string; source: Source }> }>;
  text: Array<{ key: string; title: string; value: string; command: string }>;
  /** The session's project (decision 192): its folder name, and whether parallel writers get a work tree each (null: not asked yet). Null without a session folder. */
  project: { name: string; worktree: 'on' | 'off' | null } | null;
  problems: Array<{ path: string; message: string }>;
  managed: Array<{ key: string; reason: string }>;
}

const GROUP: Record<string, ItemGroup> = {
  profile: 'profile', reproduceFirst: 'quality', stepDown: 'quality', office: 'office', officeAutoOpen: 'office', autoStart: 'office', updateCheck: 'office',
  recordPrompts: 'privacy', eventRetentionDays: 'privacy', holdoutRate: 'advanced', autoRelease: 'advanced', forceLevel: 'advanced', fableOptIn: 'advanced', bearerApi: 'advanced',
};
const TITLE: Record<string, string> = {
  profile: 'Profile', reproduceFirst: 'Reproduce first', stepDown: 'Step down after easy results', office: 'Team office panel', officeAutoOpen: 'Open the office by itself',
  autoStart: 'Start the daemon with a session', updateCheck: 'Check for updates', recordPrompts: 'Keep prompts in the records', eventRetentionDays: 'Days hook events are kept',
  holdoutRate: 'Holdout share', autoRelease: 'Auto-release', forceLevel: 'Force a level', fableOptIn: 'Allow the Fable step', bearerApi: 'Bearer API (deprecated)',
};
const APPLIES: Record<string, SettingsItem['appliesAt']> = { profile: 'next request', office: 'next session', officeAutoOpen: 'next session', autoStart: 'next session', reproduceFirst: 'next request' };
const BUDGET_CHOICES = [0.25, 0.5, 1, 1.5, 2, 3, 5, 8, 10, 15, 20, 30, 50];
const RETENTION_CHOICES = [0, 7, 14, 30, 60, 90, 180, 365];
const LEVELS: readonly Level[] = ['L0', 'L1', 'L2', 'L3'];
const LEAD_CLASSES: readonly LeadModelClass[] = ['opus', 'sonnet', 'haiku', 'other'];
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readOwn(configFile: string): { text: string | null; own: Record<string, unknown> } {
  const text = readText(configFile);
  try { const j = text ? JSON.parse(text.replace(/^﻿/, '')) as unknown : {}; return { text, own: isObject(j) ? j : {} }; }
  catch { return { text, own: {} }; }
}

function scalarItem(s: ConfigKeySpec, own: Record<string, unknown>, profile: Profile): SettingsItem {
  const set = Object.hasOwn(own, s.key) && own[s.key] !== undefined;
  const fromProfile = s.key === 'stepDown' ? PROFILE_LAYERS[profile].stepDown : undefined;
  const without = fromProfile ?? s.default;
  return {
    path: s.key, group: GROUP[s.key] ?? 'advanced', title: TITLE[s.key] ?? s.key, description: s.description,
    type: s.type as SettingsItem['type'],
    ...(s.options ? { options: [...s.options] } : {}),
    ...(s.min !== undefined ? { min: s.min } : {}), ...(s.max !== undefined ? { max: s.max } : {}),
    ...(s.key === 'holdoutRate' ? { step: 0.05 } : s.key === 'eventRetentionDays' ? { step: 1, choices: RETENTION_CHOICES } : {}),
    value: set ? own[s.key] : without,
    source: set ? 'own' : fromProfile !== undefined && fromProfile !== s.default ? 'profile' : 'default',
    default: s.default, ...(set ? { profileValue: without } : {}),
    appliesAt: APPLIES[s.key] ?? s.appliesAt,
    editable: !s.deprecated, ...(s.deprecated ? { why: 'deprecated: change it with the CLI if you must' } : {}),
  };
}

const stepLabels = (fable: boolean): { options: string[]; optionLabels: Record<string, string> } => {
  const steps = DEFAULT_LADDER.filter(l => fable || !l.optIn);
  return { options: steps.map(l => l.step), optionLabels: Object.fromEntries(steps.map(l => [l.step, `${l.alias} ${l.effort}`])) };
};

/** A session's repository and its work tree setting (decision 192), from the folder the session works in. */
export function projectView(homeRoot: string, cwd: string | undefined): { name: string; worktree: 'on' | 'off' | null } | null {
  const root = cwd ? workTreeRoot(cwd) : undefined;
  if (!root) return null;
  let worktree: 'on' | 'off' | null = null;
  try { worktree = getProjectWorktree(homeRoot, root); } catch { /* shown as not asked */ }
  return { name: path.basename(root), worktree };
}

/** The Settings tab's view. `sessionId` gives the session's lead class and folder (for the project's files), when known. */
export async function officeSettingsView(ctx: OfficeSettingsContext, sessionId?: string): Promise<OfficeSettings> {
  const { text: configText, own } = readOwn(ctx.home.config);
  const warnings: string[] = [];
  let checked: ReturnType<typeof readConfigFile> = {};
  try { checked = readConfigFile(ctx.home.config, warnings); } catch (e) { warnings.push(e instanceof Error ? e.message : String(e)); }
  const profile = profileOf(own);
  const cwd = sessionId ? ctx.sessionCwd?.(sessionId) : undefined;
  const layers = teamLayers(ctx.home.root, profile, cwd);
  const ownBudgets = isObject(own.budgetsUsd) ? own.budgetsUsd : {};
  const ownFrom = isObject(own.delegateFrom) ? own.delegateFrom as Partial<Record<LeadModelClass, Level>> : undefined;
  const leadClass = (ctx.ledger ? sessionLeadClass(ctx.ledger, sessionId) : null) ?? 'other';
  const factor = PROFILE_LAYERS[profile].budgetFactor;
  const projectWhy = `set by the project's ${PROJECT_TEAMS_FILE}`;

  const items: SettingsItem[] = [];
  for (const s of CONFIG_KEYS) {
    if (s.type === 'levels' || s.type === 'byLeadClass') continue;
    items.push(scalarItem(s, own, profile));
  }
  // where delegation starts, per lead class
  for (const c of LEAD_CLASSES) {
    const v = delegateFromOf(profile, ownFrom, c);
    items.push({
      path: `delegateFrom.${c}`, group: 'team', title: `Delegate from (${c} lead)`,
      // decision 211: said only where it applies (the value is L1 and not the user's own)
      description: 'The first level that gets a team with this lead model; below it the lead does the work itself'
        + (SMALL_STAYS_WITH_LEAD[c] && v.value === 'L1' && v.source !== 'own' ? '. A request whose wording shows a small fix stays with the lead until you set this value yourself' : ''),
      type: 'enum', options: ['L1', 'L2', 'L3'], value: v.value, source: v.source, default: delegateFromOf('balanced', undefined, c).value,
      ...(v.source === 'own' ? { profileValue: delegateFromOf(profile, undefined, c).value } : {}), appliesAt: 'next request', editable: true,
    });
  }
  // the budget of one request, per level
  for (const l of LEVELS) {
    const mine = typeof ownBudgets[l] === 'number' ? ownBudgets[l] as number : undefined;
    const below = layers.project[l].budgetUsd;
    const source: Source = mine !== undefined ? 'own' : sourceOf(p => p[l].budgetUsd, layers);
    items.push({
      path: `budgetsUsd.${l}`, group: 'budget', title: `Budget of one ${l} request (USD)`, description: 'A bound on what one request may spend on workers; the router stops dispatching beyond it',
      type: 'number', min: 0.25, max: 100, choices: BUDGET_CHOICES, value: mine ?? below, source,
      ...(source === 'profile' ? { sourceNote: `profile x ${factor}` } : {}),
      default: DEFAULT_PRESETS[l].budgetUsd, ...(mine !== undefined ? { profileValue: below } : {}), appliesAt: 'next request', editable: true,
    });
  }
  // each level's team: how many of a role, and the step it starts on
  const steps = stepLabels(checked.fableOptIn === true);
  for (const level of TEAM_LEVELS) {
    for (const role of ROLES) {
      const m = layers.project[level].roles.find(x => x.role === role);
      const base = layers.profiled[level].roles.find(x => x.role === role);
      const fromProject = sourceOf(p => p[level].roles.find(x => x.role === role) ?? null, layers) === 'project';
      const count = m?.count ?? 0;
      const pick = (f: 'count' | 'start') => sourceOf(p => p[level].roles.find(x => x.role === role)?.[f] ?? null, layers);
      items.push({
        path: `team.${level}.${role}.count`, group: 'team', title: `${level} ${role}: how many`, description: `How many ${role} members an ${level} team has (0: none)`,
        type: 'integer', min: 0, max: 4, step: 1, value: count, source: pick('count'), default: DEFAULT_PRESETS[level].roles.find(x => x.role === role)?.count ?? 0,
        ...(pick('count') === 'own' ? { profileValue: base?.count ?? 0 } : {}), appliesAt: 'next request', editable: !fromProject, ...(fromProject ? { why: projectWhy } : {}),
      });
      if (count > 0 && m) {
        items.push({
          path: `team.${level}.${role}.start`, group: 'team', title: `${level} ${role}: start step`, description: `The model and effort an ${level} ${role} starts on; a miss raises it one step`,
          type: 'enum', ...steps, value: m.start, source: pick('start'), default: DEFAULT_PRESETS[level].roles.find(x => x.role === role)?.start ?? null,
          ...(pick('start') === 'own' ? { profileValue: base?.start ?? null } : {}), appliesAt: 'next request', editable: !fromProject, ...(fromProject ? { why: projectWhy } : {}),
        });
      }
    }
  }

  const order: Level[] = ['L0', 'L1', 'L2', 'L3'];
  const from = delegateFromOf(profile, ownFrom, leadClass).value;
  const team = TEAM_LEVELS.map(level => ({
    level,
    leadDirect: order.indexOf(level) < order.indexOf(from),
    budgetUsd: typeof ownBudgets[level] === 'number' ? ownBudgets[level] as number : layers.project[level].budgetUsd,
    roles: layers.project[level].roles.filter(m => m.count > 0).map(m => {
      const st = ladderStep(m.start);
      return { role: m.role, count: m.count, step: m.start, model: st.alias, effort: st.effort, source: sourceOf(p => p[level].roles.find(x => x.role === m.role) ?? null, layers) };
    }),
  }));

  // what has no buttons: shown with the CLI line (or the file) that changes it
  const text: OfficeSettings['text'] = [];
  const problems: OfficeSettings['problems'] = [...warnings.map(w => ({ path: 'config.json', message: w })), ...layers.problems];
  try {
    const root = cwd ? await repoRoot(cwd) : undefined;
    const head = root ? await headRef(root) : undefined;
    const lines: string[] = [];
    let source = 'role';
    for (const role of ['coder', 'ui-designer', 'tester'] as const) {
      const r = await resolveVerifyCommands({ role, ...(checked.pluginDir ? { pluginDir: checked.pluginDir } : {}), ...(root ? { repoRoot: root } : {}), ...(head ? { baseRef: head } : {}) });
      if (r.source === 'project') source = 'project';
      if (r.warning) problems.push({ path: PROJECT_VERIFY_FILE, message: r.warning });
      if (r.commands.length) lines.push(`${role}: ${r.commands.map(k => k.command).join(' ; ')}`);
    }
    text.push({
      key: 'verify', title: source === 'project' ? `Verify commands (from the project's ${PROJECT_VERIFY_FILE})` : 'Verify commands (from the role files)',
      value: lines.join('\n') || 'none', command: `edit ${PROJECT_VERIFY_FILE} in the repository and commit it: it is read from the commit a request starts at`,
    });
  } catch { /* shown without the verify commands */ }
  const project = projectView(ctx.home.root, cwd);
  if (project) {
    const { worktree } = project;
    text.push({
      key: 'project.worktree', title: 'Work trees for parallel writers in this project',
      value: worktree === 'on' ? 'on: each parallel writer gets a work tree of its own' : worktree === 'off' ? 'off: writers share the checkout, and overlapping edits take turns' : 'not decided: the lead asks once, at the first delegation in this project',
      command: 'do-it-all-claude-code project enable',
    });
  }
  const teamsText = readText(teamsFile(ctx.home.root));
  text.push({ key: 'teams.yaml', title: 'Your teams.yaml', value: teamsText?.trim() || 'none: the profile\'s teams apply', command: 'do-it-all-claude-code preset edit' });
  try {
    for (const r of rolesView(ctx.home.root, checked.pluginTemplateDir, checked.pluginDir).items) {
      text.push({ key: `role.${r.role}`, title: `Role file: ${r.role}`, value: r.overridden ? `edited (${r.overriddenFields.join(', ') || 'text'})` : 'as shipped', command: `do-it-all-claude-code role edit ${r.role}` });
    }
  } catch { /* an install from before role editing: nothing to list */ }

  return {
    revision: { config: revisionOf(configText), presets: revisionOf(teamsText) },
    profile: {
      value: profile, source: Object.hasOwn(own, 'profile') ? 'own' : 'default',
      options: PROFILES.map(id => ({ id, title: PROFILE_INFO[id].title, summary: PROFILE_INFO[id].summary, sets: profileSets(id), measured: PROFILE_INFO[id].measured })),
    },
    items, team, text, project, problems,
    managed: Object.entries(MANAGED_CONFIG_KEYS).map(([key, reason]) => ({ key, reason })),
  };
}

/**
 * The Settings tab's write: `{ revision: { config?, presets? }, set: { path: value | null } }`. Config keys and team
 * paths may be mixed; everything is checked before anything is written, and a problem in either part writes nothing.
 */
export async function officeSettingsApply(ctx: OfficeSettingsContext, body: Record<string, unknown>): Promise<SettingsAnswer> {
  const set = body.set;
  const errors: SettingsError[] = [];
  let status: 400 | 409 = 400;
  if (!isObject(set) || !Object.keys(set).length) return [400, { ok: false, errors: [{ path: 'set', message: 'nothing to set' }] }];
  const revision = isObject(body.revision) ? body.revision : {};
  const configSet: Record<string, unknown> = {}, teamSet: Record<string, unknown> = {};
  for (const [p, v] of Object.entries(set)) (TEAM_PATH.test(p) || p.startsWith('team.') ? teamSet : configSet)[p] = v;

  const { text: configText, own } = readOwn(ctx.home.config);
  const teamsText = readText(teamsFile(ctx.home.root));
  const collect = (fn: () => void) => {
    try { fn(); }
    catch (e) { if (!(e instanceof SettingsRejected)) throw e; errors.push(...e.errors); if (e.status === 409) status = 409; }
  };
  if (Object.keys(configSet).length) {
    collect(() => checkRevision(revision.config, configText));
    collect(() => { validateConfigSet(own, configSet); });
  }
  let nextTeams: string | undefined;
  if (Object.keys(teamSet).length) {
    collect(() => checkRevision(revision.presets, teamsText));
    // a profile chosen in the same call is what the teams are measured against
    const profile = profileOf({ profile: Object.hasOwn(configSet, 'profile') && configSet.profile !== null ? configSet.profile : own.profile });
    collect(() => { nextTeams = applyTeamPaths(teamsText ?? '', profilePresets(profile), teamSet); });
  }
  if (errors.length) return [status, { ok: false, errors }];

  const changed: string[] = [], nextStart: string[] = [], notes: string[] = [];
  const take = (answer: SettingsAnswer): SettingsAnswer | undefined => {
    const [code, r] = answer;
    if (code !== 200) return answer;
    const w = r as { changed?: string[]; nextStart?: string[]; notes?: string[] };
    nextStart.push(...(w.nextStart ?? []));
    for (const n of w.notes ?? []) if (n !== 'no change' && !notes.includes(n)) notes.push(n);
    return undefined;
  };
  if (Object.keys(configSet).length) {
    const [code, r] = await ctx.settings.apply('config', { set: configSet, ...(revision.config !== undefined ? { revision: revision.config } : {}) }, 'office');
    if (code !== 200) return [code, r];
    changed.push(...((r as { changed?: string[] }).changed ?? []));
    take([code, r]);
  }
  if (nextTeams !== undefined && nextTeams !== (teamsText ?? '')) {
    const [code, r] = await ctx.settings.apply('presets', { text: nextTeams, ...(revision.presets !== undefined ? { revision: revision.presets } : {}) }, 'office');
    if (code !== 200) return [code, r];
    if (((r as { changed?: string[] }).changed ?? []).length) changed.push(...Object.keys(teamSet));
    take([code, r]);
  }
  if (!changed.length) notes.push('no change');
  return [200, { ok: true, changed, nextStart, notes, revision: { config: revisionOf(readText(ctx.home.config)), presets: revisionOf(readText(teamsFile(ctx.home.root))) } }];
}
