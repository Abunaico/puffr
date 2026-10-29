# 🐡 Puffr for VS Code

puffr's HUD is a Claude Code statusLine, and the Claude Code VS Code extension never runs that
hook, so its users don't see it. This extension brings the same data into VS Code. It is
read-only and computes nothing itself: it calls puffr's own `puffr-*` commands and renders what
they return.

## What you get

- **Status bar**: `🐡 49% · $0.75` is context used by this workspace's Claude Code session and
  today's spend on this project. `🐡 ⚠` from 60% context, `🐡 🔥` from 80% (autocompact), with a
  warning background. Hover for the session, model, and what's filling the context; click to
  open the dashboard.
- **Sidebar**: the fish in the Activity Bar opens a docked dashboard that refreshes every 20s
  while it's visible.
- **Dashboard tab**: the same dashboard in an editor tab (**🐡 Puffr: Open Dashboard**).

The dashboard shows spend, sessions, and requests today; the context meter with its autocompact
mark; cost by project; insights (puffr-burn's measured levers, plus Haiku-written patterns when
`model.haiku` is `on`); recent sessions; and your Claude Code accounts. It uses puffr's arcade look
(the same as the `puffr-burn --html` report), switches to its navy dark mode with a dark VS Code
theme, and folds to one column in a narrow sidebar.

Commands (Command Palette, **🐡 Puffr**): Open Dashboard, Show Context Detail, Refresh Now.

## Install

```bash
npx github:Abunaico/puffr --vscode
```

Then reload VS Code (**Developer: Reload Window**). The installer copies this folder together
with puffr's `panel/`, `lib/`, `bin/`, and the fish art into `~/.vscode/extensions/abunaico.puffr-<version>`,
so the extension is self-contained and keeps working after npx clears its cache.
`npx github:Abunaico/puffr update` refreshes it; `... uninstall` removes it.

**Developing:** symlink the repo folder instead, so edits apply on reload:

```bash
ln -s "$PWD/vscode-ext" ~/.vscode/extensions/puffr-dev
```

In the repo, the extension loads `../panel/`; in an installed copy, `./panel/`
(`panel-path.js` picks whichever exists). The installer leaves a symlinked dev install alone
unless you pass `--force`.

## Settings

| Setting | Default | |
|---|---|---|
| `puffr.pollIntervalSeconds` | 20 | status bar refresh (min 5) and sidebar refresh (min 10) |
| `puffr.costPollIntervalSeconds` | 60 | status bar cost refresh (min 15) |
| `puffr.showCost` | true | show today's cost in the status bar |
| `puffr.theme` | `puffr` | `puffr` (arcade look) or `editor` (blend in with your VS Code theme) |
| `puffr.puffr*Path` | bundled | override the `puffr-context`, `puffr-burn`, `puffr-accounts`, `puffr-sessions` binaries |

Haiku insights follow puffr's own setting: `puffr-config set model.haiku on` (or `off`). They run
at most hourly while a dashboard is open; see Privacy in the main [README](../README.md#privacy).

## How it finds your session

The workspace folder's path is passed to `puffr-context --project`, which matches it against
Claude Code's transcript folders under `~/.claude/projects/`. The Claude Code VS Code extension
writes the same transcripts as the CLI, so it works for both. Two open workspaces with very
similar paths can match the same folder.

## Troubleshooting

- **"Some data failed to load: spawn puffr-burn ENOENT"**: an older copy that relied on your shell
  PATH. Reinstall; current versions call their bundled `bin/` by path.
- **`🐡 —`**: no Claude Code session in this workspace yet. Send a message in the Claude Code
  panel, and it appears on the next refresh.
- **Nothing in the status bar**: no folder is open; the item needs a workspace folder.
