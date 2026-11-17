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
    request: { id: 'r-1', level: 'L2', source: 'rule', preset: 'L2', status: 'open', budgetUsd: 4, usedUsd: 0.1, leadDirect: false, leadModel: 'sonnet' },
    subtasks: [{ id: 'A', role: 'coder', slot: 0, step: 's2', model: 'haiku', effort: 'high', status: 'passed', verdict: 'pass', attempts: 1, agentId: 'demo-a', scope: ['src/**'],
      checks: [{ kind: 'test', result: 'ok', testsPassed: 12, testsFailed: 0 }], repro: null }],
    costUsd: 0.12, costEstimated: false, costUnknown: false, sessionCostUsd: 0.12, limits: null,
  },
})

type On = Parameters<Parameters<typeof test>[1]>[1]

/** The engine around the office: a tested Claude Code build, a session id, a clock, and a helper that says `lines`. */
function engine(on: On, lines: string[] = []): { spawned: string[][]; clock: ReturnType<typeof mock.clock> } {
  const spawned: string[][] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})
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
    await ui.pointer({ type: 'down', x: 3 * 22 + 6, y: 3 + 3, button: 'left', in: 'office-scene' })
    await ui.advance(200)
    must('coder B task', await ui.find({ type: 'Text', text: /CLI uses the new slugify/ }))
    // the same desk again: the space below is empty again
    await ui.pointer({ type: 'down', x: 3 * 22 + 6, y: 3 + 3, button: 'left', in: 'office-scene' })
    await ui.advance(200)
    must('empty space', await ui.find({ type: 'Text', text: /Click a member/ }))
    // a hover draws without throwing, and the frames keep coming
    await ui.pointer({ type: 'move', x: 6, y: 6, in: 'office-scene' })
    await ui.advance(3000)
    await ui.drawn({ in: 'office-scene' })
    // back to coder A, as the preview opened, for the next surface
    await ui.pointer({ type: 'down', x: 2 * 22 + 6, y: 3 + 3, button: 'left', in: 'office-scene' })
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
  must('level line', await ui.find({ type: 'Text', text: /L2 · rule · \$0\.120 of \$4/ }))
  // coder A is subtask A: planned s2 (Haiku high), its last request ran at Haiku low
  must('step and plan', await ui.find({ type: 'Text', text: /s2 \(Haiku high\)/ }))
  must('ran at', await ui.find({ type: 'Text', text: /ran at Haiku low/ }))
  must('checks', await ui.find({ type: 'Text', text: /test ok \(12 passed\)/ }))
  await ui.unmount()
})

test('without the router the office says so; the four tabs switch with their keys and restart the helper', async ($, on) => {
  const { spawned, clock } = engine(on, [JSON.stringify({ v: 1, type: 'office', reach: 'down', view: null })])
  await $.command.run({ command: 'office', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const settle = async () => { await clock.advance(1500); await ui.advance(1500) }
  await settle()
  must('daemon down', await ui.find({ type: 'Text', text: /router daemon not reachable/ }))
  for (const key of ['tab-office', 'tab-history', 'tab-cost', 'tab-routing']) must(key, await ui.find({ key }))
  await ui.press({ key: 'tab-cost' })
  await settle()
  must('cost periods', await ui.find({ key: 'period-7d' }))
  must('helper for the cost tab', spawned.some(a => a.includes('cost')))
  await ui.press({ key: 'tab-routing' })
  await settle()
  must('helper for the routing tab', spawned.some(a => a.includes('routing')))
  await ui.press({ key: 'tab-office' })
  await settle()
  must('back in the office', await ui.find({ type: 'Text', text: /Click a member/ }))
  await ui.unmount()
})
