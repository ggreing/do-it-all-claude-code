import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRESETS as PRESETS0, L3_PLANNED_AS_L2, L3_SIGNS, L3_SIZE_RULE, RULE_CONFIDENCE_THRESHOLD, TEAM_SIZE_RULE, formatTriageContext, l3SignalRoles, ladderStep, memberStartCell, promptFeatures, triage, uncertainLevel, withLeadModel } from '@do-it-all-claude-code/core';
import type { Difficulty, Role, TeamPreset } from '@do-it-all-claude-code/core';

// Briefs for delegated teams: L1 is lead-direct by default (decision 88), so tests of the team brief turn it off.
const DEFAULT_PRESETS = PRESETS0;
const TEAM = { ...PRESETS0, L1: { ...PRESETS0.L1, leadDirect: false } };

// Decision 225: a brief shows each role's start cell for the request's difficulty, moderate before the lead reports
// one. Which cell that is belongs to the ladder and the profiles (their tests); these tests check that the brief shows it.
const cell = (p: TeamPreset, role: Role, d: Difficulty = 'moderate') => {
  const m = p.roles.find(r => r.role === role && r.count > 0)!;
  return memberStartCell(role, m.start, m.startSet, d);
};
const callOf = (p: TeamPreset, role: Role, d: Difficulty = 'moderate') => {
  const s = ladderStep(cell(p, role, d));
  return `subagent_type "do-it-all-claude-code:${role}", model "${s.alias}", effort "${s.effort}"`;
};
const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('typo fix is L0', () => {
  const r = triage({ prompt: 'src/util.ts 에 있는 오타 하나 고쳐줘' });
  assert.equal(r.level, 'L0');
  assert.equal(r.source, 'rule');
});

test('a new service request is planned at L2 and keeps its L3 signs (decision 119)', () => {
  const r = triage({ prompt: '결제 처리를 위한 신규 서비스를 처음부터 설계하고 구현해줘. 아키텍처 문서도 함께.' });
  assert.deepEqual([r.kind, r.level, r.preset, r.budgetUsd, r.l3Signs], ['team', 'L2', 'L2', DEFAULT_PRESETS.L2.budgetUsd, true]);
  assert.ok(r.rationale.startsWith(L3_PLANNED_AS_L2));
  // ten or more files named: the same
  const many = triage({ prompt: 'update these: ' + Array.from({ length: L3_SIZE_RULE.files }, (_, i) => `src/m${i}/file${i}.ts`).join(', ') });
  assert.deepEqual([many.level, many.rule, many.l3Signs], ['L2', 'many-files', true]);
  assert.ok(many.rationale.startsWith(L3_PLANNED_AS_L2));
  // no rule plans L3, and only these two mark it
  for (const prompt of ['fix the typo in README.md', '태스크에 댓글 기능 넣어줘', 'Refactor the validation module across multiple files and add an audit log']) {
    assert.equal(triage({ prompt }).l3Signs, false, prompt);
  }

  // The team brief of a marked request shows the L3 team as the lead's own way up: the lead reports level L3 before
  // its first Agent call (decision 226), and the report's answer gives the L3 team's values, so none are listed here.
  const brief = formatTriageContext(r, DEFAULT_PRESETS.L2);
  assert.match(brief, /^\[do-it-all-claude-code\] level L2 /);
  assert.ok(brief.includes(`team preset L2: architect x1 @${cell(DEFAULT_PRESETS.L2, 'architect')};`), brief);
  assert.ok(brief.includes(`If it is clearly beyond this team (${L3_SIGNS}, or edits in ${L3_SIZE_RULE.files} or more files), report level "L3" in router_report_triage before your first Agent call (kind "team", with files, confidence and difficulty): the router re-plans this request as L3, and its answer gives the L3 team's values. When unsure, stay with this team.`), brief);
  assert.doesNotMatch(brief, /L3 team \(team preset L3\)|make your first (Agent )?call the/);
  assert.equal(brief.match(/\[subtask:<ID>\]/g)!.length, 1);
  // no first call has to show the level: an L3 team whose roles all start at L2's cells is offered the same way
  const noUi = { ...DEFAULT_PRESETS.L3, roles: DEFAULT_PRESETS.L3.roles.filter(x => x.role !== 'ui-designer') };
  assert.deepEqual(l3SignalRoles(DEFAULT_PRESETS.L2, noUi), []);
  assert.match(formatTriageContext(r, DEFAULT_PRESETS.L2, { ...DEFAULT_PRESETS, L3: noUi }), /report level "L3" in router_report_triage/);
  // an unmarked L2 request, a stored row without the mark, a lead-direct L3, no L3 team: no L3 text
  const plain = triage({ prompt: 'Refactor the validation module across multiple files and add an audit log' });
  assert.doesNotMatch(formatTriageContext(plain, DEFAULT_PRESETS.L2), /L3/);
  const { l3Signs: _m, ...unmarked } = r;
  assert.doesNotMatch(formatTriageContext(unmarked, DEFAULT_PRESETS.L2), /L3 team/);
  assert.doesNotMatch(formatTriageContext(r, DEFAULT_PRESETS.L2, { ...DEFAULT_PRESETS, L3: { ...DEFAULT_PRESETS.L3, leadDirect: true } }), /L3 team/);
  assert.doesNotMatch(formatTriageContext(r, DEFAULT_PRESETS.L2, DEFAULT_PRESETS.L2), /L3 team/);
  // a request the user put at L3 by hand gets the L3 team brief itself, not the way up
  assert.doesNotMatch(formatTriageContext({ ...r, level: 'L3', preset: 'L3', source: 'manual' }, DEFAULT_PRESETS.L3), /Larger team/);
});

