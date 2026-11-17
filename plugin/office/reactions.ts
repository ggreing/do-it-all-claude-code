// What a member of the office does for a moment when the person clicks it. Pure: no engine and no clock of its
// own; scene.tsx asks for the frame at a time and draws it. At rest a member is always drawn in its one shape
// (BODY); a reaction may stretch, squash, lift or sway it, each at its own pace, and always ends, after which the
// member is drawn in that one shape again.
//
// Ten motions. A click picks one of the eight everyday ones at random (never the same one twice in a row), played
// with the eyes and marks of the member's status (done: happy eyes and sparkles; failed: teary eyes and a drop;
// asleep: sleepy eyes that open wide when startled). Clicks that follow each other closely make it bigger: the
// second a hop or a startle, the third and fourth dizziness, the fifth and on a huff.

export type ReactionStatus = 'working' | 'done' | 'waiting' | 'failed'

/** Marks drawn around the body: [row, column, glyph] from the body's top-left cell (row -1 is the row above its head). */
export type Mark = readonly [number, number, string]

/** One drawn moment of a reaction. */
export type ReactionFrame = {
  /** the body, two pixels to a cell, 11 across: '#' the body, 'o' the eyes, '.' nothing */
  shape: readonly string[]
  /** cells up from where the member stands (negative: up), and cells across */
  dy: number
  dx: number
  /** one glyph for both eyes, or two: the left eye's and the right eye's */
  eyes: string
  fx: readonly Mark[]
  /** how long this frame stays */
  ms: number
}

/** The eight everyday motions, then the two that clicks in a row lead to. */
export const EVERYDAY = ['nod', 'wave', 'hop', 'wiggle', 'stretch', 'squish', 'startle', 'shake'] as const
export type ReactionId = (typeof EVERYDAY)[number] | 'dizzy' | 'huff'
export const ALL_REACTIONS: readonly ReactionId[] = [...EVERYDAY, 'dizzy', 'huff']

/** A member's reaction in progress: which, in which status' manner, when it began, how many clicks in a row led to it, the last click. */
export type ReactionState = { id: ReactionId; status: ReactionStatus; at: number; combo: number; last: number }

// ------------------------------------------------------------------ the shapes

/** The member's one shape: a round one-piece body. */
export const BODY = [
  '...#####...',
  '..#######..',
  '.##o###o##.',
  '.##o###o##.',
  '.#########.',
  '..#######..',
  '..##...##..',
  '...........',
]
/** Pressed down: lower and a little wider. */
export const PRESSED = [
  '...........',
  '...#####...',
  '.##o###o##.',
  '###o###o###',
  '###########',
  '.#########.',
  '..##...##..',
  '...........',
]
/** Squashed flat: lower and wider still, the feet apart. */
const FLAT = [
  '...........',
  '...........',
  '..#######..',
  '.##o###o##.',
  '###########',
  '###########',
  '.##.....##.',
  '...........',
]
/** In the air: the feet tucked in. */
const AIR = [
  '...#####...',
  '..#######..',
  '.##o###o##.',
  '.##o###o##.',
  '.#########.',
  '..#######..',
  '...##.##...',
  '...........',
]
/** Stretched up: taller and narrower (one cell taller than BODY). */
const TALL = [
  '....###....',
  '...#####...',
  '..#######..',
  '..#######..',
  '..##o#o##..',
  '..##o#o##..',
  '..#######..',
  '...#####...',
  '...##.##...',
  '...........',
]
/** Leaning to its right, the feet where they were. */
const TILT_R = [
  '....#####..',
  '...#######.',
  '..##o###o##',
  '..##o###o##',
  '.#########.',
  '..#######..',
  '..##...##..',
  '...........',
]
const TILT_L = TILT_R.map(line => [...line].reverse().join(''))
/** Puffed up: rounder, the eyes far apart. */
const PUFF = [
  '..#######..',
  '.#########.',
  '##o#####o##',
  '##o#####o##',
  '###########',
  '.#########.',
  '..##...##..',
  '...........',
]
/** Shrunk into itself. */
const SHY = [
  '...........',
  '...........',
  '...#####...',
  '..#######..',
  '..##o#o##..',
  '..#######..',
  '...##.##...',
  '...........',
]
/** Sagging: lower, the head down. */
const DROOP = [
  '...........',
  '...#####...',
  '..#######..',
  '.##o###o##.',
  '.#########.',
  '.#########.',
  '..##...##..',
  '...........',
]

