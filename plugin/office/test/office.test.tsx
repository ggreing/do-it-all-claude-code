// The team office under Claude Code's plugin test kit (`claude plugin test plugin/`, in the release checklist;
// decision 186 ⑧). No model calls, no network, no files: the kit stands in for the engine, and a mocked
// process.spawn stands in for the router's helper (office/bridge.mjs).
import { mock, test } from 'claude-code/testing'

function must(label: string, v: unknown): void { if (!v) throw new Error(`${label} not found`) }

const PANE = {
  plugin: 'do-it-all-claude-code',
  component: 'Pane',
  requestId: 'office',
  props: {
    title: 'Team office',
    isFocused: false,
    bodyColumns: 120,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const OFFICE_LINE = JSON.stringify({
  v: 1, type: 'office', reach: 'ok',
  view: {
    request: { id: 'r-1', level: 'L2', source: 'rule', preset: 'L2', status: 'open', budgetUsd: 4, usedUsd: 0.1, leadDirect: false, leadModel: 'sonnet', difficulty: 'hard', difficultySource: 'lead' },
    subtasks: [{ id: 'A', role: 'coder', slot: 0, step: 's2', model: 'haiku', effort: 'high', estimated: false, status: 'passed', verdict: 'pass', attempts: 1, agentId: 'demo-a', scope: ['src/**'],
      checks: [{ kind: 'test', result: 'ok', testsPassed: 12, testsFailed: 0 }], repro: null }],
    costUsd: 0.12, costEstimated: false, costUnknown: false, sessionCostUsd: 0.12, limits: null,
  },
})

type On = Parameters<Parameters<typeof test>[1]>[1]

/** The engine around the office: a tested Claude Code build, a session id, a clock, and a helper that says `lines`. */
function engine(on: On, lines: string[] = [], env: Record<string, string> = {}): { spawned: string[][]; clock: ReturnType<typeof mock.clock> } {
  const spawned: string[][] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, env)
  on('session.version', () => ({ value: { version: '2.1.325' } }))
  on('session.id', () => ({ value: 'kit-session' }))
  on('command.register', () => ({ value: { command: 'office' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    for (const l of lines) yield { stream: 'stdout' as const, text: `${l}\n` }
    return { value: { code: 0, signal: null } }
  })
  return { spawned, clock }
}

test('the preview seats the team, and a press shows that member below', async ($, on) => {
  engine(on)
  await $.command.run({ command: 'office', args: 'demo' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.drawn()
    // the office scene: the members at their desks, drawn by the surface module, with model and effort
    must('title', await ui.find({ type: 'Text', text: /team office/, in: 'office-scene' }))
    must('coder A', await ui.find({ type: 'Text', text: /coder A/, in: 'office-scene' }))
    must('model and effort', await ui.find({ type: 'Text', text: /Haiku · low/, in: 'office-scene' }))
    await ui.advance(1500)
    // the preview opens on coder A: its session is in the space below the office
    must('coder A session', await ui.find({ type: 'Text', text: /Read\(src\/slug\.ts\)/ }))

    // a click on the fourth desk (coder B): it is pressed, and its session shows below
    await ui.pointer({ type: 'down', x: 3 * 24 + 6, y: 3 + 3, button: 'left', in: 'office-scene' })
    await ui.advance(200)
    must('coder B task', await ui.find({ type: 'Text', text: /CLI uses the new slugify/ }))
    // the same desk again: the space below is empty again
    await ui.pointer({ type: 'down', x: 3 * 24 + 6, y: 3 + 3, button: 'left', in: 'office-scene' })
    await ui.advance(200)
    must('empty space', await ui.find({ type: 'Text', text: /Click a member/ }))
    // a hover draws without throwing, and the frames keep coming
    await ui.pointer({ type: 'move', x: 6, y: 6, in: 'office-scene' })
    await ui.advance(3000)
    await ui.drawn({ in: 'office-scene' })
    // back to coder A, as the preview opened, for the next surface
    await ui.pointer({ type: 'down', x: 2 * 24 + 6, y: 3 + 3, button: 'left', in: 'office-scene' })
    await ui.unmount()
  }
})

test('with no team the office says how to fill it', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.drawn()
  must('preview hint', await ui.find({ type: 'Text', text: /office demo/, in: 'office-scene' }))
  must('click hint', await ui.find({ type: 'Text', text: /Click a member/ }))
  await ui.unmount()
})

test('the helper\'s lines reach the office: the level line, and the step against the effort it ran at', async ($, on) => {
  const { spawned, clock } = engine(on, [OFFICE_LINE, JSON.stringify({ v: 1, type: 'alive' })])
  await $.command.run({ command: 'office', args: 'demo' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(1500)
  await ui.advance(1500)
  must('the helper ran', spawned.length > 0 && spawned[0]![0] === 'node' && /bridge\.mjs$/.test(spawned[0]![1]!) && spawned[0]!.includes('kit-session'))
  must('level line, the difficulty beside the level', await ui.find({ type: 'Text', text: /L2 hard · rule · \$0\.120 of \$4/ }))
  // coder A is subtask A: planned s2 (Haiku high), its last request ran at Haiku low
  must('the slot\'s cell and plan', await ui.find({ type: 'Text', text: /Haiku · high \(s2\)/ }))
  must('no alias on a desk that ran at another cell', !(await ui.find({ type: 'Text', text: /\(s2\)/, in: 'office-scene' })))
  must('ran at', await ui.find({ type: 'Text', text: /ran at Haiku low/ }))
  must('checks', await ui.find({ type: 'Text', text: /test ok \(12 passed\)/ }))
  await ui.unmount()
})

test('decision 225: a desk running at its slot\'s cell shows the alias where the desk has room: full and small desks, not narrow ones', async ($, on) => {
  // coder A of the preview runs at Haiku low, its slot's cell (s1)
  const line = JSON.stringify({ ...JSON.parse(OFFICE_LINE), view: { ...JSON.parse(OFFICE_LINE).view, subtasks: [{ ...JSON.parse(OFFICE_LINE).view.subtasks[0], step: 's1', effort: 'low' }] } })
  const { clock } = engine(on, [line])
  await $.command.run({ command: 'office', args: 'demo' })
  for (const [columns, rows, form] of [[120, 40, /^ {2}Haiku · low \(s1\)$/], [54, 34, /^ Haiku low \(s1\)$/], [98, 15, /^Haiku low$/]] as const) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns, scroll: { offset: 0, bodyRows: rows } }, surface: 'terminal' })
    await clock.advance(1500)
    await ui.advance(1500)
    must(`${columns} x ${rows}: coder A's cell`, await ui.find({ type: 'Text', text: form, in: 'office-scene' }))
    // the others ran at no cell of their own (no subtask): no alias on their desks
    must(`${columns} x ${rows}: one alias`, (await ui.findAll({ type: 'Text', text: /\(s\d\)/, in: 'office-scene' })).length === (columns === 98 ? 0 : 1))
    await ui.unmount()
  }
})

test('with the router on and no request yet, the office says so in one line, with isolation off and the limits', async ($, on) => {
  const idle = JSON.stringify({
    v: 1, type: 'office', reach: 'ok',
    view: { request: null, subtasks: [], costUsd: 0, costEstimated: false, costUnknown: false, sessionCostUsd: 0,
      limits: { fiveHour: { usedPercentage: 23.4, resetsAt: null }, sevenDay: { usedPercentage: 41, resetsAt: null } }, project: { name: 'r1', worktree: 'off' } },
  })
  const { clock } = engine(on, [idle])
  await $.command.run({ command: 'office', args: 'demo' })
  // the dock of a 120 x 30 terminal: the line takes a row, and the five members still sit at desks
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 53, scroll: { offset: 0, bodyRows: 25 } }, surface: 'terminal' })
  await clock.advance(1500)
  await ui.advance(1500)
  must('router line', await ui.find({ type: 'Text', text: 'router on · no request yet · isolation off · 5h 23% · 7d 41%' }))
  must('no down line', !(await ui.find({ type: 'Text', text: /not reachable/ })))
  must('desks, not the list', (await ui.find({ key: 'office-scene' })) && !(await ui.find({ key: 'member-demo-a' })))
  must('the session frame', await ui.find({ key: 'session-frame' }))
  await ui.unmount()
})

