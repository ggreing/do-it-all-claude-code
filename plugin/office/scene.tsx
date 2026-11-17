import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'

// The office scene, drawn by its own surface module so it keeps a frame clock and the pointer: the members are
// soft one-piece blobs drawn in one fixed shape (two pixels to a cell, half blocks); what moves is the eyes, what
// floats above the head and the monitor. A click presses the member down for a moment; it is picked, and posts the pick to the hooks module, which shows that member's session below the office.

type Role = 'lead' | 'architect' | 'coder' | 'reviewer' | 'tester' | 'ui-designer' | 'helper'
type Status = 'working' | 'done' | 'waiting' | 'failed'
export type SceneAgent = { id: string; role: Role; label: string; model: string; effort: string; status: Status; time: string; doing: string }
/**
 * `perRow`: desks to a row, as the hooks module laid the room out (model.ts: officeLayout); `compact`: no back wall;
 * `small`: the small desks, for a room the full ones do not fit.
 */
export type SceneProps = { agents: SceneAgent[]; selected: string; summary: string; compact?: boolean; perRow?: number; small?: boolean }

type State = { t: number; hover: number; px: number; bounce: Record<string, number> }

// a few frames a second: enough for a blink and a monitor, and each redraw is a chance for the terminal to tear
const STEP = 250
// the member's own space: its body (11 cells, one cell in) plus room to the side and above for what floats around it
const CANVAS_W = 15

/**
 * A desk's geometry. `above`: the canvas rows over the member's head; `w`: the desk across; `gap`: the columns to
 * the next desk; `h`: the desk's rows (the canvas, the desktop, the name, model and status lines); a row of desks is
 * `h + 1` down. The full desk has a monitor beside the member; the small one is the member alone at its desk, in
 * the same shape, for a room the full desks do not fit (model.ts: DESK_W, DESK_H, SMALL_DESK_W, SMALL_DESK_H).
 */
type Geom = { above: number; canvas: number; w: number; gap: number; h: number; monitor: boolean }
const FULL: Geom = { above: 3, canvas: 7, w: CANVAS_W + 7, gap: 2, h: 11, monitor: true }
const SMALL: Geom = { above: 1, canvas: 5, w: CANVAS_W, gap: 1, h: 9, monitor: false }
const geomOf = (p: SceneProps): Geom => (p.small ? SMALL : FULL)
const cellOf = (g: Geom) => g.w + g.gap
/** Where the member's face is across its desk: the body's middle. */
const FACE_X = 6
/** Rows above the first desk: the title line, then the back wall unless the room is short (`compact`). */
const topOf = (compact: boolean | undefined) => (compact ? 1 : 3)

const ROLE_COLOR: Record<Role, string> = {
  lead: 'claude', architect: 'suggestion', coder: 'planMode', reviewer: 'warning', tester: 'success', 'ui-designer': 'merged', helper: 'inactive',
}
const STATUS_COLOR: Record<Status, string> = { working: 'warning', done: 'success', waiting: 'inactive', failed: 'error' }
const STATUS_WORD: Record<Status, string> = { working: '● working', done: '✓ done', waiting: '○ waiting', failed: '✗ failed' }
const WOOD = '#9a7b5f'
const SCREEN_TAPE: Record<Role, string> = {
  lead: 'L2 > plan > team > check > ',
  architect: '[]-[] [ ]=[] ',
  coder: 'const ok = fix(x); if (ok) go(); ',
  reviewer: '+ + - + - - + ok ',
  tester: 'ok ok ok ok pass ',
  'ui-designer': '~ * o ~ * o ',
  helper: '> ls  > cat  ',
}

let latest: SceneProps = { agents: [], selected: '', summary: '' }

function phaseOf(id: string): number { let n = 7; for (const ch of id) n = (n * 31 + (ch.codePointAt(0) ?? 0)) % 997; return n / 997 }

// ------------------------------------------------------------------ one member, one frame

type Cell = { ch: string; kind: 'body' | 'fx' | 'none' }

// The member's one shape, kept as drawn: a round one-piece body, two pixels to a cell. 'o' marks the eyes.
const BODY = [
  '...#####...',
  '..#######..',
  '.##o###o##.',
  '.##o###o##.',
  '.#########.',
  '..#######..',
  '..##...##..',
  '...........',
]
// The same body pressed for a moment where the person clicked it: lower and a little wider, then back.
const PRESSED = [
  '...........',
  '...#####...',
  '.##o###o##.',
  '###o###o###',
  '###########',
  '.#########.',
  '..##...##..',
  '...........',
]
const PRESS_MS = 260

