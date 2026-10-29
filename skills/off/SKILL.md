---
name: off
description: Turn puffr off — silences the HUD statusline, fleet dashboard, session banner, and cross-session watch notifications without uninstalling the plugin. Use when the user says "/puffr off", "turn off puffr", "disable puffr", "mute puffr", "quiet puffr".
disable-model-invocation: true
---

# Turn puffr off

Drops one marker file. `statusline.sh`, `subagent-statusline.sh`, `hooks/banner.sh`, and
`bin/puffr-watch` all check it on every invocation and go silent (drain stdin, exit 0 /
return early — no output, no error).

```bash
mkdir -p ~/.puffr && touch ~/.puffr/disabled
```

This is reversible and touches nothing in `~/.claude/settings.json` — the statusLine and
hook wiring stay installed, they just render nothing. Tell the user:

- HUD and fleet rows go blank on the very next render.
- The session banner stops appearing in new sessions.
- `puffr-watch` (if running in the background) stops emitting notifications within one
  poll interval (default 15s) — no restart needed.

To turn it back on: `/puffr:on`.
