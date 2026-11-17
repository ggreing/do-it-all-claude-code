// The team office's pure parts (plugin/office/model.ts, decision 186): labels, session lines and their masking, the
// helper's line format, the step against the effort a member ran at, the router home, the version gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CLASSIC_GLYPHS, DESK_H, DESK_W, GLYPHS, MAX_ROWS, OFFICE_MIN_CLAUDE, SLACK, NARROW_DESK_H, NARROW_DESK_W, SMALL_DESK_H, SMALL_DESK_W, TABS, appliedLines, bar, callRow, checksLine,
  choices, clockTime, columns, compileSecrets, confirmLine, cycle, dur, filesText, fit, holdoutText, homeCandidates, labelFor, levelText, mask, modelName,
  nextPeriod, officeLayout, officeSwitch, parseHelperLine, pendingSet, requestLine, resultRow, roleOf, settingText, spentLine, statBar, statusWord, stepLine,
  subtaskOf, tabLabelsFit, tagOf, takeLines, textRow, timelineCells, unicodeTerminal, upDown, versionAtLeast, wantedRoom, withRow, workHeadline, workMark,
  type DaemonOffice, type DaemonSubtask, type OfficeAgent, type SettingItem,
} from '../../../plugin/office/model.ts';
import { MIN_CLAUDE } from '../../cli/src/doctor.ts';

const SECRETS = compileSecrets(JSON.parse(fs.readFileSync(new URL('../../../plugin/hooks/secret-patterns.json', import.meta.url), 'utf8')));

test('office: roles, labels from the subtask tag, model names', () => {
  assert.equal(roleOf('do-it-all-claude-code:coder'), 'coder');
  assert.equal(roleOf('general-purpose'), 'helper');
  assert.equal(tagOf('[subtask:A] work\n[scope: src/**]'), 'A');
  assert.equal(tagOf('no tag'), undefined);
  assert.equal(labelFor('coder', 'A', []), 'coder A');
  const one = [{ role: 'coder' } as OfficeAgent];
  assert.equal(labelFor('coder', undefined, one), 'coder B');
  assert.equal(labelFor('reviewer', undefined, []), 'reviewer');
  assert.equal(modelName('claude-haiku-5-5'), 'Haiku');
  assert.equal(modelName(undefined), 'model unknown');
});

test('office: session lines are short and masked with the guard\'s secret patterns', () => {
  const key = 'sk-ant-api03-abcdefghijklmnop';
  assert.deepEqual(callRow({ tool: 'Bash', command: `curl -H "x-api-key: ${key}" https://example.invalid` }, SECRETS).text.includes(key), false);
  assert.match(callRow({ tool: 'Read', file_path: 'src/a.ts' }).text, /^Read\(src\/a\.ts\)$/);
  assert.equal(resultRow('Read', { text: 'a\nb\n\nc' }).text, 'read 3 lines');
  assert.equal(resultRow('Bash', { deny: 'not allowed' }).kind, 'error');
  assert.equal(textRow(`the key is ${key} ok`, SECRETS).text, 'the key is [secret] ok');
  assert.ok(textRow('x'.repeat(500)).text.length <= 160);
  assert.equal(mask('nothing here', SECRETS), 'nothing here');
});

test('office: rows are capped per member', () => {
  let all: Record<string, Array<{ kind: 'text'; text: string }>> = {};
  for (let i = 0; i < MAX_ROWS + 25; i++) all = withRow(all, 'a', { kind: 'text', text: String(i) });
  assert.equal(all.a!.length, MAX_ROWS);
  assert.equal(all.a!.at(-1)!.text, String(MAX_ROWS + 24));
});

