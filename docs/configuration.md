# Configuration

## Features

Every feature can be switched off on its own. Run `/puffr:settings` for a picker, or:

```bash
puffr-config                      # every feature and its state
puffr-config off hud.cost hud.git # hide segments
puffr-config on hud.cost
puffr-config reset                # everything back on
```

| Key | Controls |
|---|---|
| `hud.fish` | The pufferfish, and the skull at 90% |
| `hud.mode` | Effort level and output style |
| `hud.git` | Git branch and dirty flag |
| `hud.account` | Active Anthropic account |
| `hud.rate` | 5h and 7d rate-limit meters |
| `hud.reset` | Reset countdown on the meters |
| `hud.pace` | Pace projection on the meters |
| `hud.cache` | Prompt cache countdown |
| `hud.cost` | Session cost |
| `hud.nudge` | "/compact before a break" past 150k tokens |
| `fleet` | Subagent fleet rows |
| `banner` | Session start banner |
| `watch` | Cross-session watch notifications |
| `autoname` | Auto-naming sessions from their first prompts (Haiku) |

A switched-off feature also skips its work: no git refresh, no transcript read.

## model.haiku

A choice, not a switch: `ask` (the default), `on`, `off`, or `never`.

```bash
puffr-config set model.haiku on
puffr-config get model.haiku
```

It gates Haiku labels in the radar, report rules, and panel insights. With `ask`, a skill offers
Haiku the first time; with `off`, it offers again on about one run in ten; with `never`, it never
offers. `puffr-config haiku-check` prints that decision (`on`, `ask`, or `skip`) for skills to use. `reset` leaves it alone, so
"never" stays never. Autoname has its own switch (`autoname`, above).

## The off switch

`/puffr:off` creates `~/.puffr/disabled`. The HUD, fleet rows, banner, autoname, and watch check
for it on every run and go silent. A running `puffr-watch` goes quiet within one poll. `/puffr:on`
removes it. Nothing is uninstalled.

## Layout

The active HUD layout is saved as `layout=<name>` in `~/.puffr/config`. See
[hud.md](hud.md#layouts).

## The config file

`~/.puffr/config` holds `key=off` lines (anything not listed is on), `layout=<name>` (omitted for
the default `compact`), and `model.haiku=<choice>`. You can edit it by hand. The HUD parses it in pure bash on every render, so
changes apply on the next one.

## Environment variables

| Variable | Effect |
|---|---|
| `PUFFR_LAYOUT` | HUD layout for this terminal, overriding the saved one |
| `PUFFR_HUD_WIDTH` | Width the HUD fits to, instead of `COLUMNS` |
| `PUFFR_FLEET_WIDTH` | Width the fleet rows fit to |
| `PUFFR_MOOD=off` | Same as `puffr-config off hud.fish` |
| `PUFFR_PROFILE_DIRS` | Extra Claude Code profile folders, colon-separated |
| `PUFFR_WATCH_INTERVAL` | Watch poll interval in seconds. Default 15. |
| `PUFFR_CLAUDE` | The `claude` binary to use for Haiku calls and updates |
| `PUFFR_VSCODE_EXTENSIONS` | Where the installer puts the VS Code extension. Default `~/.vscode/extensions`. |
| `PLUGIN_SCOPE` | Default `--scope` for the installer |
| `CLAUDE_CONFIG_DIR` | The Claude Code profile. The HUD's account segment follows it. |
| `CODEX_HOME` | Where Codex sessions are read from. Default `~/.codex`. |
| `UCEF_DATA_ROOT` | Default UCEF data directory for the UCEF view |
| `ANTHROPIC_API_KEY` | When set, the HUD shows `API key` as the account. The key is never printed. |

## Files

### Your settings and data, `~/.puffr`

| File | Holds |
|---|---|
| `config` | Feature switches, layout, `model.haiku` |
| `disabled` | Present while `/puffr:off` is in effect |
| `layouts/<name>.yaml` | Your HUD layouts |
| `bin/statusline` | The HUD launcher your statusLine points at |
| `root` | Which puffr copy the last session loaded, for the launcher |
| `sessions-cache.json` | The radar index |
| `sessions-meta.json` | Session names, stars, archive flags, project assignments |
| `archive/` | Saved transcripts |
| `projects.json` | Project names for folders: `{"projects": {"Name": ["/abs/path"]}}` |
| `prices.json` | Your own prices, for Codex: `{"models": {"<name>": {"input", "cached", "output"}}}` |
| `report-prompt.md` | Plain-English report rules |
| `swarm.json` | Swarm readout config |
| `autoname/` | Autoname state per session |
| `insights.json` | Cached panel insights |
| `instructions.json` | Cache for `puffr-instructions` |
| `spend.json` | What puffr's own Haiku calls cost |

### Cache, `~/.cache/puffr`

Git status per folder, the window size and cache TTL tier per session, and the last-seen usage
per account. Safe to delete; it is rebuilt as you work.

All of it is private to your user. puffr skips writing if the cache folder isn't owned by you.

### What puffr reads

- `~/.claude/projects`: Claude Code session transcripts
- `~/.claude.json` and each profile's `.claude.json`: email, organization name, plan type
- `$CODEX_HOME/sessions`: Codex rollouts
- A UCEF data directory, only when you open the UCEF view

See [privacy.md](privacy.md).