/** Every shape a reaction draws, for the checks (office-reactions.test.ts). */
export const SHAPES: Readonly<Record<string, readonly string[]>> = { BODY, PRESSED, FLAT, AIR, TALL, TILT_R, TILT_L, PUFF, SHY, DROOP }

// ------------------------------------------------------------------ the motions, in a status' manner

/** How a status plays a motion: its eyes, its eyes opened wide, the mark it makes, and whether it sags. */
type Manner = { eyes: string; wide: string; mark: string; spark: string; sag: boolean }
const MANNER: Readonly<Record<ReactionStatus, Manner>> = {
  working: { eyes: 'o', wide: 'O', mark: '!', spark: '+', sag: false },
  done: { eyes: '^', wide: '^', mark: '*', spark: '*', sag: false },
  waiting: { eyes: '-', wide: 'O', mark: 'z', spark: '?', sag: false },
  failed: { eyes: 'T', wide: 'x', mark: "'", spark: "'", sag: true },
}

const f = (shape: readonly string[], ms: number, eyes: string, o: { dy?: number; dx?: number; fx?: readonly Mark[] } = {}): ReactionFrame =>
  ({ shape, ms, eyes, dy: o.dy ?? 0, dx: o.dx ?? 0, fx: o.fx ?? [] })

const MOTIONS: Readonly<Record<ReactionId, (m: Manner) => ReactionFrame[]>> = {
  // a quick double nod
  nod: m => [f(PRESSED, 90, m.eyes), f(BODY, 110, m.eyes), f(PRESSED, 90, m.eyes), f(BODY, 320, m.eyes, { fx: [[-1, 11, m.mark]] })],
  // leaning one way, then the other, then back
  wave: m => [
    f(TILT_L, 150, m.eyes), f(BODY, 90, m.eyes), f(TILT_R, 150, m.eyes), f(BODY, 90, m.eyes),
    f(TILT_L, 150, m.eyes, { fx: [[-1, 0, m.spark]] }), f(BODY, 260, m.eyes),
  ],
  // a crouch, up two rows, and a soft landing
  hop: m => [
    f(PRESSED, 80, m.eyes), f(AIR, 80, m.eyes, { dy: -1 }), f(AIR, 150, m.eyes, { dy: -2, fx: [[0, -1, m.spark], [0, 11, m.spark]] }),
    f(AIR, 80, m.eyes, { dy: -1, fx: [[-1, 11, m.spark]] }), f(FLAT, 90, m.eyes), f(PRESSED, 80, m.eyes),
    f(BODY, 320, m.eyes, { fx: [[-1, 1, m.spark], [-1, 9, m.spark]] }),
  ],
  // a fast shimmy
  wiggle: m => [
    ...Array.from({ length: 6 }, (_, k) => f(k % 2 ? TILT_R : TILT_L, 85, m.eyes)),
    f(BODY, 260, m.eyes, { fx: [[-1, 10, m.spark]] }),
  ],
  // a slow stretch up, held, and down
  stretch: m => [
    f(PRESSED, 140, '-'), f(TALL, 440, m.sag ? m.eyes : '-', { fx: [[-1, 1, m.spark], [-1, 9, m.spark]] }),
    f(TALL, 240, m.eyes), f(PRESSED, 140, m.eyes), f(BODY, 260, m.eyes),
  ],
  // squashed and springing back, twice: soft as dough
  squish: m => [
    f(PRESSED, 110, m.eyes), f(m.sag ? DROOP : FLAT, 150, m.eyes), f(PRESSED, 100, m.eyes), f(BODY, 120, m.eyes),
    f(m.sag ? SHY : PRESSED, 110, m.eyes, { fx: [[1, 11, m.mark]] }), f(BODY, 240, m.eyes),
  ],
  // jumps at the click, eyes wide, and settles
  startle: m => [
    f(PRESSED, 60, m.eyes), f(AIR, 90, m.wide, { dy: -1, fx: [[-1, 5, '!']] }), f(AIR, 160, m.wide, { dy: -1, fx: [[-1, 5, '!']] }),
    f(FLAT, 70, m.wide), f(BODY, 380, m.wide), f(BODY, 140, '-'), f(BODY, 360, m.eyes),
  ],
  // shakes its head side to side
  shake: m => [
    f(BODY, 100, m.wide, { dx: -1 }), f(BODY, 100, m.wide, { dx: 1 }), f(BODY, 100, m.wide, { dx: -1 }),
    f(BODY, 100, m.wide, { dx: 1 }), f(BODY, 280, m.eyes, { fx: [[-1, 11, m.mark]] }),
  ],
  // clicked again and again: the room spins
  dizzy: () => [
    f(BODY, 230, '@', { dx: -1, fx: [[-1, 2, '~']] }), f(TILT_L, 230, '@', { fx: [[-1, 5, '~']] }), f(BODY, 230, '@', { dx: 1, fx: [[-1, 8, '~']] }),
    f(TILT_R, 230, '@', { fx: [[-1, 5, '~']] }), f(BODY, 260, '@', { dx: -1, fx: [[-1, 2, '~']] }), f(TILT_L, 260, '@', { fx: [[-1, 5, '~']] }),
    f(PRESSED, 200, '@'), f(BODY, 360, '-'),
  ],
  // and then it has had enough
  huff: () => [
    f(PUFF, 190, '><', { fx: [[-1, 2, '#']] }), f(PUFF, 190, '><', { fx: [[-1, 8, '#']] }), f(PUFF, 190, '><', { fx: [[-1, 2, '#'], [-1, 8, '#']] }),
    f(PRESSED, 150, '><'), f(BODY, 420, '-'),
  ],
}

