// Profiles (decision 194): one setting, `profile`, that gives a set of values between the defaults and the user's
// own settings. A value the user set in config.json or teams.yaml stays; a profile only changes what the user left
// alone. `balanced` is the defaults as they are, so an install without the key behaves as before.
//
// Only `balanced` rests on a measurement (the bench runs in docs/measurements). `save` and `quality` move the
// same settings one way or the other and are not measured; the text says so. The text gives no number: the
// figures are in the measurement notes, and they change with each run of the bench. Reproduce first is not part
// of a profile: it waits for its own measurement. The per-request budgets follow the profile by a factor (save
// 0.6, quality 1.5), below a budget the user set.
import { ladderStep, startCellFor } from './ladder.ts';
import { DEFAULT_DELEGATE_FROM, DEFAULT_PRESETS, applyPresetFile, type LeadModelClass, type PresetFile } from './presets.ts';
import type { Difficulty, LadderId, Level, Role, Step, TeamPreset } from './types.ts';

export const PROFILES = ['save', 'balanced', 'quality'] as const;
export type Profile = typeof PROFILES[number];
export const DEFAULT_PROFILE: Profile = 'balanced';

/** Decision 226: a profile shifts the whole difficulty start-cell table one notch (save down, quality up). */
export function profileNotch(profile: Profile): number {
  return profile === 'save' ? -1 : profile === 'quality' ? 1 : 0;
}

/**
 * Decision 226: the start cell a preset member runs at — the difficulty table and the profile notch, unless the
 * member's start was set by the user's teams.yaml or a role override (`startSet`), which wins whatever its value.
 */
export function memberStartCell(role: Role, start: LadderId, startSet: boolean | undefined, difficulty: Difficulty, profile: Profile = DEFAULT_PROFILE, fableOptIn = false): LadderId {
  return startCellFor(role, difficulty, { notch: profileNotch(profile), fableOptIn, ...(startSet ? { override: start } : {}) });
}

export const profileOf = (c: { profile?: unknown } | undefined | null): Profile =>
  ((PROFILES as readonly unknown[]).includes(c?.profile) ? c!.profile as Profile : DEFAULT_PROFILE);

/** What a profile gives: config values, and team presets in the shape of a teams.yaml. */
export interface ProfileLayer {
  delegateFrom?: Partial<Record<LeadModelClass, Level>>;
  stepDown?: 'on' | 'off';
  /** The default per-request budget of every level times this. */
  budgetFactor: number;
  presets: PresetFile;
}

const member = (role: TeamPreset['roles'][number]['role'], count: number, start: Step) => ({ role, count, start });

export const PROFILE_LAYERS: Record<Profile, ProfileLayer> = {
  // Smaller teams on lower steps: the lead reviews an L2 change itself, and an L3 team starts on Sonnet.
  save: {
    budgetFactor: 0.6,
    presets: {
      L2: { roles: [member('coder', 2, 's1'), member('tester', 1, 's1')] },
      L3: { roles: [member('architect', 1, 's4'), member('ui-designer', 1, 's3'), member('coder', 2, 's3'), member('reviewer', 1, 's3'), member('tester', 1, 's1')] },
    },
  },
  balanced: { budgetFactor: 1, presets: {} },
  // The lead keeps L1 itself, every worker starts one step higher, and a slot is never lowered after easy results.
  quality: {
    delegateFrom: { opus: 'L2', sonnet: 'L2', haiku: 'L2', other: 'L2' },
    stepDown: 'off',
    budgetFactor: 1.5,
    presets: {
      L2: { roles: [member('architect', 1, 's4'), member('coder', 2, 's2'), member('reviewer', 1, 's4'), member('tester', 1, 's2')] },
      L3: { roles: [member('architect', 1, 's6'), member('ui-designer', 1, 's4'), member('coder', 2, 's5'), member('reviewer', 1, 's6'), member('tester', 1, 's3')] },
    },
  },
};

