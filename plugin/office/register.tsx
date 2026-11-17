import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import {
  CLASSIC_GLYPHS, DAEMON_DOWN, GLYPHS, LEAD, OFFICE_MIN_CLAUDE, ROLE_NAME, SLACK, callRow, checksLine, compileSecrets, elapsed, fit,
  fromAgentStatus, homeCandidates, joinPath, labelFor, modelName, officeLayout, officeSwitch, oneLine, parseHelperLine, requestLine,
  resultRow, roleOf, statusWord, stepLine, subtaskOf, tagOf, takeLines, textRow, unicodeTerminal, usd, versionAtLeast, wantedRoom, withRow,
  type DaemonOffice, type Glyphs, type OfficeAgent, type OfficeRole, type OfficeRow, type OfficeStatus,
} from './model'
import type { OfficeDaemonState, OfficeTab, OfficeTabData } from '../types/office'

// The team office (decision 186, docs/design/team-office.md): the request's team drawn as members at desks across
// the top of a pane, and below them the session of the one you pick, line by line, the way Claude Code draws its
// own. Tabs: Office, History, Cost, Routing. No input line (decision 185).
//
// What only the router knows (level, steps, verify results, cost) comes from a helper process, office/bridge.mjs,
// started while the pane is open: it makes the sealed calls to the daemon itself (it reads the token; this module
// never does) and writes JSON lines, which the module reads into $.state. Without it the office still draws from
// Claude Code's own events.

const PANE = 'office'
const TITLE = 'Team office'

const agents = atom({ plugin: 'do-it-all-claude-code', key: 'agents' } as const, [], { shape: 'agents-1' })
const rows = atom({ plugin: 'do-it-all-claude-code', key: 'rows' } as const, {}, { shape: 'rows-1' })
const selected = atom({ plugin: 'do-it-all-claude-code', key: 'selected' } as const, '', { shape: 'selected-1' })
const tick = atom({ plugin: 'do-it-all-claude-code', key: 'tick' } as const, 0, { shape: 'tick-1' })
const tab = atom({ plugin: 'do-it-all-claude-code', key: 'tab' } as const, 'office', { shape: 'tab-1' })
const daemon = atom({ plugin: 'do-it-all-claude-code', key: 'daemon' } as const, { reach: 'down', view: null }, { shape: 'daemon-1' })
const history = atom({ plugin: 'do-it-all-claude-code', key: 'history' } as const, { at: 0, data: null }, { shape: 'history-1' })
const cost = atom({ plugin: 'do-it-all-claude-code', key: 'cost' } as const, { at: 0, data: null, period: '7d' }, { shape: 'cost-1' })
const routing = atom({ plugin: 'do-it-all-claude-code', key: 'routing' } as const, { at: 0, data: null }, { shape: 'routing-1' })

type Engine = EngineInterface

// theme keys, so the colors follow the person's light or dark theme
const ROLE_COLOR: Record<OfficeRole, string> = {
  lead: 'claude', architect: 'suggestion', coder: 'planMode', reviewer: 'warning', tester: 'success', 'ui-designer': 'merged', helper: 'inactive',
}
const STATUS_COLOR: Record<OfficeStatus, string> = { working: 'warning', done: 'success', waiting: 'inactive', failed: 'error' }

// ------------------------------------------------------------------ what this module keeps (never in $.state)

/** The office is on: a new enough Claude Code, and config.json does not say `office: off`. */
let enabled = true
/** Why it is off, for /office. */
let offReason = ''
let started: Promise<void> | null = null
let root = ''
let secrets: RegExp[] = []
let sessionId = ''
let paneOpen = false
/** The person closed the pane: it does not open itself again until the next prompt. */
let closedByPerson = false
let lastDaemon = ''
let demoAt = -1
let helper: { key: string; stop(): void } | null = null
/** The classic Windows console (no terminal that says which it is): the list with one-cell marks, no scene. */
let classic = false
const glyphs = (): Glyphs => (classic ? CLASSIC_GLYPHS : GLYPHS)

function start($: Engine): Promise<void> {
  started ??= (async () => {
    // each step on its own: a noun this build or host lacks leaves its default, and only a known, older
    // Claude Code turns the office off
    let version: string | undefined
    try { version = (await $.session.version()).version } catch { version = undefined }
    if (version !== undefined && !versionAtLeast(version, OFFICE_MIN_CLAUDE)) {
      enabled = false
      offReason = `The team office needs Claude Code ${OFFICE_MIN_CLAUDE.join('.')} or newer (this is ${version}).`
      return
    }
    try { root = $.plugin.root } catch { root = '' }
    const env = async (read: () => Promise<string | undefined>) => { try { return await read() } catch { return undefined } }
    const userHome = (await env(() => $.env.get('USERPROFILE'))) ?? (await env(() => $.env.get('HOME')))
    // the terminal, decided as Claude Code decides it for its own figures (model.ts: unicodeTerminal)
    classic = !unicodeTerminal({
      OS: await env(() => $.env.get('OS')),
      WT_SESSION: await env(() => $.env.get('WT_SESSION')),
      TERMINUS_SUBLIME: await env(() => $.env.get('TERMINUS_SUBLIME')),
      ConEmuTask: await env(() => $.env.get('ConEmuTask')),
      TERM_PROGRAM: await env(() => $.env.get('TERM_PROGRAM')),
      TERM: await env(() => $.env.get('TERM')),
      TERMINAL_EMULATOR: await env(() => $.env.get('TERMINAL_EMULATOR')),
    })
    const envHome = await env(() => $.env.get('DO_IT_ALL_CLAUDE_CODE_HOME'))
    for (const home of homeCandidates({ pluginRoot: root, envHome, userHome })) {
      let text: string | undefined
      try { text = String(await $.fs.read(joinPath(home, 'config.json'))) } catch { continue }
      if (officeSwitch(text) === 'off') {
        enabled = false
        offReason = 'The team office is off (config.json has office: off). Turn it on: do-it-all-claude-code config set office on, then start a new session.'
      }
      break
    }
    try { secrets = compileSecrets(JSON.parse(String(await $.fs.read(joinPath(joinPath(root, 'hooks'), 'secret-patterns.json'))))) } catch { secrets = [] }
    sessionId = await $.session.id().catch(() => '')
  })().catch(() => { enabled = false; offReason = 'The team office could not start.' })
  return started
}