test('without the router every tab says so in one line; the five tabs switch with their keys and restart the helper', async ($, on) => {
  const { spawned, clock } = engine(on, [JSON.stringify({ v: 1, type: 'office', reach: 'down', view: null })])
  await $.command.run({ command: 'office', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const settle = async () => { await clock.advance(1500); await ui.advance(1500) }
  await settle()
  must('daemon down', await ui.find({ type: 'Text', text: /router daemon not reachable/ }))
  for (const key of ['tab-office', 'tab-work', 'tab-savings', 'tab-team', 'tab-settings']) must(key, await ui.find({ key }))
  for (const id of ['work', 'savings', 'team', 'settings']) {
    await ui.press({ key: `tab-${id}` })
    await settle()
    // each tab draws (a tab that throws shows a line of its own instead), and says the router is down
    must(`${id} without a fault`, !(await ui.find({ key: 'tab-error' })))
    must(`${id}: router down`, await ui.find({ type: 'Text', text: /router daemon not reachable/ }))
    must(`helper for ${id}`, spawned.some(a => a.includes('--tab') && a[a.indexOf('--tab') + 1] === id))
  }
  await ui.press({ key: 'tab-office' })
  await settle()
  must('back in the office', await ui.find({ type: 'Text', text: /Click a member/ }))
  await ui.unmount()
})

// ------------------------------------------------------------------ the tabs' data, in the shapes of the contract

const ISO = (min: number) => new Date(1_000_000 - min * 60_000).toISOString()
const ROW = {
  requestId: 'r-2', state: 'closed', mine: true, createdAt: ISO(20), closedAt: ISO(18), kind: 'feature', level: 'L1', finalLevel: 'L2',
  difficulty: 'moderate', difficultySource: 'default',
  outcome: 'delegated', passed: true, acceptance: 'accepted', subtasks: 3, verifyFailures: 1, stepUps: 1,
  changedFiles: 3, linesAdded: 42, linesRemoved: 7, files: [{ path: 'src/slug.ts', added: 30, removed: 4 }, { path: 'src/cli.ts', added: 10, removed: 3 }],
  durationMs: 92_000, activeMs: 90_000, totalUsd: 0.42, estimated: false, unknown: false, budgetExceeded: false,
}
const WORK = {
  open: [{ ...ROW, requestId: 'r-3', state: 'open', closedAt: null, passed: null, kind: 'bugfix', level: 'L2', finalLevel: 'L2', difficulty: 'hard', difficultySource: 'lead', durationMs: null, files: [] }],
  // r-1 is from before difficulty was kept
  rows: [ROW, { ...ROW, requestId: 'r-1', passed: false, kind: 'docs', level: 'L0', finalLevel: 'L0', difficulty: null, difficultySource: null, totalUsd: 0.05, files: [{ path: 'README.md', added: 2, removed: 1 }], changedFiles: 1 }],
  nextCursor: null, today: { done: 4, failed: 1, usd: 1.82 },
}
const DETAIL = {
  requestId: 'r-2', state: 'closed', createdAt: ISO(20), closedAt: ISO(18), kind: 'feature', taskType: null,
  level: { judged: 'L1', source: 'rule', rule: 'multi-file', confidence: 0.82, final: 'L2', changes: [{ from: 'L1', to: 'L2', why: 'replanned' }], difficulty: 'hard', difficultySource: 'lead' },
  plan: { preset: 'L2', leadDirect: false, leadModel: 'claude-sonnet', leadClass: 'sonnet', budgetUsd: 4, holdout: null },
  outcome: 'delegated', passed: true, acceptance: 'accepted',
  subtasks: [
    { id: 'A', role: 'coder', slot: 0, attempts: 2, step: 's2', model: 'haiku', effort: 'high', estimated: false, ranModel: 'haiku', status: 'passed', verdict: null,
      stepChanges: [{ at: ISO(19), requestId: 'r-2', subtaskId: 'A', role: 'coder', slot: 0, from: 's1', to: 's2', direction: 'up', reason: 'miss', detail: 'wrong_result' }],
      scope: ['src/**'], unscoped: false, files: null,
      checks: [{ kind: 'test', attempt: 1, result: 'failed', testsPassed: 11, testsFailed: 1 }, { kind: 'test', attempt: 2, result: 'ok', testsPassed: 12, testsFailed: 0 }],
      repro: null, review: null, time: { startedAt: ISO(20), stoppedAt: ISO(19), runMs: 41_000, verifyMs: 8000 }, cost: { usd: 0.18, state: 'actual' } },
    { id: 'R', role: 'reviewer', slot: 0, attempts: 1, step: 'opus-medium', model: 'opus', effort: 'medium', estimated: true, ranModel: null, status: 'passed', verdict: 'accept',
      stepChanges: [], scope: [], unscoped: false, files: null, checks: [], repro: null, review: null,
      time: { startedAt: ISO(19), stoppedAt: ISO(18), runMs: 15_000, verifyMs: null }, cost: { usd: 0.09, state: 'actual' } },
  ],
  changes: { changedFiles: 3, linesAdded: 42, linesRemoved: 7, newFiles: 1, deletedFiles: 0, approximate: false },
  files: [{ path: 'src/slug.ts', added: 30, removed: 4, state: 'changed' }, { path: 'src/cli.ts', added: 10, removed: 3, state: 'changed' }, { path: 'test/slug.test.ts', added: 2, removed: 0, state: 'new' }],
  tests: { passed: 12, failed: 0 },
  stepChanges: [{ at: ISO(19), requestId: 'r-2', subtaskId: 'A', role: 'coder', slot: 0, from: 's1', to: 's2', direction: 'up', reason: 'miss', detail: 'wrong_result' }],
  time: { durationMs: 92_000, activeMs: 90_000, awaitingMs: 0, phases: [{ phase: 'lead', ms: 20_000 }, { phase: 'workers', ms: 56_000 }, { phase: 'verify', ms: 16_000 }] },
  timeline: [
    { kind: 'plan', role: null, subtaskId: null, startedAt: ISO(20), endedAt: ISO(19.8), ok: null },
    { kind: 'worker', role: 'coder', subtaskId: 'A', startedAt: ISO(19.8), endedAt: ISO(19.1), ok: true },
    { kind: 'verify', role: null, subtaskId: 'A', startedAt: ISO(19.1), endedAt: ISO(19), ok: true },
    { kind: 'worker', role: 'reviewer', subtaskId: 'R', startedAt: ISO(19), endedAt: ISO(18.5), ok: true },
  ],
  cost: { totalUsd: 0.42, leadUsd: 0.15, workerUsd: 0.27, budgetUsd: 4, estimated: false, unknown: false, budgetExceeded: false, basis: 'transcript' },
  hasPrompt: false,
}
const ASSUMPTIONS = [
  'The lead would have used the same tokens as the workers did.', 'List prices.', 'The lead\'s own cost is the same either way.', 'Briefing and coordination are not taken out.',
]
const savingsOf = (period: string) => ({
  period, since: ISO(60 * 24 * 7), until: ISO(0),
  measured: {
    cost: { label: 'api-equivalent', totalUsd: 4.12, leadUsd: 1.1, workerUsd: 3.02, requests: 38, passed: 35, costPerPassedUsd: 0.118, bySource: { proxy: 0, transcript: 38 }, flags: { estimated: 0, unknown: 1, budgetExceeded: 0 } },
    limits: { fiveHour: { usedPercentage: 42, resetsAt: 1000 + 3600 }, sevenDay: { usedPercentage: 21, resetsAt: null }, updatedAt: 1000 },
  },
  estimated: {
    leadPriced: { workerUsd: 3.02, atLeadPriceUsd: 9.8, differenceUsd: 6.78, requests: 30, leftOut: { noLeadModel: 2, noPrice: 0, noTokens: 0 }, assumptions: ASSUMPTIONS },
    holdout: [
      { leadClass: 'sonnet', level: 'L2', team: { n: 14, accepted: 13, costPerAcceptedUsd: 0.31 }, direct: { n: 2, accepted: 2, costPerAcceptedUsd: 0.45 }, need: { team: 10, direct: 7 }, enough: false, differencePct: null },
    ],
    holdoutRate: 0.1, holdoutMode: 'observe',
  },
  series: { unit: 'day', utcOffsetMinutes: 540, points: Array.from({ length: 7 }, (_, i) => ({ start: ISO(60 * 24 * (6 - i)), requests: 5, passed: 5, totalUsd: [0.2, 0.5, 1.2, 0.8, 0, 0.6, 0.82][i]!, leadUsd: 0.1, workerUsd: 0.3, leadPricedDifferenceUsd: 0.5 })) },
})
const teamOf = (period: string) => ({
  period, since: ISO(60), until: ISO(0), profile: { value: 'balanced', source: 'default' }, leadClass: 'sonnet', delegateFrom: { value: 'L1', source: 'default' },
  roles: [
    // decision 225: a level and difficulty an entry, with the start cell the router computed (L2 and L3 the same here)
    { role: 'coder', levels: [
      { level: 'L1', difficulty: 'routine', count: 1, step: 's1', model: 'haiku', effort: 'low', estimated: false, source: 'default' },
      { level: 'L1', difficulty: 'moderate', count: 1, step: 's3', model: 'sonnet', effort: 'medium', estimated: false, source: 'default' },
      { level: 'L1', difficulty: 'hard', count: 1, step: 's5', model: 'opus', effort: 'high', estimated: false, source: 'default' },
      ...(['L2', 'L3'] as const).flatMap(level => [
        { level, difficulty: 'hard', count: 2, step: 's5', model: 'opus', effort: 'high', estimated: false, source: 'default' },
        { level, difficulty: 'routine', count: 2, step: 'haiku-medium', model: 'haiku', effort: 'medium', estimated: true, source: 'own' },
        { level, difficulty: 'moderate', count: 2, step: 's3', model: 'sonnet', effort: 'medium', estimated: false, source: 'default' },
      ]),
    ],
      stats: { subtasks: 22, passed: 20, failed: 2, passRate: 20 / 22, avgCostUsd: 0.18, avgRunMs: 42_000, stepUps: 2, stepDowns: 1 } },
    // as an older router sends it: a level an entry, no difficulty
    { role: 'reviewer', levels: [{ level: 'L2', count: 1, step: 's3', model: 'sonnet', effort: 'medium', source: 'default' }],
      stats: { subtasks: 6, passed: 6, failed: 0, passRate: 1, avgCostUsd: 0.09, avgRunMs: 15_000, stepUps: 0, stepDowns: 0 } },
  ],
  stepChanges: [{ at: ISO(30), requestId: 'r-2', subtaskId: 'A', role: 'coder', slot: 0, from: 's1', to: 's2', direction: 'up', reason: 'miss', detail: 'wrong_result' }],
  triage: { overall: { total: 34, levelHeld: 28, teamFit: 26, startStepFit: 24 }, byRule: [{ rule: 'docs-small', count: 5, reinforced: 0, upStreaks: 2, suggestLevelUp: true, suggestStepUp: false }], byLevel: [] },
  routing: { mode: 'observe', holdoutRate: 0.1, classes: [] },
})
const SETTINGS = {
  revision: { config: 'c-1', presets: 'p-1' },
  profile: { value: 'balanced', source: 'default', options: [
    { id: 'save', title: 'Save', summary: 'smaller teams and budgets', sets: [], measured: null },
    { id: 'balanced', title: 'Balanced', summary: 'the defaults', sets: [], measured: 'a passed task cost 33% less than plain Claude Code' },
    { id: 'quality', title: 'Quality', summary: 'higher steps, a reviewer on every team', sets: [], measured: null },
  ] },
  items: [
    { path: 'profile', group: 'profile', title: 'Profile', description: '', type: 'enum', options: ['save', 'balanced', 'quality'], value: 'balanced', source: 'default', default: 'balanced', appliesAt: 'next request', editable: true },
    { path: 'team.L2.coder.start', group: 'team', title: 'L2 coder start', description: '', type: 'enum', options: ['s1', 's2', 's3'], optionLabels: { s1: 'haiku low', s2: 'haiku high', s3: 'sonnet medium' }, value: 's1', source: 'profile', default: 's1', profileValue: 's1', appliesAt: 'next request', editable: true },
    { path: 'budgetsUsd.L2', group: 'budget', title: 'L2 budget', description: '', type: 'number', choices: [1, 2, 4, 6, 8], value: 4, source: 'default', default: 4, appliesAt: 'now', editable: true },
    { path: 'stepDown', group: 'quality', title: 'Step down', description: '', type: 'enum', options: ['on', 'off'], value: 'on', source: 'own', default: 'on', appliesAt: 'now', editable: true },
    { path: 'recordPrompts', group: 'privacy', title: 'Record prompts', description: '', type: 'boolean', value: false, source: 'default', default: false, appliesAt: 'next start', editable: true },
    { path: 'forceLevel', group: 'advanced', title: 'Force level', description: '', type: 'enum', options: ['L0', 'L1'], value: null, source: 'default', default: null, appliesAt: 'now', editable: false, why: 'benchmarks only: set it with the CLI' },
  ],
  team: [{ level: 'L2', leadDirect: false, budgetUsd: 4, roles: [{ role: 'coder', count: 2, step: 's1', model: 'haiku', effort: 'low', source: 'profile' }] }],
  text: [{ key: 'verify', title: 'Verify commands', value: 'npm test', command: 'edit .do-it-all-claude-code/verify.json in the repository and commit it' }],
  project: { name: 'r1', worktree: null },
  problems: [{ path: 'teams.yaml', message: 'line 4: unknown role "tester2" (being ignored)' }],
  managed: [{ key: 'daemonPort', reason: 'set by init' }],
}

/** A helper that answers each tab with its fixture, and an apply with `applied`; the inputs the applies were given. */
function tabsEngine(on: On, env: Record<string, string> = {}, applied: unknown = { ok: true, changed: ['profile'], nextStart: [], notes: [], revision: { config: 'c-2', presets: 'p-1' } }, work: unknown = WORK) {
  const spawned: string[][] = []
  const inputs: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, env)
  on('session.version', () => ({ value: { version: '2.1.325' } }))
  on('session.id', () => ({ value: 'kit-session' }))
  on('command.register', () => ({ value: { command: 'office' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    const arg = (k: string) => (e.argv.includes(k) ? e.argv[e.argv.indexOf(k) + 1] : undefined)
    const say = (o: object) => ({ stream: 'stdout' as const, text: `${JSON.stringify({ v: 1, ...o })}\n` })
    if (e.argv.includes('--apply')) {
      inputs.push(String((e as { input?: string }).input ?? ''))
      yield say({ type: 'applied', status: 200, data: applied })
      return { value: { code: 0, signal: null } }
    }
    yield say({ type: 'office', reach: 'ok', view: { request: null, subtasks: [], costUsd: 0, costEstimated: false, costUnknown: false, sessionCostUsd: 0, limits: null } })
    const which = arg('--tab'), p = arg('--period') ?? '7d'
    if (which === 'work') {
      yield say({ type: 'work', data: work })
      const id = arg('--detail')
      if (id) yield say({ type: 'work-detail', id, data: DETAIL })
    }
    if (which === 'savings') yield say({ type: 'savings', period: p, data: savingsOf(p) })
    if (which === 'team') yield say({ type: 'team', period: p, data: teamOf(p) })
    if (which === 'settings') yield say({ type: 'settings', data: SETTINGS })
    return { value: { code: 0, signal: null } }
  })
  return { spawned, inputs, clock }
}

async function openTab($: Parameters<Parameters<typeof test>[1]>[0], clock: ReturnType<typeof mock.clock>, id: string, props: object = {}) {
  await $.command.run({ command: 'office', args: '' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, ...props }, surface: 'terminal' })
  const settle = async () => { await clock.advance(1500); await ui.advance(1500) }
  await ui.press({ key: `tab-${id}` })
  await settle()
  return { ui, settle }
}

test('Work: the first line says what runs and how today went; running requests first; a request opens its timeline, files and tests', async ($, on) => {
  const { spawned, clock } = tabsEngine(on)
  const { ui, settle } = await openTab($, clock, 'work')
  must('headline', await ui.find({ type: 'Text', text: /1 running · today 4 done, 1 failed · \$1\.82/ }))
  const rows = await ui.findAll({ type: 'Button', text: /L[0-3]/ })
  must('running first', rows[0]?.key === 'req-r-3')
  must('level it ran at, its difficulty, the file it changed', await ui.find({ key: 'req-r-2', text: /L1→L2 moderate feature +src\/slug\.ts \+30 -4, 2 more files/ }))
  must('a hard one', await ui.find({ key: 'req-r-3', text: /L2 +hard +bugfix/ }))
  must('a request from before: no difficulty, the columns kept', await ui.find({ key: 'req-r-1', text: /L0 {13}docs/ }))
  must('a failed one', await ui.find({ key: 'req-r-1', text: /✗/ }))
  for (const r of await ui.findAll({ type: 'Button', text: /L[0-3]/ })) must(`${r.key} within the frame`, [...(r.text ?? '')].length <= 118)
  await ui.press({ key: 'req-r-2' })
  await settle()
  must('the helper asks for it', spawned.some(a => a.includes('--detail') && a.includes('r-2')))
  must('how it went', await ui.find({ type: 'Text', text: /L1→L2 hard feature ✓ passed · 1:32 · \$0\.420/ }))
  must('how it was judged', await ui.find({ type: 'Text', text: /judged L1 by rule multi-file 82% · L1→L2 \(replanned\) · difficulty hard, by the lead/ }))
  must('the timeline', await ui.find({ type: 'Text', text: /^coder A +█+ +\d+s ✓$/ }))
  must('a worker with its cell, its step up and tests', await ui.find({ type: 'Text', text: /^A coder Haiku · high \(s2\) · passed · 2 tries · Haiku low→high miss · 12 passed/ }))
  must('a worker on an estimated cell', await ui.find({ type: 'Text', text: /^R reviewer Opus · medium est\. · accept/ }))
  must('the step changes as cells', await ui.find({ type: 'Text', text: /Steps {2}↑1: coder Haiku low→high \(miss\)/ }))
  must('a file with its stat bar', await ui.find({ type: 'Text', text: /\+{6,}-+ \+30 -4/ }))
  must('tests', await ui.find({ type: 'Text', text: /12 passed/ }))
  must('no prompt text', !(await ui.find({ type: 'Text', text: /secret/ })))
  await ui.press({ key: 'back' })
  await settle()
  must('back to the list', await ui.find({ key: 'req-r-2' }))
  await ui.unmount()
})

test('Savings: the first line is what was measured; the two estimates stand apart, with their assumptions and the holdout counts', async ($, on) => {
  const { spawned, clock } = tabsEngine(on)
  const { ui, settle } = await openTab($, clock, 'savings')
  must('measured first line', await ui.find({ type: 'Text', text: /^Spent \$4\.12 at API prices · 38 requests, 35 passed · 5h limit 42% · 7d 21%$/ }))
  must('no single saved figure up top', !/sav/i.test((await ui.find({ type: 'Text', text: /^Spent/ }))?.text ?? 'sav'))
  must('the limit as a bar', await ui.find({ type: 'Text', text: /5-hour limit +█+[▏▎▍▌▋▊▉]?░+ +42%/ }))
  must('the bars per day', await ui.find({ type: 'Text', text: /spent per day · most \$1\.20/ }))
  must('four chart rows', (await ui.findAll({ type: 'Text', text: /^ {2}[ ▁▂▃▄▅▆▇█]+$/ })).length === 4)
  must('estimates are labelled', await ui.find({ type: 'Text', text: /Estimated \(not measured\)/ }))
  must('lead-priced estimate', await ui.find({ type: 'Text', text: /\$9\.80 instead of \$3\.02/ }))
  for (const a of ASSUMPTIONS) must(`assumption: ${a}`, await ui.find({ type: 'Text', text: `    · ${a}` }))
  must('holdout: not enough yet, no difference', await ui.find({ type: 'Text', text: /team 14, lead alone 2 · not enough requests yet \(5 more needed\)/ }))
  must('no holdout difference', !/%/.test((await ui.find({ type: 'Text', text: /sonnet L2: team 14/ }))?.text ?? '%'))
  // p steps the period, and the helper asks for it
  await ui.press({ key: 'period' })
  await settle()
  must('30 days asked for', spawned.some(a => a.includes('savings') && a.includes('30d')))
  await ui.unmount()
})

test('Team: each role with its pass rate as a bar and its models per level; step changes; the triage at the bottom', async ($, on) => {
  const { clock } = tabsEngine(on)
  const { ui } = await openTab($, clock, 'team')
  must('headline', await ui.find({ type: 'Text', text: /Profile balanced · 2 roles · 93% of 28 passed · ↑2 ↓1/ }))
  must('coder', await ui.find({ type: 'Text', text: /coder +█+.* 91% of 22 · \$0\.180 · 42s · ↑2 ↓1/ }))
  // decision 225: each level's start cells routine to hard, the difficulty before each; L2 and L3 the same, one line
  must('a level\'s cells by difficulty', await ui.find({ type: 'Text', text: /^ {2}L1 routine Haiku · low \(s1\) · moderate Sonnet · medium \(s3\) · hard Opus · high \(s5\)$/ }))
  must('levels with the same cells share a line, with where they come from', await ui.find({ type: 'Text', text: /^ {2}L2, L3 2x routine Haiku · medium est\. \(own\) · moderate Sonnet · medium \(s3\) · hard Opus · high \(s5\)$/ }))
  must('an older router: the levels on one line', await ui.find({ type: 'Text', text: /^ {2}L2 Sonnet · medium \(s3\)$/ }))
  must('a step change', await ui.find({ type: 'Text', text: /coder A Haiku low→high miss \(wrong result\)/ }))
  must('triage at the bottom', await ui.find({ type: 'Text', text: /34 requests: level held 82% · team fit 76% · start step 71%/ }))
  must('a rule to look at', await ui.find({ type: 'Text', text: /rule docs-small: its level may be too low \(5 requests\)/ }))
  await ui.unmount()
})

test('decision 225: in a narrow dock the Team tab puts a level\'s cells on more lines, each within the frame, and the Work list keeps four cells for the difficulty', async ($, on) => {
  const { clock } = tabsEngine(on)
  // the dock of a 120 x 30 terminal: 53 across, the frames 51
  const { ui, settle } = await openTab($, clock, 'team', { bodyColumns: 53, scroll: { offset: 0, bodyRows: 40 } })
  const cells = await ui.findAll({ type: 'Text', text: /routine|moderate|hard/ })
  must('the cells drawn', cells.length >= 3)
  for (const c of cells) must(`within 51: ${c.text}`, [...(c.text ?? '')].length <= 51)
  must('the first line', await ui.find({ type: 'Text', text: /^ {2}L1 routine Haiku · low \(s1\)$/ }))
  must('the next ones under it', await ui.find({ type: 'Text', text: /^ {5}moderate Sonnet · medium \(s3\)$/ }))
  await ui.press({ key: 'tab-work' })
  await settle()
  must('the short badge', await ui.find({ key: 'req-r-2', text: /L1→L2 mod +feat/ }))
  must('hard is short already', await ui.find({ key: 'req-r-3', text: /L2 +hard +bug/ }))
  for (const r of await ui.findAll({ type: 'Button', text: /L[0-3]/ })) must(`${r.key} within 51`, [...(r.text ?? '')].length <= 51)
  await ui.unmount()
})

test('Settings: Enter steps a value, shown old → new and kept waiting; a asks, y writes it once through the helper', async ($, on) => {
  const { spawned, inputs, clock } = tabsEngine(on)
  const { ui, settle } = await openTab($, clock, 'settings')
  must('headline', await ui.find({ type: 'Text', text: /Profile balanced \(default\) · 1 own setting · 1 problem/ }))
  must('a problem in one line', await ui.find({ type: 'Text', text: /teams\.yaml: line 4/ }))
  must('what the profile rests on', await ui.find({ type: 'Text', text: /the defaults · a passed task cost 33% less/ }))
  must('a step with its model', await ui.find({ key: 'set-team.L2.coder.start', text: /s1 haiku low +profile/ }))
  must('not changeable here', await ui.find({ type: 'Text', text: /benchmarks only/ }))
  must('shown, changed with a command', await ui.find({ type: 'Text', text: /verify\.json/ }))
  await ui.press({ key: 'set-profile' })
  await settle()
  must('old → new', await ui.find({ key: 'set-profile', text: /balanced → quality/ }))
  must('the profile it would be', await ui.find({ type: 'Text', text: /not measured yet/ }))
  await ui.press({ key: 'set-budgetsUsd.L2' })
  await settle()
  must('a budget steps through its choices', await ui.find({ key: 'set-budgetsUsd.L2', text: /\$4\.00 → \$6\.00/ }))
  await ui.press({ key: 'set-budgetsUsd.L2' })
  await ui.press({ key: 'set-budgetsUsd.L2' })
  await ui.press({ key: 'set-budgetsUsd.L2' })
  await ui.press({ key: 'set-budgetsUsd.L2' })
  await settle()
  must('round to where it was: no change waits', !(await ui.find({ key: 'set-budgetsUsd.L2', text: /→/ })))
  must('one change waiting', await ui.find({ type: 'Text', text: /1 change waiting/ }))
  must('nothing written yet', !spawned.some(a => a.includes('--apply')))
  must('the bar keeps two buttons', (await ui.findAll({ type: 'Button', text: /^(Apply|Discard)$/ })).length === 2)
  await ui.press({ key: 'apply' })
  await settle()
  must('the question', await ui.find({ type: 'Text', text: /Apply 1 change\? · next request: Profile/ }))
  await ui.press({ key: 'apply-yes' })
  await settle()
  must('written once', spawned.filter(a => a.includes('--apply')).length === 1)
  must('with the change and the revision', inputs[0] === JSON.stringify({ revision: { config: 'c-1', presets: 'p-1' }, set: { profile: 'quality' } }))
  must('what it answered', await ui.find({ type: 'Text', text: /Applied: profile/ }))
  must('nothing waits after', await ui.find({ type: 'Text', text: /No change waiting/ }))
  await ui.unmount()
})

test('Settings: a refused change keeps waiting, with each problem on its own line; x drops what waits', async ($, on) => {
  const { clock } = tabsEngine(on, {}, { ok: false, errors: [{ path: 'stepDown', message: 'not one of on, off' }, { path: 'recordPrompts', message: 'must be true or false' }] })
  const { ui, settle } = await openTab($, clock, 'settings')
  await ui.press({ key: 'set-stepDown' })
  await ui.press({ key: 'set-recordPrompts' })
  await settle()
  must('two waiting', await ui.find({ type: 'Text', text: /2 changes waiting/ }))
  must('a later one', await ui.find({ key: 'set-recordPrompts', text: /off → on +own · next start/ }))
  await ui.press({ key: 'apply' })
  await settle()
  must('by when they take effect', await ui.find({ type: 'Text', text: /Apply 2 changes\? · now: Step down · next start: Record prompts/ }))
  await ui.press({ key: 'apply-yes' })
  await settle()
  must('first problem', await ui.find({ type: 'Text', text: /stepDown: not one of/ }))
  must('second problem', await ui.find({ type: 'Text', text: /must be true or false/ }))
  must('still waiting', await ui.find({ type: 'Text', text: /2 changes waiting/ }))
  await ui.press({ key: 'discard' })
  await settle()
  must('dropped', await ui.find({ type: 'Text', text: /No change waiting/ }))
  await ui.unmount()
})

test('the tabs in a narrow dock and in the classic console: short labels, one-cell marks', async ($, on) => {
  const { clock } = tabsEngine(on, { OS: 'Windows_NT' })
  const { ui } = await openTab($, clock, 'work', { bodyColumns: 47, scroll: { offset: 0, bodyRows: 30 } })
  must('short label', await ui.find({ key: 'tab-settings', text: /Config/ }))
  must('one-cell marks', await ui.find({ key: 'req-r-1', text: /^x / }))
  must('no two-cell marks', !(await ui.find({ type: 'Button', text: /[●○✓✗→]/ })))
  must('the short badge after the one-cell arrow', await ui.find({ key: 'req-r-2', text: /L1->L2 mod / }))
  for (const r of await ui.findAll({ type: 'Button', text: /L[0-3]/ })) must(`${r.key} within 45`, [...(r.text ?? '')].length <= 45)
  await ui.press({ key: 'tab-savings' })
  await clock.advance(1500)
  await ui.advance(1500)
  must('a bar of one-cell marks', await ui.find({ type: 'Text', text: /#+\.+/ }))
  await ui.unmount()
})

// an open request that waits for the user: the longest state a row holds
const WAITING = { ...WORK, open: [...WORK.open, { ...WORK.open[0]!, requestId: 'r-4', state: 'awaiting_user', kind: 'feature' }] }
for (const [name, env] of [['a terminal', {}], ['the classic console', { OS: 'Windows_NT' }]] as const) {
  test(`the Work list at 47 columns and narrower (${name}): every row within the frame, the open ones too`, async ($, on) => {
    const { clock } = tabsEngine(on, env, undefined, WAITING)
    await $.command.run({ command: 'office', args: '' })
    for (const columns of [47, 40, 32, 24]) {
      const width = columns - 2
      const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns, scroll: { offset: 0, bodyRows: 30 } }, surface: 'terminal' })
      await ui.press({ key: 'tab-work' })
      await clock.advance(1500)
      await ui.advance(1500)
      for (const id of ['r-1', 'r-2', 'r-3', 'r-4']) {
        const row = await ui.find({ key: `req-${id}` })
        must(`${columns}: ${id} drawn`, row)
        must(`${columns}: ${id} within ${width}: "${row?.text}"`, [...(row?.text ?? '')].length <= width)
      }
      // at 47 the waiting row keeps its whole state word (the kind gives way first); narrower, the word is cut
      if (columns === 47) must('the whole state at 47', await ui.find({ key: 'req-r-4', text: /waiting for you +\$0\.420$/ }))
      if (columns === 40) must('the state cut at 40', await ui.find({ key: 'req-r-4', text: /waiting f…/ }))
      await ui.unmount()
    }
  })
}

test('in a narrow dock (a 120-column terminal) the members sit at small desks, and a click picks the one under it', async ($, on) => {
  engine(on)
  await $.command.run({ command: 'office', args: 'demo' })
  // the dock beside the transcript of a 120 x 40 terminal: 54 across, 34 high; full desks would be two a row
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 54, scroll: { offset: 0, bodyRows: 34 } }, surface: 'terminal' })
  await ui.drawn()
  must('the scene', await ui.find({ key: 'office-scene' }))
  must('no list', !(await ui.find({ key: 'member-demo-a' })))
  must('coder B', await ui.find({ type: 'Text', text: /coder B/, in: 'office-scene' }))
  must('model and effort', await ui.find({ type: 'Text', text: /Sonnet medium/, in: 'office-scene' }))
  // small desks are 15 across with a 1-column gap, 9 rows and a gap down, under the title line: coder B is the
  // fourth member, the first desk of the second row
  await ui.pointer({ type: 'down', x: 6, y: 1 + 10 + 2, button: 'left', in: 'office-scene' })
  await ui.advance(200)
  must('coder B task', await ui.find({ type: 'Text', text: /CLI uses the new slugify/ }))
  await ui.unmount()
})

