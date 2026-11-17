// Release guard (review L2): the repo's second-door marketplace (.claude-plugin/marketplace.json) pins the
// plugin to a tag; at release its git source must carry both a version ref and the tag's full commit sha, or
// users installing from GitHub get `main`, not the release. This check only runs under the release flag
// (DIACC_RELEASE_CHECK=1) — the sha is filled in at tag time (release-checklist §2), so it is intentionally
// absent on the working branch and the check skips there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const skip = process.env.DIACC_RELEASE_CHECK === '1' ? false : 'not a release check — set DIACC_RELEASE_CHECK=1 at tag time';

test('the repo marketplace pins the plugin to a tag ref and its full sha', { skip }, () => {
  const file = path.join(REPO, '.claude-plugin', 'marketplace.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8')) as { plugins?: Array<{ source?: { ref?: unknown; sha?: unknown } }> };
  const source = m.plugins?.[0]?.source ?? {};
  assert.match(String(source.ref ?? ''), /^v\d+\.\d+\.\d+$/, 'source.ref must be a vX.Y.Z tag');
  assert.match(String(source.sha ?? ''), /^[0-9a-f]{40}$/, 'source.sha must be the tag commit\'s full 40-char sha');
});
