import type { Elements, RenderElement } from 'claude-code'

import {
  PERIODS, PERIOD_NAME, SLACK, appliedLines, bar, choices, clockTime, columns, confirmLine, cycle, dur, filesText, fit, holdoutText,
  levelText, modelName, pct, pendingSet, pointLabel, settingText, shownValue, spanName, spentLine, statBar, timelineCells, upDown,
  usd, workHeadline, workMark,
  type Glyphs, type LimitWindow, type OfficeSettings, type Period, type Savings, type SettingItem, type SettingValue, type Team, type WorkDetail, type WorkList,
  type WorkRow,
} from './model'
import type { OfficeDaemonState, OfficeSettingsState, OfficeTabData } from '../types/office'

// The tabs beside the Office (decision 193): Work, Savings, Team and Settings. Each one's first line answers one
// question; what follows is the detail. Measured and estimated figures stay apart on screen. The data comes from
// the router's helper (bridge.mjs) as the daemon answered it (docs/design/team-office.md, section 8).
//
// A view module: the hooks module (register.tsx) reads the state and hands each tab its data and the actions its
// buttons run (the engine reads a state value only through an atom written in the file that reads it). Everything
// is drawn within the frames' width (the body's less SLACK), with the marks the terminal draws one cell wide
// (Glyphs). No local takes the JSX factory's names (h, Fragment): the JSX in its scope would call it instead.

/** The pane's body as the engine gave it: `columns` across, `rows` the most it may take. */
export type Room = { columns: number; rows: number }
/** The elements every surface draws: what `$.ui.resolve(e)` gives a tab. */
export type Els = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button'>
type El = RenderElement
export type TabContext = {
  g: Glyphs
  room: Room
  dstate: OfficeDaemonState
  now: number
  /** Savings and Team: the period shown; `p` steps it. */
  period: Period
  act: {
    /** Work: open a request, and back to the list. */
    open: (id: string) => void
    back: () => void
    nextPeriod: () => void
    /** Settings: Enter on a row puts its next value in the pending changes. */
    cycle: (item: SettingItem) => void
    ask: () => void
    cancel: () => void
    discard: () => void
    /** Sends the changes through a one-time helper run; the answer lands in the settings state. */
    apply: (set: Record<string, SettingValue>, revision: OfficeSettings['revision']) => void
  }
}

export const widthOf = (room: Room): number => Math.max(20, room.columns - SLACK)

/** Why there is no data from the router, one line; '' when it answers. */
export function reachLine(d: OfficeDaemonState): string {
  if (d.reach === 'ok') return ''
  if (d.reach === 'refused') return 'the router refused the call — run do-it-all-claude-code doctor'
  if (d.reach === 'setup') return 'the router is not set up — run do-it-all-claude-code init'
  return 'router daemon not reachable — run do-it-all-claude-code start'
}

/** The top of a tab: the router's reach or the tab's own error, one line, or nothing. */
function noteOf(ctx: TabContext, st: OfficeTabData): string {
  return reachLine(ctx.dstate) || st.error || ''
}

/** Lines past `max` left out, the last kept line saying how many: the pane keeps to the rows it has. */
function within(lines: El[], max: number, more: (n: number) => El): El[] {
  if (lines.length <= max) return lines
  const keep = Math.max(0, max - 1)
  return [...lines.slice(0, keep), more(lines.length - keep)]
}

// ------------------------------------------------------------------ Work