/** The ids of the members the scene draws at desks, in order. */
function stationsOf(tree: unknown): string[] {
  const out: string[] = []
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return
    const e = n as { props?: { key?: string }; children?: unknown[] }
    const k = e.props?.key
    if (typeof k === 'string' && k.startsWith('st-')) out.push(k.slice(3))
    for (const c of e.children ?? []) walk(c)
  }
  walk(tree)
  return out
}

test('cramped (a 120 x 30 dock with a dialog open, 53 x 12): one row of desks, the rest on a line that picks them', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: `ag-${++n}` }))
  await $.command.run({ command: 'office', args: 'demo' })
  const mount = () => $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 53, scroll: { offset: 0, bodyRows: 12 } }, surface: 'terminal' })
  // five members: four at desks, the reviewer on the line under them, with its model and status
  let ui = await mount()
  await ui.drawn()
  must('four at desks', stationsOf(await ui.drawn({ in: 'office-scene' })).join(',') === 'lead,demo-s,demo-a,demo-b')
  must('no title line', !(await ui.find({ type: 'Text', text: /team office/, in: 'office-scene' })))
  must('the line', await ui.find({ type: 'Text', text: /^\+1: $/ }))
  must('the reviewer on it', await ui.find({ key: 'more-demo-r', text: 'reviewer · Sonnet medium · ○ waiting' }))
  must('no session frame', !(await ui.find({ key: 'session-frame' })))
  // 5 picks the reviewer once a click has given the scene the keys; a press on the name picks it too
  await ui.key({ key: '5', in: 'office-scene' })
  await ui.advance(200)
  must('5 picked it', await ui.find({ key: 'more-demo-r', text: /^▸reviewer/ }))
  await ui.press({ key: 'more-demo-r' })
  await ui.advance(200)
  must('a press on it again lets it go', await ui.find({ key: 'more-demo-r', text: /^reviewer/ }))
  await ui.press({ key: 'more-demo-r' })
  await ui.advance(200)
  must('a press picks it', await ui.find({ key: 'more-demo-r', text: /^▸reviewer/ }))
  await ui.unmount()
  // two more members: three on the line, their names only
  for (const t of ['tester', 'ui-designer']) {
    await $.agent.spawn({ tool_use_id: `t-${t}`, prompt: 'work', description: `${t} work`, subagentType: `do-it-all-claude-code:${t}`, parentModel: 'claude-sonnet-4-5', background: false, fork: false })
  }
  ui = await mount()
  await ui.drawn()
  must('still four at desks', stationsOf(await ui.drawn({ in: 'office-scene' })).length === 4)
  must('three on the line', await ui.find({ type: 'Text', text: /^\+3: $/ }))
  for (const id of ['demo-r', 'ag-1', 'ag-2']) must(`${id} on the line`, await ui.find({ key: `more-${id}` }))
  must('names only', await ui.find({ key: 'more-ag-1', text: 'tester' }))
  await ui.press({ key: 'more-ag-2' })
  await ui.advance(200)
  must('the designer picked', await ui.find({ key: 'more-ag-2', text: '▸designer' }))
  await ui.unmount()
})

