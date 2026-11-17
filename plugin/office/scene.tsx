import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'

// The office scene, drawn by its own surface module so it keeps a frame clock and the pointer: the members are
// soft one-piece blobs drawn in one fixed shape (two pixels to a cell, half blocks); what moves is the eyes, what
// floats above the head and the monitor. A click presses the member down for a moment; it is picked, and posts the pick to the hooks module, which shows that member's session below the office.

type Role = 'lead' | 'architect' | 'coder' | 'reviewer' | 'tester' | 'ui-designer' | 'helper'
type Status = 'working' | 'done' | 'waiting' | 'failed'
export type SceneAgent = { id: string; role: Role; label: string; model: string; effort: string; status: Status; time: string; doing: string }
export type SceneProps = { agents: SceneAgent[]; selected: string; summary: string }

type State = { t: number; hover: number; px: number; bounce: Record<string, number> }

const STEP = 100
const CANVAS_W = 13
const CANVAS_ROWS = 6
const STATION_W = 20
const CELL = STATION_W + 2
const STATION_H = CANVAS_ROWS + 4
const ROW_H = STATION_H + 1
const TOP = 3

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

function phaseOf(id: string): number { let h = 7; for (const ch of id) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 997; return h / 997 }

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

function member(a: SceneAgent, st: State, gaze: number): Cell[][] {
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
  // the body sits at the bottom of the canvas, one cell in: rows 0 and 1 stay free for what floats above the head
  const grid: Cell[][] = Array.from({ length: CANVAS_ROWS }, () => Array.from({ length: CANVAS_W }, () => ({ ch: ' ', kind: 'none' as const })))
  for (let r = 0; r < 4; r++) {
    const top = rows[r * 2]!
    const bot = rows[r * 2 + 1]!
    for (let x = 0; x < top.length; x++) {
      const cell = grid[r + 2]![x + 1]!
      if (top[x] === 'o' || bot[x] === 'o') { cell.ch = eye; cell.kind = 'body'; continue }
      const up = top[x] === '#'
      const down = bot[x] === '#'
      if (up || down) { cell.ch = up && down ? '█' : up ? '▀' : '▄'; cell.kind = 'body' }
    }
  }
  const put = (r: number, c: number, ch: string) => { const cell = grid[r]?.[c]; if (cell && cell.kind === 'none') { cell.ch = ch; cell.kind = 'fx' } }
  if (a.status === 'waiting') {
    for (const off of [0, 0.5]) {
      const q = (t / 2.6 + ph + off) % 1
      put(q < 0.5 ? 1 : 0, 9 + Math.floor(q * 3), q < 0.5 ? 'z' : 'Z')
    }
  } else if (a.status === 'done') {
    const spots: Array<[number, number]> = [[1, 1], [0, 3], [1, 11], [0, 9], [3, 0], [3, 12]]
    spots.forEach(([r, c], i) => { const k = Math.floor(t * 2.5 + i * 1.7) % 5; if (k < 2) put(r, c, k ? '+' : '*') })
  } else if (a.status === 'failed') {
    const q = (t / 1.4 + ph) % 1
    put(2 + Math.floor(q * 3), 12, "'")
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

function perRow(columns: number): number { return Math.max(1, Math.floor(Math.max(columns, CELL) / CELL)) }

function stationAt(x: number, y: number, columns: number, count: number): number {
  const dy = y - TOP
  if (dy < 0 || x < 0) return -1
  const row = Math.floor(dy / ROW_H)
  if (dy % ROW_H >= STATION_H) return -1
  const col = Math.floor(x / CELL)
  if (x % CELL >= STATION_W || col >= perRow(columns)) return -1
  const i = row * perRow(columns) + col
  return i < count ? i : -1
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
      const i = stationAt(e.x, e.y, Math.max(CELL, surface.columns || 100), latest.agents.length)
      if (e.type === 'down' && e.button === 'left') { if (i >= 0) pick(surface, i); return }
      if (e.type === 'move' && (i !== s.hover || e.x !== s.px)) surface.setState({ ...s, hover: i, px: e.x })
    })
    surface.onKey((e: ClientKeyEvent) => {
      const s = surface.state
      if (!s) return
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
  const columns = Math.max(CELL, surface.columns || 100)
  const per = perRow(columns)
  const agents = props.agents

  const clock = (() => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` })()
  const windowUnit = ['    ▐▀▀▀▀▌    ', '    ▐▄▄▄▄▌    ']
  const wall = windowUnit.map((u, j) => {
    const line = u.repeat(Math.ceil(columns / u.length)).slice(0, columns)
    return j === 0 && columns > 12 ? `${line.slice(0, columns - 9)} [${clock}]` : line
  })

  const station = (a: SceneAgent, i: number): RenderElement => {
    const isSel = a.id === props.selected
    const isHover = i === st.hover
    const charCenter = (i % per) * CELL + 6
    const gaze = isHover && Math.abs(st.px - charCenter) > 2 ? Math.sign(st.px - charCenter) : a.status === 'working' && Math.floor(t / 2.5 + phaseOf(a.id) * 3) % 3 === 0 ? 1 : 0
    const grid = member(a, st, gaze)
    const tone = ROLE_COLOR[a.role]
    const dim = a.status === 'waiting' && !isSel && !isHover
    const scr = screenOf(a, t + phaseOf(a.id) * 5)
    const monitor = ['       ', '       ', '▗▄▄▄▄▄▖', '', '▝▀▀▀▀▀▘', '  ▗█▖  ']
    const rows = grid.map((cells, r) => {
      const runs: Array<{ text: string; kind: Cell['kind'] }> = []
      for (const c of cells) { const last = runs[runs.length - 1]; if (last && last.kind === c.kind) last.text += c.ch; else runs.push({ text: c.ch, kind: c.kind }) }
      return (
        <Text key={`m-${a.id}-${r}`}>
          {runs.map((run, k) => <Text key={`m-${a.id}-${r}-${k}`} color={run.kind === 'fx' ? STATUS_COLOR[a.status] : tone} dimColor={dim}>{run.text}</Text>)}
          {r === 3
            ? <Text><Text color="inactive" dimColor={dim}>▐</Text><Text color={a.status === 'failed' ? 'error' : a.status === 'waiting' ? 'inactive' : 'success'} dimColor={dim}>{scr}</Text><Text color="inactive" dimColor={dim}>▌</Text></Text>
            : <Text color="inactive" dimColor={dim}>{monitor[r]}</Text>}
        </Text>
      )
    })
    const name = isSel ? `▸ ${a.label}` : `  ${a.label}`
    return (
      <Box key={`st-${a.id}`} flexDirection="column" width={STATION_W} marginRight={2} marginBottom={1}>
        {rows}
        <Text color={WOOD}>{'▀'.repeat(STATION_W)}</Text>
        <Text wrap="truncate-end" bold color={tone} underline={isHover && !isSel}>{name}</Text>
        <Text wrap="truncate-end" dimColor>  {a.model}{a.effort ? ` · ${a.effort}` : ''}</Text>
        <Text wrap="truncate-end" color={STATUS_COLOR[a.status]}>  {STATUS_WORD[a.status]} {a.status === 'waiting' ? '' : a.time}</Text>
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

  return (
    <Box flexDirection="column" width={columns}>
      <Box justifyContent="space-between" width={columns}>
        <Text bold>DO IT ALL · team office</Text>
        <Text dimColor>{props.summary}</Text>
      </Box>
      {wall.map((w, j) => <Text key={`wall-${j}`} color="inactive" dimColor>{w}</Text>)}
      <Box flexDirection="row" flexWrap="wrap" width={columns}>
        {agents.map(station)}
        {agents.length % per !== 0 || agents.length === 0 ? plant : null}
      </Box>
      {agents.length === 0 ? <Text dimColor>  The team takes its desks when a request gets one · /office demo for a preview</Text> : null}
    </Box>
  )
}

export default OfficeScene

