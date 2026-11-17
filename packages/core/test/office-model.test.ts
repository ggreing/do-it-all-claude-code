// The team office's pure parts (plugin/office/model.ts, decision 186): labels, session lines and their masking, the
// helper's line format, the step against the effort a member ran at, the router home, the version gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  MAX_ROWS, callRow, checksLine, compileSecrets, homeCandidates, labelFor, mask, modelName, officeSwitch, parseHelperLine,
  requestLine, resultRow, roleOf, stepLine, subtaskOf, tagOf, takeLines, textRow, versionAtLeast, withRow,
  type DaemonOffice, type DaemonSubtask, type OfficeAgent,
} from '../../../plugin/office/model.ts';

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
