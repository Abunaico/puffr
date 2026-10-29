# PUFFR documentation

PUFFR is a Claude Code plugin that shows what a session is costing you while you work, and
reports afterwards on where the tokens went. These pages cover every part of it.

## Getting started

| Page | Covers |
|---|---|
| [install.md](install.md) | Installing with `npx` or `/plugin`, trying it without installing, how updates reach the HUD, updating, uninstalling, requirements |
| [tour.md](tour.md) | Building PUFFR with PUFFR: a walk through the HUD, a burn report, a report rule, and a shared HTML file |

## Using it

| Page | Covers |
|---|---|
| [hud.md](hud.md) | The statusline gauges, layouts, terminal width fitting, fleet rows, the banner |
| [context.md](context.md) | `puffr-context`: what fills the context window, cache hit rate, cache breaks and their causes |
| [burn.md](burn.md) | `puffr-burn`: insights, every report section, time windows, before and after, HTML reports, report rules |
| [swarm.md](swarm.md) | `puffr-swarm`: lanes, concurrency, phases, cross-session messages, several machines, bill reconciliation |
| [instructions.md](instructions.md) | `puffr-instructions`: what each always-on instruction source costs |
| [sessions.md](sessions.md) | `puffr-sessions`: the radar, naming, starring, archiving, saving transcripts, autoname, opening sessions, watch |
| [accounts.md](accounts.md) | `puffr-accounts`: every login on the machine and its usage |
| [panels.md](panels.md) | VS Code extension, browser page, `puffr-dash` terminal panel, and the UCEF view |
| [codex.md](codex.md) | Reading OpenAI Codex sessions and adding your own prices |

## Reference

| Page | Covers |
|---|---|
| [commands.md](commands.md) | Every skill and CLI with its flags |
| [configuration.md](configuration.md) | Feature switches, `model.haiku`, environment variables, every file PUFFR reads and writes |
| [privacy.md](privacy.md) | What PUFFR reads, what it writes, and the few things that leave your machine |
| [troubleshooting.md](troubleshooting.md) | The HUD is missing, stale, or wrong; panels; rate meters; slow mounts |
| [development.md](development.md) | Repo layout, how the pieces fit, tests, CI, adding a command, releasing |
| [ucef-monitor/spec.md](ucef-monitor/spec.md) | The event model and sources behind the UCEF view (contract v1.1) |

## Where costs come from

Every dollar figure in PUFFR is an estimate at Anthropic API list prices, computed from the usage
each response records in its transcript. On a subscription (Pro, Max, Team, Enterprise) it shows
relative weight, not your bill. Report generation itself makes no model calls and costs nothing.
