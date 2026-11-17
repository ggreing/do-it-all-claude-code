import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'
import { BODY, frameAt, frameIndex, react, type ReactionState } from './reactions'

// The office scene, drawn by its own surface module so it keeps a frame clock and the pointer: the members are
// soft one-piece blobs (two pixels to a cell, half blocks). At rest a member keeps its one shape, and what moves is
// the eyes, what floats above the head and the monitor. A click picks the member, which posts the pick to the hooks
// module (that member's session shows below the office), and the member reacts for a moment: it may stretch,
// squash, hop or sway, at its own pace, and is then back in its one shape (reactions.ts).

type Role = 'lead' | 'architect' | 'coder' | 'reviewer' | 'tester' | 'ui-designer' | 'helper'
type Status = 'working' | 'done' | 'waiting' | 'failed'
export type SceneAgent = { id: string; role: Role; label: string; model: string; effort: string; status: Status; time: string; doing: string }
/**
 * `perRow`: desks to a row, as the hooks module laid the room out (model.ts: officeLayout); `compact`: no back wall;
 * `small`: the small desks, for a room the full ones do not fit; `narrow`: the narrow ones, for a room even those do
 * not fit.
 */
/**
 * `bare`: no title line (the cramped layout gives its row to the line of members left over, which the hooks module
 * draws under the scene); `more`: the ids of those members, in order after the ones drawn, so 1–9 reach them too.
 */
export type SceneProps = { agents: SceneAgent[]; selected: string; summary: string; compact?: boolean; perRow?: number; small?: boolean; narrow?: boolean; bare?: boolean; more?: string[] }

type State = { t: number; hover: number; px: number; react: Record<string, ReactionState> }

// a few frames a second at rest: enough for a blink and a monitor, and each redraw is a chance for the terminal to
// tear; a reaction's frames come faster, so the clock ticks every FINE ms and redraws only when a frame changes
const STEP = 250
const FINE = 40
// the member's own space: its body (11 cells, one cell in) plus room to the side and above for what floats around it
const CANVAS_W = 15

/**
 * A desk's geometry. `canvas`: the member's rows (the body at the bottom, `above` rows over its head), `cw` across
 * with the body `inset` cells in; `w`: the desk across; `gap`: the columns to the next desk; `h`: the desk's rows
 * (the canvas, the desktop, the name, model and status lines); a row of desks is `h + 1` down. The full desk has a
 * monitor beside the member; the small one is the member alone at its desk; the narrow one is the member with only
 * its name and model under it, nothing over its head (model.ts: DESK_W/H, SMALL_DESK_W/H, NARROW_DESK_W/H). The
 * member is drawn the same at all three.
 */
type Geom = { above: number; canvas: number; cw: number; inset: number; w: number; gap: number; h: number; monitor: boolean; desk: boolean }
const FULL: Geom = { above: 3, canvas: 7, cw: CANVAS_W, inset: 1, w: CANVAS_W + 7, gap: 2, h: 11, monitor: true, desk: true }
const SMALL: Geom = { above: 1, canvas: 5, cw: CANVAS_W, inset: 1, w: CANVAS_W, gap: 1, h: 9, monitor: false, desk: true }
const NARROW: Geom = { above: 0, canvas: 4, cw: 11, inset: 0, w: 11, gap: 1, h: 6, monitor: false, desk: false }
const geomOf = (p: SceneProps): Geom => (p.narrow ? NARROW : p.small ? SMALL : FULL)
const cellOf = (g: Geom) => g.w + g.gap
/** Where the member's face is across its desk: the body's middle. */
const faceX = (g: Geom) => g.inset + 5
/** Rows above the first desk: the title line, then the back wall unless the room is short (`compact`). */
/** The rows over the first row of desks: the title line (none when bare) and the back wall (none when compact). */
const topOf = (p: Pick<SceneProps, 'compact' | 'bare'>) => (p.bare ? 0 : 1) + (p.compact ? 0 : 2)

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

/** A cell of a desk's picture: the member's body, a mark floating by it, the monitor (a prop, with its colour), or nothing. */
type Cell = { ch: string; kind: 'body' | 'fx' | 'prop' | 'none'; color?: string }

