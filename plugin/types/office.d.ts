// The team office's state contract (decision 186): the values the plugin keeps in $.state for a Claude Code
// session. Any plugin may read them, so they hold what the transcript already shows, masked, and what the router's
// helper reported; never the token (only the helper process reads it) and never a prompt's text.
export type OfficeRoleName = 'lead' | 'architect' | 'coder' | 'reviewer' | 'tester' | 'ui-designer' | 'helper'
export type OfficeStatusName = 'working' | 'done' | 'waiting' | 'failed'

export type OfficeMember = {
  id: string
  role: OfficeRoleName
  label: string
  model: string
  effort: string
  task: string
  status: OfficeStatusName
  startedAt: number
  endedAt?: number
  tag?: string
  real: boolean
}

export type OfficeLine = { kind: 'text' | 'tool' | 'result' | 'error'; text: string }

export type OfficeTab = 'office' | 'work' | 'savings' | 'team' | 'settings'
export type OfficePeriod = '24h' | '7d' | '30d'

/** What the daemon said last: `ok` with its view, or why there is none. */
export type OfficeDaemonState = { reach: 'ok' | 'down' | 'setup' | 'refused'; view: unknown }

/** A tab's data from the router's helper, as it came (`at`), or the reason there is none; Work keeps the open request. */
export type OfficeTabData = { at: number; data: unknown; error?: string; detail?: unknown; detailId?: string; period?: string }

/**
 * The Settings tab: the daemon's view (as OfficeTabData), the person's changes not yet applied (path to value;
 * null takes the own value away), whether the confirmation is up, and what the last apply answered.
 */
export type OfficeSettingsState = OfficeTabData & {
  pending: Record<string, string | number | boolean | null>
  confirm: boolean
  busy: boolean
  result: null | { ok: boolean; lines: string[] }
}

declare module 'claude-code' {
  interface PluginState {
    'do-it-all-claude-code': {
      agents: Shaped<OfficeMember[]>
      rows: Shaped<Record<string, OfficeLine[]>>
      selected: Shaped<string>
      tick: Shaped<number>
      tab: Shaped<OfficeTab>
      period: Shaped<OfficePeriod>
      daemon: Shaped<OfficeDaemonState>
      work: Shaped<OfficeTabData>
      savings: Shaped<OfficeTabData>
      team: Shaped<OfficeTabData>
      settings: Shaped<OfficeSettingsState>
    }
  }
}
