---
name: layout
argument-hint: "[<name> | new <name> [from] | edit <name>]"
description: List, switch, create, or edit puffr HUD layouts. A layout is a small YAML file (one per layout, file name = layout name) that says which widgets go on which statusline line. Built-ins are compact (default), detailed, and all (every widget, like /status). Use when the user says "/puffr layout", "switch the HUD layout", "make a custom HUD layout", "add X to the statusline", "move cost to its own line", or wants the HUD arranged differently.
---

# puffr layouts

Built-in layouts live in the plugin's `layouts/` folder; the user's own live in
`~/.puffr/layouts/<name>.yaml` and win over a built-in with the same name. The widget
reference and format rules are in the plugin's `layouts/README.md`: read it before
writing or editing a layout.

```bash
puffr-config layout                     # list, active one marked
puffr-config layout <name>              # switch
puffr-config layout new <name> [from]   # copy a layout (default: the active one) to ~/.puffr/layouts/
```

Arguments the user passed: "$ARGUMENTS"

1. **No arguments:** run `puffr-config layout`, then ask with AskUserQuestion which layout to
   use (one option per layout, current one marked). Switch with `puffr-config layout <name>`.
2. **A layout name:** `puffr-config layout <name>`.
3. **`new <name> [from]`:** run it, show the file path it prints, and offer to open it in
   the user's editor or make changes for them.
4. **A change in words** ("put cost on its own line", "drop the weekly limit"): edit a
   file in `~/.puffr/layouts/`. Never edit the plugin's built-in files; if the active layout
   is a built-in, first `puffr-config layout new <name> <built-in>` (ask for a name, suggest
   `my-<built-in>`), edit that copy, then switch to it. Use only widget names from
   `layouts/README.md`.

After a switch or edit: the HUD shows it on its next refresh. A bad widget name shows red
as `?name`; a missing layout falls back to compact with a yellow note. `PUFFR_LAYOUT=<name>`
in a terminal's environment overrides the saved choice there.
