---
name: settings
argument-hint: "[on|off <feature>... | all | reset]"
description: Turn individual puffr features on or off (HUD segments like git, account, rate meters, reset countdown, pace, cache countdown, cost, mode, the fish; plus the fleet rows, session banner, and watch notifications). Use when the user says "/puffr settings", "puffr config", "hide the cost", "turn off the fish", "disable the banner", or wants to customize what puffr shows.
---

# puffr settings

The bundled CLI (on PATH while puffr is enabled) owns the config file, `~/.puffr/config`:

```bash
puffr-config                    # show every feature and whether it's on
puffr-config off hud.cost hud.git
puffr-config on hud.cost
puffr-config off all            # or: on all
puffr-config reset              # everything back on
```

Arguments the user passed: "$ARGUMENTS"

1. **Arguments given** (e.g. `off hud.cost`, "hide the fish", "turn the banner back on"): map them to feature keys, run `puffr-config on|off <keys>`, and show the resulting table. Choices like `model.haiku` and `guard.cold` are not switches: they use `puffr-config set <key> <value>`, not `on|off`.
2. **No arguments:** run `puffr-config --json` to get the current state, then ask with AskUserQuestion, four `multiSelect: true` questions, pre-describing each option with its current state (e.g. "Git branch (on)"). The user picks the features they want **on**:
   - "HUD line 1": `hud.fish` (pufferfish), `hud.mode` (effort + style), `hud.git` (git branch), `hud.account` (account)
   - "HUD line 2": `hud.rate` (5h/7d meters), `hud.reset` (reset countdown), `hud.pace` (pace projection), `hud.cache` (cache countdown)
   - "HUD extras": `hud.cost` (session cost), `hud.nudge` (compact-before-a-break hint)
   - "Everything else": `fleet` (subagent rows), `banner` (session banner), `watch` (watch notifications), `autoname` (auto-name sessions)

   Turn on everything selected and off everything not selected in one `puffr-config on ...` plus one `puffr-config off ...` call. Show the final table.
3. Tell the user: HUD and fleet changes show on the next render, the banner on the next new session, watch within one poll. `/puffr:off` still mutes everything at once, independently of these switches.

Which widgets appear at all, and on which line, is the layout's job: `/puffr:layout`. These switches hide a widget in every layout. `hud.reset` and `hud.pace` only show when `hud.rate` is on. `PUFFR_MOOD=off` in the environment also hides the fish.

`model.haiku` is a choice, not a switch: `puffr-config set model.haiku on|off|never` (`get` reads it). `reset` leaves it alone so "never" stays never.

`guard.cold` is an opt-in choice too: `puffr-config set guard.cold on|off` (`get` reads it). Unset means off, and `on all` and `reset` leave it alone. It warns at the next prompt when a large session's prompt cache has gone cold.