function member(a: SceneAgent, st: State, gaze: number, geo: Geom): Cell[][] {
  const t = st.t / 1000
  const ph = phaseOf(a.id)
  const clickedAt = st.bounce[a.id]
  const pressed = clickedAt !== undefined && st.t - clickedAt < PRESS_MS
  const shape = pressed ? PRESSED : BODY
  const g = Math.max(-1, Math.min(1, gaze))
  // the eyes move within the face; the shape around them does not
  const rows = shape.map(line => {
    if (!line.includes('o') || g === 0) return line
    const plain = line.replace(/o/g, '#').split('')
    line.split('').forEach((ch, x) => { if (ch === 'o' && plain[x + g] === '#') plain[x + g] = 'o' })
    return plain.join('')
  })
  const blink = (a.status === 'working' || a.status === 'done') && ((t + ph * 3) % 3.6) < 0.14
  const eye = blink ? '-' : a.status === 'done' ? '^' : a.status === 'waiting' ? '-' : a.status === 'failed' ? 'x' : ' '
  // the body sits at the bottom of the canvas, one cell in: the rows above it and the three columns to its right
  // stay free for what floats around it, so nothing reaches the monitor or the next desk
  const top0 = geo.above
  const grid: Cell[][] = Array.from({ length: geo.canvas }, () => Array.from({ length: CANVAS_W }, () => ({ ch: ' ', kind: 'none' as const })))
  for (let r = 0; r < 4; r++) {
    const top = rows[r * 2]!
    const bot = rows[r * 2 + 1]!
    for (let x = 0; x < top.length; x++) {
      const cell = grid[r + top0]![x + 1]!
      if (top[x] === 'o' || bot[x] === 'o') { cell.ch = eye; cell.kind = 'body'; continue }
      const up = top[x] === '#'
      const down = bot[x] === '#'
      if (up || down) { cell.ch = up && down ? '█' : up ? '▀' : '▄'; cell.kind = 'body' }
    }
  }
  const put = (r: number, c: number, ch: string) => { const cell = grid[r]?.[c]; if (cell && cell.kind === 'none') { cell.ch = ch; cell.kind = 'fx' } }
  // the small desk has one row over the head: what floats rises beside it, in the columns to its right
  const small = geo.above < 3
  if (a.status === 'waiting') {
    const path: Array<[number, number]> = small ? [[2, 12], [1, 13], [0, 14]] : [[2, 11], [1, 12], [0, 13]]
    for (const off of [0, 0.5]) {
      const q = (t / 2.6 + ph + off) % 1
      const [r, c] = path[Math.min(2, Math.floor(q * 3))]!
      put(r, c, q < 0.5 ? 'z' : 'Z')
    }
  } else if (a.status === 'done') {
    const spots: Array<[number, number]> = small
      ? [[0, 2], [0, 10], [2, 13], [3, 0], [1, 12], [0, 6]]
      : [[2, 1], [1, 3], [2, 12], [1, 9], [4, 0], [4, 13]]
    spots.forEach(([r, c], i) => { const k = Math.floor(t * 2.5 + i * 1.7) % 5; if (k < 2) put(r, c, k ? '+' : '*') })
  } else if (a.status === 'failed') {
    const q = (t / 1.4 + ph) % 1
    put(top0 + Math.floor(q * 3), 13, "'")
  }
  return grid
}

function screenOf(a: SceneAgent, t: number): string {
  if (a.status === 'done') return Math.floor(t / 1.2) % 2 ? ' OK  ' : 'DONE '
  if (a.status === 'failed') return Math.floor(t * 2) % 2 ? '!!!!!' : '     '
  if (a.status === 'waiting') { const p = Math.floor(t * 1.5) % 5; return `${' '.repeat(p)}.${' '.repeat(4 - p)}` }
  const tape = SCREEN_TAPE[a.role]
  const at = Math.floor(t * 3) % tape.length
  return (tape + tape).slice(at, at + 5)
}

// ------------------------------------------------------------------ geometry for the pointer

/** Desks to a row: the hooks module's count, else as many as the region holds (the last desk needs no gap after it). */
function perRowOf(props: SceneProps, columns: number): number {
  const geo = geomOf(props)
  return Math.max(1, props.perRow ?? Math.floor((Math.max(columns, geo.w) + geo.gap) / cellOf(geo)))
}