// ------------------------------------------------------------------ the helper process

function stopHelper(): void {
  const running = helper
  helper = null
  running?.stop()
}

/** Reads one helper line into $.state. */
async function onLine($: Engine, text: string): Promise<void> {
  const m = parseHelperLine(text)
  if (!m) return
  const now = Date.now()
  if (m.type === 'office') {
    const next: OfficeDaemonState = { reach: m.reach, view: m.view }
    const s = JSON.stringify(next)
    if (s === lastDaemon) return             // a quiet team redraws nothing
    lastDaemon = s
    await update($, daemon, () => next)
    return
  }
  // the latest answer replaces the last error; data stays when only an error came
  const fresh = (prev: OfficeTabData): OfficeTabData => {
    const { error: _old, ...rest } = prev
    return { ...rest, at: now, data: m.data ?? prev.data, ...(m.error ? { error: m.error } : {}) }
  }
  if (m.type === 'history') await update($, history, fresh)
  else if (m.type === 'detail') await update($, history, cur => ({ ...cur, detail: m.data ?? { error: m.error ?? 'no such request' } }))
  else if (m.type === 'cost') await update($, cost, c => ({ ...fresh(c), period: m.period ?? c.period ?? '7d' }))
  else if (m.type === 'routing') await update($, routing, fresh)
}

/** Runs the helper for these arguments, replacing one that runs for others; it ends with the pane, the session or the module. */
function ensureHelper($: Engine, which: OfficeTab, period: string, detail: string): void {
  const key = `${which}|${period}|${detail}`
  if (helper?.key === key) return
  stopHelper()
  if (!enabled || !root) return
  // without a session id the helper says the office is not set up, and the office draws from Claude Code alone
  const argv = ['node', joinPath(joinPath(root, 'office'), 'bridge.mjs'), ...(sessionId ? ['--session', sessionId] : []), '--tab', which, '--period', period, ...(detail ? ['--detail', detail] : [])]
  const stream = $.process.spawn({ argv })
  let stopped = false
  const mine = { key, stop: () => { stopped = true; void stream.return(undefined as never).catch(() => undefined) } }
  helper = mine
  void (async () => {
    let rest = ''
    try {
      for await (const piece of stream) {
        if (stopped) break
        if (piece.stream !== 'stdout') continue
        const taken = takeLines(rest, piece.text)
        rest = taken.rest
        for (const line of taken.lines) await onLine($, line)
      }
    } catch { /* it could not start (no node on the PATH): the office draws from Claude Code alone */ }
    if (helper === mine) helper = null       // ended on its own: the next tick starts another
  })()
}

/** What the helper should be doing now: nothing while the pane is closed. */
async function steerHelper($: Engine): Promise<void> {
  if (!enabled || !paneOpen) { stopHelper(); return }
  const which = await read($, tab)
  const c = await read($, cost)
  const hist = await read($, history) as HistoryState
  ensureHelper($, which, c.period ?? '7d', which === 'history' ? hist.detailId ?? '' : '')
}

// ------------------------------------------------------------------ state changes

async function pushRow($: Engine, who: string, row: OfficeRow): Promise<void> {
  await update($, rows, all => withRow(all, who, row))
}

async function addAgent($: Engine, a: Omit<OfficeAgent, 'label' | 'status' | 'startedAt' | 'effort'> & { effort?: string }, leadModel: string): Promise<void> {
  const now = await $.clock.now()
  await update($, agents, list => {
    const next = list.some(x => x.id === LEAD) ? [...list]
      : [{ id: LEAD, role: 'lead' as const, label: ROLE_NAME.lead, model: modelName(leadModel), effort: '', task: 'plan and check', status: 'working' as const, startedAt: now, real: a.real }, ...list]
    if (next.some(x => x.id === a.id)) return next
    return [...next, { ...a, effort: a.effort ?? '', label: labelFor(a.role, a.tag, next), status: 'working' as const, startedAt: now }]
  })
}