test('questions stay cheap', () => {
  assert.equal(triage({ prompt: '이 함수는 왜 null을 반환해?' }).taskType, 'question');
});

test('"pylint" is not a lint task', () => {
  assert.notEqual(triage({ prompt: 'pylint의 pyreverse가 타입 힌트를 UML에 반영하도록 해줘' }).level, 'L0');
});

test('low confidence falls back to L1', () => {
  const r = triage({ prompt: '음' });
  assert.equal(r.level, 'L1');
  assert.equal(r.source, 'default');
  assert.ok(r.confidence < RULE_CONFIDENCE_THRESHOLD);
});

test('lead brief names the per-role start step with model and effort', () => {
  const r = triage({ prompt: '모듈 단위로 리팩터링해줘' });
  const text = formatTriageContext(r, DEFAULT_PRESETS[r.level]);
  // the team line gives each role's count and step; its model and effort are in its Agent call line, once
  const L2 = DEFAULT_PRESETS.L2;
  assert.ok(text.includes(`team preset L2: architect x1 @${cell(L2, 'architect')}; coder x2 @${cell(L2, 'coder')}; reviewer x1 @${cell(L2, 'reviewer')}; tester x1 @${cell(L2, 'tester')}. budget $5.`), text);
  assert.ok(text.includes(`- architect: ${callOf(L2, 'architect')}`));
  assert.doesNotMatch(text, /model=/);
  assert.match(text, /\[subtask:<ID>\]/);
});

test('decision 225: a team brief asks for the difficulty before the first Agent call, once, and lists the moderate cells', () => {
  const r = triage({ prompt: '모듈 단위로 리팩터링해줘' });
  const text = formatTriageContext(r, DEFAULT_PRESETS[r.level]);
  // the signals of docs/design/difficulty-steps.md, said once
  assert.match(text, /^Difficulty: hard if any of these holds: no test reproduces the problem and one is not obvious; .*a first attempt is likely to be subtly wrong\. Routine if all hold: .*Otherwise moderate\. Difficulty is not size/m);
  assert.equal(text.match(/^Difficulty: /gm)!.length, 1);
  assert.ok(text.includes('Before your first Agent call, call router_report_triage with kind "team", level "L2", files and confidence (your estimates) and difficulty. The values below are for moderate; for routine or hard, use the ones its answer gives.'));
  // before the Agent calls, which show the moderate cells
  assert.ok(text.indexOf('router_report_triage') < text.indexOf('2. Call the Agent tool'));
  for (const role of ['architect', 'coder', 'reviewer', 'tester'] as const) assert.ok(text.includes(callOf(DEFAULT_PRESETS.L2, role)), role);
  // the brief the report answers with: what was reported, its cells, and no second request for it
  const after = formatTriageContext({ ...r, difficulty: 'hard', difficultySource: 'lead' }, DEFAULT_PRESETS[r.level]);
  assert.match(after, /^Difficulty hard, as you reported: the values below are for it\.$/m);
  assert.doesNotMatch(after, /router_report_triage|^Difficulty: hard if/m);
  for (const role of ['architect', 'coder', 'reviewer', 'tester'] as const) assert.ok(after.includes(callOf(DEFAULT_PRESETS.L2, role, 'hard')), role);
  // the router's own default is not a report: the brief still asks
  assert.match(formatTriageContext({ ...r, difficulty: 'moderate', difficultySource: 'default' }, DEFAULT_PRESETS[r.level]), /Before your first Agent call, call router_report_triage/);
});

