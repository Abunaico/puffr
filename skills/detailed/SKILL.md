---
name: detailed
description: Switch the puffr HUD to the detailed layout, where every gauge gets its own labeled line in plain words (context fill and tokens, 5-hour and weekly limits with reset times and pace, prompt cache, session cost). Use when the user says "/puffr detailed", "detailed HUD", "expand the statusline", "what do these HUD numbers mean", or can't read the compact gauges.
disable-model-invocation: true
---

# puffr detailed HUD

```bash
puffr-config layout detailed
```

The next render shows, for example:

```
context      █████░░░░░ 52% full · 104k of 200k tokens
5-hour limit 8% used · resets in 4h04m (3:42 PM) · on pace for 43% by reset
weekly limit 8% used · resets in 6d11h (Mon 9:00 AM)
prompt cache warm, 59m left (1h tier, every message resets it)
cost         $0.20 this session
```

`/puffr:compact` goes back. `/puffr:layout` lists every layout (including `all`, which shows
everything like `/status`) and makes custom ones.