export function workTab(els: Els, st: OfficeTabData, ctx: TabContext): El {
  if (st.detailId) return workDetail(els, ctx, st)
  const { Box, Text, Button } = els
  const { g, now } = ctx
  const width = widthOf(ctx.room)
  const w = st.data as WorkList | null
  const note = noteOf(ctx, st)
  const open = (id: string) => () => ctx.act.open(id)

  // a request a line: its mark and time, the level it ran at, the kind of work, what it changed; time and cost at the end
  const firstId = w?.open[0]?.requestId ?? w?.rows[0]?.requestId
  const row = (r: WorkRow): El => {
    const m = workMark(r, g)
    // the time today, the date before (five cells either way)
    const at = clockTime(r.state === 'closed' ? r.closedAt : r.createdAt, now).slice(0, 5)
    const lvl = levelText(r.level, r.finalLevel, g).padEnd(5)
    const kind = fit(r.kind ?? (r.outcome === 'direct' ? 'lead alone' : ''), 10).padEnd(10)
    const right = `${r.state === 'closed' ? dur(r.durationMs) : m.word}`.padStart(r.state === 'closed' ? 6 : 16) + ` ${usd(r.totalUsd)}${r.estimated ? '~' : ''}`.padStart(8)
    const head = ` ${at} ${lvl} ${kind} `
    const room = width - 1 - [...head].length - [...right].length - 1
    const what = room > 4 ? fit(filesText(r) || (r.subtasks ? `${r.subtasks} subtask${r.subtasks === 1 ? '' : 's'}` : ''), room).padEnd(room) : ''
    return (
      <Button key={`req-${r.requestId}`} plain {...(r.requestId === firstId ? { autoFocus: true as const } : {})} onPress={open(r.requestId)}>
        <Text color={m.color}>{m.mark}</Text>{head}<Text dimColor>{what}</Text>{' '}{right}
      </Button>
    )
  }

  const body: El[] = []
  if (w) {
    for (const r of w.open) body.push(row(r))
    if (w.open.length && w.rows.length) body.push(<Text key="recent" dimColor>Recent</Text>)
    for (const r of w.rows) body.push(row(r))
    if (!w.open.length && !w.rows.length) body.push(<Text key="none" dimColor wrap="truncate-end">No requests yet: the next prompt in a session the router sees starts one.</Text>)
  }
  const head = workHeadline(w) || (note ? '' : 'Loading…')
  const fixed = 1 + (note ? 1 : 0) + (head ? 1 : 0) + 1
  return (
    <Box key="work" flexDirection="column" width={width}>
      {note ? <Text key="note" color="warning" wrap="wrap">{note}</Text> : null}
      {head ? <Text key="head" bold wrap="wrap">{head}</Text> : null}
      {within(body, Math.max(1, ctx.room.rows - fixed), n => <Text key="more" dimColor>{`${n} more not shown`}</Text>)}
      <Text key="hint" dimColor wrap="truncate-end">{`${g.keys} and Enter open a request · o w s t c switch tabs`}</Text>
    </Box>
  )
}

