// scripts/build-npm.mjs — build the single publishable `do-it-all-claude-code` npm package (distribution note,
// option A). esbuild bundles the CLI, daemon, proxy and the two apiKeyHelper scripts to dependency-free
// JavaScript (zod and yaml inlined; node builtins stay external), then the plugin templates are copied in and
// a package.json with both bin entries and no runtime dependencies is written. The
// helpers are bundled (not copied) so they are self-contained: copied into the router home, key-helper.mjs's
// `../src/vault.ts` import would otherwise resolve against the home. It finishes with an `npm pack --dry-run`
// listing and, unless --no-smoke, a local install + `--version`/`doctor` smoke test in a throwaway prefix and
// home. Nothing is published and nothing is committed; all output lives under build/ (git-ignored).
//
// This script never runs `npm publish`. Publishing is a deliberate, separate step done by hand (or by the
// release workflow) from a clean checkout of the release tag on announcement day — not from the working tree
// this script builds. `--publish` only prints that reminder; it is off by default and does not publish.
//
// Usage: node scripts/build-npm.mjs [--out <dir>] [--minify] [--no-smoke] [--publish]
//
// Note on the shipped layout (flat: dist/cli.js, dist/proxy.js, dist/daemon.js, plugin/): the
// CLI's workspace-era path resolution (import.meta.resolve of the sibling packages, ../../../plugin,
// proxyEntry -> src/main.ts) does not yet point at this layout. Those are init/spawn
// changes owned by the cli package; this script only produces the target the CLI should resolve against. The
// smoke test is scoped to `--version`, `doctor` and `setup --no-start` on a throwaway home (and a throwaway
// CLAUDE_CONFIG_DIR / Claude settings file), none of which spawn the daemon/proxy or touch the real ~/.claude.
import esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const OUT = path.resolve(opt('--out', path.join(ROOT, 'build', 'npm')));
const PKG = path.join(OUT, 'package');
const MINIFY = has('--minify');
const SMOKE = !has('--no-smoke');
const PUBLISH = has('--publish');   // off by default; never actually publishes (see the note at the top)

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = rootPkg.version;

const rm = p => fs.rmSync(p, { recursive: true, force: true });
const copyDir = (from, to, filter) => fs.cpSync(from, to, { recursive: true, ...(filter ? { filter } : {}) });
const copyFile = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const kb = bytes => `${(bytes / 1024).toFixed(1)} kB`;

// zod is ESM but `yaml` is CommonJS; esbuild bundles it into the ESM output behind a `__require` shim that
// throws for Node builtins (`require("process")`). Defining a real `require` via createRequire makes the shim
// use it. It must sit AFTER the entry's `#!/usr/bin/env node` shebang (a shebang is only valid on line 1), so
// this inserts it there rather than using an esbuild banner (which would push the shebang to line 2).
function injectRequireShim(file) {
  const shim = "import { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);\n";
  const code = fs.readFileSync(file, 'utf8');
  if (code.startsWith('#!')) {
    const nl = code.indexOf('\n') + 1;
    fs.writeFileSync(file, code.slice(0, nl) + shim + code.slice(nl));
  } else {
    fs.writeFileSync(file, shim + code);
  }
}

