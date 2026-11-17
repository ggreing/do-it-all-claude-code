---
description: Finish setting up Do It All Claude Code — install the router engine and start the daemon on this machine.
allowed-tools: Bash(npx:*)
---

The Do It All Claude Code plugin is installed, but the router engine (its local daemon) is not set up on this
machine yet, so nothing is being routed. Finish setup now with the one command below — it installs the engine
into your router home and starts the daemon. The plugin is already installed from the marketplace, so this does
not touch it (`--no-plugin`), and it runs unattended (`--yes`):

```bash
npx -y do-it-all-claude-code@0.5.0 setup --yes --no-plugin
```

Run that command now with the Bash tool, then tell the user, in a few lines:

- whether it finished (the daemon is running) or printed a problem to fix first — most often Node 24.5 or newer,
  or, on Windows, Git Bash (which Claude Code itself requires);
- that `/office demo` previews the team office, and `do-it-all-claude-code doctor` checks the setup;
- that the daemon now starts itself whenever a Claude Code session starts, and
  `do-it-all-claude-code config set autoStart off` turns that off.

Do not edit any files. If `npx` is blocked or the machine is offline, show the user the command above and ask
them to run it in a terminal instead.