test('office: the helper\'s lines, split as they stream, and only version 1 of known kinds', () => {
  const a = takeLines('', '{"v":1,"type":"alive"}\n{"v":1,"ty');
  assert.deepEqual(a.lines, ['{"v":1,"type":"alive"}']);
  const b = takeLines(a.rest, 'pe":"office","reach":"down","view":null}\r\n');
  assert.deepEqual(b, { lines: ['{"v":1,"type":"office","reach":"down","view":null}'], rest: '' });
  assert.deepEqual(parseHelperLine(b.lines[0]!), { type: 'office', reach: 'down', view: null });
  assert.deepEqual(parseHelperLine('{"v":1,"type":"savings","period":"7d","data":null,"error":"x"}'), { type: 'savings', data: null, error: 'x', period: '7d' });
  assert.deepEqual(parseHelperLine('{"v":1,"type":"work-detail","id":"r-1","data":{"a":1}}'), { type: 'work-detail', data: { a: 1 }, id: 'r-1' });
  assert.deepEqual(parseHelperLine('{"v":1,"type":"applied","status":409,"data":{"ok":false}}'), { type: 'applied', data: { ok: false }, status: 409 });
  // the 0.4 tabs' lines are gone
  for (const old of ['history', 'detail', 'cost', 'routing']) assert.equal(parseHelperLine(`{"v":1,"type":"${old}","data":null}`), null, old);
  assert.equal(parseHelperLine('{"v":2,"type":"office","reach":"ok"}'), null);
  assert.equal(parseHelperLine('{"v":1,"type":"alive"}'), null);
  assert.equal(parseHelperLine('not json'), null);
});

const SUB: DaemonSubtask = { id: 'A', role: 'coder', slot: 0, step: 's2', model: 'haiku', effort: 'high', status: 'passed', verdict: 'pass', attempts: 1, agentId: 'ag-1', scope: ['src/**'], checks: [{ kind: 'test', result: 'ok', testsPassed: 12, testsFailed: 0 }, { kind: 'scope', result: 'ok' }], repro: null };

test('office: the step against what ran: the plan, and "ran at" only when the real model or effort differs', () => {
  assert.deepEqual(stepLine({ model: 'Haiku', effort: 'high' }, SUB), { plan: 's2 (Haiku high)' });
  assert.deepEqual(stepLine({ model: 'Haiku', effort: 'medium' }, SUB), { plan: 's2 (Haiku high)', ranAt: 'ran at Haiku medium' });
  assert.deepEqual(stepLine({ model: 'Sonnet', effort: '' }, SUB), { plan: 's2 (Haiku high)', ranAt: 'ran at Sonnet high' });
  assert.deepEqual(stepLine({ model: '', effort: '' }, SUB), { plan: 's2 (Haiku high)' });
  assert.equal(stepLine({ model: 'Haiku', effort: 'low' }, undefined), null);
  assert.equal(checksLine(SUB.checks), 'test ok (12 passed), scope ok');
});

test('office: members join their subtask by agent id, else by tag; the request line', () => {
  const view: DaemonOffice = {
    request: { id: 'r', level: 'L2', source: 'rule', preset: 'L2', status: 'open', budgetUsd: 4, usedUsd: 0, leadDirect: false, leadModel: null },
    subtasks: [SUB], costUsd: 0.12, costEstimated: true, costUnknown: false, sessionCostUsd: 0.12,
    limits: { fiveHour: { usedPercentage: 23.4, resetsAt: null }, sevenDay: null },
  };
  assert.equal(subtaskOf(view, { id: 'ag-1' })?.id, 'A');
  assert.equal(subtaskOf(view, { id: 'other', tag: 'A' })?.id, 'A');
  assert.equal(subtaskOf(view, { id: 'other' }), undefined);
  assert.equal(requestLine(view), 'L2 · rule · $0.120~ of $4.00 · 5h 23%');
  assert.equal(requestLine(null), '');
});

test('office: the router home, the office switch, the version gate', () => {
  assert.deepEqual(homeCandidates({ pluginRoot: 'C:\\Users\\u\\.do-it-all-claude-code\\plugin', envHome: '/x', userHome: '/home/u' }),
    ['C:\\Users\\u\\.do-it-all-claude-code', '/x', '/home/u/.do-it-all-claude-code']);
  assert.equal(officeSwitch('{"office":"off"}'), 'off');
  assert.equal(officeSwitch('{"daemonPort":1}'), 'on');
  assert.equal(officeSwitch('broken'), 'on');
  assert.equal(officeSwitch(undefined), 'on');
  assert.equal(versionAtLeast('2.1.325', [2, 1, 325]), true);
  assert.equal(versionAtLeast('2.1.400-dev.20261101', [2, 1, 325]), true);
  assert.equal(versionAtLeast('2.1.324', [2, 1, 325]), false);
  assert.equal(versionAtLeast('nonsense', [2, 1, 325]), false);
});

