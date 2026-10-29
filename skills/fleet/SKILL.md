---
name: fleet
description: Explain or tune the puffr subagent fleet dashboard. Use when the user asks about the agent rows display, "fleet view", or wants to change how running subagents render.
---

# Fleet dashboard

The fleet view is `subagent-statusline.sh`, applied automatically via the plugin's `settings.json` (`subagentStatusLine`). Each running subagent row renders as:

```
⚡ finder [opus-5] ▸ running · 42k 12%
```

Icons: ⚡ running, ✅ done, 💥 failed, 🐡 anything else.

To tune: edit `subagent-statusline.sh` in the plugin root — it receives all visible task rows as one JSON object on stdin and emits one `{"id","content"}` JSON line per row it wants to override. Emit nothing for a row to keep the default rendering.
