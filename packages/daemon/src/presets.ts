// Team presets in effect for a request (gap in decision 88): the defaults (as the profile gives them, decision 194) with lead_direct set for the
// lead's model (decisions 117-118: an Opus-class lead delegates from L1, others from L2; config
// delegateFrom may change that), or the presets the daemon was started with as they are; then the
// user's <routerHome>/teams.yaml, then the project's
// .do-it-all-claude-code/teams.yaml (a protected path; read from the work tree when the request starts), then
// the per-level budgets of config.json. Each file may set any field of a level; what it leaves out
// comes from the layer below (core loadPresets with a base). An invalid file is logged and ignored.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROFILE, PROJECT_DIR, loadPresets, profilePresets, withLeadModel, workTreeRoot, type Level, type LeadModelClass, type Profile, type TeamPreset } from '@do-it-all-claude-code/core';
import { applyBudgets } from './config.ts';
import { errorText, type Logger } from './log.ts';

export const TEAMS_FILE = 'teams.yaml';
export const PROJECT_TEAMS_FILE = `${PROJECT_DIR}/teams.yaml`;

export type PresetSource = 'default' | 'user' | 'project' | 'user+project';

export interface ResolvedPresets {
  presets: Record<Level, TeamPreset>;
  source: PresetSource;
}

/** Top of the git work tree containing `dir` (nearest ancestor with a .git entry), by the filesystem only: core's, so the project key agrees everywhere. */
export { workTreeRoot };

export class PresetResolver {
  readonly #base: Record<Level, TeamPreset> | undefined;
  readonly #delegateFrom: Partial<Record<LeadModelClass, Level>> | undefined;
  readonly #userFile: string;
  readonly #budgets: Partial<Record<Level, number>> | undefined;
  readonly #profile: Profile;
  readonly #log: Logger;
  readonly #warned = new Map<string, string>();

  constructor(o: {
    base?: Record<Level, TeamPreset>; homeRoot: string; budgets?: Partial<Record<Level, number>>;
    delegateFrom?: Partial<Record<LeadModelClass, Level>>; profile?: Profile; log: Logger;
  }) {
    this.#profile = o.profile ?? DEFAULT_PROFILE;
    this.#base = o.base;
    this.#delegateFrom = o.delegateFrom;
    this.#userFile = path.join(o.homeRoot, TEAMS_FILE);
    this.#budgets = o.budgets;
    this.#log = o.log;
  }

  /** The presets for a request whose session works in `cwd` (undefined: the user's file only) with this lead model. */
  resolve(cwd: string | undefined, leadModel?: string): ResolvedPresets {
    const used: string[] = [];
    // decision 194: the profile's teams and budgets sit below the user's files
    let presets = this.#base ?? withLeadModel(profilePresets(this.#profile), leadModel, this.#delegateFrom ?? {});
    const user = this.#load(this.#userFile, presets);
    if (user) { presets = user; used.push('user'); }
    const root = cwd ? workTreeRoot(cwd) : undefined;
    // the previous release's .agentic-router/teams.yaml is no longer read (decision 164; doctor names the folder)
    const project = root ? this.#load(path.join(root, PROJECT_TEAMS_FILE), presets) : undefined;
    if (project) { presets = project; used.push('project'); }
    return { presets: applyBudgets(presets, this.#budgets), source: (used.join('+') || 'default') as PresetSource };
  }

  /** A teams.yaml on top of `base`; undefined when there is none or it is invalid (logged once per content). */
  #load(file: string, base: Record<Level, TeamPreset>): Record<Level, TeamPreset> | undefined {
    if (!fs.existsSync(file)) return undefined;
    try {
      const out = loadPresets(file, base);
      this.#warned.delete(file);
      return out;
    } catch (e) {
      const why = errorText(e).slice(0, 500);
      if (this.#warned.get(file) !== why) this.#log.warn('teams.yaml ignored: invalid', { file, error: why });
      this.#warned.set(file, why);
      return undefined;
    }
  }
}
