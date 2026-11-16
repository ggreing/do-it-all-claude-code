# Design note: one-command install

Today a user clones the repository, runs `npm ci`, runs `init`, and starts Claude Code with
`--plugin-dir`. This note covers the two ways to shorten that, the Claude Code plugin marketplace and npm,
and recommends how to combine them.

**Status: research and recommendation. Nothing here has been built or tried.** Points marked *to verify*
come from the documentation only.

## Recommendation

1. **Publish one npm package, `do-it-all-claude-code`, with everything bundled as JavaScript.** Install is
   `npm i -g do-it-all-claude-code`, then `do-it-all-claude-code init`.
2. **`init` installs the plugin itself**, from the files inside the npm package, by registering them as a
   local marketplace. The user never types `--plugin-dir`, and the plugin always matches the daemon.
3. **Also add a `marketplace.json` to the repository**, pinned to each release tag, so the plugin can be
   found and installed from inside Claude Code. It is the second door, not the main one: the plugin alone
   does nothing without the daemon, so it must say how to get the rest.

The reason for this order: the plugin and the daemon speak a versioned protocol to each other. Shipping
them in one package and installing both from it removes the case where one is updated and the other is not.

## The plugin marketplace

### How it works

- A marketplace is a repository with `.claude-plugin/marketplace.json`: a `name`, an `owner`, and a
  `plugins` array whose entries have a `name` and a `source` ([create a marketplace][mkt]).
- Users run `claude plugin marketplace add <owner>/<repo>` and `claude plugin install <plugin>@<marketplace>`,
  or the same as `/plugin …` inside a session.
- A plugin's `source` can be a relative path inside the marketplace repository, or `github`, `url`,
  `git-subdir`, `npm`, `archive` or `command`; git sources can be pinned with `ref` and `sha`
  ([marketplace reference][mktref]).
