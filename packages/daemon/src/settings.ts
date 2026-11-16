// Decision 168: the daemon's settings service. Both front doors call it: the sealed /router/v1 routes (the CLI) and
// the dashboard's cookie + CSRF routes. It runs the core's one write core (validate, atomic write, audit) and then
// reloads what the daemon holds: config.json into the router; teams.yaml is read for every request anyway; a role
// change regenerates the effective plugin, whose files the router and verify read when they need them.
import {
  SettingsRejected, applyConfigChange, applyPresetsChange, applyRoleChange, configView, generateEffectivePlugin, pluginRoleProblems,
  presetsView, readAudit, readText, rolesView, type AuditEntry, type ConfigView, type PresetsView, type RolesView, type SettingsSource, type WriteResult,
} from '@do-it-all-claude-code/core';
import { readConfig, type ConfigFile } from './config.ts';
import type { HomeLayout } from './home.ts';
import { errorText, type Logger } from './log.ts';
import type { Router } from './router.ts';

export interface SettingsView { config: ConfigView; presets: PresetsView; roles: RolesView }
export type SettingsAnswer = [status: number, body: unknown];

export class SettingsService {
  readonly #home: HomeLayout;
  readonly #router: Router;
  readonly #log: Logger;
  readonly #now: () => Date;

  constructor(o: { home: HomeLayout; router: Router; logger: Logger; now?: () => Date }) {
    this.#home = o.home;
    this.#router = o.router;
    this.#log = o.logger;
    this.#now = o.now ?? (() => new Date());
  }

  #config(warnings: string[] = []): ConfigFile {
    try { return readConfig(this.#home.config, warnings); } catch (e) { warnings.push(errorText(e)); return {}; }
  }

  view(): SettingsView {
    const cfg = this.#config();
    return { config: configView(readText(this.#home.config)), presets: presetsView(this.#home.root), roles: rolesView(this.#home.root, cfg.pluginTemplateDir, cfg.pluginDir) };
  }

  history(limit = 50): AuditEntry[] { return readAudit(this.#home.root, limit); }

  config(input: Record<string, unknown>, source: SettingsSource): WriteResult {
    const { config: _written, ...r } = applyConfigChange(this.#home.root, input, source, this.#now());
    if (r.changed.length) { this.#reloadConfig(); this.#log.info('settings changed', { kind: 'config', source, changed: r.changed }); }
    return r;
  }

  presets(input: Record<string, unknown>, source: SettingsSource): WriteResult {
    const r = applyPresetsChange(this.#home.root, input, source, this.#now());
    if (r.changed.length) this.#log.info('settings changed', { kind: 'presets', source, changed: r.changed });
    return r;
  }

  role(input: Record<string, unknown>, source: SettingsSource): WriteResult {
    const { generated, ...r } = applyRoleChange(this.#home.root, this.#config().pluginTemplateDir, input, source, this.#now());
    if (r.changed.length) this.#log.info('settings changed', { kind: 'role', source, role: String(input.role), changed: r.changed, files: generated.written.length });
    this.#router.applyConfig(this.#config());         // the role files' tools are cached by mtime; start clean
    return r;
  }

  /**
   * The one entry both front doors call: a write between events (in-flight hooks finish first), answered as an
   * HTTP status and body (200, or the core's 400 / 409 with every problem).
   */
  async apply(kind: 'config' | 'presets' | 'role' | 'reload', body: Record<string, unknown>, source: SettingsSource): Promise<SettingsAnswer> {
    await this.#router.drain();
    return settingsAnswer(() => (kind === 'config' ? this.config(body, source) : kind === 'presets' ? this.presets(body, source)
      : kind === 'role' ? this.role(body, source) : this.reload()));
  }

  /** `reload`: config.json into the router, the effective plugin regenerated, the role floor checked. */
  reload(): { ok: true; reloaded: string[]; notes: string[] } {
    const notes = this.#reloadConfig();
    const reloaded = ['config.json', 'teams.yaml'];
    const cfg = this.#config();
    if (cfg.pluginTemplateDir) {
      const g = this.regenerate(cfg);
      reloaded.push('roles');
      if (g.written) notes.push(`the effective plugin: ${g.written} file(s) updated`);
      for (const r of g.refused) notes.push(`${r.role}: its override does not hold (${r.errors.map(e => `${e.path}: ${e.message}`).join('; ')}); the role uses the template's file until it is fixed`);
    }
    return { ok: true, reloaded, notes };
  }

  /**
   * Decision 168, at start and on reload: the effective plugin from the templates and the overrides (only changed
   * files are written), then the floor checked over the files the router reads.
   */
  regenerate(cfg: ConfigFile = this.#config()): { written: number; refused: Array<{ role: string; errors: Array<{ path: string; message: string }> }> } {
    let written = 0;
    let refused: Array<{ role: string; errors: Array<{ path: string; message: string }> }> = [];
    if (cfg.pluginTemplateDir) {
      try {
        const g = generateEffectivePlugin(this.#home.root, cfg.pluginTemplateDir, this.#now());
        written = g.written.length + g.removed.length;
        refused = g.refused;
        if (written) this.#log.info('effective plugin updated', { written: g.written.length, removed: g.removed.length, templateHash: g.templateHash });
        for (const r of g.refused) this.#log.warn('role override does not hold: the role keeps its last good file', { role: r.role, problems: r.errors.map(e => e.path) });
      } catch (e) { this.#log.error('effective plugin not generated', { error: errorText(e) }); }
    }
    if (cfg.pluginDir) {
      for (const p of pluginRoleProblems(cfg.pluginDir)) this.#log.error('role file breaks the role floor: the router does not use it', { role: p.role, problems: p.errors.map(e => `${e.path}: ${e.message}`) });
    }
    return { written, refused };
  }

  #reloadConfig(): string[] {
    const warnings: string[] = [];
    this.#router.applyConfig(this.#config(warnings));
    for (const w of warnings) this.#log.warn(w);
    return warnings;
  }
}

/** A settings call answered as an HTTP status and body: 200, or the core's 400 / 409 with its errors. */
export function settingsAnswer(fn: () => unknown): SettingsAnswer {
  try { return [200, fn()]; }
  catch (e) {
    if (e instanceof SettingsRejected) return [e.status, { ok: false, errors: e.errors }];
    throw e;
  }
}