function workDetail(els: Els, ctx: TabContext, st: OfficeTabData): El {
  const { Box, Text, Button } = els
  const { g, now } = ctx
  const width = widthOf(ctx.room)
  const d = (st.detail && typeof st.detail === 'object' && 'requestId' in (st.detail as object) ? st.detail : null) as WorkDetail | null
  const failed = st.detail && typeof st.detail === 'object' && 'error' in (st.detail as object) ? String((st.detail as { error: unknown }).error) : ''
  const back = (
    <Button key="back" hotkey="b" autoFocus onPress={() => ctx.act.back()}>Back</Button>
  )
  if (!d) {
    return (
      <Box key="work-detail" flexDirection="column" width={width}>
        {back}
        <Text key="wait" {...(failed ? { color: 'error' } : { dimColor: true })} wrap="truncate-end">{failed || reachLine(ctx.dstate) || 'Loading…'}</Text>
      </Box>
    )
  }
  const m = workMark({ state: d.state, passed: d.passed }, g)
  const lines: El[] = []
  // the answer: how it went, how long, what it cost
  lines.push(
    <Text key="head" wrap="wrap">
      <Text bold>{`${levelText(d.level.judged, d.level.final, g)}${d.kind ? ` ${d.kind}` : ''} `}</Text>
      <Text color={m.color}>{`${m.mark} ${m.word}`}</Text>
      {` · ${dur(d.time.durationMs)} · ${usd(d.cost.totalUsd)}${d.cost.estimated ? ' estimated' : ''}${d.cost.budgetExceeded ? ' (over budget)' : ''}`}
    </Text>,
  )
  const judged = `judged ${d.level.judged} by ${d.level.source}${d.level.rule ? ` ${d.level.rule}` : ''}${d.level.confidence !== null ? ` ${pct(d.level.confidence)}` : ''}`
  const changed = d.level.changes.map(c => `${c.from}${g.arrow}${c.to} (${c.why})`).join(', ')
  const plan = d.plan.leadDirect ? 'the lead alone' : `team ${d.plan.preset}`
  lines.push(<Text key="level" dimColor wrap="wrap">{[judged, changed, plan, d.plan.leadModel ? `lead ${modelName(d.plan.leadModel)}` : '', d.plan.holdout ? `holdout ${d.plan.holdout}` : ''].filter(Boolean).join(' · ')}</Text>)

  // the timeline: plan, workers, verify, review on one time axis
  if (d.timeline.length) {
    lines.push(<Text key="tl-title" bold>Timeline</Text>)
    const label = 12, tail = 8
    const barW = Math.max(6, width - label - tail)
    const cells = timelineCells(d.timeline, barW, now)
    d.timeline.forEach((s, i) => {
      const c = cells[i]!
      const color = s.ok === false ? 'error' : s.endedAt ? (s.kind === 'verify' ? 'success' : 'suggestion') : 'warning'
      const mark = s.ok === null ? (s.endedAt ? ' ' : g.status.working) : s.ok ? g.status.done : g.status.failed
      lines.push(
        <Text key={`tl-${i}`} wrap="truncate-end">
          {fit(spanName(s), label - 1).padEnd(label)}
          {' '.repeat(c.from)}<Text color={color}>{g.full.repeat(c.len)}</Text>{' '.repeat(Math.max(0, barW - c.from - c.len))}
          <Text dimColor>{dur(c.ms).padStart(tail - 2)}</Text>{` ${mark}`}
        </Text>,
      )
    })
  }

  // each worker: its step against what ran, how it ended, its tries and step changes, its checks, time and cost
  if (d.subtasks.length) {
    lines.push(<Text key="sub-title" bold>Workers</Text>)
    for (const s of d.subtasks) {
      const ran = s.ranModel && modelName(s.ranModel) !== modelName(s.model) ? ` (ran ${modelName(s.ranModel)})` : ''
      const moves = s.stepChanges.map(c => `${c.from}${g.arrow}${c.to} ${c.reason}`).join(', ')
      const tests = s.checks.filter(c => c.kind === 'test' && c.testsPassed !== undefined).at(-1)
      const checks = [...new Map(s.checks.map(c => [c.kind, c])).values()].map(c => `${c.kind} ${c.result}`).join(', ')
      const ok = s.status === 'passed' || s.verdict === 'pass' || s.verdict === 'accept'
      // a writer sharing the work tree: its build and tests wait for the last writer's verify (decision 192)
      const held = s.verdict === 'held'
      lines.push(
        <Text key={`sub-${s.id}`} wrap="wrap">
          <Text bold>{`${s.id} ${s.role} `}</Text>
          <Text dimColor>{`${s.step} ${modelName(s.model)} ${s.effort}${ran} · `}</Text>
          <Text {...(ok ? { color: 'success' } : held ? { color: 'warning' } : s.status === 'failed' ? { color: 'error' } : {})}>{held ? 'waiting for the shared work tree verify' : s.verdict ?? s.status}</Text>
          <Text dimColor>{[s.attempts > 1 ? ` · ${s.attempts} tries` : '', moves ? ` · ${moves}` : '', tests ? ` · ${tests.testsPassed} passed${tests.testsFailed ? `, ${tests.testsFailed} failed` : ''}` : checks ? ` · ${checks}` : '',
            ` · ${dur(s.time.runMs)} · ${usd(s.cost.usd)}${s.cost.state === 'estimate' ? '~' : ''}`].join('')}</Text>
        </Text>,
      )
    }
  }

  // what changed: the files with git's stat bar, then the tests
  if (d.changes || d.files.length) {
    const c = d.changes
    lines.push(<Text key="files-title" wrap="truncate-end"><Text bold>Files</Text><Text dimColor>{c ? `  ${c.changedFiles} changed +${c.linesAdded} -${c.linesRemoved}${c.newFiles ? ` · ${c.newFiles} new` : ''}${c.deletedFiles ? ` · ${c.deletedFiles} deleted` : ''}${c.approximate ? ' (approximate)' : ''}` : ''}</Text></Text>)
    const most = Math.max(1, ...d.files.map(f => f.added + f.removed))
    const nameW = Math.max(8, Math.min(40, width - 24))
    for (const f of d.files.slice(0, 8)) {
      const sb = statBar(f.added, f.removed, 12, most)
      lines.push(
        <Text key={`file-${f.path}`} wrap="truncate-end">
          {`  ${fit(f.path, nameW).padEnd(nameW)} `}<Text color="success">{sb.plus}</Text><Text color="error">{sb.minus}</Text>
          <Text dimColor>{` +${f.added} -${f.removed}${f.state !== 'changed' ? ` ${f.state}` : ''}`}</Text>
        </Text>,
      )
    }
    if (d.files.length > 8) lines.push(<Text key="files-more" dimColor>{`  ${d.files.length - 8} more`}</Text>)
  }
  if (d.tests) lines.push(<Text key="tests" wrap="truncate-end"><Text bold>Tests</Text>{`  ${d.tests.passed} passed`}<Text color="error">{d.tests.failed ? `, ${d.tests.failed} failed` : ''}</Text></Text>)
  const ups = d.stepChanges.filter(c => c.direction === 'up').length, downs = d.stepChanges.length - ups
  if (ups || downs) lines.push(<Text key="steps" wrap="wrap"><Text bold>Steps</Text>{`  ${upDown(ups, downs, g)}: `}<Text dimColor>{d.stepChanges.map(c => `${c.role} ${c.from}${g.arrow}${c.to} (${c.reason})`).join(', ')}</Text></Text>)
  lines.push(<Text key="time" wrap="wrap"><Text bold>Time</Text><Text dimColor>{`  ${d.time.phases.map(p => `${p.phase === 'awaiting_user' ? 'waiting for you' : p.phase} ${dur(p.ms)}`).join(' · ')}`}</Text></Text>)
  lines.push(<Text key="cost" wrap="wrap"><Text bold>Cost</Text><Text dimColor>{`  lead ${usd(d.cost.leadUsd)} + workers ${usd(d.cost.workerUsd)} of a ${usd(d.cost.budgetUsd)} budget${d.cost.estimated ? ' · estimated' : ''}${d.cost.unknown ? ' · some costs unknown' : ''}`}</Text></Text>)
  if (d.hasPrompt) lines.push(<Text key="prompt" dimColor wrap="truncate-end">The prompt is kept in the request record (recordPrompts); the office does not show it.</Text>)
  return (
    <Box key="work-detail" flexDirection="column" width={width}>
      {back}
      {lines}
    </Box>
  )
}