test('decision 225: a small change the lead keeps is handed on when it is hard, for a lead that is not Opus-class', () => {
  const sonnet = withLeadModel(DEFAULT_PRESETS, 'claude-sonnet-5-5');
  const t = { ...triage({ prompt: 'slugify drops accents, please fix the bug' }, sonnet), kind: 'direct' as const };
  const direct = { ...sonnet.L1, leadDirect: true };
  const invite = 'Small is not always easy: if your look shows the change is hard (no test reproduces it, the cause is unclear, the right behaviour is ambiguous, or the work is reasoning-heavy), do not edit. Call router_report_triage with kind "direct", level "L1", files, lines, confidence and difficulty "hard": its answer gives the Agent call for a coder on a stronger model.';
  for (const leadClass of ['sonnet', 'haiku', 'other'] as const) assert.ok(formatTriageContext(t, direct, sonnet, { leadClass }).includes(invite), leadClass);
  // an Opus-class lead keeps a small hard change; no invite either when the caller names no class, or after a report
  for (const opts of [{ leadClass: 'opus' as const }, {}]) assert.doesNotMatch(formatTriageContext(t, direct, sonnet, opts), /router_report_triage|Small is not always easy/);
  assert.doesNotMatch(formatTriageContext({ ...t, difficulty: 'routine', difficultySource: 'lead' }, direct, sonnet, { leadClass: 'sonnet' }), /Small is not always easy/);
  // the uncertain lead-direct brief: the signals and the invite, and the switch reports the difficulty first
  const unclear = triage({ prompt: '태스크에 댓글 기능 넣어줘' });
  const u = formatTriageContext(unclear, DEFAULT_PRESETS.L1, DEFAULT_PRESETS, { leadClass: 'haiku' });
  assert.match(u, /^Difficulty: hard if any of these holds/m);
  assert.ok(u.includes(invite));
  assert.ok(u.includes('To switch, first call router_report_triage with kind "team", level "L2" or "L3" (the team you chose), files and confidence (your estimates) and difficulty: the router re-plans this request at that level.'), u);
  assert.ok(u.includes('for the L2 team with exactly the parameters below, or for routine or hard the ones its answer gives (these are for moderate)'), u);
});