async function main() {
  console.log(`build-npm: do-it-all-claude-code ${VERSION} (esbuild ${esbuild.version})`);

  rm(OUT);
  fs.mkdirSync(PKG, { recursive: true });

  // 1) Bundle the three server entries to dependency-free ESM.
  const entries = [
    { name: 'cli', input: 'packages/cli/src/index.ts', out: 'dist/cli.js', bin: true },
    { name: 'proxy', input: 'packages/proxy/src/main.ts', out: 'dist/proxy.js', bin: true },
    { name: 'daemon', input: 'packages/daemon/src/main.ts', out: 'dist/daemon.js', bin: false },
  ];
  for (const e of entries) {
    await esbuild.build({
      entryPoints: [path.join(ROOT, e.input)],
      outfile: path.join(PKG, e.out),
      bundle: true, platform: 'node', format: 'esm', target: 'node24',
      splitting: false,          // one self-contained file per entry; dynamic import()s of internal modules inline
      minify: MINIFY, sourcemap: false, legalComments: 'none', logLevel: 'warning',
      // No banner: esbuild preserves the entry file's own `#!/usr/bin/env node` shebang on line 1. Adding one
      // here would duplicate it onto line 2, which is a syntax error.
      // platform:node externalises node: builtins (incl. node:sqlite); zod, yaml and the @do-it-all-claude-code/*
      // workspace packages are bundled in. import.meta.url/import.meta.resolve are preserved as-is.
    });
    injectRequireShim(path.join(PKG, e.out));
    if (e.bin) { try { fs.chmodSync(path.join(PKG, e.out), 0o755); } catch { /* Windows: npm sets the bit on pack */ } }
    console.log(`  bundled ${e.name.padEnd(6)} -> ${e.out} (${kb(fs.statSync(path.join(PKG, e.out)).size)})`);
  }

  // 2) Bundle the two apiKeyHelper scripts to self-contained dist/*.mjs (so the router-home copy has no dangling
  //    relative import). local-token.mjs is already node-only; key-helper.mjs pulls in the proxy vault.
  for (const h of ['local-token', 'key-helper']) {
    const out = path.join(PKG, 'dist', `${h}.mjs`);
    await esbuild.build({
      entryPoints: [path.join(ROOT, 'packages', 'proxy', 'bin', `${h}.mjs`)],
      outfile: out, bundle: true, platform: 'node', format: 'esm', target: 'node24',
      splitting: false, minify: MINIFY, sourcemap: false, legalComments: 'none', logLevel: 'warning',
    });
    injectRequireShim(out);
    console.log(`  bundled helper ${h.padEnd(11)} -> dist/${h}.mjs (${kb(fs.statSync(out).size)})`);
  }

  // 3) Copy the templates and the license/notice/readmes.
  // Ship the plugin templates, minus the `claude plugin test` kit (plugin/office/test, release-checklist only)
  // and the engine's hot-reload type cache (plugin/.claude-plugin/types, git-ignored).
  const pluginSrc = path.join(ROOT, 'plugin');
  const pluginSkip = [path.join('office', 'test'), path.join('.claude-plugin', 'types')];
  copyDir(pluginSrc, path.join(PKG, 'plugin'), src => {
    const rel = path.relative(pluginSrc, src);
    return !pluginSkip.some(s => rel === s || rel.startsWith(s + path.sep));
  });
  const docs = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'README.ko.md', 'README.ja.md', 'README.zh-CN.md'];
  for (const f of docs) if (fs.existsSync(path.join(ROOT, f))) copyFile(path.join(ROOT, f), path.join(PKG, f));
  console.log('  copied plugin/, license/notice/readmes');

  // 4) Write the package.json: both bins, a files allowlist, and no runtime dependencies.
  const pkgJson = {
    name: 'do-it-all-claude-code',
    version: VERSION,
    description: rootPkg.description,
    license: 'BUSL-1.1',
    type: 'module',
    engines: { node: '>=24.5' },
    bin: {
      'do-it-all-claude-code': 'dist/cli.js',
      'do-it-all-claude-code-proxy': 'dist/proxy.js',
    },
    files: ['dist/', 'plugin/', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'README.ko.md', 'README.ja.md', 'README.zh-CN.md'],
    repository: { type: 'git', url: 'git+https://github.com/ggreing/do-it-all-claude-code.git' },
    homepage: 'https://github.com/ggreing/do-it-all-claude-code#readme',
    bugs: { url: 'https://github.com/ggreing/do-it-all-claude-code/issues' },
  };
  fs.writeFileSync(path.join(PKG, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');
  console.log('  wrote package.json (no runtime dependencies)');

  // 5) npm pack --dry-run: the file list and size of what would be published.
  console.log('\n--- npm pack --dry-run ---');
  const dry = JSON.parse(execSync('npm pack --dry-run --json', { cwd: PKG, encoding: 'utf8' }));
  const info = dry[0];
  for (const f of info.files) console.log(`  ${kb(f.size).padStart(9)}  ${f.path}`);
  console.log(`  ----`);
  console.log(`  ${info.entryCount} files · packed ${kb(info.size)} · unpacked ${(info.unpackedSize / 1024 / 1024).toFixed(2)} MB`);

  if (PUBLISH) {
    console.log('\n--- publish ---');
    console.log('This script does not publish. Publish by hand (or via the release workflow) on announcement day,');
    console.log('from a clean checkout of the release tag — not from this working-tree build. First set the');
    console.log('marketplace.json ref/sha for the tag; then run `npm publish`. See docs/release-checklist.md.');
  }

  if (!SMOKE) { console.log('\n(skipping smoke test: --no-smoke)'); return; }

  // 6) Smoke test: pack for real, install into a throwaway prefix, run --version and doctor on a throwaway home.
  console.log('\n--- smoke test (local install; nothing published) ---');
  const packed = JSON.parse(execSync('npm pack --json', { cwd: PKG, encoding: 'utf8' }));
  const tarball = path.join(PKG, packed[0].filename);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'diacc-pack-'));
  const prefix = path.join(work, 'prefix');
  const home = path.join(work, 'home');
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const isWin = process.platform === 'win32';
  const q = s => `"${s}"`;
  const run = (cmd, cwd, env) => {
    try { return { code: 0, out: execSync(cmd, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (e) { return { code: e.status ?? null, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
  };

  console.log(`  installing ${packed[0].filename} into a temp prefix…`);
  const inst = run(`npm install -g --prefix ${q(prefix)} --no-audit --no-fund --prefer-offline ${q(tarball)}`, work);
  if (inst.code !== 0) { console.error('  install FAILED:\n' + inst.out); process.exit(1); }

  const binPath = isWin ? path.join(prefix, 'do-it-all-claude-code.cmd') : path.join(prefix, 'bin', 'do-it-all-claude-code');
  if (!fs.existsSync(binPath)) { console.error(`  installed bin not found at ${binPath}`); process.exit(1); }
  console.log(`  installed bin: ${binPath}`);

  const env = { DO_IT_ALL_CLAUDE_CODE_HOME: home };
  const results = [];
  for (const sub of ['--version', 'doctor']) {
    const r = run(`${q(binPath)} ${sub}`, work, env);
    const ran = r.out.length > 0 || r.code !== null;        // the command executed (did not fail to launch)
    results.push({ sub, code: r.code, ran });
    console.log(`\n  $ do-it-all-claude-code ${sub}   (exit ${r.code})`);
    console.log(r.out.split('\n').map(l => '    ' + l).join('\n').replace(/\n\s*$/, ''));
  }

  // `setup --no-start` (decision 192): the home-side install work — copy the app into the router home, generate
  // the plugin and register the status line — WITHOUT starting the daemon. It runs against a throwaway home, a
  // throwaway CLAUDE_CONFIG_DIR and a throwaway Claude settings file, and an isolated (empty) legacy home, so
  // nothing touches the real ~/.claude or ~/.agentic-router. The plugin's `claude plugin …` registration needs a
  // real `claude` on PATH; here it is absent and fails gracefully, so this checks the home-side work only.
  console.log('\n--- smoke: setup --no-start (isolated home + CLAUDE_CONFIG_DIR; never ~/.claude) ---');
  const setupHome = path.join(work, 'setup-home');
  const claudeCfg = path.join(work, 'claude-config');
  const claudeSettings = path.join(work, 'claude-settings.json');
  fs.mkdirSync(setupHome, { recursive: true });
  fs.mkdirSync(claudeCfg, { recursive: true });
  const setupEnv = { DO_IT_ALL_CLAUDE_CODE_HOME: setupHome, AGENTIC_ROUTER_HOME: path.join(work, 'legacy-none'), CLAUDE_CONFIG_DIR: claudeCfg };
  const s = run(`${q(binPath)} setup --yes --no-start --claude-settings ${q(claudeSettings)}`, work, setupEnv);
  console.log(`  $ do-it-all-claude-code setup --yes --no-start   (exit ${s.code})`);
  console.log(s.out.split('\n').map(l => '    ' + l).join('\n').replace(/\n\s*$/, ''));
  const appCli = path.join(setupHome, 'app', 'dist', 'cli.js');
  const genManifest = path.join(setupHome, 'plugin', '.claude-plugin', 'marketplace.json');
  const statusLineSet = fs.existsSync(claudeSettings) && /statusline\.mjs/.test(fs.readFileSync(claudeSettings, 'utf8'));
  const setupChecks = {
    'exit 0': s.code === 0,
    'app copied to home (app/dist/cli.js)': fs.existsSync(appCli),
    'plugin generated + local marketplace manifest': fs.existsSync(genManifest),
    'status line written to the isolated settings': statusLineSet,
  };
  for (const [name, ok] of Object.entries(setupChecks)) console.log(`    [${ok ? 'ok' : 'FAIL'}] ${name}`);
  const setupOk = Object.values(setupChecks).every(Boolean);

  rm(work);
  console.log('\n--- smoke summary ---');
  for (const r of results) console.log(`  ${r.sub.padEnd(10)} launched=${r.ran} exit=${r.code}`);
  console.log(`  ${'setup'.padEnd(10)} ${setupOk ? 'ok' : 'FAILED'} (home-side install, no daemon)`);
  console.log(`\npackage staged at: ${PKG}`);
  if (!setupOk) { console.error('\nsetup --no-start smoke FAILED (see the checks above)'); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
