# Panels

The HUD lives in the terminal's statusLine. The Claude Code VS Code extension never runs that
hook, so its users see nothing. The panels render the same data anywhere else.

One core (`panel/core.js`) gathers it from `puffr-burn`, `puffr-sessions`, `puffr-context`, and
`puffr-accounts` (all with `--json`) and draws it three ways. The panels call puffr's own `bin/`
by path, so a GUI-launched VS Code without your shell PATH still finds them.

| Where | How to open it |
|---|---|
| **VS Code** | `npx github:Abunaico/puffr --vscode`, then reload VS Code |
| **Browser** | `node panel/server.js`, then open `http://localhost:4850` |
| **Terminal** | `puffr-dash` in a split pane (Warp, iTerm, tmux) |
| **UCEF view** | `puffr-dash --ucef`, or `u` from the terminal panel |

## What's on it

- **Stat tiles.** Spend, sessions, and requests today, plus the biggest saving lever.
- **Open sessions.** A context meter for every Claude session touched in the last hour (up to 8),
  with the autocompact mark, a worded status (room to work, filling up, near autocompact), cost,
  and what is filling it. In VS Code the workspace's own session is pinned first.
- **Cost by project** today, as sorted bars.
- **Insights.** puffr-burn's measured levers (7 days, scaled to a month) and, when `model.haiku`
  is `on`, 3 to 5 patterns Haiku writes from the same summary, naming the projects they apply
  to. Haiku runs at most once an hour while a panel is open (never on the 20 second poll), plus a
  Regenerate button. A run takes about a minute and costs a few cents, counted in
  `~/.puffr/spend.json`, and the result is cached in `~/.puffr/insights.json`. Haiku's items are
  suggestions; the levers are measurements.
- **Recent sessions** (active ones marked) and **accounts**.

The panels wear the same arcade look as the HTML burn report (sky, navy, amber, hard shadows),
with a navy dark mode that follows your system or VS Code theme, and fold to one column in a
narrow sidebar.

## VS Code

- **Status bar.** `🐡 49% · $0.75` is context used by this workspace's Claude Code session and
  today's spend on this project. `🐡 ⚠` from 60% context and `🐡 🔥` from 80% (autocompact), with
  a warning background. Hover for the session, model, and what's filling the context; click to
  open the dashboard.
- **Sidebar.** The fish in the Activity Bar opens a docked dashboard that refreshes every 20
  seconds while it is visible.
- **Dashboard tab.** The same dashboard in an editor tab.

Commands, under **🐡 Puffr** in the Command Palette: Open Dashboard, Show Context Detail, Refresh
Now.

The installer copies the extension, together with puffr's `panel/`, `lib/`, `bin/`, and the fish
art, into `~/.vscode/extensions/abunaico.puffr-<version>`, so it keeps working after npx clears its
cache. `npx github:Abunaico/puffr update` refreshes it and `... uninstall` removes it.

Settings (`puffr.*` in VS Code settings):

| Setting | Effect |
|---|---|
| `puffr.pollIntervalSeconds` | How often the status bar refreshes context |
| `puffr.costPollIntervalSeconds` | How often it refreshes cost |
| `puffr.showCost` | Show today's cost in the status bar |
| `puffr.theme` | `editor` swaps the arcade look for your editor's colors |
| `puffr.puffrContextPath`, `puffr.puffrBurnPath`, `puffr.puffrAccountsPath`, `puffr.puffrSessionsPath` | Override where each command is found |

More in [vscode-ext/README.md](../vscode-ext/README.md), including how to develop the extension
from a symlink.

## Browser

```bash
node panel/server.js              # port 4850
node panel/server.js --port 5000
```

Open `http://localhost:4850`. `?project=<substr>` picks which session's context to show. It
refreshes every 20 seconds and binds to 127.0.0.1 only.

## Terminal

```bash
puffr-dash                        # live panel
puffr-dash --project swingr
puffr-dash --every 10             # refresh every 10 seconds
puffr-dash --once                 # draw one frame and exit
```

Keys: `r` refresh, `g` regenerate insights, `u` UCEF view, `q` quit.

The installer's `--warp` option adds a Warp launch configuration that opens your shell with
`puffr-dash` beside it.

## UCEF view

`puffr-dash --ucef`, or `u` from the main view, swaps the panel for a read-only monitor of a UCEF
data directory. UCEF is a multi-agent orchestration protocol for Claude Code; if you don't use it,
you can ignore this view.

Four panes:

- **Hooks and verdicts.** Counts by verdict, then every block, warn, bypass, and not-done row. A
  verdict read back from a transcript is marked `infer`.
- **Agents.** Each subagent run with its model tier, status, time, atom, and tokens.
- **Phase and gates.** The eight phases, plus completion, constitutional, and field-stability
  results with the threshold each one carried.
- **Jev decisions and cost.** Tier, confidence, and latency per decision, and token and cost
  totals for finished subagent runs. Cost comes from puffr's own price table and is always
  labelled `estimated`; a model with no price shows `unknown`.

It follows the newest session live. `[` and `]` step to older and newer sessions (replay), `l`
returns to live, `r` refreshes, `u` goes back to the main view, `q` quits. `--once` draws one frame
and exits, so it pipes. Exit codes: 0 ok, 1 nothing to show, 2 bad flag.

| Flag | Effect |
|---|---|
| `--ucef-data-dir <dir>` | The directory that holds `workspaces/`. Default: `UCEF_DATA_ROOT`, else the `.claude/data` found above the current directory. Transcripts come from `~/.claude/projects`. |
| `--ucef-session <id>` | Start on a past session instead of the newest |
| `--ucef-no-redact` | Stop scrubbing secret-shaped text. Terminal control characters are still stripped. |

**Read-only.** It opens UCEF files read-only and never writes, locks, or migrates anything there,
and makes no network calls. The SQLite database opens with `mode=ro`, with one exception: a
WAL-mode database with no `-wal` or `-shm` file beside it would make SQLite create both, so that
case is read as a snapshot (`immutable=1`) and the sources line says `snapshot`. A snapshot can
lag a live writer. The database needs Node 22 or newer (`node:sqlite`); without it the database
shows as unavailable and the other sources still work.

The event model, every source, and the redaction rules are in
[ucef-monitor/spec.md](ucef-monitor/spec.md).
