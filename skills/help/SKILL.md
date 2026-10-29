---
name: help
description: List puffr's commands and what each one does, including how to customize reports. Use when the user says "/puffr help", "puffr commands", "what can puffr do", "how do I customize reports", or asks which puffr command to use.
---

# puffr help

Run the bundled CLI (on PATH while puffr is enabled) and present what it prints:

```bash
puffr-help --plain
```

- It starts with a one-color pufferfish: show it in a ```text code block, exactly as printed. Then show the next two lines as a heading, the commands as a two-column table, and the "Customize reports" part as a short section with its three commands. Keep the closing note about what calls a model.
- Then add one line: run `! puffr-help` (or `! puffr-help --puff`) to see PUFFR in full color in the terminal. The chat view can't show terminal colors, so don't paste the colored art here.
- Answer any follow-up about a specific command afterward.
- If a command reports "Unknown command", puffr was updated during this session: Claude Code reads a plugin's commands at session start, so start a new session (or resume this one) to pick it up.