test('in a lower room the desks stay and the session shrinks to its last line, then goes; then a line a member', async ($, on) => {
  engine(on)
  await $.command.run({ command: 'office', args: 'demo' })
  const mount = (bodyRows: number) => $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 98, scroll: { offset: 0, bodyRows } }, surface: 'terminal' })
  // inline above the prompt, 15 rows: narrow desks, and of coder A's session (the preview picks it) its last line
  let ui = await mount(15)
  await ui.drawn()
  must('the scene', await ui.find({ key: 'office-scene' }))
  must('no list', !(await ui.find({ key: 'member-demo-a' })))
  must('the session frame', await ui.find({ key: 'session-frame' }))
  must('its last line', await ui.find({ type: 'Text', text: /read 42 lines/ }))
  must('no header in one row', !(await ui.find({ type: 'Text', text: /coder A · Haiku low · slugify accents/ })))
  await ui.unmount()
  // 12 rows: the desks without the session
  ui = await mount(12)
  await ui.drawn()
  must('the scene still', await ui.find({ key: 'office-scene' }))
  must('no session frame', !(await ui.find({ key: 'session-frame' })))
  await ui.unmount()
  // 10 rows: a line a member, and a press picks one
  ui = await mount(10)
  await ui.drawn()
  must('the list', await ui.find({ key: 'member-demo-a' }))
  must('no scene', !(await ui.find({ key: 'office-scene' })))
  must('model and effort', await ui.find({ type: 'Text', text: /· Haiku low/ }))
  // a list for want of room says nothing of the console
  must('no console line', !(await ui.find({ type: 'Text', text: /Windows Terminal/ })))
  await ui.press({ key: 'member-demo-b' })
  await ui.advance(200)
  must('coder B picked', await ui.find({ key: 'member-demo-b', text: /▸ coder B/ }))
  await ui.unmount()
})