test('office: its minimum Claude Code is the one doctor and init check for', () => {
  // the panel turns itself off below OFFICE_MIN_CLAUDE; doctor blocks below MIN_CLAUDE: one moves, both move
  assert.deepEqual([...OFFICE_MIN_CLAUDE], [...MIN_CLAUDE]);
});

test("office: the members drawn wherever desks fit, small ones before a line a member; no frame reaches the body's edge", () => {
  // a wide terminal's dock (200 x 50): three desks a row, the wall, room for the session
  const wide = officeLayout({ columns: 88, rows: 47, members: 5, routerLine: true, classic: false });
  assert.deepEqual([wide.mode, wide.small, wide.wall, wide.perRow, wide.width], ['desks', false, true, 3, 88 - SLACK]);
  assert.ok(wide.sessionRows >= 3);
  // 120 x 40: the dock is 54 across and 34 high: five full desks two a row would need 36 rows; small desks, three a
  // row, take 20, and the session the rest
  const dock120 = officeLayout({ columns: 54, rows: 34, members: 5, routerLine: true, classic: false });
  assert.deepEqual([dock120.mode, dock120.small, dock120.wall, dock120.perRow], ['desks', true, false, 3]);
  assert.equal(dock120.sessionRows, 34 - (1 + 1 + 2 + 1 + 2) - 2 * SMALL_DESK_H);
  // 160 x 45: the dock is 69 across and 38 high: small desks, four a row
  const dock160 = officeLayout({ columns: 69, rows: 38, members: 5, routerLine: true, classic: false });
  assert.deepEqual([dock160.mode, dock160.small, dock160.perRow], ['desks', true, 4]);
  // 120 x 30, Windows Terminal's first size: the dock is 53 across and 25 high; small desks for five need 30 rows,
  // narrow ones four a row take 14, and seven members (an L3 team and the lead) fit too
  const dock120x30 = officeLayout({ columns: 53, rows: 25, members: 5, routerLine: true, classic: false });
  assert.deepEqual([dock120x30.mode, dock120x30.small, dock120x30.narrow, dock120x30.perRow], ['desks', false, true, 4]);
  assert.equal(dock120x30.sessionRows, 25 - (1 + 1 + 2 + 1 + 2) - 2 * NARROW_DESK_H);
  assert.equal(officeLayout({ columns: 53, rows: 25, members: 7, routerLine: true, classic: false }).narrow, true);
  assert.ok(4 * NARROW_DESK_W - 1 <= 53 - SLACK - 4);
  // four fit at full desks without the wall
  const four = officeLayout({ columns: 54, rows: 34, members: 4, routerLine: true, classic: false });
  assert.deepEqual([four.mode, four.small, four.wall, four.perRow], ['desks', false, false, 2]);
  // inline above the prompt, 15 rows: no room for desks of any size; the list, and the session at its least
  const low = officeLayout({ columns: 98, rows: 15, members: 5, routerLine: true, classic: false });
  assert.deepEqual([low.mode, low.sessionRows], ['list', 3]);
  // three rows (a short inline pane): no frames, the members' lines in the frames' width
  const tiny = officeLayout({ columns: 98, rows: 3, members: 5, routerLine: true, classic: false });
  assert.deepEqual([tiny.mode, tiny.inner, tiny.sessionRows], ['tiny', 98 - SLACK, 0]);
  assert.equal(officeLayout({ columns: 98, rows: 10, members: 2, routerLine: true, classic: true }).mode, 'tiny');
  // narrower than a full desk: a small one
  const narrow = officeLayout({ columns: 26, rows: 60, members: 1, routerLine: false, classic: false });
  assert.deepEqual([narrow.mode, narrow.small], ['desks', true]);
  // the classic console: the list wherever it is
  assert.equal(officeLayout({ columns: 200, rows: 60, members: 2, routerLine: true, classic: true }).mode, 'list');
  // what the desks take is what scene.tsx draws: a row of desks DESK_H high, DESK_W across with the last gap left
  // out (a small desk's gap is one column)
  for (const columns of [30, 54, 77, 88, 120, 160]) {
    const l = officeLayout({ columns, rows: 200, members: 9, routerLine: true, classic: false });
    assert.ok(l.perRow * DESK_W - 2 <= l.inner && l.inner + 4 + SLACK === columns, `${columns}`);
    const s = officeLayout({ columns, rows: 1 + 1 + 2 + 1 + 2 + Math.ceil(9 / Math.floor((columns - SLACK - 4 + 1) / SMALL_DESK_W)) * SMALL_DESK_H + 3, members: 9, routerLine: true, classic: false });
    assert.ok(s.small && s.perRow * SMALL_DESK_W - 1 <= s.inner, `small ${columns}`);
  }
  assert.equal(officeLayout({ columns: 120, rows: 1 + 1 + 2 + 1 + 2 + DESK_H + 3, members: 1, routerLine: true, classic: false }).mode, 'desks');
});

