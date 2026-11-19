import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PRESETS, loadPresets } from '@do-it-all-claude-code/core';

const tmp = (name: string, text: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-presets-')); const f = path.join(d, name); fs.writeFileSync(f, text); return f; };

test('teams.yaml: a level may set only lead_direct; other fields come from the base (decision 88)', () => {
  const p = loadPresets(tmp('teams.yaml', 'L1:\n  lead_direct: false\n'));
  assert.equal(p.L1.leadDirect, undefined);
  assert.deepEqual(p.L1.roles, DEFAULT_PRESETS.L1.roles);
  assert.equal(p.L1.budgetUsd, DEFAULT_PRESETS.L1.budgetUsd);
  assert.equal(p.L0.leadDirect, true);
});

test('the repository file layers over the user file', () => {
  const user = loadPresets(tmp('teams.yaml', 'L2:\n  budget_usd: 9\nL1:\n  lead_direct: false\n'));
  const repo = loadPresets(tmp('teams.yaml', 'L2:\n  roles:\n    - { role: coder, count: 1, start: s2 }\n'), user);
  assert.equal(repo.L2.budgetUsd, 9, 'user budget kept');
  assert.deepEqual(repo.L2.roles, [{ role: 'coder', count: 1, start: 's2', startSet: true }]);   // decision 226: a file-set start is marked
  assert.equal(repo.L1.leadDirect, undefined, 'user lead_direct kept');
});

test('invalid teams.yaml throws', () => {
  assert.throws(() => loadPresets(tmp('teams.yaml', 'L1:\n  roles: []\n')));
  assert.throws(() => loadPresets(tmp('teams.yaml', 'L9:\n  lead_direct: true\n')));
});

test('decision 230: every lead class delegates from L1; only L0 is lead-direct by default', async () => {
  const { withLeadModel, leadModelClass } = await import('@do-it-all-claude-code/core');
  assert.equal(leadModelClass('claude-opus-5-5'), 'opus');
  assert.equal(leadModelClass('claude-fable-5-1'), 'opus');
  assert.equal(leadModelClass('claude-sonnet-5-5'), 'sonnet');
  assert.equal(leadModelClass(undefined), 'other');
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', undefined]) {
    const p = withLeadModel(DEFAULT_PRESETS, model);
    assert.equal(p.L0.leadDirect, true, `${model}: L0 lead-direct`);
    assert.equal(p.L1.leadDirect, undefined, `${model}: L1 delegated (decision 230)`);
    assert.equal(p.L2.leadDirect, undefined, `${model}: L2 delegated`);
  }
  const opus = withLeadModel(DEFAULT_PRESETS, 'claude-opus-5-5');
  assert.deepEqual(opus.L1.roles, [{ role: 'coder', count: 1, start: 's1' }], 'light L1 team');
  // a user delegateFrom override still keeps lower levels with the lead
  assert.equal(withLeadModel(DEFAULT_PRESETS, 'claude-sonnet-5-5', { sonnet: 'L2' }).L1.leadDirect, true, 'config override');
  const fileOverride = loadPresets(tmp('teams.yaml', 'L1:\n  lead_direct: true\n'), opus);
  assert.equal(fileOverride.L1.leadDirect, true, 'explicit teams.yaml lead_direct wins');
});
