---
name: compact
description: Switch the puffr HUD back to the compact layout, all gauges on one line (the default). Use when the user says "/puffr compact", "compact HUD", "shrink the statusline", or wants the detailed HUD gone.
disable-model-invocation: true
---

# puffr compact HUD

```bash
puffr-config layout compact
```

The next render puts the gauges back on one line:

```
█████░░░░░ 52% 5h 8% ⏰4h04m →43% 7d 8% ⏰6d11h cache 59m · $0.20
```

Reading it left to right: context bar and fill; 5-hour limit used, time to reset, and the
projected % at reset (`→`, hidden while it's close to the current number); the same for the
weekly limit; time until the prompt cache goes cold; session cost. `/puffr:detailed` spells
all of that out on labeled lines; `/puffr:layout` lists every layout.