const STATUSES: readonly ReactionStatus[] = ['working', 'done', 'waiting', 'failed']
/** Every motion in every status' manner, made once. */
export const REACTIONS: Readonly<Record<ReactionStatus, Readonly<Record<ReactionId, readonly ReactionFrame[]>>>> = Object.fromEntries(
  STATUSES.map(s => [s, Object.fromEntries(ALL_REACTIONS.map(id => [id, MOTIONS[id](MANNER[s])]))]),
) as Record<ReactionStatus, Record<ReactionId, ReactionFrame[]>>

/** The second click in a row: something bigger. */
const BIGGER: Readonly<Record<ReactionStatus, ReactionId>> = { working: 'hop', done: 'hop', waiting: 'startle', failed: 'shake' }
/** A click within this long of the one before is the next in a row. */
export const COMBO_MS = 1600

// ------------------------------------------------------------------ choosing and playing

export const reactionLength = (id: ReactionId, status: ReactionStatus = 'working'): number =>
  REACTIONS[status][id].reduce((n, fr) => n + fr.ms, 0)

function mix(text: string): number {
  let n = 2166136261
  for (const ch of text) n = Math.imul(n ^ (ch.codePointAt(0) ?? 0), 16777619) >>> 0
  return n
}

/**
 * The reaction to a click at `now` on member `memberId` in `status`, given its reaction before (or none). The
 * pick is random but repeatable: the same click at the same time picks the same.
 */
export function react(prev: ReactionState | undefined, memberId: string, status: ReactionStatus, now: number): ReactionState {
  const combo = prev && now - prev.last <= COMBO_MS ? prev.combo + 1 : 1
  let id: ReactionId
  if (combo >= 5) id = 'huff'
  else if (combo >= 3) id = 'dizzy'
  else if (combo === 2) id = BIGGER[status]
  else {
    let k = mix(`${memberId}|${now}`) % EVERYDAY.length
    if (prev && EVERYDAY[k] === prev.id) k = (k + 1 + (mix(`${now}`) % (EVERYDAY.length - 1))) % EVERYDAY.length
    id = EVERYDAY[k]!
  }
  return { id, status, at: now, combo, last: now }
}

/** Which frame of the reaction shows at `now`: its index, or -1 once it is over (or before it began). */
export function frameIndex(r: ReactionState | undefined, now: number): number {
  if (!r) return -1
  let t = now - r.at
  if (t < 0) return -1
  const frames = REACTIONS[r.status][r.id]
  for (let k = 0; k < frames.length; k++) {
    if (t < frames[k]!.ms) return k
    t -= frames[k]!.ms
  }
  return -1
}

/** The frame to draw at `now`, or null: the member at rest, in its one shape. */
export function frameAt(r: ReactionState | undefined, now: number): ReactionFrame | null {
  const k = frameIndex(r, now)
  return k < 0 ? null : REACTIONS[r!.status][r!.id][k]!
}