test('office: the room it asks for when it opens', () => {
  assert.deepEqual(wantedRoom(5), { rows: 1 + 1 + 2 + 1 + 2 + 2 * DESK_H + 2 + 12, columns: 4 * DESK_W - 2 + 4 + SLACK });
  assert.equal(wantedRoom(0).columns, 2 * DESK_W - 2 + 4 + SLACK);
});

test('office: the classic Windows console is told from the terminals that say which they are, as Claude Code tells it', () => {
  assert.equal(unicodeTerminal({ OS: 'Windows_NT' }), false);
  assert.equal(unicodeTerminal({ OS: 'Windows_NT', WT_SESSION: '0f1e' }), true);
  assert.equal(unicodeTerminal({ OS: 'Windows_NT', TERM_PROGRAM: 'vscode' }), true);
  assert.equal(unicodeTerminal({ OS: 'Windows_NT', TERM: 'xterm-256color' }), true);
  assert.equal(unicodeTerminal({ OS: 'Windows_NT', ConEmuTask: '{cmd::Cmder}' }), true);
  assert.equal(unicodeTerminal({ OS: 'Windows_NT', TERMINAL_EMULATOR: 'JetBrains-JediTerm' }), true);
  assert.equal(unicodeTerminal({ TERM: 'xterm-256color' }), true);
  assert.equal(unicodeTerminal({}), true);
  assert.equal(unicodeTerminal({ TERM: 'linux' }), false);
});

test("office: the classic console's marks are all ones it draws a cell wide", () => {
  // measured in that console: ● ○ → (and ◆ ■ ▶ ★ ⇒) take two cells there; these take one
  const wide = /[●○→◆◇■□▶⇒★☆◎⊙≫–]/;
  const all = [...Object.values(CLASSIC_GLYPHS.status), CLASSIC_GLYPHS.tool, CLASSIC_GLYPHS.text, CLASSIC_GLYPHS.picked, CLASSIC_GLYPHS.arrow, CLASSIC_GLYPHS.range];
  for (const mark of all) assert.ok(!wide.test(mark), mark);
  assert.equal(statusWord('working'), '● working');
  assert.equal(statusWord('waiting', CLASSIC_GLYPHS), '- waiting');
  assert.equal(GLYPHS.border, 'round');
  assert.equal(CLASSIC_GLYPHS.border, 'single');
  assert.equal(fit('Edit(src/slug.ts)', 9), 'Edit(src…');
  assert.equal(fit('short', 9), 'short');
});

test("office: no binding in its .tsx takes the JSX factory's names", () => {
  // the JSX compiles to h(...) and Fragment: a local of that name in scope is called in their place (the History
  // tab once threw "h is not a function" for a local `const h`)
  for (const name of ['register.tsx', 'scene.tsx', 'tabs.tsx']) {
    const src = fs.readFileSync(new URL(`../../../plugin/office/${name}`, import.meta.url), 'utf8')
      .replace(/\/\/.*$/gm, '')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
    const bad = src.match(/\b(?:const|let|var|function|class)\s+(?:h|Fragment)\b|[(,]\s*(?:h|Fragment)\s*[,)=]|\b(?:h|Fragment)\s*=>|[{,]\s*(?:h|Fragment)\s*[,}]/);
    assert.equal(bad, null, `${name}: ${bad?.[0]}`);
  }
});