test('in the classic Windows console the office is the list with marks that console draws one cell wide', async ($, on) => {
  engine(on, [], { OS: 'Windows_NT' })
  await $.command.run({ command: 'office', args: 'demo' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.drawn()
  must('the list', await ui.find({ key: 'member-demo-a' }))
  must('no scene', !(await ui.find({ key: 'office-scene' })))
  must('one-cell marks', await ui.find({ type: 'Text', text: /\* working/ }))
  must('no two-cell marks', !(await ui.find({ type: 'Text', text: /[●○→]/ })))
  // why it is a list, and where the desks show (decision 206)
  must('the console line', await ui.find({ type: 'Text', text: /^Open in Windows Terminal to see the desks/ }))
  // a press follows that member in the session below
  await ui.press({ key: 'member-demo-b' })
  await ui.advance(200)
  must('coder B task', await ui.find({ type: 'Text', text: /CLI uses the new slugify/ }))
  await ui.unmount()
})

test('an inline pane kept short gets lines only, and says how to make it taller', async ($, on) => {
  engine(on)
  await $.command.run({ command: 'office', args: 'demo' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 98, scroll: { offset: 0, bodyRows: 3 } }, surface: 'terminal' })
  await ui.drawn()
  must('how to make room', await ui.find({ type: 'Text', text: /ctrl\+x up/ }))
  must('the members', await ui.find({ key: 'member-lead' }))
  must('no frames', !(await ui.find({ key: 'office-frame' })))
  await ui.unmount()
})

// ------------------------------------------------------------------ a click's reaction (decision 200)

type Node = { type?: string; props?: { key?: string }; children?: unknown[] } | string
/** The text an element shows, its children's in order. */
const textOf = (n: unknown): string => (typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as { children?: unknown[] }).children ?? []).map(textOf).join('') : '')
/**
 * A member's shape as drawn: per canvas row, where its body starts and ends (the first and last block cell). The
 * eyes move inside the face and the marks float outside it, so neither changes this; a reaction's shape or jump does.
 */
