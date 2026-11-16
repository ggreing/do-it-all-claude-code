// Settings editing client (decision 168). Talks to the daemon's /dashboard/settings routes, which run on the
// same validated core as the CLI. Reads are GET; writes are POST with the per-session CSRF token (kept in
// memory only, never localStorage) and `credentials: 'same-origin'`. A refused write saves nothing; the
// daemon answers 400/409 with a per-field error list the UI shows inline.
//
// Mock is strictly opt-in and dev-only: `import.meta.env.DEV && VITE_USE_MOCK === 'true'`. A production build
// (DEV false) folds USE_MOCK to a constant false, so the dynamic import of ./settings-mock is unreachable and
// dropped — the sample store never reaches dist. Run the mock with `VITE_USE_MOCK=true npm run dev`.
import { ApiError } from './api';

const USE_MOCK = import.meta.env.DEV && import.meta.env.VITE_USE_MOCK === 'true';
const TIMEOUT = 5000;

// ---- shapes (fixed by the daemon's API) ----
export type ConfigType = 'boolean' | 'number' | 'integer' | 'enum' | 'levels' | 'byLeadClass';
export interface ConfigKey {
  key: string; type: ConfigType; value: unknown; default: unknown; set?: boolean;
  min?: number; max?: number; minExclusive?: boolean; options?: string[];
  appliesAt?: 'now' | 'next start'; advanced?: boolean; deprecated?: boolean; description?: string;
}
export interface ManagedKey { key: string; reason: string }
export interface ConfigDoc { revision: string; keys: ConfigKey[]; managed: ManagedKey[] }

export interface PresetRole { role: string; count: number; start: string }
export interface PresetLevel { roles: PresetRole[]; leadMayAdjust?: boolean; leadDirect?: boolean; budgetUsd?: number }
export interface PresetSchema { levels: string[]; roles: string[]; steps: string[]; countMin: number; countMax: number }
export interface PresetDoc {
  revision: string; text: string; effective: Record<string, PresetLevel>; schema: PresetSchema;
  /** Set when the saved teams.yaml fails to parse; the defaults in `effective` apply until it is fixed. */
  error?: string;
}

export interface RoleField {
  value: unknown; locked?: boolean; editable?: boolean; reason?: string; rule?: string;
  options?: string[]; min?: number; max?: number; runsAsYou?: boolean; note?: string;
}
export interface RoleItem {
  role: string; revision: string; overridden: boolean; overriddenFields: string[];
  text: string; template: string; fields: Record<string, RoleField>;
}
export interface RolesDoc { editable: boolean; items: RoleItem[] }

// M4: the CSRF token is handed out only once, in the POST /dashboard/auth answer (the one-time-code
// exchange), never on a GET. The settings read may omit it; the page keeps the auth-answer token in memory
// and does not take one from here, so a reloaded page with only the cookie cannot write (Save is disabled).
export interface SettingsDoc { csrf?: string; config: ConfigDoc; presets: PresetDoc; roles: RolesDoc }

export interface HistoryChange { path: string; from?: unknown; to?: unknown; changed?: boolean }
export interface HistoryEntry {
  at: string; source: 'dashboard' | 'cli' | 'cli-direct'; kind: 'config' | 'presets' | 'role';
  target?: string; changes: HistoryChange[];
}
export interface HistoryDoc { entries: HistoryEntry[] }

export interface WriteOk { ok: true; changed: string[]; nextStart?: string[]; notes?: string[] }
export interface FieldError { path: string; message: string }
export type RoleWrite =
  | { role: string; text: string; revision?: string }
  | { role: string; fields: Record<string, unknown>; revision?: string }
  | { role: string; reset: true };

/** A refused write (400 or 409). `errors` is the daemon's per-field list; the UI shows each inline. */
export class SettingsError extends Error {
  readonly status: number;
  readonly errors: FieldError[];
  constructor(status: number, errors: FieldError[]) {
    super(errors[0]?.message ?? `settings write refused (${status})`);
    this.status = status;
    this.errors = errors;
  }
}

// ---- CSRF (in memory only) ----
// Set once from the POST /dashboard/auth answer (auth.ts). After a reload with only the session cookie it is
// null: reads still work, but writes are disabled in the UI (M4 — the cookie is not scoped by port, so the
// token, not the cookie, is what authorises a write).
let csrf: string | null = null;
export function setCsrf(token: string | null): void { csrf = token; }
export function getCsrf(): string | null { return csrf; }

async function getJSON<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(path, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' }, signal: controller.signal });
    if (res.status === 401) throw new ApiError('unauthorized');
    if (!res.ok) throw new ApiError('http_error', `HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiError('timeout');
    throw new ApiError('daemon_off');
  } finally { clearTimeout(timer); }
}

async function postJSON(path: string, body: unknown): Promise<WriteOk> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (res.status === 401) throw new ApiError('unauthorized');
    let payload: unknown = null;
    try { payload = await res.json(); } catch { /* some error statuses may carry no body */ }
    if (res.ok) return (payload as WriteOk) ?? { ok: true, changed: [] };
    if (res.status === 400 || res.status === 409) {
      const errs = (payload as { errors?: FieldError[] } | null)?.errors;
      throw new SettingsError(res.status, Array.isArray(errs) && errs.length ? errs : [{ path: '', message: `HTTP ${res.status}` }]);
    }
    if (res.status === 403) throw new SettingsError(403, [{ path: '', message: 'forbidden' }]);
    throw new ApiError('http_error', `HTTP ${res.status}`);
  } catch (e) {
    if (e instanceof ApiError || e instanceof SettingsError) throw e;
    if (e instanceof DOMException && e.name === 'AbortError') throw new ApiError('timeout');
    throw new ApiError('daemon_off');
  } finally { clearTimeout(timer); }
}

export const settingsApi = {
  async read(): Promise<SettingsDoc> {
    if (USE_MOCK) {
      const doc = await (await import('./settings-mock')).mockRead();
      // dev only: the mock has no auth exchange, so it seeds the in-memory token here
      if (typeof doc.csrf === 'string') csrf = doc.csrf;
      return doc;
    }
    // live: the token comes only from the auth answer (M4); never taken from this GET
    return getJSON<SettingsDoc>('/dashboard/settings');
  },
  history(limit = 50): Promise<HistoryDoc> {
    if (USE_MOCK) return import('./settings-mock').then(m => m.mockHistory());
    return getJSON<HistoryDoc>(`/dashboard/settings/history?limit=${encodeURIComponent(limit)}`);
  },
  writeConfig(set: Record<string, unknown>, revision?: string): Promise<WriteOk> {
    if (USE_MOCK) return import('./settings-mock').then(m => m.mockWrite('config', { set, revision }));
    return postJSON('/dashboard/settings/config', { set, ...(revision ? { revision } : {}) });
  },
  writePresets(text: string, revision?: string): Promise<WriteOk> {
    if (USE_MOCK) return import('./settings-mock').then(m => m.mockWrite('presets', { text, revision }));
    return postJSON('/dashboard/settings/presets', { text, ...(revision ? { revision } : {}) });
  },
  writeRole(w: RoleWrite): Promise<WriteOk> {
    if (USE_MOCK) return import('./settings-mock').then(m => m.mockWrite('role', w as unknown as Record<string, unknown>));
    return postJSON('/dashboard/settings/role', w);
  },
};
