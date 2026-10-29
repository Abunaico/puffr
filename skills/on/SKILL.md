---
name: on
description: Turn puffr back on after /puffr:off. Use when the user says "/puffr on", "turn puffr back on", "enable puffr", "un-mute puffr", "unquiet puffr".
disable-model-invocation: true
---

# Turn puffr on

Removes the marker `/puffr:off` drops:

```bash
rm -f ~/.puffr/disabled
```

Tell the user: HUD and fleet rows resume on the next render, the banner returns on the
next new session, and `puffr-watch` (if already running) resumes notifications within one
poll interval — no restart needed either way.

If puffr was never installed (no `~/.puffr` dir, `jq -e '.statusLine'` empty on
`~/.claude/settings.json`), this command has nothing to do — point the user at
`/puffr:hud` instead.