function bodyOf(tree: unknown, id: string): string[] {
  const find = (n: unknown): Node | undefined => {
    if (!n || typeof n !== 'object') return undefined
    const e = n as Exclude<Node, string>
    if (e.props?.key === `st-${id}`) return e
    for (const c of e.children ?? []) { const f = find(c); if (f) return f }
    return undefined
  }
  const station = find(tree)
  const kids = station && typeof station === 'object' ? station.children ?? [] : []
  // the canvas rows come first, then the desk's edge (a full row of ▀) and the labels
  const rows: string[] = []
  for (const k of kids) {
    const t = textOf(k)
    if (/^▀+$/.test(t)) break
    const cells = [...t].slice(0, 15)
    const at = cells.map((ch, x) => (/[█▀▄]/.test(ch) ? x : -1)).filter(x => x >= 0)
    rows.push(at.length ? `${at[0]}-${at.at(-1)}` : '')
  }
  return rows
}

test('a click starts a reaction on that member alone, and it ends in the shape the member had (decision 200)', async ($, on) => {
  engine(on)
  await $.command.run({ command: 'office', args: 'demo' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.drawn()
  await ui.advance(500)
  const shape = async (id: string) => bodyOf(await ui.drawn({ in: 'office-scene' }), id).join('\n')
  const before = await shape('demo-b')
  const other = await shape('lead')
  must('the body drawn', /\d/.test(before))
  // coder B is the fourth desk of the first row
  await ui.pointer({ type: 'down', x: 3 * 24 + 6, y: 3 + 3, button: 'left', in: 'office-scene' })
  let changed = false
  for (let k = 0; k < 20 && !changed; k++) { await ui.advance(40); changed = (await shape('demo-b')) !== before }
  must('the reaction changes its drawing', changed)
  must('the others keep theirs', (await shape('lead')) === other)
  await ui.advance(3000)
  must('back to the shape it had', (await shape('demo-b')) === before)
  // clicks in a row: a bigger reaction, and still back to the same shape
  for (let k = 0; k < 3; k++) { await ui.pointer({ type: 'down', x: 3 * 24 + 6, y: 3 + 3, button: 'left', in: 'office-scene' }); await ui.advance(150) }
  await ui.advance(4000)
  must('back again after clicks in a row', (await shape('demo-b')) === before)
  await ui.unmount()
})
