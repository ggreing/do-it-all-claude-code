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

// decision 192: `/do-it-all-setup` runs `npx -y do-it-all-claude-code@<pinned> setup`. The pin must be a fixed
// version (not a tag or a floating range), so the marketplace-installed plugin fetches a known engine.
const SETUP_CMD = path.join(REPO, 'plugin', 'commands', 'do-it-all-setup.md');
function setupPin(): string | null {
  const m = fs.readFileSync(SETUP_CMD, 'utf8').match(/do-it-all-claude-code@(\d+\.\d+\.\d+)\s+setup/);
  return m ? m[1]! : null;
}

test('the /do-it-all-setup command pins the engine to a fixed X.Y.Z version', () => {
  assert.match(String(setupPin()), /^\d+\.\d+\.\d+$/, 'the command must run `npx -y do-it-all-claude-code@X.Y.Z setup`');
});

test('the /do-it-all-setup pin matches the plugin version at release time', { skip }, () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string };
  assert.equal(setupPin(), plugin.version, 'the setup command pin and plugin.json version must be bumped together (release-checklist §2)');
});