// ------------------------------------------------------------------ the period, for Savings and Team

function periodRow(els: Els, ctx: TabContext): El {
  const { Text, Button } = els
  const p = ctx.period
  return (
    <Button key="period" plain hotkey="p" autoFocus onPress={() => ctx.act.nextPeriod()}>
      {PERIODS.map(id => (id === p ? <Text key={`p-${id}`} bold underline>{PERIOD_NAME[id]}</Text> : <Text key={`p-${id}`} dimColor>{PERIOD_NAME[id]}</Text>)).flatMap((t, i) => (i ? ['  ', t] : [t]))}
    </Button>
  )
}

// ------------------------------------------------------------------ Savings

export function savingsTab(els: Els, st: OfficeTabData, ctx: TabContext): El {
  const { Box, Text } = els
  const { g, now } = ctx
  const width = widthOf(ctx.room)
  const p = ctx.period
  const s = (st.data && (st.data as Savings).period === p ? st.data : null) as Savings | null
  const note = noteOf(ctx, st)
  const lines: El[] = []
  if (s) {
    const m = s.measured
    // measured: what was spent, and the limits as the status line reported them
    lines.push(<Text key="m-title" bold>Measured</Text>)
    const limit = (key: string, name: string, l: LimitWindow | null) => {
      if (!l) return null
      const barW = Math.max(6, Math.min(30, width - 34))
      const color = l.usedPercentage >= 90 ? 'error' : l.usedPercentage >= 70 ? 'warning' : 'success'
      return (
        <Text key={key} wrap="truncate-end">
          {`  ${name.padEnd(13)} `}<Text color={color}>{bar(l.usedPercentage, 100, barW, g)}</Text>
          {` ${String(Math.round(l.usedPercentage)).padStart(3)}%`}<Text dimColor>{l.resetsAt ? `  resets ${clockTime(l.resetsAt, now)}` : ''}</Text>
        </Text>
      )
    }
    const five = limit('lim-5h', '5-hour limit', m.limits?.fiveHour ?? null)
    const seven = limit('lim-7d', '7-day limit', m.limits?.sevenDay ?? null)
    if (five) lines.push(five)
    if (seven) lines.push(seven)
    if (!five && !seven) lines.push(<Text key="lim-none" dimColor wrap="truncate-end">  No limits reported yet (the status line reports them on a subscription)</Text>)
    const c = m.cost
    lines.push(<Text key="m-cost" dimColor wrap="wrap">{`  lead ${usd(c.leadUsd)} · workers ${usd(c.workerUsd)}${c.costPerPassedUsd !== null ? ` · ${usd(c.costPerPassedUsd)} a passed request` : ''}${c.flags.estimated ? ` · ${c.flags.estimated} estimated` : ''}${c.flags.unknown ? ` · ${c.flags.unknown} unknown` : ''}`}</Text>)
    // the bars: what was spent per hour or day
    const pts = s.series.points
    if (pts.length) {
      const avail = width - 2
      const gap = Math.floor((avail + 1) / pts.length) >= 3 ? 1 : 0
      const colW = Math.max(1, Math.floor((avail + gap) / pts.length) - gap)
      const shown = pts.slice(-Math.max(1, Math.floor((avail + gap) / (colW + gap))))
      const top = shown.reduce((a, x) => (x.totalUsd > a.totalUsd ? x : a), shown[0]!)
      lines.push(<Text key="chart-title" dimColor wrap="truncate-end">{`  spent per ${s.series.unit} · most ${usd(top.totalUsd)} (${pointLabel(top.start, s.series.unit)})`}</Text>)
      const tall = ctx.room.rows >= 30 ? 4 : 3
      columns(shown.map(x => x.totalUsd), tall, colW, gap, g).forEach((r, i) => lines.push(<Text key={`chart-${i}`} color="suggestion">{`  ${r}`}</Text>))
      const first = pointLabel(shown[0]!.start, s.series.unit), last = pointLabel(shown.at(-1)!.start, s.series.unit)
      const span = shown.length * colW + (shown.length - 1) * gap
      lines.push(<Text key="chart-axis" dimColor>{`  ${first}${' '.repeat(Math.max(1, span - first.length - last.length))}${span > first.length + last.length ? last : ''}`}</Text>)
    }
    // estimated: the two comparisons, never added into one figure
    const lp = s.estimated.leadPriced
    lines.push(<Text key="e-title" wrap="truncate-end"><Text bold>Estimated</Text><Text dimColor> (not measured)</Text></Text>)
    lines.push(
      <Text key="e-lead" wrap="wrap">
        {'  The workers\' tokens at the lead model\'s price: '}<Text bold>{usd(lp.atLeadPriceUsd)}</Text>{` instead of ${usd(lp.workerUsd)}`}
        <Text {...(lp.differenceUsd > 0 ? { color: 'success' } : {})}>{` (${usd(Math.abs(lp.differenceUsd))} ${lp.differenceUsd >= 0 ? 'less' : 'more'})`}</Text><Text dimColor>{` · ${lp.requests} request${lp.requests === 1 ? '' : 's'}`}</Text>
      </Text>,
    )
    lp.assumptions.forEach((a, i) => lines.push(<Text key={`e-as-${i}`} dimColor wrap="wrap">{`    · ${a}`}</Text>))
    const left = lp.leftOut.noLeadModel + lp.leftOut.noPrice + lp.leftOut.noTokens
    if (left) lines.push(<Text key="e-left" dimColor wrap="wrap">{`    · left out: ${[lp.leftOut.noLeadModel ? `${lp.leftOut.noLeadModel} without a lead model` : '', lp.leftOut.noPrice ? `${lp.leftOut.noPrice} without a price` : '', lp.leftOut.noTokens ? `${lp.leftOut.noTokens} without tokens` : ''].filter(Boolean).join(', ')}`}</Text>)
    lines.push(<Text key="h-title" wrap="wrap">{'  Holdout: requests the lead did alone, against the teams'}<Text dimColor>{` · ${pct(s.estimated.holdoutRate)} held out · auto-release ${s.estimated.holdoutMode}`}</Text></Text>)
    if (!s.estimated.holdout.length) lines.push(<Text key="h-none" dimColor wrap="truncate-end">    none yet</Text>)
    for (const arm of s.estimated.holdout) {
      const said = holdoutText(arm)
      lines.push(<Text key={`h-${arm.leadClass}-${arm.level}`} wrap="wrap">{`    ${said.head} · `}<Text dimColor={!said.enough}>{said.tail}</Text></Text>)
    }
  }
  const head = s ? spentLine(s.measured) : note ? '' : 'Loading…'
  return (
    <Box key="savings" flexDirection="column" width={width}>
      {note ? <Text key="note" color="warning" wrap="wrap">{note}</Text> : null}
      {head ? <Text key="head" bold wrap="wrap">{head}</Text> : null}
      {periodRow(els, ctx)}
      {lines}
    </Box>
  )
}