function stationAt(x: number, y: number, per: number, props: SceneProps): number {
  const geo = geomOf(props)
  const dy = y - topOf(props.compact)
  if (dy < 0 || x < 0) return -1
  const row = Math.floor(dy / (geo.h + 1))
  if (dy % (geo.h + 1) >= geo.h) return -1
  const col = Math.floor(x / cellOf(geo))
  if (x % cellOf(geo) >= geo.w || col >= per) return -1
  const i = row * per + col
  return i < props.agents.length ? i : -1
}

function pick(surface: ClientSurface<State>, i: number): void {
  const a = latest.agents[i]
  const s = surface.state
  if (!a || !s) return
  surface.setState({ ...s, hover: i, bounce: { ...s.bounce, [a.id]: s.t } })
  surface.post({ type: 'select', id: a.id })
}

// ------------------------------------------------------------------ the drawing

const OfficeScene: ClientModule<SceneProps, State> = (props, surface) => {
  latest = props
  if (!surface.state) {
    surface.every(STEP, () => { const s = surface.state; if (s) surface.setState({ ...s, t: s.t + STEP }) })
    surface.onPointer((e: ClientPointerEvent) => {
      const s = surface.state
      if (!s) return
      if (e.type === 'leave') { if (s.hover !== -1) surface.setState({ ...s, hover: -1 }); return }
      const per = perRowOf(latest, surface.columns || 100)
      const i = stationAt(e.x, e.y, per, latest)
      if (e.type === 'down' && e.button === 'left') { if (i >= 0) pick(surface, i); return }
      // redraw on a move only when what is drawn changes: the member under the pointer, or where its eyes look
      const cell = cellOf(geomOf(latest))
      const look = (hover: number, x: number) => (hover < 0 ? 0 : Math.abs(x - ((hover % per) * cell + FACE_X)) > 2 ? Math.sign(x - ((hover % per) * cell + FACE_X)) : 0)
      if (e.type === 'move' && (i !== s.hover || look(i, e.x) !== look(s.hover, s.px))) surface.setState({ ...s, hover: i, px: e.x })
    })
    surface.onKey((e: ClientKeyEvent) => {
      const s = surface.state
      if (!s) return
      // the tab keys work here too: a click on the scene gives it the keyboard, away from the tab buttons
      const tabKey: Record<string, string> = { o: 'office', h: 'history', c: 'cost', r: 'routing' }
      if (tabKey[e.key]) { surface.post({ type: 'tab', id: tabKey[e.key]! }); return }
      const n = latest.agents.length
      if (!n) return
      if (/^[1-9]$/.test(e.key)) { const i = Number(e.key) - 1; if (i < n) pick(surface, i); return }
      if (e.key === 'right' || e.key === 'left') {
        const cur = s.hover < 0 ? 0 : s.hover
        surface.setState({ ...s, hover: (cur + (e.key === 'right' ? 1 : n - 1)) % n })
        return
      }
      if (e.key === 'return' && s.hover >= 0) pick(surface, s.hover)
    })
    surface.setState({ t: 0, hover: -1, px: 0, bounce: {} })
  }
  const st: State = surface.state ?? { t: 0, hover: -1, px: 0, bounce: {} }
  const { Box, Text } = surface.elements
  const t = st.t / 1000
  const per = perRowOf(props, surface.columns || 100)
  const agents = props.agents
  const geo = geomOf(props)
  const cell = cellOf(geo)
  // the office spans its desks, never the whole region: a line that reaches its right edge is the first a
  // narrower window wraps (model.ts: SLACK)
  const span = Math.min(Math.max(per * cell - geo.gap, 24), surface.columns || 100)

  const clock = (() => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` })()
  const windowUnit = ['    ▐▀▀▀▀▌    ', '    ▐▄▄▄▄▌    ']
  const wall = windowUnit.map((u, j) => {
    const line = u.repeat(Math.ceil(span / u.length)).slice(0, span)
    return j === 0 && span > 12 ? `${line.slice(0, span - 8)} [${clock}]` : line
  })

  const station = (a: SceneAgent, i: number): RenderElement => {
    const isSel = a.id === props.selected
    const isHover = i === st.hover
    const charCenter = (i % per) * cell + FACE_X
    const gaze = isHover && Math.abs(st.px - charCenter) > 2 ? Math.sign(st.px - charCenter) : a.status === 'working' && Math.floor(t / 2.5 + phaseOf(a.id) * 3) % 3 === 0 ? 1 : 0
    const grid = member(a, st, gaze, geo)
    const tone = ROLE_COLOR[a.role]
    const dim = a.status === 'waiting' && !isSel && !isHover
    const scr = screenOf(a, t + phaseOf(a.id) * 5)
    const monitor = ['       ', '       ', '       ', '▗▄▄▄▄▄▖', '', '▝▀▀▀▀▀▘', '  ▗█▖  ']
    const rows = grid.map((cells, r) => {
      const runs: Array<{ text: string; kind: Cell['kind'] }> = []
      for (const c of cells) { const last = runs[runs.length - 1]; if (last && last.kind === c.kind) last.text += c.ch; else runs.push({ text: c.ch, kind: c.kind }) }
      return (
        <Text key={`m-${a.id}-${r}`}>
          {runs.map((run, k) => <Text key={`m-${a.id}-${r}-${k}`} color={run.kind === 'fx' ? STATUS_COLOR[a.status] : tone} dimColor={dim}>{run.text}</Text>)}
          {!geo.monitor ? null : r === 4
            ? <Text><Text color="inactive" dimColor={dim}>▐</Text><Text color={a.status === 'failed' ? 'error' : a.status === 'waiting' ? 'inactive' : 'success'} dimColor={dim}>{scr}</Text><Text color="inactive" dimColor={dim}>▌</Text></Text>
            : <Text color="inactive" dimColor={dim}>{monitor[r]}</Text>}
        </Text>
      )
    })
    // the small desk is one cell narrower on the left: its lines start a cell in, with the body
    const pad = geo.monitor ? '  ' : ' '
    const name = isSel ? `▸${pad.slice(1)}${a.label}` : `${pad}${a.label}`
    const model = geo.monitor ? `${a.model}${a.effort ? ` · ${a.effort}` : ''}` : `${a.model}${a.effort ? ` ${a.effort}` : ''}`
    return (
      <Box key={`st-${a.id}`} flexDirection="column" width={geo.w} marginRight={i % per === per - 1 ? 0 : geo.gap} marginBottom={1}>
        {rows}
        <Text color={WOOD}>{'▀'.repeat(geo.w)}</Text>
        <Text wrap="truncate-end" bold color={tone} underline={isHover && !isSel}>{name}</Text>
        <Text wrap="truncate-end" dimColor>{pad}{model}</Text>
        <Text wrap="truncate-end" color={STATUS_COLOR[a.status]}>{pad}{STATUS_WORD[a.status]} {a.status === 'waiting' ? '' : a.time}</Text>
      </Box>
    )
  }

  const sway = Math.floor(t / 2) % 2
  const plant = (
    <Box key="plant" flexDirection="column" width={7}>
      <Text> </Text>
      <Text color="success">  ▗▄▖  </Text>
      <Text color="success">{sway ? ' ▟███▙ ' : ' ▜███▛ '}</Text>
      <Text color="success">  ▝█▘  </Text>
      <Text color={WOOD}> ▐▀▀▀▌ </Text>
      <Text color={WOOD}> ▝▀▀▀▘ </Text>
    </Box>
  )

  // the desks a row at a time, as many as the hooks module counted on: nothing wraps on its own
  const rowsOf: SceneAgent[][] = []
  for (let k = 0; k < agents.length; k += per) rowsOf.push(agents.slice(k, k + per))
  return (
    <Box flexDirection="column" width={span}>
      <Box justifyContent="space-between" width={span}>
        <Text bold wrap="truncate-end">DO IT ALL · team office</Text>
        <Text dimColor wrap="truncate-end">{props.summary}</Text>
      </Box>
      {props.compact ? null : wall.map((w, j) => <Text key={`wall-${j}`} color="inactive" dimColor wrap="truncate-end">{w}</Text>)}
      {rowsOf.map((r, k) => (
        <Box key={`desks-${k}`} flexDirection="row">
          {r.map((a, j) => station(a, k * per + j))}
          {k === rowsOf.length - 1 && r.length < per ? plant : null}
        </Box>
      ))}
      {agents.length === 0 ? <Box key="desks-none" flexDirection="row">{plant}</Box> : null}
      {agents.length === 0 ? <Text dimColor wrap="truncate-end">  The team takes its desks when a request gets one · /office demo for a preview</Text> : null}
    </Box>
  )
}

export default OfficeScene

