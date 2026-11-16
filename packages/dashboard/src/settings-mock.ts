// Mock settings store — DEV ONLY. settings.ts loads this through a dynamic import() that is reachable only
// when `import.meta.env.DEV && import.meta.env.VITE_USE_MOCK === 'true'`, so a production build (DEV false)
// drops the branch and this module never reaches dist. It lets the settings page render and round-trip with
// no daemon. MOCK_MARKER is a sentinel the no-mock-in-build guard test looks for in the built bundle.
import type { SettingsDoc, RoleField, RoleItem, HistoryDoc, HistoryEntry, WriteOk } from './settings';

export const MOCK_MARKER = 'DIACC_SETTINGS_MOCK_ONLY';

let mockStore: SettingsDoc | null = null;
const mockLog: HistoryEntry[] = [];
function rev(): string { return Math.random().toString(16).slice(2, 18).padEnd(16, '0'); }

function freshMock(): SettingsDoc {
  const roleFields = (role: string, model: string): Record<string, RoleField> => ({
    name: { value: role, locked: true, reason: "the role's identity: the daemon and the guard map on it" },
    'x-router.role': { value: role, locked: true, reason: "the role's identity" },
    disallowedTools: { value: 'Agent, Task, WebFetch, WebSearch', locked: true, reason: "keeps the router's lead-only tools away from subagents" },
    isolation: { value: 'worktree', locked: true, reason: 'set by the template' },
    tools: { value: ['Read', 'Edit', 'Grep', 'Glob', 'Bash'], editable: true, rule: 'never Agent, Task, WebFetch or WebSearch, no MCP tools, never empty (an empty list means every tool)' },
    model: { value: model, editable: true, options: ['haiku', 'sonnet', 'opus', 'fable', 'inherit'], rule: 'or a full model id' },
    effort: { value: 'medium', editable: true, options: ['low', 'medium', 'high', 'xhigh', 'max'] },
    maxTurns: { value: 40, editable: true, min: 1, max: 500 },
    description: { value: `the ${role} subagent (${MOCK_MARKER})`, editable: true },
    'x-router.verify': { value: ['npm test'], editable: true, runsAsYou: true, note: 'These commands run on your machine, as you, when a subtask is verified. You vouch for them.' },
    body: { value: `## Work unit\nYou are the ${role}.\n`, editable: true },
  });
  const roleItem = (role: string, model: string): RoleItem => ({
    role, revision: rev(), overridden: false, overriddenFields: [],
    text: `---\nname: ${role}\n---\n## Work unit\nYou are the ${role}.\n`,
    template: `---\nname: ${role}\n---\n## Work unit\nYou are the ${role}.\n`,
    fields: roleFields(role, model),
  });
  return {
    csrf: 'mock-csrf',
    config: {
      revision: rev(),
      keys: [
        { key: 'autoRelease', type: 'enum', options: ['on', 'observe', 'off'], value: 'observe', default: 'observe', set: false, appliesAt: 'now', description: 'Whether to act on the delegation-vs-direct comparison.' },
        { key: 'stepDown', type: 'enum', options: ['on', 'off'], value: 'on', default: 'on', set: false, appliesAt: 'now', description: 'Let a slot step down after easy passes.' },
        { key: 'updateCheck', type: 'enum', options: ['on', 'off'], value: 'off', default: 'off', set: false, appliesAt: 'now', description: 'Check GitHub once a day for a newer release.' },
        { key: 'holdoutRate', type: 'number', value: 0.1, default: 0.1, set: false, min: 0, max: 0.2, appliesAt: 'now', description: 'Share of delegable requests handled directly for comparison.' },
        { key: 'eventRetentionDays', type: 'integer', value: 30, default: 30, set: false, min: 0, max: 365, appliesAt: 'next start', description: 'Days hook events are kept (0 keeps them).' },
        { key: 'budgetsUsd', type: 'levels', value: { L0: 0.5, L1: 2, L2: 5, L3: 15 }, default: { L0: 0.5, L1: 2, L2: 5, L3: 15 }, set: false, min: 0, minExclusive: true, appliesAt: 'now', description: 'Per-request budget per level.' },
        { key: 'delegateFrom', type: 'byLeadClass', options: ['L0', 'L1', 'L2', 'L3'], value: { opus: 'L1', sonnet: 'L2', haiku: 'L2', other: 'L2' }, default: { opus: 'L1', sonnet: 'L2', haiku: 'L2', other: 'L2' }, set: false, appliesAt: 'now', description: 'First delegated level per lead model class.' },
        { key: 'forceLevel', type: 'enum', options: ['L0', 'L1', 'L2', 'L3'], value: '', default: '', set: false, advanced: true, appliesAt: 'now', description: 'Force every request to a level (benchmarks/debugging).' },
        { key: 'fableOptIn', type: 'boolean', value: false, default: false, set: false, advanced: true, appliesAt: 'now', description: 'Allow the Fable model class.' },
      ],
      // M4: recordPrompts and bearerApi are CLI-only, shown locked here like the other managed keys.
      managed: [
        { key: 'daemonPort', reason: 'set by init' },
        { key: 'proxyPort', reason: 'set by init' },
        { key: 'apiMode', reason: 'changed with `do-it-all-claude-code mode`' },
        { key: 'recordPrompts', reason: 'changed with the CLI only: `do-it-all-claude-code config set recordPrompts <on|off>`' },
        { key: 'bearerApi', reason: 'deprecated and CLI-only: `do-it-all-claude-code config set bearerApi off`' },
      ],
    },
    presets: {
      revision: rev(), text: '',
      effective: {
        L0: { roles: [{ role: 'coder', count: 1, start: 's1' }], leadMayAdjust: false, leadDirect: true, budgetUsd: 0.5 },
        L1: { roles: [{ role: 'coder', count: 1, start: 's1' }], leadMayAdjust: true, leadDirect: true, budgetUsd: 2 },
        L2: { roles: [{ role: 'architect', count: 1, start: 's3' }, { role: 'coder', count: 2, start: 's1' }, { role: 'reviewer', count: 1, start: 's3' }, { role: 'tester', count: 1, start: 's1' }], leadMayAdjust: true, budgetUsd: 5 },
        L3: { roles: [{ role: 'architect', count: 1, start: 's5' }, { role: 'ui-designer', count: 1, start: 's3' }, { role: 'coder', count: 2, start: 's5' }, { role: 'reviewer', count: 1, start: 's5' }, { role: 'tester', count: 1, start: 's1' }], leadMayAdjust: true, budgetUsd: 15 },
      },
      schema: { levels: ['L0', 'L1', 'L2', 'L3'], roles: ['architect', 'ui-designer', 'coder', 'reviewer', 'tester'], steps: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'], countMin: 0, countMax: 4 },
    },
    roles: {
      editable: true,
      items: [roleItem('coder', 'haiku'), roleItem('architect', 'sonnet'), roleItem('reviewer', 'sonnet'), roleItem('tester', 'haiku'), roleItem('ui-designer', 'sonnet')],
    },
  };
}

export function mockRead(): Promise<SettingsDoc> {
  if (!mockStore) mockStore = freshMock();
  return Promise.resolve(structuredClone(mockStore));
}
export function mockHistory(): Promise<HistoryDoc> { return Promise.resolve({ entries: [...mockLog].reverse() }); }
export function mockWrite(kind: HistoryEntry['kind'], payload: Record<string, unknown>): Promise<WriteOk> {
  if (!mockStore) mockStore = freshMock();
  const changed: string[] = [];
  const notes: string[] = [];
  if (kind === 'config') {
    const set = (payload.set ?? {}) as Record<string, unknown>;
    for (const [path, to] of Object.entries(set)) {
      const [key, sub] = path.split('.');
      const k = mockStore.config.keys.find(x => x.key === key);
      if (!k) continue;
      if (sub && k.value && typeof k.value === 'object') (k.value as Record<string, unknown>)[sub] = to === null ? (k.default as Record<string, unknown>)[sub] : to;
      else k.value = to === null ? k.default : to;
      k.set = to !== null;
      changed.push(path);
    }
    mockStore.config.revision = rev();
  } else if (kind === 'presets') {
    mockStore.presets.text = String(payload.text ?? '');
    mockStore.presets.revision = rev();
    changed.push('teams.yaml');
  } else {
    const role = String(payload.role);
    const item = mockStore.roles.items.find(x => x.role === role);
    if (item) {
      if (payload.reset === true) { item.overridden = false; item.overriddenFields = []; changed.push('reset'); }
      else if (payload.fields) {
        for (const [f, v] of Object.entries(payload.fields as Record<string, unknown>)) { if (item.fields[f]) item.fields[f]!.value = v; changed.push(f); if (f === 'x-router.verify') notes.push('These commands run on your machine, as you, when a subtask is verified.'); }
        item.overridden = true;
      } else if (typeof payload.text === 'string') { item.text = payload.text; item.overridden = true; changed.push('file'); }
      item.revision = rev();
    }
  }
  mockLog.push({ at: new Date().toISOString(), source: 'dashboard', kind, ...(payload.role ? { target: String(payload.role) } : {}), changes: changed.map(p => ({ path: p, changed: true })) });
  return Promise.resolve({ ok: true, changed, notes });
}