export const PROFILE_INFO: Record<Profile, { title: string; summary: string; measured: string | null }> = {
  save: {
    title: 'Save',
    summary: 'Smaller teams on cheaper steps: no architect or reviewer at L2 (the lead reviews), L3 workers start on Sonnet, and budgets at 0.6 of the default.',
    measured: null,
  },
  balanced: {
    title: 'Balanced',
    summary: 'The defaults: delegation from L1 for Opus and Sonnet leads (a Sonnet lead keeps a request whose wording shows a small fix), Haiku coders first, a reviewer and a tester at L2 and L3.',
    measured: 'Measured on the bench (see docs/measurements); the other profiles are not measured yet.',
  },
  quality: {
    title: 'Quality',
    summary: 'The lead does L1 work itself, workers start one step higher, a slot is not lowered after easy results, and budgets at 1.5 of the default. Costs more.',
    measured: null,
  },
};

/** The team presets a profile gives, before the lead's model and the user's files are applied. */
export function profilePresets(profile: Profile, base: Record<Level, TeamPreset> = DEFAULT_PRESETS): Record<Level, TeamPreset> {
  const layer = PROFILE_LAYERS[profile];
  const out = applyPresetFile(layer.presets, base);
  if (layer.budgetFactor !== 1) for (const l of Object.keys(out) as Level[]) out[l] = { ...out[l], budgetUsd: profileBudget(profile, base[l].budgetUsd) };
  return out;
}

/** A default budget under a profile, in whole cents. */
export function profileBudget(profile: Profile, defaultUsd: number): number {
  return Math.round(defaultUsd * PROFILE_LAYERS[profile].budgetFactor * 100) / 100;
}

/** Where delegation starts per lead class under a profile (the user's own delegateFrom goes on top). */
export function profileDelegateFrom(profile: Profile): Record<LeadModelClass, Level> {
  return { ...DEFAULT_DELEGATE_FROM, ...PROFILE_LAYERS[profile].delegateFrom };
}

/**
 * A config with the profile's values where the user set none. `delegateFrom` is merged per lead class. The
 * result is what the router runs on; what the user wrote is in the file.
 */
export function withProfile<T extends { profile?: unknown; delegateFrom?: Partial<Record<LeadModelClass, Level>>; stepDown?: 'on' | 'off' }>(config: T): T {
  const layer = PROFILE_LAYERS[profileOf(config)];
  const out = { ...config };
  if (layer.delegateFrom) out.delegateFrom = { ...layer.delegateFrom, ...config.delegateFrom };
  if (layer.stepDown !== undefined && config.stepDown === undefined) out.stepDown = layer.stepDown;
  return out;
}

const stepText = (s: LadderId): string => { const l = ladderStep(s); return `${s} (${l.alias} ${l.effort})`; };

/** What a profile changes against the defaults, as paths and values the settings view can list. */
export function profileSets(profile: Profile): Array<{ path: string; value: string }> {
  const layer = PROFILE_LAYERS[profile];
  const out: Array<{ path: string; value: string }> = [];
  for (const [k, v] of Object.entries(layer.delegateFrom ?? {})) {
    if (DEFAULT_DELEGATE_FROM[k as LeadModelClass] !== v) out.push({ path: `delegateFrom.${k}`, value: String(v) });
  }
  if (layer.stepDown !== undefined) out.push({ path: 'stepDown', value: layer.stepDown });
  if (layer.budgetFactor !== 1) {
    for (const l of Object.keys(DEFAULT_PRESETS) as Level[]) out.push({ path: `budgetsUsd.${l}`, value: `${profileBudget(profile, DEFAULT_PRESETS[l].budgetUsd)} (default x ${layer.budgetFactor})` });
  }
  for (const [level, p] of Object.entries(layer.presets)) {
    const roles = p?.roles;
    if (!roles) continue;
    const before = DEFAULT_PRESETS[level as Level].roles;
    for (const b of before) if (!roles.some(r => r.role === b.role && r.count > 0)) out.push({ path: `team.${level}.${b.role}.count`, value: '0' });
    for (const r of roles) {
      const b = before.find(x => x.role === r.role);
      if (!b || b.count !== r.count) out.push({ path: `team.${level}.${r.role}.count`, value: String(r.count) });
      if (!b || b.start !== r.start) out.push({ path: `team.${level}.${r.role}.start`, value: stepText(r.start) });
    }
  }
  return out;
}