// ------------------------------------------------------------------ Team

export function teamTab(els: Els, st: OfficeTabData, ctx: TabContext): El {
  const { Box, Text } = els
  const { g, now } = ctx
  const width = widthOf(ctx.room)
  const p = ctx.period
  const t = (st.data && (st.data as Team).period === p ? st.data : null) as Team | null
  const note = noteOf(ctx, st)
  const lines: El[] = []
  let head = note ? '' : 'Loading…'
  if (t) {
    const subtasks = t.roles.reduce((n, r) => n + r.stats.subtasks, 0)
    const passed = t.roles.reduce((n, r) => n + r.stats.passed, 0)
    const ups = t.roles.reduce((n, r) => n + r.stats.stepUps, 0), downs = t.roles.reduce((n, r) => n + r.stats.stepDowns, 0)
    head = [`Profile ${t.profile.value}`, `${t.roles.length} role${t.roles.length === 1 ? '' : 's'}`, subtasks ? `${pct(passed / subtasks)} of ${subtasks} passed` : 'no subtasks yet', upDown(ups, downs, g)].filter(Boolean).join(' · ')
    if (t.delegateFrom) lines.push(<Text key="from" dimColor wrap="wrap">{`Teams from ${t.delegateFrom.value}${t.leadClass ? ` (${modelName(t.leadClass)} lead)` : ''}${t.delegateFrom.source !== 'default' ? `, ${t.delegateFrom.source}` : ''}`}</Text>)
    const nameW = Math.max(9, ...t.roles.map(r => r.role.length + 1))
    const barW = Math.max(4, Math.min(16, width - nameW - 36))
    for (const r of t.roles) {
      const s = r.stats
      const color = s.passRate === null ? 'inactive' : s.passRate >= 0.9 ? 'success' : s.passRate >= 0.7 ? 'warning' : 'error'
      lines.push(
        <Text key={`role-${r.role}`} wrap="truncate-end">
          <Text bold>{r.role.padEnd(nameW)}</Text>
          {s.subtasks
            ? [
                <Text key="bar" color={color}>{bar(s.passRate ?? 0, 1, barW, g)}</Text>,
                ` ${pct(s.passRate).padStart(4)} of ${s.subtasks}`,
                <Text key="more" dimColor>{` · ${usd(s.avgCostUsd)} · ${dur(s.avgRunMs)}${s.stepUps || s.stepDowns ? ` · ${upDown(s.stepUps, s.stepDowns, g)}` : ''}`}</Text>,
              ]
            : <Text dimColor>no subtasks in this period</Text>}
        </Text>,
      )
      lines.push(
        <Text key={`role-${r.role}-levels`} dimColor wrap="truncate-end">
          {`  ${r.levels.map(l => `${l.level} ${l.count > 1 ? `${l.count}x ` : ''}${l.step} ${modelName(l.model)} ${l.effort}${l.source !== 'default' ? ` (${l.source})` : ''}`).join(' · ')}`}
        </Text>,
      )
    }
    if (!t.roles.length) lines.push(<Text key="roles-none" dimColor>No team has run in this period.</Text>)
    // the latest step changes, newest first, as many as the room holds
    if (t.stepChanges.length) {
      lines.push(<Text key="sc-title" bold>Step changes</Text>)
      const room = Math.max(1, ctx.room.rows - 1 - 2 - lines.length - 4)
      for (const c of t.stepChanges.slice(0, room)) {
        lines.push(<Text key={`sc-${c.at}-${c.subtaskId ?? c.slot}`} wrap="truncate-end">{`  ${clockTime(c.at, now)} ${c.role}${c.subtaskId ? ` ${c.subtaskId}` : ''} `}<Text color={c.direction === 'up' ? 'warning' : 'success'}>{`${c.from}${g.arrow}${c.to}`}</Text><Text dimColor>{` ${c.reason}${c.detail ? ` (${c.detail.replace(/_/g, ' ')})` : ''}`}</Text></Text>)
      }
    }
    // how well the triage judged, at the bottom
    const o = t.triage?.overall
    if (o && o.total) {
      const share = (n: number) => pct(n / o.total)
      lines.push(<Text key="triage" wrap="wrap"><Text bold>Triage</Text>{` ${o.total} requests: level held ${share(o.levelHeld)} · team fit ${share(o.teamFit)} · start step ${share(o.startStepFit)}`}</Text>)
      for (const x of (t.triage?.byRule ?? []).filter(x => x.suggestLevelUp || x.suggestStepUp)) {
        lines.push(<Text key={`rule-${x.rule}`} color="warning" wrap="wrap">{`  rule ${x.rule}: ${x.suggestLevelUp ? 'its level may be too low' : 'its start step may be too low'} (${x.count} requests)`}</Text>)
      }
    }
  }
  return (
    <Box key="team" flexDirection="column" width={width}>
      {note ? <Text key="note" color="warning" wrap="wrap">{note}</Text> : null}
      {head ? <Text key="head" bold wrap="wrap">{head}</Text> : null}
      {periodRow(els, ctx)}
      {lines}
    </Box>
  )
}

