# HUD, layouts, and fleet rows

## The HUD

The HUD is `statusline.sh`, run by Claude Code on every render through the launcher at
`~/.puffr/bin/statusline` (see [install.md](install.md#how-updates-reach-the-hud)). The default
`compact` layout is three lines:

```
🐡 Opus 5.5 [high · Explanatory] · 👤 you@example.com (max)
██░░░░░░░░ 17% 5h 62% ⏰1h30m →88% 7d 41% ⏰3d0h →71% cache 52m · $4.12
📁 puffr · main ✔
```

**Line 1.** Model, effort level and output style (the default style isn't shown), and the
Anthropic account this session bills to with its plan. With `ANTHROPIC_API_KEY` set the account
shows as `API key`; the key itself is never printed. The account follows `CLAUDE_CONFIG_DIR`, so
each profile shows its own login.

**Line 2.** The gauges:

- **Context bar and %.** Color-coded fill of the context window. The fish puffs up as it fills,
  and the toxin ☠️ comes out at 90%.
- **`5h 62% ⏰1h30m →88%`.** 62% of the 5-hour limit used, the window resets in 1h30m, and at the
  current pace you'll end the window around 88%. The projection is linear and stays hidden for
  the first 10% of a window, where it is noise, and while it is close to the current number. It
  turns yellow at 85% and red at 100%.
- **`7d ...`.** The same for the weekly limit.
- **`cache 52m`.** Time until the prompt cache expires. Every request refreshes it. `cold` means
  the next message rewrites the whole context at the cache-write price. It uses Claude Code's
  own `prompt_cache.expires_at` when present; on older versions it falls back to the last cache
  write in the transcript (only the last 256 KB is read).
- **`$4.12`.** Session cost at API list price.
- **Nudge.** Past 150k tokens of context, `/compact before a break` appears, yellow when under
  10 minutes of cache remain. Compact before you walk away, not mid-work.

**Line 3.** The folder and git branch, with ✔ clean or ✗ dirty.

The rate meters need a Pro or Max login and appear after the first response.

## Layouts

What goes on which line is a small YAML file, one per layout, named for the layout. Built-in:

| Layout | Shows |
|---|---|
| `compact` | The default: everything on three lines |
| `detailed` | One labeled line per gauge, in words |
| `all` | Every widget, like `/status` |

```
🐡 Opus 5.5 · 👤 you@example.com (enterprise)
context      ███░░░░░░░ 36% full · 368k of 1.0M tokens
5-hour limit 38% used · resets in 1h30m (11:35 AM) · on pace for 54% by reset
weekly limit 41% used · resets in 3d0h (Sat 10:05 AM) · on pace for 71% by reset
prompt cache · /compact before a break
cost         $55.60 this session
📁 ~/puffr
```

Switch with `/puffr:layout <name>`, `/puffr:compact`, `/puffr:detailed`, or
`puffr-config layout <name>`. `PUFFR_LAYOUT=<name>` overrides the saved choice for one terminal.

Make your own:

```bash
puffr-config layout new mine      # copies the active layout to ~/.puffr/layouts/mine.yaml
$EDITOR ~/.puffr/layouts/mine.yaml
puffr-config layout mine
```

A layout in `~/.puffr/layouts/` with the same name as a built-in wins.

```yaml
# detailed.yaml
lines:
  - [fish, model, mode, ·, account, plan]
  - context:      [context-bar, context-full, ·, context-tokens, ·, context-warning]
  - 5-hour limit: [5h-used, ·, 5h-resets, 5h-clock, ·, 5h-pace-words]
  - weekly limit: [7d-used, ·, 7d-resets, 7d-clock, ·, 7d-pace-words]
  - prompt cache: [cache-words, cache-why, ·, nudge]
  - cost:         [cost-words]
  - [dir, ·, git]
```

The file format and the full widget list are in [layouts/README.md](../layouts/README.md).

## Fitting the terminal

Claude Code passes `COLUMNS` and cuts off anything wider, so the HUD sheds detail as the terminal
narrows instead of losing the end of the line. On line 2, pace projections go first, then reset
countdowns, the bar, cost, and cache. On line 1, the output style, plan, git, and account.
Segments come back when they fit again. The order is the same on every layout.
`PUFFR_HUD_WIDTH` overrides the width.

## Speed

The HUD is bash and `jq`, and it never runs git inline. Git status is cached for 5 seconds per
folder and refreshed by a detached background job, so a hung network mount can't stall a render.
A feature switched off with `/puffr:settings` also skips its work (no git refresh, no transcript
read). Settings are parsed in pure bash and apply on the next render.

## Fleet rows

While the plugin is enabled, its `settings.json` sets `subagentStatusLine` to
`subagent-statusline.sh`, so every running subagent renders as one row:

```
⚡ finder [opus-5] ▸ running · 42k 21%
```

Icons: ⚡ running, ✅ done, 💥 failed, 🐡 anything else. Rows fit the terminal: model, context %,
tokens, and status drop in that order, then the name is clipped with `…`. `PUFFR_FLEET_WIDTH`
overrides the width. `puffr-config off fleet` turns the rows off.

To change the rendering, edit `subagent-statusline.sh`. It receives all visible task rows as one
JSON object on stdin and prints one `{"id","content"}` JSON line per row it overrides; a row it
prints nothing for keeps Claude Code's default rendering.

## Banner

A SessionStart hook (`hooks/banner.sh`) prints:

```
🐡 puffr served. ABUNAI — HANDLE WITH CARE.
Session radar covers 156 project dirs — /puffr:sessions to scan.
```

It also records which puffr copy this session loaded, for the HUD launcher. That record is
written even while puffr is muted, so updates are picked up regardless. `puffr-config off banner`
hides the text.

## The fish

`puffr-config off hud.fish` or `PUFFR_MOOD=off` deflates him. Why would you.
