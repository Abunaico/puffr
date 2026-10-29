# puffr HUD layouts

A layout is a YAML file. Its name is the file name: `compact.yaml` is the
`compact` layout. Built-in layouts live here; your own go in
`~/.puffr/layouts/`, and one there with the same name as a built-in wins.

```yaml
lines:
  - [fish, model, mode, ·, account, plan]          # one HUD line
  - context: [context-bar, context-full, ·, context-tokens]   # a labeled line
```

- Each `- [...]` is one line of the HUD, widgets left to right.
- `label: [...]` puts a dim label in front; labels in one file line up.
- `·`, `|`, `/` or any `"quoted text"` is a separator. It only shows when a
  widget after it has something to show, so it never dangles.
- A line whose widgets are all empty (no rate limits yet, say) is skipped.
- A name puffr doesn't know shows red as `?name`.
- When the terminal is narrow, lower-value widgets drop first, the same way on
  every layout. `/puffr:settings` switches (like `hud.cost=off`) still apply.

Switch with `/puffr:layout <name>` or `puffr-config layout <name>`. Make your own
with `puffr-config layout new <name>` (copies the active layout to edit).
`PUFFR_LAYOUT=<name>` in the environment overrides the saved choice.

## Widgets

| Widget | Shows |
|---|---|
| `fish` | 🐡, or 🐡☠️ at 90% context |
| `model` | Model name |
| `mode` | `[high · Explanatory]`: effort and output style (default style hidden) |
| `effort` | Effort level |
| `style` | Output style, including `default` |
| `account` | `👤 you@example.com`, or `👤 API key` |
| `plan` | `(max)`: plan of the account |
| `org` | Organization name of the account |
| `version` | Claude Code version |
| `session` | Session id |
| `dir` | `📁 ~/path` |
| `git` | Branch and ✔ clean / ✗ dirty |
| `context-bar` | `█████░░░░░` context fill |
| `context-pct` | `52%` |
| `context-full` | `52% full` |
| `context-tokens` | `104k of 200k tokens` |
| `context-warning` | `nearly full, compaction soon`, only at 90%+ |
| `5h` | `5h 8%` |
| `5h-used` | `8% used` |
| `5h-reset` | `⏰4h04m` |
| `5h-resets` | `resets in 4h04m` |
| `5h-clock` | `(3:42 PM)`, when it resets |
| `5h-pace` | `→43%`, projected use at reset (only when well above now) |
| `5h-pace-words` | `on pace for 43% by reset` / `on pace to hit the limit in 2h10m` |
| `7d`, `7d-used`, `7d-reset`, `7d-resets`, `7d-clock`, `7d-pace`, `7d-pace-words` | Same for the weekly limit |
| `cache` | `cache 59m` / `cache cold` |
| `cache-words` | `warm, 59m left` / `cold` |
| `cache-why` | `(1h tier, every message resets it)` |
| `cost` | `$0.20` |
| `cost-words` | `$0.20 this session` |
| `nudge` | `/compact before a break` (only past 150k tokens; yellow under 10 minutes of cache; `hud.nudge` hides it) |
| `duration` | `1h12m total` session time |
| `api-time` | `14m in API` |
| `lines` | `+120 -34 lines` changed this session |