- An installed plugin is **copied** into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`.
  `${CLAUDE_PLUGIN_ROOT}` points there, so the path changes with every version, and the old directory is
  removed 14 days after an update. Files outside the plugin directory are not copied
  ([loading reference][loading]).
- **Version decides updates.** A `version` in `plugin.json` keeps users on that copy until the string
  changes; without one, the commit SHA is the version. Third-party marketplaces do not auto-update unless
  the user turns it on ([loading reference][loading]).
- Hooks, agents, skills and MCP servers ship as files in the plugin's standard folders; hook and MCP
  processes receive `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` ([manifest reference][manifest],
  [components][components]).

### What our repository must add

A `marketplace.json` at the repository root. Pin it to the release instead of pointing at `./plugin` on the
default branch, so that what users install is a release and not whatever `main` holds:

```json
{
  "name": "do-it-all",
  "owner": { "name": "ggreing" },
  "description": "Do It All Claude Code: difficulty-based team router",
  "plugins": [
    {
      "name": "do-it-all-claude-code",
      "description": "Router plugin: hooks, agents, skills and the router MCP server. Needs the do-it-all-claude-code daemon (npm i -g do-it-all-claude-code).",
      "source": { "source": "git-subdir", "url": "ggreing/do-it-all-claude-code", "path": "plugin", "ref": "v0.5.0", "sha": "<full commit sha of the tag>" }
    }
  ]
}
```

Updating `ref`, `sha` and `plugin.json`'s `version` becomes one line of the release checklist.
`claude plugin validate` checks the file.

### What does not work as it is

| Problem | Why | Fix |
|---|---|---|
| The status line | A plugin cannot declare a status line; it is a user setting. `init` writes the path of `statusline.mjs` inside the plugin folder, and in the cache that path changes with every version | `init` copies `statusline.mjs` to the router home and points the setting there; `start` refreshes the copy |
| The key helpers (API-key mode) | Same problem for `apiKeyHelper`, which points into the package folder; with a Node version manager the global folder also moves when the user switches Node | Copy the two helper scripts to the router home as well |
| Edited role files (0.5.0) | Edits cannot live in the cache: it is replaced on update | Keep the generated plugin folder in the router home and install the plugin from there (next section) |
| A plugin without a daemon | Hooks pass through and nothing is routed, silently | When the router home is missing, the SessionStart hook tells the user, once, to run `npm i -g do-it-all-claude-code` and `init` |
| Plugin newer or older than the daemon | They update separately | Install both from one package; `doctor` compares the two versions |

What already works from the cache: the hooks, the guard, the MCP server and the status line script are
dependency-free and find the daemon through the router home (its config, token and endpoint file), not
through the checkout.

### Naming

`claude plugin validate` treats names that read as Anthropic's own specially. A plugin name that starts
with `claude-` is an error; one with `claude` as a whole word elsewhere, which ours has, gets a **warning**
("reads as one of Anthropic's own"), and `--strict` turns warnings into failures. Marketplace names that
imitate official ones are refused outright ([manifest reference][manifest], [marketplace reference][mktref]).
So: the plugin installs, the marketplace should have a neutral name such as `do-it-all`, and a submission
to Anthropic's directory may be questioned on the name. *To verify* with `claude plugin validate` on the
real files. This is worth the user knowing before the name is printed on more things.

## Installing the plugin from `init`

A marketplace added from a **local directory** is not copied: its plugins load in place, and edits take
effect at the next session without a version change ([loading reference][loading]). That fits the 0.5.0
generated plugin folder exactly:

1. `init` writes the plugin (with the user's role edits) to a folder in the router home, with a small
   `marketplace.json` beside it.
2. `init` runs `claude plugin marketplace add <that folder>` and `claude plugin install
   do-it-all-claude-code@<name> --scope user`, after showing both in its confirmation.
3. `uninstall` removes both.

No `--plugin-dir`, no GitHub access, and role edits survive updates. *To verify:* that both commands work
non-interactively from a script on all three systems, and what they print when Claude Code is not on PATH.

## npm

### What stops us today

- Every package is `private`, and the entry points are TypeScript files run by Node's type stripping.
- **Node refuses to strip types under `node_modules`**, deliberately, "to discourage package authors from
  publishing packages written in TypeScript" ([Node.js TypeScript docs][nodets]). So an installed package
  must contain JavaScript.
- The internal packages import each other by name (`@do-it-all-claude-code/core`), which only resolves
  inside the workspace.

### Options

| | A. One bundled package | B. Publish all packages | C. One package, compiled without a bundler |
|---|---|---|---|
| What is published | `do-it-all-claude-code` only | It plus four scoped packages | `do-it-all-claude-code` only |
| Build | Bundle the CLI, daemon and proxy entries to a few `.js` files; copy `plugin/` and the dashboard build | `tsc` per package | `tsc`, then rewrite the internal package imports to relative paths with a script of our own |
| Runtime dependencies | None (zod and yaml are bundled) | zod, yaml | zod, yaml |
| npm setup | One name | An npm organization for the scope; five trusted-publisher entries; versions in lockstep | One name |
| New build dependency | A bundler (see below) | None | None |
| Risk | Bundler output must be tested as shipped | A partial publish leaves mismatched versions | The rewrite script is ours to get right |

**Recommended: A.** One name to publish and protect, nothing fetched at install time beyond the package
itself, and the key-holding proxy keeps running no third-party code that was not reviewed at build time.
Everything is pure JavaScript (the ledger uses Node's built-in `node:sqlite`), so bundling has no native
parts to handle.

Proposed build dependency, for approval: **esbuild**, as a devDependency only. It is a native binary (one
platform package of about 10 MB, one transitive package), used at build time and not shipped. If a native
build tool is unwelcome, option C needs no dependency at all.

### What a user needs

- Node 24.5 or later (built-in SQLite, and the built-in proxy support the egress code needs).
- `npm i -g do-it-all-claude-code`, then `do-it-all-claude-code init`. `npx do-it-all-claude-code init`
  also works for a first look, but the helpers and status line must then live in the router home, not in
  the npx cache (already recommended above).

### What the maintainer must set up

Both names are free on the registry today (`do-it-all-claude-code` and the `@do-it-all-claude-code` scope
return 404).

1. An npm account with two-factor authentication.
2. **First publish by hand**, from a clean checkout of the release tag. Trusted publishing is configured in
   a package's settings, so the package has to exist first (*to verify*; the documentation's steps assume
   an existing package).
3. **Trusted publishing for every later release**: in the package settings, name the GitHub repository and
   the release workflow file. It needs npm 11.5.1 or later, Node 22.14 or later, a GitHub-hosted runner and
   `id-token: write` in the workflow. No token is stored anywhere, and **provenance is attached
   automatically** for a public repository ([npm trusted publishing][npmtp]).
4. Then set the package to "require two-factor authentication and disallow tokens".
5. `repository.url` in `package.json` must match the GitHub repository exactly, or the publish is refused.

### Release checklist additions

- Build, then install the packed tarball into a clean folder and run `init`, `start`, `doctor` and the
  plugin's hooks from it, on the three systems. Test what ships, not the workspace.
- Bump `plugin.json` `version`; update `ref` and `sha` in `marketplace.json`.
- `claude plugin validate` on the plugin and the marketplace file.

## Open points

1. Approve a bundler as a build dependency (option A), or choose option C.
2. The marketplace name, and whether the product name's "Claude Code" is acceptable given the validator's
   warning.
3. Whether a plugin installed alone should only point to the npm package (recommended), or go further and
   start a daemon by itself. The second is a background process started by a hook, which deserves its own
   decision.
4. Who owns the npm account, and when the first manual publish happens.

## Sources

- [Create a marketplace][mkt], [Marketplace reference][mktref]: `marketplace.json`, sources, pinning, reserved names.
- [Plugin loading reference][loading]: the cache, in-place loading, versions and updates, dependency install.
- [Plugin manifest reference][manifest], [Add components to a plugin][components]: `plugin.json`, layout, path variables, name checks.
- [Node.js: Modules: TypeScript][nodets]: type stripping and `node_modules`.
- [npm trusted publishing][npmtp]: OIDC publishing, requirements, provenance.

[mkt]: https://code.claude.com/docs/en/plugin-marketplaces
[mktref]: https://code.claude.com/docs/en/plugins/marketplace-reference
[loading]: https://code.claude.com/docs/en/plugins/loading
[manifest]: https://code.claude.com/docs/en/plugins-reference
[components]: https://code.claude.com/docs/en/plugins/components
[nodets]: https://nodejs.org/api/typescript.html
[npmtp]: https://docs.npmjs.com/trusted-publishers