async function setStatus($: Engine, id: string, status: OfficeStatus): Promise<void> {
  const now = await $.clock.now()
  await update($, agents, list => list.some(a => a.id === id && a.status !== status)
    ? list.map(a => a.id === id ? { ...a, status, endedAt: status === 'done' || status === 'failed' ? now : undefined } : a)
    : list)
}

async function setModel($: Engine, id: string, model: string, effort: string): Promise<void> {
  await update($, agents, list => list.some(a => a.id === id && (a.model !== model || a.effort !== effort))
    ? list.map(a => a.id === id ? { ...a, model, effort } : a)
    : list)
}

async function pollAgents($: Engine): Promise<void> {
  const list = await read($, agents)
  const real = list.filter(a => a.real && a.id !== LEAD)
  if (!real.length) return
  const live = await $.agent.list()
  for (const a of real) {
    const l = live.find(x => x.id === a.id)
    if (l) await setStatus($, a.id, fromAgentStatus(l.status))
  }
}

async function openPane($: Engine, focus = false): Promise<{ isPlaced: boolean; reason?: string }> {
  // inline, left to itself, the engine gives a pane a third of its room; this asks for the office's (the classic
  // renderer grants more, fullscreen a third at most, and a size the person kept wins)
  const want = wantedRoom((await read($, agents)).length)
  const opened = await $.ui.open({ id: PANE, title: TITLE, rows: want.rows, columns: want.columns, ...(focus ? { focus: true as const } : {}) })
  if (opened.isPlaced) paneOpen = true
  return opened
}

async function clearOffice($: Engine): Promise<void> {
  demoAt = -1
  await update($, agents, () => [])
  await update($, rows, () => ({}))
  await update($, selected, () => '')
}

// ------------------------------------------------------------------ the preview (no model calls: made-up lines)

type Step = { who: string; row?: OfficeRow; status?: OfficeStatus }
const t = (who: string, text: string): Step => ({ who, row: { kind: 'tool', text } })
const r = (who: string, text: string): Step => ({ who, row: { kind: 'result', text } })
const x = (who: string, text: string): Step => ({ who, row: { kind: 'error', text } })
const s = (who: string, text: string): Step => ({ who, row: { kind: 'text', text } })
const st = (who: string, status: OfficeStatus): Step => ({ who, status })

const DEMO_STEPS: Step[] = [
  s('demo-a', 'Accented letters need NFKD first, then the combining marks dropped.'), t('demo-b', 'Grep("slugify")'),
  t('demo-a', 'Edit(src/slug.ts)'), r('demo-b', '3 results'),
  r('demo-a', '+6 -2'), t('demo-b', 'Edit(src/cli.ts)'),
  t('demo-a', 'Bash(npm test -- slug)'), r('demo-b', '+3 -1'),
  x('demo-a', "1 test failed: slugify('Crème Brûlée')"), t('demo-b', 'Bash(npm test -- cli)'),
  s('demo-a', 'Collapsing spaces ran before the split. Swapping the order.'), r('demo-b', '8 passed'),
  t('demo-a', 'Edit(src/slug.ts)'), s('demo-b', 'Done: the CLI uses the new slugify.'),
  r('demo-a', '+2 -1'), st('demo-b', 'done'),
  t('demo-a', 'Bash(npm test -- slug)'),
  r('demo-a', '12 passed'),
  s('demo-a', 'Done: accented letters become ASCII in a slug.'), st('demo-a', 'done'),
  st('demo-r', 'working'), s('lead', 'Both coders passed verify. Handing it to review.'),
  t('demo-r', 'Read(src/slug.ts)'),
  r('demo-r', 'read 48 lines'),
  s('demo-r', 'Checked two edge cases (empty string, repeated spaces). No problems.'),
  st('demo-r', 'done'),
  s('lead', 'The team is done. Router verify passed, 12 tests.'), st('lead', 'waiting'),
]

async function startDemo($: Engine): Promise<void> {
  const now = await $.clock.now()
  const ago = (sec: number) => now - sec * 1000
  await update($, agents, () => [
    { id: LEAD, role: 'lead', label: 'lead', model: 'Sonnet', effort: 'high', task: 'plan and check', status: 'working', startedAt: ago(95), real: false },
    { id: 'demo-s', role: 'architect', label: 'architect', model: 'Haiku', effort: 'low', task: 'split the modules', status: 'done', startedAt: ago(90), endedAt: ago(58), real: false },
    { id: 'demo-a', role: 'coder', label: 'coder A', model: 'Haiku', effort: 'low', task: 'slugify accents', status: 'working', startedAt: ago(52), real: false },
    { id: 'demo-b', role: 'coder', label: 'coder B', model: 'Haiku', effort: 'low', task: 'CLI uses the new slugify', status: 'working', startedAt: ago(52), real: false },
    { id: 'demo-r', role: 'reviewer', label: 'reviewer', model: 'Sonnet', effort: 'medium', task: 'review the change', status: 'waiting', startedAt: now, real: false },
  ])
  const seeded: Record<string, OfficeRow[]> = {
    lead: [
      { kind: 'text', text: 'Request size L2: architect 1, coders 2, reviewer 1.' },
      { kind: 'tool', text: 'Agent(split the modules)' }, { kind: 'result', text: 'architect done: slug.ts to coder A, cli.ts to coder B' },
      { kind: 'tool', text: 'Agent(slugify accents)' }, { kind: 'tool', text: 'Agent(CLI uses the new slugify)' },
    ],
    'demo-s': [
      { kind: 'tool', text: 'Read(src/slug.ts)' }, { kind: 'result', text: 'read 42 lines' },
      { kind: 'tool', text: 'Read(src/cli.ts)' }, { kind: 'result', text: 'read 88 lines' },
      { kind: 'text', text: 'The two files are independent, so two coders can take them at the same time.' },
      { kind: 'text', text: 'Done: slug.ts to coder A, cli.ts to coder B.' },
    ],
    'demo-a': [{ kind: 'tool', text: 'Read(src/slug.ts)' }, { kind: 'result', text: 'read 42 lines' }],
    'demo-b': [{ kind: 'tool', text: 'Read(src/cli.ts)' }, { kind: 'result', text: 'read 88 lines' }],
  }
  await update($, rows, () => seeded)
  await update($, selected, () => 'demo-a')
  demoAt = 0
}

