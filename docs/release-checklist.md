# Release checklist (maintainers)

Steps to cut a public release. Replace `X.Y.Z` with the version (for example `0.1.0`).

## 1. Scan the history

- Look over `git log` since the last tag for anything that should not ship: secrets or API keys, absolute
  local paths or usernames, internal-only notes, and machine-generated attribution lines (the repo keeps
  none — see the project's own convention).
- Confirm the working tree is clean and on the release branch.

## 2. Versions

- Bump the version in every manifest and keep them identical: root `package.json`, each
  `packages/*/package.json`, every workspace dependency pin (`@do-it-all-claude-code/*`), the plugin
  (`plugin/.claude-plugin/plugin.json`), and any hard-coded VERSION constant (e.g. `PROXY_VERSION` in
  `packages/proxy/src/server.ts`). The daemon version is read from `package.json`.
- Regenerate the lockfile: `npm install --package-lock-only`.
- Set `.claude-plugin/marketplace.json` `plugins[0].source.ref` to `vX.Y.Z` and its `sha` to the release
  commit's full SHA, so the plugin's second door installs the tagged release and not `main`.
- Confirm that pin is set before publishing: `DIACC_RELEASE_CHECK=1 node --test packages/cli/test/marketplace-release.test.ts`.
- Verify green: `npm test`, `npx tsc -b`.

## 3. CHANGELOG and release notes

- Add a dated `X.Y.Z` section to `CHANGELOG.md` in user terms (modes, delegation and the ladder, the
  team office, privacy defaults, the guard and its limits, known limits).
- Update the `[X.Y.Z]` compare/tag link at the bottom of `CHANGELOG.md` with the real repository.
- Write `docs/release-notes-X.Y.Z.md` (short, English) for the GitHub release body.

## 4. Third-party notices

- The npm package bundles its runtime dependencies. Confirm `THIRD_PARTY_NOTICES.md` lists each of them
  (currently `zod` and `yaml`) with the version in `package-lock.json` and its license, and that `NOTICE`
  points to it.

## 5. GitHub settings

- Enable **private vulnerability reporting** on the repository (Settings → Security). The issue chooser
  (`.github/ISSUE_TEMPLATE/config.yml`) and `SECURITY.md` send security reports there.

## 6. Tag and release

- Tag the release commit (`git tag vX.Y.Z`) and push the tag.
- Create the GitHub release from the tag, using `docs/release-notes-X.Y.Z.md` as the body.

## 7. npm package

- Build and verify the publishable package: `node scripts/build-npm.mjs`. It bundles the CLI, daemon and
  proxy into one dependency-free `do-it-all-claude-code` package, copies the plugin and
  the helpers, then runs `npm pack --dry-run` and a local install smoke test. Confirm the file list and size,
  and that `--version` and `doctor` run from the installed bin.
- Run `claude plugin test plugin/` (the team office kit tests in `plugin/office/test`, not part of `npm test`)
  and `claude plugin validate plugin/`; both must pass on the Claude Code build named as MIN_CLAUDE.
- `claude plugin validate` on `.claude-plugin/marketplace.json`.
- **Publish on announcement day, not before.** From a clean checkout of the tag, run `npm publish` by hand
  (or the release workflow) — never from a working-tree build. The build script's `--publish` flag is off by
  default and only prints this reminder.

## CI

GitHub Actions (`.github/workflows/ci.yml`) builds, typechecks and runs the tests on Linux,
Windows and macOS for every pull request and every push to `main`. A release commit should be green on all
three. The live checks that need a real Claude Code (`scripts/guard-e2e/run.mjs`, `scripts/tls-live/run.mjs`)
are run by hand before a release that touches the guard or API-key mode.