// ------------------------------------------------------------------ the five tabs (decisions 193, 194)

test('office tabs: five, keys that do not collide with each other or the tabs\' own keys; short labels in a narrow dock', () => {
  assert.deepEqual(TABS.map(t => `${t.key}:${t.id}`), ['o:office', 'w:work', 's:savings', 't:team', 'c:settings']);
  // the keys a tab draws: 1-9 members and v (Office), b back (Work), p period (Savings, Team), a x y n (Settings)
  const own = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'v', 'b', 'p', 'a', 'x', 'y', 'n'];
  const keys = TABS.map(t => t.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of keys) assert.ok(!own.includes(k), k);
  for (const k of keys) assert.match(k, /^[a-z]$/);       // a hotkey is one digit or one lowercase letter
  assert.equal(tabLabelsFit(49), true);
  assert.equal(tabLabelsFit(45), false);
  assert.ok(TABS.reduce((n, t) => n + t.short.length + 4, 0) <= 45, 'the short labels fit the narrowest dock');
  assert.deepEqual(['24h', '7d', '30d'].map(nextPeriod), ['7d', '30d', '24h']);
  assert.equal(nextPeriod('1y'), '24h');
});

test('office figures: a bar fills in eighths, the classic console in whole cells of its own marks', () => {
  assert.equal(bar(50, 100, 10), '█████░░░░░');
  assert.equal(bar(42, 100, 10), '████▎░░░░░');
  assert.equal(bar(100, 100, 4), '████');
  assert.equal(bar(0, 100, 4), '░░░░');
  assert.equal(bar(130, 100, 4), '████');
  assert.equal(bar(5, 0, 4), '░░░░');
  assert.equal(bar(42, 100, 10, CLASSIC_GLYPHS), '####......');
  for (const n of [0, 1, 7, 33, 50, 99, 100]) assert.equal([...bar(n, 100, 13)].length, 13, String(n));
  // columns: one a value, the top row first; a value above 0 shows its lowest mark; the classic marks are ASCII
  assert.deepEqual(columns([0, 1, 2, 4], 2, 1, 0), ['   █', ' ▄██']);
  assert.deepEqual(columns([0, 0.01, 4], 1, 2, 1), ['   ▁▁ ██']);
  assert.deepEqual(columns([1, 4], 2, 1, 1, CLASSIC_GLYPHS), ['  #', '# #']);
  for (const r of columns([3, 1, 4, 1, 5], 3, 2, 1, CLASSIC_GLYPHS)) assert.match(r, /^[ .#]+$/);
  // git's stat bar
  assert.deepEqual(statBar(30, 4, 12, 34), { plus: '+++++++++++', minus: '-' });
  assert.deepEqual(statBar(2, 1, 12, 34), { plus: '+', minus: '-' });
  assert.deepEqual(statBar(0, 0, 12, 34), { plus: '', minus: '' });
  assert.deepEqual(statBar(5, 0, 12, 5), { plus: '++++++++++++', minus: '' });
  assert.equal(upDown(2, 1), '↑2 ↓1');
  assert.equal(upDown(0, 3, CLASSIC_GLYPHS), '3 down');
  assert.equal(upDown(0, 0), '');
  assert.deepEqual([dur(42_000), dur(185_000), dur(3_720_000), dur(null)], ['42s', '3:05', '1h 02m', '—']);
  const now = new Date(2026, 10, 17, 15, 0).getTime();
  assert.equal(clockTime(new Date(2026, 10, 17, 9, 5).toISOString(), now), '09:05');
  assert.equal(clockTime(new Date(2026, 10, 16, 9, 5).toISOString(), now), '11-16 09:05');
  assert.equal(clockTime(new Date(2026, 10, 17, 18, 0).getTime() / 1000, now), '18:00', 'the limits give epoch seconds');
  assert.equal(clockTime(null, now), '—');
});

const ROW = {
  requestId: 'r', state: 'closed' as const, mine: true, createdAt: '', closedAt: '', kind: 'feature', level: 'L1' as const, finalLevel: 'L2' as const, outcome: 'delegated' as const,
  passed: true, acceptance: null, subtasks: 2, verifyFailures: 0, stepUps: 0, changedFiles: 3, linesAdded: 9, linesRemoved: 2,
  files: [{ path: 'src/a.ts', added: 6, removed: 1 }], durationMs: 1, activeMs: 1, totalUsd: 0.2, estimated: false, unknown: false, budgetExceeded: false,
};

test('office Work: a request\'s mark, level and files; the first line', () => {
  assert.deepEqual(workMark({ state: 'open', passed: null }), { mark: '●', word: 'running', color: 'warning' });
  assert.deepEqual(workMark({ state: 'awaiting_user', passed: null }, CLASSIC_GLYPHS), { mark: '-', word: 'waiting for you', color: 'suggestion' });
  assert.equal(workMark({ state: 'closed', passed: false }).word, 'failed');
  assert.equal(levelText('L1', 'L2'), 'L1→L2');
  assert.equal(levelText('L1', 'L2', CLASSIC_GLYPHS), 'L1->L2');
  assert.equal(levelText('L2', 'L2'), 'L2');
  assert.equal(filesText(ROW), 'src/a.ts +6 -1, 2 more files');
  assert.equal(filesText({ ...ROW, files: [], changedFiles: 1 }), '1 file +9 -2');
  assert.equal(filesText({ ...ROW, files: [], changedFiles: null }), '');
  const list = { open: [{ ...ROW, state: 'open' as const }, { ...ROW, state: 'awaiting_user' as const }], rows: [ROW], nextCursor: null, today: { done: 3, failed: 0, usd: 1.5 } };
  assert.equal(workHeadline(list), '1 running · 1 waiting for you · today 3 done · $1.50');
  assert.equal(workHeadline({ ...list, open: [], today: { done: 0, failed: 2, usd: 0 } }), 'Nothing running · today 0 done, 2 failed · $0.000');
  // the timeline: on one axis, each span at least a cell, none past the width
  const at = (s: number) => new Date(1_000_000 + s * 1000).toISOString();
  const cells = timelineCells([
    { kind: 'plan', role: null, subtaskId: null, startedAt: at(0), endedAt: at(10), ok: null },
    { kind: 'worker', role: 'coder', subtaskId: 'A', startedAt: at(10), endedAt: at(90), ok: true },
    { kind: 'verify', role: null, subtaskId: 'A', startedAt: at(90), endedAt: at(100), ok: true },
    { kind: 'worker', role: 'reviewer', subtaskId: 'R', startedAt: at(100), endedAt: null, ok: null },
  ], 40, 1_000_000 + 100_000);
  assert.deepEqual(cells.map(c => [c.from, c.len]), [[0, 4], [4, 32], [36, 4], [39, 1]]);
  for (const c of cells) assert.ok(c.from + c.len <= 40 && c.len >= 1);
});

test('office Savings: the first line is measured only; the holdout says how many are missing until there are enough', () => {
  const measured = {
    cost: { label: 'billed' as const, totalUsd: 12.5, leadUsd: 4, workerUsd: 8.5, requests: 10, passed: 9, costPerPassedUsd: 1.3, flags: { estimated: 0, unknown: 0, budgetExceeded: 0 } },
    limits: { fiveHour: { usedPercentage: 23.4, resetsAt: null }, sevenDay: null },
  };
  assert.equal(spentLine(measured), 'Spent $12.5 billed · 10 requests, 9 passed · 5h limit 23%');
  assert.equal(spentLine({ ...measured, cost: { ...measured.cost, label: 'mixed' }, limits: null }), 'Spent $12.5 billed and at API prices · 10 requests, 9 passed');
  assert.doesNotMatch(spentLine(measured), /sav|estimat/i);
  const arm = (n: number) => ({ n, accepted: n, costPerAcceptedUsd: 0.4 });
  const h = { leadClass: 'sonnet', level: 'L2' as const, team: arm(14), direct: arm(2), need: { team: 10, direct: 7 }, enough: false, differencePct: null };
  assert.deepEqual(holdoutText(h), { head: 'sonnet L2: team 14, lead alone 2', tail: 'not enough requests yet (5 more needed)', enough: false });
  const enough = holdoutText({ ...h, direct: { n: 9, accepted: 8, costPerAcceptedUsd: 0.6 }, team: arm(20), enough: true, differencePct: -33.3 });
  assert.equal(enough.tail, 'team $0.400 vs alone $0.600 per accepted (-33%)');
});

const ITEM = (o: Partial<SettingItem>): SettingItem => ({ path: 'x', group: 'quality', title: 'X', description: '', type: 'enum', options: ['on', 'off'], value: 'on', source: 'default', default: 'on', appliesAt: 'now', editable: true, ...o });

test('office Settings: Enter steps through the choices; a change back to what is inherited takes the own value away', () => {
  assert.deepEqual(choices(ITEM({ type: 'boolean', value: false })), [false, true]);
  assert.deepEqual(choices(ITEM({ type: 'number', min: 1, max: 3, step: 0.5, value: 2 })), [1, 1.5, 2, 2.5, 3]);
  assert.deepEqual(choices(ITEM({ type: 'number', choices: [1, 2, 4], min: 0, max: 100, value: 2 })), [1, 2, 4]);
  assert.equal(choices(ITEM({ type: 'integer', min: 0, max: 1000, value: 0 })).length, 25, 'at most 25 steps');
  assert.equal(cycle(ITEM({}), 'on'), 'off');
  assert.equal(cycle(ITEM({}), 'off'), 'on');
  assert.equal(cycle(ITEM({ options: ['a', 'b'] }), 'zzz'), 'a');
  // an own budget of 6 over the profile's 2.4: back to 2.4 is "no own value"
  const budget = ITEM({ path: 'budgetsUsd.L2', type: 'number', choices: [2.4, 4, 6], value: 6, source: 'own', default: 4, profileValue: 2.4, appliesAt: 'now' });
  const later = ITEM({ path: 'recordPrompts', title: 'Record prompts', type: 'boolean', value: false, default: false, appliesAt: 'next start' });
  const locked = ITEM({ path: 'forceLevel', editable: false });
  assert.deepEqual(pendingSet([budget, later, locked], { 'budgetsUsd.L2': 2.4, recordPrompts: true, forceLevel: 'off' }), { 'budgetsUsd.L2': null, recordPrompts: true });
  assert.deepEqual(pendingSet([budget], { 'budgetsUsd.L2': 6 }), {}, 'back to its own value: nothing');
  assert.deepEqual(pendingSet([budget], { 'budgetsUsd.L2': 4 }), { 'budgetsUsd.L2': 4 });
  assert.equal(confirmLine([budget, later], { 'budgetsUsd.L2': null, recordPrompts: true }), 'Apply 2 changes? · now: X · next start: Record prompts');
  assert.equal(settingText(budget, 6), '$6.00');
  assert.equal(settingText(later, true), 'on');
  assert.equal(settingText(ITEM({ optionLabels: { s2: 'haiku high' } }), 's2'), 's2 haiku high');
  assert.equal(settingText(ITEM({}), null), 'none');
  // what the person reads of the write's answer
  assert.deepEqual(appliedLines(200, { ok: true, changed: ['profile'], nextStart: ['recordPrompts'], notes: [] }), { ok: true, lines: ['Applied: profile', 'from the next start: recordPrompts'] });
  assert.deepEqual(appliedLines(400, { ok: false, errors: [{ path: 'a', message: 'bad' }, { path: 'b', message: 'worse' }] }), { ok: false, lines: ['a: bad', 'b: worse'] });
  assert.equal(appliedLines(409, { ok: false, errors: [{ path: 'revision', message: 'stale' }] }).lines[0], 'The settings changed elsewhere since this tab read them: they are read again, nothing was written');
  assert.deepEqual(appliedLines(undefined, null, 'router daemon not reachable'), { ok: false, lines: ['router daemon not reachable'] });
  assert.equal(officeSwitch('{"office":"on","officeAutoOpen":"off"}', 'officeAutoOpen'), 'off');
  assert.equal(officeSwitch('{"office":"on"}', 'officeAutoOpen'), 'on');
});