test('lead brief is directive and spells out the Agent call for every preset role', () => {
  for (const level of ['L1', 'L2', 'L3'] as const) {
    const p = TEAM[level];
    const text = formatTriageContext({ level, confidence: 0.9, source: 'rule', taskType: 'feature', preset: p.id, budgetUsd: p.budgetUsd, rationale: 'x' }, p);
    assert.match(text, /Do not edit or write files yourself/);
    for (const r of p.roles) assert.match(text, new RegExp(`subagent_type "do-it-all-claude-code:${r.role}", model "(haiku|sonnet|opus|fable)", effort "\\w+"`));
    assert.match(text, /\[scope: /);
  }
});

test('English keywords need word boundaries (review #10)', () => {
  const r = triage({ prompt: 'fix typo: optional is misspelled in README.md' });
  assert.equal(r.level, 'L0');
  assert.doesNotMatch(r.rationale, /new API|small feature/);
  const rapid = triage({ prompt: 'make the rapid prefix handling in node_modules docs clearer' });
  assert.doesNotMatch(rapid.rationale, /new API|module-level|bug fix/);
});

test('pasted stack traces and code blocks do not count as mentioned files (review #9)', () => {
  const frames = Array.from({ length: 10 }, (_, i) => `    at fn${i} (src/mod${i}/file${i}.ts:${i + 1}:5)`).join('\n');
  const r = triage({ prompt: `parseConfig throws on empty input, please fix\nTypeError: Cannot read properties of undefined\n${frames}` });
  assert.notEqual(r.level, 'L3');
  assert.doesNotMatch(r.rationale, /10 files/);
  assert.match(r.rationale, /log attached/);
  assert.equal(r.taskType, 'debug');
  const imports = '```ts\n' + Array.from({ length: 6 }, (_, i) => `import { x${i} } from './lib/m${i}.ts';`).join('\n') + '\n```';
  assert.doesNotMatch(triage({ prompt: `이 파일 맨 위 import 정리해줘\n${imports}` }).rationale, /\d+ files/);
});

test('a question about a failure is a debugging task, not an L0 question (review #11)', () => {
  const r = triage({ prompt: 'Why does the build fail on Windows only?' });
  assert.equal(r.taskType, 'debug');
  assert.notEqual(r.level, 'L0');
  assert.equal(triage({ prompt: 'What does the slugify helper return for empty strings?' }).taskType, 'question');
});

test('no brief asks for worktree isolation: parallel writers share the working tree (decisions 83, 219)', () => {
  const brief = (level: 'L0' | 'L1' | 'L2' | 'L3') => {
    const p = TEAM[level];
    return formatTriageContext({ level, confidence: 0.9, source: 'rule', taskType: 'feature', preset: p.id, budgetUsd: p.budgetUsd, rationale: 'x' }, p);
  };
  assert.match(brief('L1'), /Do not pass isolation/);
  for (const l of ['L1', 'L2', 'L3'] as const) assert.doesNotMatch(brief(l), /isolation "worktree"|merge their branches/);
  for (const l of ['L2', 'L3'] as const) {
    assert.match(brief(l), /Do not pass isolation: the writers share the working tree/);
    assert.match(brief(l), /runs the build and tests once, when the last one stops/);
  }
  assert.match(brief('L1'), /task-notification/);
});

test('L0 and L1 are handled by the lead directly by default; team briefs keep the lead from reading files and re-running checks (decisions 87, 88)', () => {
  const brief = (level: 'L0' | 'L1' | 'L2' | 'L3', presets = DEFAULT_PRESETS) => {
    const p = presets[level];
    return formatTriageContext({ level, confidence: 0.9, source: 'rule', taskType: 'edit', preset: p.id, budgetUsd: p.budgetUsd, rationale: 'x' }, p);
  };
  for (const l of ['L0', 'L1'] as const) {
    assert.equal(DEFAULT_PRESETS[l].leadDirect, true);
    assert.match(brief(l), /handled by you directly/);
    assert.doesNotMatch(brief(l), /subagent_type/);
  }
  for (const l of ['L1', 'L2', 'L3'] as const) {
    assert.match(brief(l, TEAM), /Do not open or read source files to plan/);
    assert.match(brief(l, TEAM), /do not run the build or the tests yourself/);
    assert.match(brief(l, TEAM), /A report without that line is not verified yet/);
  }
});

// ------------------------------------------------------------------ three-way answer (decisions 104-111)

test('stage 1 answers direct, team or uncertain, and the level follows the answer', () => {
  const cases: Array<[string, 'direct' | 'team' | 'uncertain', 'L0' | 'L1' | 'L2' | 'L3', string]> = [
    ['fix the typo in README.md', 'direct', 'L0', 'l0-keyword'],
    ['Fix the typo in the error message in src/a/x.ts', 'direct', 'L0', 'l0-keyword'],
    ['Fix the bug where parse() fails on empty input in src/parse.ts', 'direct', 'L1', 'small-fix'],
    ['Also fix the bug in src/b/y.ts where it fails on empty input', 'direct', 'L1', 'small-fix'],
    ['이 함수는 왜 null을 반환해?', 'direct', 'L0', 'question'],
    ['Refactor the validation module across multiple files and add an audit log', 'team', 'L2', 'stated-breadth'],
    ['Add a pagination module and refactor the API layer across multiple files', 'team', 'L2', 'stated-breadth'],
    ['결제 처리를 위한 신규 서비스를 처음부터 설계하고 구현해줘. 아키텍처 문서도 함께.', 'team', 'L2', 'l3-keyword'],
    ['태스크에 댓글 기능 넣어줘', 'uncertain', 'L1', 'none'],
    ['convert the data access layer from callbacks to async/await', 'uncertain', 'L1', 'none'],
    ['src/parse.ts', 'uncertain', 'L1', 'none'],
    ['', 'uncertain', 'L1', 'none'],
  ];
  for (const [prompt, kind, level, rule] of cases) {
    const r = triage({ prompt });
    assert.deepEqual([r.kind, r.level, r.rule], [kind, level, rule], prompt);
    assert.equal(r.source, kind === 'uncertain' ? 'default' : 'rule', prompt);
    assert.equal(r.confidence < RULE_CONFIDENCE_THRESHOLD, kind === 'uncertain', prompt);
    assert.ok(r.teamScore >= 0 && r.teamScore <= 1);
    assert.notEqual(r.level, 'L3', prompt);
  }
});

test('the size of the request is not the size of the change', () => {
  // a long bug report with a stack trace and environment details is still one fix
  const frames = Array.from({ length: 12 }, (_, i) => `    at fn${i} (/app/src/mod${i}/file${i}.ts:${i + 1}:5)`).join('\n');
  const report = `Production crash after the last deploy.\n\nTypeError: Cannot read properties of undefined (reading 'lines')\n${frames}\n\n`
    + 'Environment: Node 24, Postgres 16. '.repeat(30) + '\nExpected: an order without a shipment renders with a total of 0. Please fix and add a regression test.';
  assert.notEqual(triage({ prompt: report }).kind, 'team');
  // naming four files does not make a team (tests and helpers are named too) ...
  const four = '캐시에 TTL 옵션을 넣어 주세요. 손댈 곳은 `src/cache/cache.ts`, `src/config/schema.ts`, `test/cache/cache.test.ts`이고 시계는 `src/util/clock.ts`에 있습니다.';
  assert.equal(triage({ prompt: four }).kind, 'uncertain');
  // ... a long list does
  const six = 'update these: src/a/one.ts, src/a/two.ts, src/b/three.ts, src/b/four.ts, src/c/five.ts, src/c/six.ts';
  assert.deepEqual([triage({ prompt: six }).kind, triage({ prompt: six }).rule], ['team', 'many-files']);
  // "all of them" is never settled as a small direct change, even with an L0 word in it
  assert.equal(triage({ prompt: '에러 메시지를 전부 메시지 키로 바꾸고 한국어/영어 카탈로그 붙여줘' }).kind, 'uncertain');
  assert.equal(triage({ prompt: 'fix the typo in every error message' }).kind, 'uncertain');
});

test('with a lead that delegates L1, an uncertain request gets the L2 team and staffs it itself (decision 121)', () => {
  const prompt = '태스크에 댓글 기능 넣어줘';
  const opus = withLeadModel(DEFAULT_PRESETS, 'claude-opus-5-5');
  const haiku = withLeadModel(DEFAULT_PRESETS, 'claude-haiku-5-5');
  const sonnet = withLeadModel(DEFAULT_PRESETS, 'claude-sonnet-5-5');
  assert.deepEqual([uncertainLevel(DEFAULT_PRESETS), uncertainLevel(haiku), uncertainLevel(sonnet), uncertainLevel(opus)], ['L1', 'L1', 'L2', 'L2']);
  // L2 lead-direct as well (teams.yaml): nothing to delegate to, so the request stays L1
  assert.equal(uncertainLevel({ ...opus, L2: { ...opus.L2, leadDirect: true } }), 'L1');

  // a lead that handles L1 itself: as before, lead-direct with the rubric
  const s = triage({ prompt }, haiku);
  assert.deepEqual([s.kind, s.level, s.preset, s.source], ['uncertain', 'L1', 'L1', 'default']);
  assert.match(s.rationale, /-> start as L1, the lead decides$/);
  assert.match(formatTriageContext(s, haiku[s.level], haiku), /handled by you directly/);

  // a lead that delegates L1: the L2 team, still uncertain (source 'default', low confidence), the lead picks the roles
  const o = triage({ prompt }, opus);
  assert.deepEqual([o.kind, o.level, o.preset, o.budgetUsd, o.source, o.rule], ['uncertain', 'L2', 'L2', DEFAULT_PRESETS.L2.budgetUsd, 'default', 'none']);
  assert.ok(o.confidence < RULE_CONFIDENCE_THRESHOLD);
  assert.match(o.rationale, /-> L2 team, the lead picks the roles$/);
  const brief = formatTriageContext(o, opus[o.level], opus);
  assert.match(brief, /^\[do-it-all-claude-code\] level L2 \(source=default/);
  assert.match(brief, /Do not edit or write files yourself/);
  assert.match(brief, new RegExp(`the staffing is yours: call only the roles the change needs\\. One coder subtask alone is right for a small change \\(fewer than ${TEAM_SIZE_RULE.files} files, one module\\)`));
  assert.match(brief, new RegExp(`${TEAM_SIZE_RULE.dirs} or more modules or layers`));
  for (const r of DEFAULT_PRESETS.L2.roles) assert.match(brief, new RegExp(`subagent_type "do-it-all-claude-code:${r.role}"`));
  assert.doesNotMatch(brief, /handled by you directly|L3/);

  // requests settled as small use the one-coder L1 team; settled team requests get no staffing line
  const small = triage({ prompt: 'Fix the bug where parse() fails on empty input in src/parse.ts' }, opus);
  assert.deepEqual([small.kind, small.level, small.preset], ['direct', 'L1', 'L1']);
  const smallBrief = formatTriageContext(small, opus[small.level], opus);
  assert.ok(smallBrief.includes(`team preset L1: coder x1 @${cell(opus.L1, 'coder')}.`), smallBrief);
  assert.doesNotMatch(smallBrief, /the staffing is yours/);
  const wide = triage({ prompt: 'Refactor the validation module across multiple files and add an audit log' }, opus);
  assert.doesNotMatch(formatTriageContext(wide, opus[wide.level], opus), /the staffing is yours/);
  // trivial requests stay with the lead whatever the lead model
  const typo = triage({ prompt: 'fix the typo in README.md' }, opus);
  assert.match(formatTriageContext(typo, opus[typo.level], opus), /handled by you directly/);
});

test('a written specification with sections, declared types and many requirements is a team request', () => {
  const spec = ['taskboard에 태스크 댓글 기능을 추가해 주세요. 저장소, 서비스, 핸들러에 각각 맞게 나눠서 구현합니다.', '', '## 모델', '```ts', 'interface Comment { id: string; taskId: string; body: string }', '```', '',
    '## 요구 사항', ...Array.from({ length: 9 }, (_, i) => `${i + 1}. 요구 사항 ${i + 1}: ${'댓글을 작성자만 수정할 수 있고 실패하면 정해진 에러로 응답합니다. '.repeat(3)}`)].join('\n');
  const r = triage({ prompt: spec });
  assert.deepEqual([r.kind, r.level, r.rule], ['team', 'L2', 'written-spec']);
  // the same amount of text without the structure is left to stage 2
  assert.equal(triage({ prompt: spec.replace(/^## .*$/gm, '').replace(/```[\s\S]*?```/, '').replace(/^\d+\. /gm, '') }).kind, 'uncertain');
});

test('features are numbers and categories, never prompt text', () => {
  const secret = 'ZZTOPSECRETZZ';
  const f = promptFeatures(`Fix the bug in \`${secret}\` handling, see src/${secret}.ts\n\n## Steps\n- one\n- two\n1. three\n\`\`\`ts\ninterface ${secret} { a: string }\n\`\`\`\nhttps://example.com/${secret}`);
  assert.ok(!JSON.stringify(f).includes(secret));
  for (const v of Object.values(f)) assert.ok(typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 12));
  assert.deepEqual([f.headings, f.bullets, f.numberedItems, f.codeFences, f.typeDecls, f.filePaths, f.urls], [1, 2, 1, 1, 1, 1, 1]);
  assert.deepEqual(triage({ prompt: 'fix the typo in README.md' }).features, promptFeatures('fix the typo in README.md'));
  assert.ok(Number(promptFeatures('오타를 고쳐 주세요').hangulRatio) > 0.9);
});

test('an uncertain lead-direct request gets the rubric and the L2 call values; a settled one does not', () => {
  const t = triage({ prompt: '태스크에 댓글 기능 넣어줘' });
  const text = formatTriageContext(t, DEFAULT_PRESETS.L1);
  assert.match(text, /^\[do-it-all-claude-code\] level L1 \(source=default, confidence=0\.\d\d\)/);
  assert.match(text, /handled by you directly/);
  assert.match(text, new RegExp(`${TEAM_SIZE_RULE.files} or more files`));
  assert.match(text, new RegExp(`${TEAM_SIZE_RULE.dirs} or more modules`));
  for (const r of DEFAULT_PRESETS.L2.roles) assert.match(text, new RegExp(`subagent_type "do-it-all-claude-code:${r.role}", model "(haiku|sonnet|opus)", effort "\\w+"`));
  assert.match(text, /\[subtask:<ID>\]/);
  // decisions 113, 226: the L3 team is offered too, with a higher bar; the lead names the team in its report, whose
  // answer gives the L3 team's values, so the brief lists the L2 team's alone and names no first call
  assert.match(text, new RegExp(`Which team: the L2 team, unless the change is clearly beyond it: ${L3_SIGNS}, or edits in ${L3_SIZE_RULE.files} or more files\\.`));
  assert.match(text, /When unsure between the two, use L2\./);
  assert.ok(text.includes('To switch, first call router_report_triage with kind "team", level "L2" or "L3" (the team you chose), files and confidence (your estimates) and difficulty: the router re-plans this request at that level. Then call the Agent tool once per subtask: for the L3 team with the values its answer gives, for the L2 team with exactly the parameters below'), text);
  assert.ok(text.includes(`L2 team (team preset L2):\n   - architect: ${callOf(DEFAULT_PRESETS.L2, 'architect')}`), text);
  assert.doesNotMatch(text, /L3 team \(team preset L3\)|ui-designer|make your first call|when that call is/);
  assert.equal(text.match(/\[subtask:<ID>\]/g)!.length, 1);
  assert.ok(L3_SIZE_RULE.files > TEAM_SIZE_RULE.files);
  // the router still reads a first call that shows L3 (decision 226: start cells follow the difficulty, not the level,
  // so of the defaults only the ui-designer, which L2 lacks, does), unasked
  assert.deepEqual(l3SignalRoles(DEFAULT_PRESETS.L2, DEFAULT_PRESETS.L3), ['ui-designer']);
  // the escalation teams are the ones passed in (a customised teams.yaml); a single preset is the L2 team alone
  const custom = { ...DEFAULT_PRESETS.L2, roles: [{ role: 'coder' as const, count: 1, start: 's3' as const }] };
  const customText = formatTriageContext(t, DEFAULT_PRESETS.L1, custom);
  assert.ok(customText.includes(callOf(custom, 'coder')), customText);
  assert.match(customText, /first call router_report_triage with kind "team", level "L2", .*: the router re-plans this request as L2\./);
  assert.doesNotMatch(customText, /do-it-all-claude-code:architect|L3/);
  const both = formatTriageContext(t, DEFAULT_PRESETS.L1, { ...DEFAULT_PRESETS, L2: custom });
  assert.ok(both.includes('level "L2" or "L3" (the team you chose)'), both);
  assert.ok(both.includes(callOf(custom, 'coder')));
  // the report raises it whatever the cells: an L3 team whose roles all start at L2's cells is offered too; no L3
  // path when L3 is lead-direct or there is no L3 team
  const noUi = { ...DEFAULT_PRESETS.L3, roles: DEFAULT_PRESETS.L3.roles.filter(r => r.role !== 'ui-designer') };
  assert.match(formatTriageContext(t, DEFAULT_PRESETS.L1, { L2: DEFAULT_PRESETS.L2, L3: noUi }), /Which team/);
  assert.doesNotMatch(formatTriageContext(t, DEFAULT_PRESETS.L1, { L2: DEFAULT_PRESETS.L2, L3: { ...DEFAULT_PRESETS.L3, leadDirect: true } }), /Which team/);
  assert.doesNotMatch(formatTriageContext(t, DEFAULT_PRESETS.L1, { L2: DEFAULT_PRESETS.L2 }), /Which team/);
  // settled direct: the short brief, no call values
  const direct = formatTriageContext(triage({ prompt: 'fix the typo in README.md' }), DEFAULT_PRESETS.L0);
  assert.doesNotMatch(direct, /subagent_type|or more files/);
  // uncertain with L1 delegated by configuration: the ordinary team brief
  assert.match(formatTriageContext(t, TEAM.L1), /Do not edit or write files yourself/);
  // a stored result without the new fields (older ledger rows) still formats
  const { kind: _k, rule: _r, teamScore: _s, features: _f, ...old } = t;
  assert.match(formatTriageContext(old, DEFAULT_PRESETS.L1), /handled by you directly/);
});

test('decision 211: what the wording settles as small stays with a Sonnet lead and an unknown one, not with an Opus-class lead', async () => {
  const { SMALL_STAYS_WITH_LEAD, smallStaysWithLead } = await import('@do-it-all-claude-code/core');
  assert.deepEqual(SMALL_STAYS_WITH_LEAD, { opus: false, sonnet: true, haiku: true, other: true });
  const sonnet = withLeadModel(DEFAULT_PRESETS, 'claude-sonnet-5-5');
  // the two rules that settle a request as small: a short fix or option request, and a short one with a log
  const small = triage({ prompt: 'slugify drops accents, please fix the bug' }, sonnet);
  const withLog = triage({ prompt: 'parseConfig throws on empty input\nTypeError: Cannot read properties of undefined\n    at parse (src/config.ts:10:5)' }, sonnet);
  assert.deepEqual([small.level, small.kind, small.rule, withLog.level, withLog.kind, withLog.rule], ['L1', 'direct', 'small-fix', 'L1', 'direct', 'debug-with-log']);
  for (const t of [small, withLog]) {
    assert.deepEqual((['opus', 'sonnet', 'other'] as const).map(c => smallStaysWithLead(t, c)), [false, true, true]);
    // a delegateFrom the user set for the class wins, whatever its value; another class's value does not count
    assert.equal(smallStaysWithLead(t, 'sonnet', { sonnet: 'L1' }), false);
    assert.equal(smallStaysWithLead(t, 'sonnet', { opus: 'L2' }), true);
  }
  // not small by a rule: unclear size, a team by rule, a typo (L0, the lead's anyway), a level set by hand or by the judge
  const unclear = triage({ prompt: 'Make the date picker remember the last chosen month' }, sonnet);
  const team = triage({ prompt: 'Refactor the validation module across multiple files and add an audit log' }, sonnet);
  const typo = triage({ prompt: 'fix the typo in README.md' }, sonnet);
  assert.deepEqual([unclear.kind, team.kind, typo.level], ['uncertain', 'team', 'L0']);
  for (const t of [unclear, team, typo, { ...small, source: 'manual' as const }, { ...small, source: 'judge' as const }]) assert.equal(smallStaysWithLead(t, 'sonnet'), false);
  // the brief of such a request is the short one: no call values, nothing about a team's steps; decision 225 adds one
  // line for the lead it stays with (Sonnet, or a model of no known class): a hard one is reported and handed on
  const brief = formatTriageContext({ ...small, kind: 'direct' }, { ...sonnet.L1, leadDirect: true }, sonnet, { leadClass: 'sonnet' });
  assert.match(brief, /Level L1 is handled by you directly \(team preset lead_direct\): make the change yourself, without subagents/);
  assert.doesNotMatch(brief, /subagent_type|task-notification/);
  assert.equal(brief.match(/router_report_triage/g)?.length, 1);
  assert.ok(brief.length < 720, `${brief.length} characters`);
  const without = formatTriageContext({ ...small, kind: 'direct' }, { ...sonnet.L1, leadDirect: true }, sonnet, { leadClass: 'opus' });
  assert.doesNotMatch(without, /subagent_type|router_report_triage|task-notification/);
  assert.ok(without.length < 450, `${without.length} characters`);
});