/** The monitor beside the member, row by row (row 4 is its screen, drawn from the status). */
const MONITOR = ['       ', '       ', '       ', '▗▄▄▄▄▄▖', '', '▝▀▀▀▀▀▘', '  ▗█▖  ']
/** The rightmost column a shape draws in. */
const lastCol = (shape: readonly string[]) => Math.max(...shape.map(line => Math.max(line.lastIndexOf('#'), line.lastIndexOf('o'))))

function member(a: SceneAgent, st: State, gaze: number, geo: Geom): Cell[][] {
  const t = st.t / 1000
  const ph = phaseOf(a.id)
  const fr = frameAt(st.react[a.id], st.t)
  const shape = fr ? fr.shape : BODY
  // the eyes move within the face (at rest toward the pointer or the monitor; in a reaction where it looks); the
  // shape around them does not
  const g = Math.max(-1, Math.min(1, fr ? fr.look : gaze))
  const rows = shape.map(line => {
    if (!line.includes('o') || g === 0) return line
    const plain = line.replace(/o/g, '#').split('')
    line.split('').forEach((ch, x) => { if (ch === 'o' && plain[x + g] === '#') plain[x + g] = 'o' })
    return plain.join('')
  })
  const blink = (a.status === 'working' || a.status === 'done') && ((t + ph * 3) % 3.6) < 0.14
  const eye = blink ? '-' : a.status === 'done' ? '^' : a.status === 'waiting' ? '-' : a.status === 'failed' ? 'x' : ' '
  const eyes = fr ? fr.eyes : eye
  const eyeAt = (x: number) => (eyes.length > 1 ? eyes[x < 5 ? 0 : 1]! : eyes)
  // the body stands at the bottom of the canvas, `inset` cells in: the rows above it and the columns to its right
  // stay free for what floats around it, so nothing reaches the monitor or the next desk. A reaction lifts it (never
  // past the top: the small desk has one row over the head, the narrow none), sinks it behind the desk (out of
  // sight at +4) or moves it across the desk, behind the monitor. A shape taller than the canvas keeps its feet on
  // the ground and loses the top of its head.
  const tall = shape.length / 2
  const base = geo.canvas - tall
  const top0 = Math.max(Math.min(0, base), Math.min(geo.canvas, base + (fr?.dy ?? 0)))
  const left0 = Math.max(0, Math.min(geo.w - 1 - lastCol(shape), geo.inset + (fr?.dx ?? 0)))
  const grid: Cell[][] = Array.from({ length: geo.canvas }, () => Array.from({ length: geo.w }, () => ({ ch: ' ', kind: 'none' as const })))
  for (let r = 0; r < tall; r++) {
    const top = rows[r * 2]!
    const bot = rows[r * 2 + 1]!
    for (let x = 0; x < top.length; x++) {
      const cell = grid[r + top0]?.[x + left0]
      if (!cell) continue
      if (top[x] === 'o' || bot[x] === 'o') { cell.ch = eyeAt(x); cell.kind = 'body'; continue }
      const up = top[x] === '#'
      const down = bot[x] === '#'
      if (up || down) { cell.ch = up && down ? '█' : up ? '▀' : '▄'; cell.kind = 'body' }
    }
  }
  // the monitor stands in front of the member, who can creep behind it: its frame and screen hide what is behind
  // them, and the member shows through the gaps by its stand
  if (geo.monitor) {
    const screen = screenOf(a, t + ph * 5)
    const screenColor = a.status === 'failed' ? 'error' : a.status === 'waiting' ? 'inactive' : 'success'
    for (let r = 0; r < geo.canvas; r++) {
      const line = r === 4 ? `▐${screen}▌` : MONITOR[r] ?? ''
      ;[...line].forEach((ch, k) => {
        const cell = grid[r]?.[geo.cw + k]
        if (!cell || (ch === ' ' && r !== 4)) return
        cell.ch = ch
        cell.kind = 'prop'
        cell.color = r === 4 && k > 0 && k < line.length - 1 ? screenColor : 'inactive'
      })
    }
  }
  const put = (r: number, c: number, ch: string) => { const cell = grid[r]?.[c]; if (cell && cell.kind === 'none') { cell.ch = ch; cell.kind = 'fx' } }
  // a reaction's own marks, around the body where it is now: kept on the canvas, where a free cell is
  const clampR = (r: number) => Math.max(0, Math.min(geo.canvas - 1, r))
  const clampC = (c: number) => Math.max(0, Math.min(geo.w - 1, c))
  if (fr) {
    for (const [r, c, ch] of fr.fx) put(clampR(top0 + r), clampC(left0 + c), ch)
    return grid
  }
  // the small desk has one row over the head: what floats rises beside it, in the columns to its right; the
  // narrow desk has neither, and it floats in the corners the round body leaves free
  const narrow = geo.cw < CANVAS_W
  const small = geo.above < 3
  if (a.status === 'waiting') {
    const path: Array<[number, number]> = narrow ? [[0, 10], [0, 9], [0, 10]] : small ? [[2, 12], [1, 13], [0, 14]] : [[2, 11], [1, 12], [0, 13]]
    for (const off of [0, 0.5]) {
      const q = (t / 2.6 + ph + off) % 1
      const [r, c] = path[Math.min(2, Math.floor(q * 3))]!
      put(r, c, q < 0.5 ? 'z' : 'Z')
    }
  } else if (a.status === 'done') {
    const spots: Array<[number, number]> = narrow
      ? [[0, 0], [0, 10], [0, 1], [0, 9], [2, 0], [2, 10]]
      : small
      ? [[0, 2], [0, 10], [2, 13], [3, 0], [1, 12], [0, 6]]
      : [[2, 1], [1, 3], [2, 12], [1, 9], [4, 0], [4, 13]]
    spots.forEach(([r, c], i) => { const k = Math.floor(t * 2.5 + i * 1.7) % 5; if (k < 2) put(r, c, k ? '+' : '*') })
  } else if (a.status === 'failed') {
    const q = (t / 1.4 + ph) % 1
    put(top0 + Math.floor(q * 3), narrow ? 10 : 13, "'")
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
  const dy = y - topOf(props)
  if (dy < 0 || x < 0) return -1
  const row = Math.floor(dy / (geo.h + 1))
  if (dy % (geo.h + 1) >= geo.h) return -1
  const col = Math.floor(x / cellOf(geo))
  if (x % cellOf(geo) >= geo.w || col >= per) return -1
  const i = row * per + col
  return i < props.agents.length ? i : -1
}

/** A click (or 1-9, Enter) on member `i` at `now`: it reacts, and the hooks module shows its session. */
function pick(surface: ClientSurface<State>, i: number, now: number): void {
  const a = latest.agents[i]
  const s = surface.state
  if (!a || !s) return
  surface.setState({ ...s, t: now, hover: i, react: { ...s.react, [a.id]: react(s.react[a.id], a.id, a.status, now, geomOf(latest).monitor) } })
  surface.post({ type: 'select', id: a.id })
}

// ------------------------------------------------------------------ the drawing

const OfficeScene: ClientModule<SceneProps, State> = (props, surface) => {
  latest = props
  if (!surface.state) {
    // the clock runs finer than the redraws: a redraw each STEP at rest, and one whenever a reaction's frame changes
    let clock = 0
    let drawnAt = 0
    let drawnFrames = ''
    surface.every(FINE, () => {
      clock += FINE
      const s = surface.state
      if (!s) return
      const frames = Object.entries(s.react).map(([id, r]) => `${id}:${frameIndex(r, clock)}`).join(',')
      if (frames === drawnFrames && clock - drawnAt < STEP) return
      drawnFrames = frames
      drawnAt = clock
      surface.setState({ ...s, t: clock })
    })
    surface.onPointer((e: ClientPointerEvent) => {
      const s = surface.state
      if (!s) return
      if (e.type === 'leave') { if (s.hover !== -1) surface.setState({ ...s, hover: -1 }); return }
      const per = perRowOf(latest, surface.columns || 100)
      const i = stationAt(e.x, e.y, per, latest)
      if (e.type === 'down' && e.button === 'left') { if (i >= 0) pick(surface, i, clock); return }
      // redraw on a move only when what is drawn changes: the member under the pointer, or where its eyes look
      const g = geomOf(latest)
      const cell = cellOf(g)
      const look = (hover: number, x: number) => (hover < 0 ? 0 : Math.abs(x - ((hover % per) * cell + faceX(g))) > 2 ? Math.sign(x - ((hover % per) * cell + faceX(g))) : 0)
      if (e.type === 'move' && (i !== s.hover || look(i, e.x) !== look(s.hover, s.px))) surface.setState({ ...s, hover: i, px: e.x })
    })
    surface.onKey((e: ClientKeyEvent) => {
      const s = surface.state
      if (!s) return
      // the tab keys work here too: a click on the scene gives it the keyboard, away from the tab buttons
      const tabKey: Record<string, string> = { o: 'office', w: 'work', s: 'savings', t: 'team', c: 'settings' }
      if (tabKey[e.key]) { surface.post({ type: 'tab', id: tabKey[e.key]! }); return }
      const n = latest.agents.length
      if (!n) return
      if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1
        const left = latest.more?.[i - n]
        if (i < n) pick(surface, i, clock)
        else if (left) surface.post({ type: 'select', id: left })      // one of the line under the desks
        return
      }
      if (e.key === 'right' || e.key === 'left') {
        const cur = s.hover < 0 ? 0 : s.hover
        surface.setState({ ...s, hover: (cur + (e.key === 'right' ? 1 : n - 1)) % n })
        return
      }
      if (e.key === 'return' && s.hover >= 0) pick(surface, s.hover, clock)
    })
    surface.setState({ t: 0, hover: -1, px: 0, react: {} })
  }
  const st: State = surface.state ?? { t: 0, hover: -1, px: 0, react: {} }
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
    const charCenter = (i % per) * cell + faceX(geo)
    const gaze = isHover && Math.abs(st.px - charCenter) > 2 ? Math.sign(st.px - charCenter) : a.status === 'working' && Math.floor(t / 2.5 + phaseOf(a.id) * 3) % 3 === 0 ? 1 : 0
    const grid = member(a, st, gaze, geo)
    const tone = ROLE_COLOR[a.role]
    const dim = a.status === 'waiting' && !isSel && !isHover
    const colorOf = (c: Cell) => (c.kind === 'fx' ? STATUS_COLOR[a.status] : c.kind === 'prop' ? c.color ?? 'inactive' : tone)
    const rows = grid.map((cells, r) => {
      const runs: Array<{ text: string; color: string }> = []
      for (const c of cells) { const color = colorOf(c); const last = runs[runs.length - 1]; if (last && last.color === color) last.text += c.ch; else runs.push({ text: c.ch, color }) }
      return (
        <Text key={`m-${a.id}-${r}`}>
          {runs.map((run, k) => <Text key={`m-${a.id}-${r}-${k}`} color={run.color} dimColor={dim}>{run.text}</Text>)}
        </Text>
      )
    })
    // the lines start where the body does; the narrow desk shortens a medium effort and leaves the status to the
    // member's eyes and marks (and to the session below)
    const pad = geo.monitor ? '  ' : geo.inset ? ' ' : ''
    const name = isSel ? (pad ? `▸${pad.slice(1)}${a.label}` : `▸${a.label}`) : `${pad}${a.label}`
    const effort = geo.desk ? a.effort : a.effort === 'medium' ? 'med' : a.effort
    const model = geo.monitor ? `${a.model}${a.effort ? ` · ${a.effort}` : ''}` : `${a.model}${effort ? ` ${effort}` : ''}`
    return (
      <Box key={`st-${a.id}`} flexDirection="column" width={geo.w} marginRight={i % per === per - 1 ? 0 : geo.gap} marginBottom={1}>
        {rows}
        {geo.desk ? <Text color={WOOD}>{'▀'.repeat(geo.w)}</Text> : null}
        <Text wrap="truncate-end" bold color={tone} underline={isHover && !isSel}>{name}</Text>
        <Text wrap="truncate-end" dimColor>{pad}{model}</Text>
        {geo.desk ? <Text wrap="truncate-end" color={STATUS_COLOR[a.status]}>{pad}{STATUS_WORD[a.status]} {a.status === 'waiting' ? '' : a.time}</Text> : null}
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
      {props.bare ? null : (
        <Box justifyContent="space-between" width={span}>
          <Text bold wrap="truncate-end">DO IT ALL · team office</Text>
          <Text dimColor wrap="truncate-end">{props.summary}</Text>
        </Box>
      )}
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

