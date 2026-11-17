// The team office's pure parts (plugin/office/model.ts, decision 186): labels, session lines and their masking, the
// helper's line format, the step against the effort a member ran at, the router home, the version gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CLASSIC_GLYPHS, DESK_H, DESK_W, GLYPHS, MAX_ROWS, OFFICE_MIN_CLAUDE, SLACK, SMALL_DESK_H, SMALL_DESK_W, callRow, checksLine, compileSecrets, fit, homeCandidates,
  labelFor, mask, modelName, officeLayout, officeSwitch, parseHelperLine, requestLine, resultRow, roleOf, statusWord, stepLine, subtaskOf,
  tagOf, takeLines, textRow, unicodeTerminal, versionAtLeast, wantedRoom, withRow,
  type DaemonOffice, type DaemonSubtask, type OfficeAgent,
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
  assert.deepEqual(parseHelperLine('{"v":1,"type":"cost","period":"7d","data":null,"error":"x"}'), { type: 'cost', data: null, error: 'x', period: '7d' });
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
  for (const name of ['register.tsx', 'scene.tsx']) {
    const src = fs.readFileSync(new URL(`../../../plugin/office/${name}`, import.meta.url), 'utf8')
      .replace(/\/\/.*$/gm, '')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
    const bad = src.match(/\b(?:const|let|var|function|class)\s+(?:h|Fragment)\b|[(,]\s*(?:h|Fragment)\s*[,)=]|\b(?:h|Fragment)\s*=>|[{,]\s*(?:h|Fragment)\s*[,}]/);
    assert.equal(bad, null, `${name}: ${bad?.[0]}`);
  }
});