// ------------------------------------------------------------------ Settings

const GROUP_NAME: Record<string, string> = { profile: 'Profile', team: 'Team', budget: 'Budget', quality: 'Quality', office: 'Office', privacy: 'Privacy', advanced: 'Advanced' }

export function settingsTab(els: Els, st: OfficeSettingsState, ctx: TabContext): El {
  const { Box, Text, Button } = els
  const { g } = ctx
  const width = widthOf(ctx.room)
  const v = st.data as OfficeSettings | null
  const note = noteOf(ctx, st)
  const pending = st.pending ?? {}
  if (!v) {
    return (
      <Box key="settings" flexDirection="column" width={width}>
        {note ? <Text key="note" color="warning" wrap="wrap">{note}</Text> : <Text key="head" dimColor>Loading…</Text>}
      </Box>
    )
  }
  const set = pendingSet(v.items, pending)
  const changes = Object.keys(set).length
  const own = v.items.filter(i => i.source === 'own').length
  // the title as long as the row leaves room for a value and where it comes from (about 24 columns)
  const titleW = Math.min(Math.max(14, width - 26), Math.max(12, ...v.items.map(i => [...i.title].length + 1)))

  const press = (item: SettingItem) => () => ctx.act.cycle(item)
  // a setting a line: its title, the value in effect (or the change waiting, old → new) and where it comes from
  const row = (item: SettingItem, first: boolean): El => {
    const shown = shownValue(item, pending)
    const changed = Object.hasOwn(set, item.path)
    const from = changed ? (set[item.path] === null ? (item.profileValue !== undefined ? 'profile' : 'default') : 'own') : item.sourceNote ?? item.source
    const value = changed ? `${settingText(item, item.value)} ${g.arrow} ${settingText(item, shown)}` : settingText(item, shown)
    const count = choices(item).length
    const text = `${fit(item.title, titleW - 1).padEnd(titleW)}`
    if (!item.editable) {
      return <Text key={`set-${item.path}`} dimColor wrap="truncate-end">{`  ${text}${value}  ${item.why ?? 'not changeable here'}`}</Text>
    }
    return (
      <Button key={`set-${item.path}`} plain {...(first ? { autoFocus: true as const } : {})} onPress={press(item)}>
        {'  '}{text}<Text bold {...(changed ? { color: 'warning' } : {})}>{value}</Text>
        <Text dimColor>{`  ${from}${item.appliesAt !== 'now' && item.appliesAt !== 'next request' ? ` · ${item.appliesAt}` : ''}${count > 8 ? ` · ${count} steps` : ''}`}</Text>
      </Button>
    )
  }

  const lines: El[] = []
  // the profile first, with what the chosen one rests on
  const profileItem = v.items.find(i => i.path === 'profile')
  const shownProfile = String(profileItem ? shownValue(profileItem, pending) : v.profile.value)
  const option = v.profile.options.find(o => o.id === shownProfile)
  let first = true
  const groups = [...new Set(v.items.map(i => i.group))].sort((a, b) => Object.keys(GROUP_NAME).indexOf(a) - Object.keys(GROUP_NAME).indexOf(b))
  for (const grp of groups) {
    lines.push(<Text key={`grp-${grp}`} bold>{GROUP_NAME[grp] ?? grp}</Text>)
    if (grp === 'team') {
      for (const lv of v.team) {
        lines.push(<Text key={`team-${lv.level}`} dimColor wrap="truncate-end">{`  ${lv.level} ${usd(lv.budgetUsd)} · ${lv.leadDirect ? 'the lead alone' : lv.roles.map(r => `${r.role} ${r.count} ${r.step}`).join(' · ')}`}</Text>)
      }
    }
    for (const item of v.items.filter(i => i.group === grp)) {
      lines.push(row(item, first && item.editable))
      if (item.editable) first = false
      if (item.path === 'profile' && option) {
        lines.push(<Text key="profile-about" dimColor wrap="wrap">{`    ${option.summary} · ${option.measured ?? 'not measured yet'}`}</Text>)
      }
    }
  }
  if (v.text.length) {
    lines.push(<Text key="text-title" bold>Shown here, changed with a command</Text>)
    for (const x of v.text) {
      lines.push(<Text key={`text-${x.key}`} wrap="wrap">{`  ${x.title}: `}<Text dimColor>{x.value}</Text></Text>)
      lines.push(<Text key={`text-${x.key}-cmd`} dimColor wrap="wrap">{`    ${x.command}`}</Text>)
    }
  }
  if (v.project) {
    const wt = v.project.worktree === 'on' ? 'a work tree each' : v.project.worktree === 'off' ? 'one shared folder' : 'not asked yet'
    lines.push(<Text key="project" wrap="truncate-end"><Text bold>Project</Text>{` ${v.project.name}: parallel writers get ${wt}`}</Text>)
  }
  if (v.managed.length) lines.push(<Text key="managed" dimColor wrap="truncate-end">{`Set by init or mode: ${v.managed.map(m => m.key).join(', ')}`}</Text>)

  // the change bar under the first line: what waits, the question before it is written, what the write answered
  // The engine keeps the focus ring at a position among the buttons, not on a key: the bar always holds two, so a
  // change that brings the question (or takes it away) never moves the ring off the row the person is on.
  const bar2: El[] = []
  const asking = st.confirm && changes > 0 && !st.busy
  if (asking) bar2.push(<Text key="confirm" color="warning" wrap="wrap">{confirmLine(v.items, set)}</Text>)
  bar2.push(
    <Box key="changes" flexDirection="row">
      {asking
        ? [
            <Button key="apply-yes" hotkey="y" variant="primary" onPress={() => ctx.act.apply(set, v.revision)}>Apply</Button>,
            <Button key="apply-no" hotkey="n" onPress={() => ctx.act.cancel()}>Not now</Button>,
          ]
        : [
            <Text key="waiting" {...(changes && !st.busy ? { color: 'warning' } : { dimColor: true })}>{st.busy ? 'Applying… ' : changes ? `${changes} change${changes === 1 ? '' : 's'} waiting ` : 'No change waiting '}</Text>,
            <Button key="apply" hotkey="a" dimColor={!changes || st.busy} onPress={() => { if (changes && !st.busy) ctx.act.ask() }}>Apply</Button>,
            <Button key="discard" hotkey="x" dimColor={!changes || st.busy} onPress={() => { if (changes && !st.busy) ctx.act.discard() }}>Discard</Button>,
          ]}
    </Box>,
  )
  if (st.result) st.result.lines.forEach((l, i) => bar2.push(<Text key={`result-${i}`} color={st.result!.ok ? 'success' : 'error'} wrap="wrap">{l}</Text>))
  const problems = v.problems.map((x, i) => <Text key={`problem-${i}`} color="warning" wrap="wrap">{`${x.path}: ${x.message}`}</Text>)
  const head = [`Profile ${v.profile.value}${v.profile.source === 'default' ? ' (default)' : ''}`, `${own} own setting${own === 1 ? '' : 's'}`, v.problems.length ? `${v.problems.length} problem${v.problems.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
  return (
    <Box key="settings" flexDirection="column" width={width}>
      {note ? <Text key="note" color="warning" wrap="wrap">{note}</Text> : null}
      <Text key="head" bold wrap="wrap">{head}</Text>
      {problems}
      {bar2}
      <Text key="hint" dimColor wrap="truncate-end">{`${g.keys} move · Enter changes a value · a applies the changes`}</Text>
      {lines}
    </Box>
  )
}

/** The settings state after Enter on a row: its next value pending, or none when that is the value in effect. */
export function withCycled(x: OfficeSettingsState, item: SettingItem): OfficeSettingsState {
  const next = cycle(item, shownValue(item, x.pending ?? {}))
  const rest = { ...(x.pending ?? {}) }
  if (next === item.value) delete rest[item.path]; else rest[item.path] = next
  return { ...x, pending: rest, confirm: false, result: null }
}

/** The settings state after an apply's answer: its lines, and the changes kept when nothing was written. */
export function afterApply(x: OfficeSettingsState, status: number | undefined, body: unknown, error?: string): OfficeSettingsState {
  const r = appliedLines(status, body, error)
  return { ...x, busy: false, confirm: false, result: r, pending: r.ok ? {} : x.pending }
}

