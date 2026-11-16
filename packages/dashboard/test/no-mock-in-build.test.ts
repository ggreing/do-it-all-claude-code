// Guards the fix for the 0.1.0 mock-in-production bug: the shipped dashboard must talk to the daemon, never
// show the sample data from mock.ts / settings-mock.ts. Run after `npm run build:dashboard`; when there is no
// dist/ (a plain local `npm test` without a build), it skips. CI builds the dashboard before the tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const assetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets');

// Strings that appear only in the mock modules (never in the live client).
const MOCK_MARKERS = ['matched the files rule', 'DIACC_SETTINGS_MOCK_ONLY', 'mock-csrf'];
// Strings the live client always emits, so we know the real API code shipped.
const LIVE_PATHS = ['/dashboard/metrics/', '/dashboard/settings'];

test('the built dashboard has no mock data and calls the live API', { skip: !fs.existsSync(assetsDir) && 'no dist/ — run `npm run build:dashboard` first' }, () => {
  const files = fs.readdirSync(assetsDir).filter(f => f.endsWith('.js'));
  assert.ok(files.length > 0, 'expected built .js assets in dist/assets');
  const bundle = files.map(f => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
  for (const marker of MOCK_MARKERS) {
    assert.ok(!bundle.includes(marker), `mock marker leaked into the production build: ${JSON.stringify(marker)} — mock must be dev-only`);
  }
  for (const p of LIVE_PATHS) {
    assert.ok(bundle.includes(p), `live API path missing from the build: ${p} — the real client did not ship`);
  }
});