async function demoStep($: Engine): Promise<void> {
  if (demoAt < 0) return
  const step = DEMO_STEPS[demoAt]
  if (!step) { demoAt = -1; return }
  demoAt++
  if (step.row) await pushRow($, step.who, step.row)
  if (step.status) {
    if (step.status === 'working') {
      const now = await $.clock.now()
      await update($, agents, list => list.map(a => a.id === step.who ? { ...a, status: 'working', startedAt: now, endedAt: undefined } : a))
    } else await setStatus($, step.who, step.status)
  }
}

// ------------------------------------------------------------------ the hooks

let ticking = false

/** The office's clock: elapsed times, the preview, the agents' status, and the helper's steering. Started once. */
function ensureTicker($: Engine): void {
  if (ticking) return
  ticking = true
  let n = 0
  $.clock.every(600, () => {
    n++
    void (async () => {
      if (!enabled) return
      const list = await read($, agents)
      if (list.some(a => a.status === 'working')) await update($, tick, v => v + 1)
      await steerHelper($)
      if (n % 2 === 0) {
        await demoStep($)
        await pollAgents($)
      }
    })().catch(() => undefined)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await start($)
    await $.command.register({ name: 'office', description: 'Open the team office (/office demo: a preview with made-up members; /office clear: empty it)' })
    ensureTicker($)
    return next(e)
  })

  on('command.run', { command: 'office' }, async ($, e) => {
    await start($)
    if (!enabled) return { text: offReason || 'The team office is off.' }
    ensureTicker($)
    const arg = e.args.trim()
    if (arg === 'demo') await startDemo($)
    if (arg === 'clear') await clearOffice($)
    closedByPerson = false
    const opened = await openPane($)
    await steerHelper($).catch(() => undefined)
    return { text: opened.isPlaced ? 'Opened the team office.' : `The team office is not drawn yet: ${opened.reason}` }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      paneOpen = false
      stopHelper()
      if (e.origin.kind === 'person') closedByPerson = true
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    try {
      if (enabled && spawned.agentId) {
        const tag = tagOf(e.prompt)
        await addAgent($, { id: spawned.agentId, role: roleOf(e.subagentType), model: modelName(spawned.model ?? e.model ?? ''), task: oneLine(e.description, 40), real: true, ...(tag ? { tag } : {}) }, e.parentModel)
        // a request's first worker opens the office; the engine places a pane it was not asked for only on a wide terminal
        await start($)
        ensureTicker($)
        if (!paneOpen && !closedByPerson) void openPane($).catch(() => undefined)
      }
    } catch { /* the office never stands in an agent's way */ }
    return spawned
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const who = e.agentId ?? LEAD
    if (enabled) try { await pushRow($, who, callRow(e, secrets)) } catch { /* drawing only */ }
    const ran = await next(e)
    if (enabled) try { await pushRow($, who, resultRow(String(e.tool), ran, secrets)) } catch { /* drawing only */ }
    return ran
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    try {
      if (enabled && e.message.type === 'assistant') {
        const who = e.agentId ?? LEAD
        for (const b of e.message.content) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) await pushRow($, who, textRow(b.text, secrets))
        }
      }
    } catch { /* drawing only */ }
    return next(e)
  }).catch(($, e, next) => next(e))

  // each model request names the model and effort it runs at: the desk shows what the member really uses
  on('turn.step', async function* ($, e, next) {
    if (enabled) try { await setModel($, e.agentId ?? LEAD, modelName(e.model), e.effort === undefined ? '' : String(e.effort)) } catch { /* drawing only */ }
    return yield* next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (enabled && !e.agentId) {
      closedByPerson = false
      await setStatus($, LEAD, 'working').catch(() => undefined)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (enabled && !e.agentId) await setStatus($, LEAD, 'waiting').catch(() => undefined)
    return done
  })

  on('session.end', async ($, e, next) => {
    // nothing of the session is kept past it
    stopHelper()
    try { await clearOffice($) } catch { /* nothing to clear */ }
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    const d = e.data as { type?: unknown; id?: unknown } | null
    if (d && d.type === 'select' && typeof d.id === 'string') {
      const id = d.id
      await update($, selected, cur => (cur === id ? '' : id))
    }
    // a click on the scene gives it the keyboard, so the scene passes the tab keys on (o, h, c, r)
    if (d && d.type === 'tab' && (d.id === 'office' || d.id === 'history' || d.id === 'cost' || d.id === 'routing')) {
      const id = d.id
      await update($, tab, () => id)
      await steerHelper($)
      // the scene had the keys and leaves with the Office tab: the pane asks for them, so the next tab key is not
      // typed into the prompt (granted only while the prompt holds no text)
      if (id !== 'office' && paneOpen) await openPane($, true).catch(() => undefined)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const which = await read($, tab)
    const pane = e.props as { bodyColumns?: number; scroll?: { bodyRows?: number } } | undefined
    const room: Room = { columns: pane?.bodyColumns ?? 100, rows: pane?.scroll?.bodyRows ?? 40 }

    const tabs = (
      <Box key="tabs" flexDirection="row">
        {([['office', 'Office', 'o'], ['history', 'History', 'h'], ['cost', 'Cost', 'c'], ['routing', 'Routing', 'r']] as const).map(([id, label, key]) => (
          <Button key={`tab-${id}`} hotkey={key} variant={which === id ? 'primary' : 'secondary'} onPress={() => { void (async () => { await update($, tab, () => id); await steerHelper($) })().catch(() => undefined) }}>{label}</Button>
        ))}
      </Box>
    )
    let body: RenderElement
    try {
      body = which === 'history' ? await historyTab($, e, room)
        : which === 'cost' ? await costTab($, e, room)
        : which === 'routing' ? await routingTab($, e, room)
        : await officeTab($, e, room)
    } catch (err) {
      // a tab that cannot draw says so below the tabs, which stay, so the person can still leave it
      const first = String(err instanceof Error ? err.message : err).split('\n')[0] ?? ''
      body = <Box key="tab-error" width={Math.max(20, room.columns - SLACK)}><Text color="error" wrap="truncate-end">{`This tab could not draw: ${first}`}</Text></Box>
    }
    return <Box flexDirection="column">{tabs}{body}</Box>
  })
}

// ------------------------------------------------------------------ the office tab

/** The pane's body as the engine gave it: `bodyColumns` across, `scroll.bodyRows` the most rows it may take. */
type Room = { columns: number; rows: number }
type RenderEvent = Parameters<Engine['ui']['resolve']>[0]

async function officeTab($: Engine, e: RenderEvent, room: Room): Promise<RenderElement> {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  // the scene is a surface module; the classic console gets the list instead (its marks and its redraws)
  const Client = 'Client' in els && !classic ? els.Client : undefined
  const g = glyphs()
  const list = await read($, agents)
  const all = await read($, rows)
  const sel = await read($, selected)
  const dstate = await read($, daemon)
  await read($, tick)
  const view = (dstate.reach === 'ok' ? dstate.view : null) as DaemonOffice | null
  const now = await $.clock.now()
  const working = list.filter(a => a.status === 'working').length
  const target = list.find(a => a.id === sel)

  const lastTool = (id: string) => {
    const mine = all[id] ?? []
    for (let k = mine.length - 1; k >= 0; k--) if (mine[k]!.kind === 'tool') return mine[k]!.text
    return ''
  }
  const daemonLine = dstate.reach === 'ok' ? requestLine(view)
    : dstate.reach === 'refused' ? 'the router refused the call — run do-it-all-claude-code doctor'
    : dstate.reach === 'setup' ? 'the router is not set up — run do-it-all-claude-code init' : DAEMON_DOWN
  // The pane stays within the rows Claude Code gives it, and every frame stops SLACK columns short of its right
  // edge: a frame taller than the room cannot be redrawn in place, and a line that reaches the terminal's last
  // column is the first a narrower window wraps. Desks when they fit, else a line a member (model.ts: officeLayout).
  const layout = officeLayout({ columns: room.columns, rows: room.rows, members: list.length, routerLine: Boolean(daemonLine), classic: !Client })
  const summary = list.length ? `${list.length} member${list.length === 1 ? '' : 's'} · ${working} working` : ''
  const doing = (a: OfficeAgent) => (a.status === 'working' ? lastTool(a.id) : '')
  const pick = (id: string) => { void update($, selected, cur => (cur === id ? '' : id)).catch(() => undefined) }

  const line = (row: OfficeRow, j: number) => {
    if (row.kind === 'tool') return <Text key={`row-${j}`} wrap="truncate-end"><Text color="success">{g.tool}</Text> <Text bold>{row.text}</Text></Text>
    if (row.kind === 'result') return <Text key={`row-${j}`} wrap="truncate-end" dimColor>{'  ⎿  '}{row.text}</Text>
    if (row.kind === 'error') return <Text key={`row-${j}`} wrap="truncate-end" color="error">{'  ⎿  '}{row.text}</Text>
    return <Text key={`row-${j}`} wrap="truncate-end">{g.text} {row.text}</Text>
  }

  // one line a member: who, the model and effort it runs at, its status, what it does; the engine writes a
  // Button's hotkey before it ("1: "), so the line is that much shorter
  const memberLine = (a: OfficeAgent, i: number) => {
    const avail = layout.inner - (i < 9 ? 3 : 0)
    const head = `${a.id === sel ? g.picked : ' '} ${a.label}`
    const model = ` · ${a.model}${a.effort ? ` ${a.effort}` : ''}`
    const status = ` · ${statusWord(a.status, g)}${a.status === 'waiting' ? '' : ` ${elapsed(a, now)}`}`
    const what = doing(a)
    const used = [...`${head}${model}${status}`].length
    const tail = what && avail - used > 6 ? fit(` · ${what}`, avail - used) : ''
    return (
      <Button key={`member-${a.id}`} plain {...(i < 9 ? { hotkey: String(i + 1) } : {})} onPress={() => pick(a.id)}>
        {used > avail
          ? fit(`${head}${model}${status}`, avail)
          : <Text><Text bold color={ROLE_COLOR[a.role]}>{head}</Text><Text dimColor>{model}</Text><Text color={STATUS_COLOR[a.status]}>{status}</Text><Text dimColor>{tail}</Text></Text>}
      </Button>
    )
  }

  const scene = {
    agents: list.map(a => ({ id: a.id, role: a.role, label: a.label, model: a.model, effort: a.effort ?? '', status: a.status, time: elapsed(a, now), doing: doing(a) })),
    selected: sel,
    summary,
    compact: !layout.wall,
    perRow: layout.perRow,
    small: layout.small,
  }
  const office = layout.mode === 'desks' && Client
    ? <Client key="office-scene" module="./scene.tsx" props={scene} width={layout.inner} />
    : (
      <Box key="office-list" flexDirection="column">
        <Text key="office-title" wrap="truncate-end"><Text bold>DO IT ALL · team office</Text><Text dimColor>{summary ? `  ${summary}` : ''}</Text></Text>
        {list.length === 0 ? <Text key="office-empty" dimColor wrap="truncate-end">The team takes its desks when a request gets one · /office demo for a preview</Text> : null}
        {list.map(memberLine)}
      </Box>
    )

  const session = target ? all[target.id] ?? [] : []
  const sub = target && target.id !== LEAD ? subtaskOf(view, target) : undefined
  const plan = target ? stepLine(target, sub) : null
  const detail = !target ? '' : target.id === LEAD ? requestLine(view)
    : sub ? [sub.checks.length ? checksLine(sub.checks) : '', sub.repro?.required ? `repro ${sub.repro.state}` : ''].filter(Boolean).join(' · ') : ''
  const hint = layout.mode === 'desks'
    ? `Click a member to follow its session here · then 1${g.range}9 picks, o h c r switch tabs`
    : `1${g.range}9 or a click picks a member to follow here (ctrl+x tab gives the office the keys) · o h c r switch tabs`

  // a room too low for frames: Claude Code keeps the height a person once gave an inline pane, for every plugin's
  if (layout.mode === 'tiny') {
    return (
      <Box key="office-tiny" flexDirection="column" width={layout.width}>
        <Text key="tiny-room" dimColor wrap="truncate-end">{`${room.rows} rows here: ctrl+x tab, then ctrl+x up, makes the office taller`}</Text>
        {list.length === 0 ? <Text key="office-empty" dimColor wrap="truncate-end">The team takes its desks when a request gets one · /office demo for a preview</Text> : null}
        {list.map(memberLine)}
        {target && layout.sessionRows > 0 ? session.slice(-layout.sessionRows).map(line) : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {daemonLine ? <Box key="daemon" width={layout.width}><Text dimColor wrap="truncate-end">{daemonLine}</Text></Box> : null}
      <Box key="office-frame" flexDirection="column" borderStyle={g.border} borderColor="inactive" paddingX={1} width={layout.width}>
        {office}
      </Box>
      <Box key="session-frame" flexDirection="column" borderStyle={g.border} borderColor={target ? ROLE_COLOR[target.role] : 'inactive'} borderDimColor={!target} paddingX={1} width={layout.width} height={layout.sessionRows + 2}>
        {!target
          ? <Box flexGrow={1} alignItems="center" justifyContent="center"><Text dimColor wrap="truncate-end">{hint}</Text></Box>
          : (
            <Box flexDirection="column">
              <Box justifyContent="space-between">
                <Text wrap="truncate-end"><Text bold color={ROLE_COLOR[target.role]}>{target.label}</Text><Text dimColor> · {target.model}{target.effort ? ` ${target.effort}` : ''} · {target.task} · {statusWord(target.status, g)}</Text></Text>
                {target.real && target.id !== LEAD
                  ? <Button key="open-view" hotkey="v" onPress={() => { void $.ui.view({ agentId: target.id }) }}>View in main</Button>
                  : null}
              </Box>
              {plan || detail
                ? <Text key="plan" wrap="truncate-end" dimColor>{plan ? plan.plan : ''}{plan?.ranAt ? <Text color="warning">{` · ${plan.ranAt}`}</Text> : null}{detail ? `${plan ? ' · ' : ''}${detail}` : ''}</Text>
                : null}
              {session.length === 0 ? <Text dimColor>No lines yet.</Text> : session.slice(-Math.max(1, layout.sessionRows - 2)).map(line)}
            </Box>
          )}
      </Box>
    </Box>
  )
}

// ------------------------------------------------------------------ the other tabs

type HistoryRowView = { requestId: string; closedAt: string; level: string; finalLevel: string; outcome: string | null; acceptance: string | null; totalUsd: number; durationMs: number | null; verifyFailures: number; success: boolean }
type HistoryState = OfficeTabData & { detailId?: string }

const when = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso.slice(0, 16) : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const secs = (ms: number | null) => (typeof ms === 'number' ? `${Math.round(ms / 1000)}s` : '—')

// Each tab draws within the frames' width (the body's less SLACK) and with the marks the terminal draws one cell
// wide. No local takes the JSX factory's names (h, Fragment): the JSX in its scope would call it instead.

async function historyTab($: Engine, e: RenderEvent, room: Room): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const g = glyphs()
  const width = Math.max(20, room.columns - SLACK)
  const hist = await read($, history) as HistoryState
  const list = ((hist.data as { rows?: HistoryRowView[] } | null)?.rows ?? [])
  const detail = hist.detailId ? hist.detail as null | undefined | { error?: string; requestId?: string; record?: Record<string, unknown>; signals?: Array<{ subtaskId: string | null; kind: string; ok: boolean }>; hasPrompt?: boolean } : null
  if (hist.detailId) {
    const rec = detail?.record ?? {}
    const subs = (Array.isArray(rec.subtasks) ? rec.subtasks : []) as Array<{ id?: string; role?: string; step?: string; status?: string; verdict?: string | null }>
    return (
      <Box flexDirection="column" width={width}>
        <Button key="back" hotkey="b" onPress={() => { void update($, history, x => { const { detail: _d, detailId: _i, ...rest } = x as HistoryState; return rest }) }}>Back</Button>
        {!detail ? <Text dimColor>Loading…</Text> : null}
        {detail?.error ? <Text color="error" wrap="truncate-end">{detail.error}</Text> : null}
        <Text bold wrap="truncate-end">{hist.detailId}</Text>
        {detail && !detail.error && subs.length === 0 ? <Text dimColor wrap="truncate-end">No subtasks: the lead did this request itself.</Text> : null}
        {subs.map((s, i) => {
          const sig = (detail?.signals ?? []).filter(x => x.subtaskId === s.id && x.kind !== 'review')
          return <Text key={`sub-${i}`} wrap="truncate-end">{`${s.id ?? '?'} ${s.role ?? ''} ${s.step ?? ''} ${s.status ?? ''}${s.verdict ? ` (${s.verdict})` : ''}`}<Text dimColor>{sig.length ? ` · ${sig.map(x => `${x.kind} ${x.ok ? 'ok' : 'failed'}`).join(', ')}` : ''}</Text></Text>
        })}
        {detail?.hasPrompt ? <Text dimColor wrap="truncate-end">The prompt is kept in the request record (recordPrompts); the office does not show it.</Text> : null}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={width}>
      {hist.error ? <Text color="error" wrap="truncate-end">{hist.error}</Text> : null}
      {list.length === 0 && !hist.error ? <Text dimColor>{hist.at ? 'No closed requests yet.' : 'Loading…'}</Text> : null}
      {list.map(row => {
        const main = `${when(row.closedAt)}  ${row.level}${row.finalLevel !== row.level ? `${g.arrow}${row.finalLevel}` : ''}  ${(row.outcome ?? '—').padEnd(10)} ${row.success ? g.status.done : g.status.failed} ${usd(row.totalUsd).padStart(7)}`
        const more = `  ${secs(row.durationMs)}${row.verifyFailures ? ` · ${row.verifyFailures} verify failure${row.verifyFailures === 1 ? '' : 's'}` : ''}${row.acceptance && row.acceptance !== 'n/a' ? ` · ${row.acceptance}` : ''}`
        return (
          <Button key={`req-${row.requestId}`} plain onPress={() => { void update($, history, x => ({ ...x, detailId: row.requestId, detail: undefined })) }}>
            {fit(main, width)}
            <Text dimColor>{fit(more, Math.max(0, width - [...main].length))}</Text>
          </Button>
        )
      })}
    </Box>
  )
}

async function costTab($: Engine, e: RenderEvent, room: Room): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const width = Math.max(20, room.columns - SLACK)
  const c = await read($, cost) as OfficeTabData
  const s = c.data as null | {
    total: number; successRate: number | null; costPerAcceptedTaskUsd: number | null
    cost: { totalUsd: number; leadUsd: number; subtaskUsd: number }
    flags: { estimated: number; unknown: number; budgetExceeded: number }
    byLevel: Array<{ level: string; count: number; totalUsd: number; successRate: number | null }>
    acceptance?: { accepted: number }
    limits?: null | { fiveHour: { usedPercentage: number } | null; sevenDay: { usedPercentage: number } | null }
  }
  const pct = (v: number | null | undefined) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—')
  return (
    <Box flexDirection="column" width={width}>
      <Box key="periods" flexDirection="row">
        {([['24h', '24 hours', 't'], ['7d', '7 days', 'w'], ['30d', '30 days', 'm']] as const).map(([id, label, key]) => (
          <Button key={`period-${id}`} hotkey={key} variant={(c.period ?? '7d') === id ? 'primary' : 'secondary'} onPress={() => { void update($, cost, x => ({ ...x, period: id, data: null })) }}>{label}</Button>
        ))}
      </Box>
      {c.error ? <Text color="error" wrap="truncate-end">{c.error}</Text> : null}
      {!s ? <Text dimColor>{c.error ? '' : 'Loading…'}</Text> : (
        <Box flexDirection="column">
          <Text wrap="truncate-end">{`${s.total} request${s.total === 1 ? '' : 's'} · ${usd(s.cost.totalUsd)} (lead ${usd(s.cost.leadUsd)}, workers ${usd(s.cost.subtaskUsd)}) · ${usd(s.costPerAcceptedTaskUsd)} per accepted · ${s.acceptance ? `${s.acceptance.accepted} of ${s.total} accepted` : `success ${pct(s.successRate)}`}`}</Text>
          {s.byLevel.map(l => <Text key={`lvl-${l.level}`} wrap="truncate-end">{`  ${l.level}  ${String(l.count).padStart(4)}  ${usd(l.totalUsd).padStart(8)}  success ${pct(l.successRate)}`}</Text>)}
          {s.flags.estimated || s.flags.unknown || s.flags.budgetExceeded
            ? <Text color="warning" wrap="truncate-end">{[s.flags.estimated ? `${s.flags.estimated} estimated` : '', s.flags.unknown ? `${s.flags.unknown} with unknown costs` : '', s.flags.budgetExceeded ? `${s.flags.budgetExceeded} over budget` : ''].filter(Boolean).join(' · ')}</Text>
            : null}
          {s.limits && (s.limits.fiveHour || s.limits.sevenDay)
            ? <Text dimColor wrap="truncate-end">{[s.limits.fiveHour ? `5-hour limit ${Math.round(s.limits.fiveHour.usedPercentage)}% used` : '', s.limits.sevenDay ? `7-day limit ${Math.round(s.limits.sevenDay.usedPercentage)}% used` : ''].filter(Boolean).join(' · ')}</Text>
            : null}
        </Box>
      )}
    </Box>
  )
}

async function routingTab($: Engine, e: RenderEvent, room: Room): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)
  const g = glyphs()
  const width = Math.max(20, room.columns - SLACK)
  const rt = await read($, routing) as OfficeTabData
  const dstate = await read($, daemon)
  const view = (dstate.reach === 'ok' ? dstate.view : null) as (DaemonOffice & { routing?: { mode: string; holdoutRate: number; classes: Array<{ leadClass: string; levels: Array<{ level: string; released: boolean; delegated: { n: number; costPerAcceptedUsd: number | null }; direct: { n: number; costPerAcceptedUsd: number | null }; decision: { action: string; reason: string } }> }> } }) | null
  const report = rt.data as null | { overall: { total: number; levelHeld: number; teamFit: number; startStepFit: number }; byRule: Array<{ rule: string; count: number; suggestLevelUp: boolean; suggestStepUp: boolean }>; byLevel: Array<{ planned: string; final: string; count: number }> }
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—')
  const r = view?.routing
  return (
    <Box flexDirection="column" width={width}>
      {rt.error ? <Text color="error" wrap="truncate-end">{rt.error}</Text> : null}
      {r ? <Text bold wrap="truncate-end">{`auto-release ${r.mode} · holdout ${Math.round(r.holdoutRate * 100)}%`}</Text> : <Text dimColor wrap="truncate-end">{dstate.reach === 'ok' ? 'No routing data yet.' : DAEMON_DOWN}</Text>}
      {(r?.classes ?? []).flatMap(c => c.levels.filter(l => l.delegated.n || l.direct.n).map(l => (
        <Text key={`arm-${c.leadClass}-${l.level}`} wrap="truncate-end">{`  ${c.leadClass} ${l.level}${l.released ? ' (lead-direct now)' : ''}  team n=${l.delegated.n} ${usd(l.delegated.costPerAcceptedUsd)}/accepted · lead n=${l.direct.n} ${usd(l.direct.costPerAcceptedUsd)}/accepted ${g.arrow} ${l.decision.action}`}<Text dimColor>{` (${l.decision.reason.replace(/_/g, ' ')})`}</Text></Text>
      )))}
      {report ? <Text wrap="truncate-end">{`triage: ${report.overall.total} requests · level held ${pct(report.overall.levelHeld, report.overall.total)} · team fit ${pct(report.overall.teamFit, report.overall.total)} · start step fit ${pct(report.overall.startStepFit, report.overall.total)}`}</Text> : null}
      {(report?.byLevel ?? []).filter(l => l.planned !== l.final).map(l => <Text key={`pl-${l.planned}-${l.final}`} dimColor wrap="truncate-end">{`  planned ${l.planned}, ended ${l.final}: ${l.count}`}</Text>)}
      {(report?.byRule ?? []).filter(x => x.suggestLevelUp || x.suggestStepUp).map(x => <Text key={`rule-${x.rule}`} color="warning" wrap="truncate-end">{`  rule ${x.rule}: ${x.suggestLevelUp ? 'its level may be too low' : 'its start step may be too low'} (${x.count} requests)`}</Text>)}
    </Box>
  )
}
