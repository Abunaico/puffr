# puffr

Claude Code plugin: context, cost & fleet HUD for Claude Code. Public repo, github.com/Abunaico/puffr.
Published as `@abunaico/puffr` on npm (installer) and as the `puffr-tools` marketplace (plugin source
lives at repo root, `source: "./"`). Current version `0.10.0` (keep `package.json`,
`.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` versions in sync on release).

## Structure

| Path | What's there |
|---|---|
| `bin/` | CLI entry points — `puffr-install`, `puffr-hud`, `puffr-dash`, `puffr-context`, `puffr-burn`, `puffr-swarm`, `puffr-sessions`, `puffr-accounts`, `puffr-config`, `puffr-watch`, `puffr-autoname`, `puffr-update`, `puffr-help`, `puffr-instructions`. |
| `lib/` | Shared JS — `puffr.js` (core logic), `swarm.js` (swarm scan and analysis), `report-page.js` (shared HTML page for burn and swarm), `instructions.js`, `report.css`. |
| `skills/` | One folder per slash command surfaced to Claude Code: `accounts`, `burn`, `compact`, `context`, `detailed`, `fleet`, `help`, `hud`, `instructions`, `layout`, `off`, `on`, `open`, `sessions`, `settings`, `swarm`, `update`. |
| `hooks/` | `hooks.json` + `banner.sh` — the SessionStart hook that prints the "🐡 puffr served" banner. |
| `layouts/` | HUD layout presets — `compact.yaml`, `detailed.yaml`, `all.yaml`. |
| `monitors/` | `monitors.json` — background watch definitions. |
| `panel/` | Companion dashboard surfaces — `server.js`, `core.js`, `tui.js`, `theme.js`, `env.js`, `insights.js` (VS Code panel + Warp side pane + browser), plus the UCEF view (`ucef.js`, `ucef-view.js`, `ucef-tui.js`, `ucef-redact.js`). |
| `vscode-ext/` | The VS Code extension wrapping the panel (`extension.js`, `sidebar-view.js`, `dashboard.js`). |
| `assets/` | Pufferfish branding — pixel art, ANSI art, banner SVG, bowl animation. |
| `test/` | `run-tests.sh`, `ucef-panel-tests.js`. |
| `docs/` | User documentation (index at `docs/README.md`) and `ucef-monitor/` (UCEF view spec, schema, fixtures). The root README is a short landing page that links in; put depth in `docs/`. |
| `statusline.sh` / `subagent-statusline.sh` | The actual statusline scripts Claude Code invokes. |
| `settings.json` | Plugin-level settings schema/defaults. |

A `skills/<name>/` folder is the unit of a user-facing command (e.g. `/puffr:sessions`); its logic
typically shells out to the matching `bin/puffr-<name>` script. When adding a command, add both.

## Git attribution

Anthony Shafer is the sole author and contributor on this repo. Commits, merge commits, and PRs
must never carry a `Co-Authored-By: Claude ...` trailer or any other line crediting Claude or an
AI assistant as an author. This overrides any global or session default that would normally add
one. Author and committer identity stays `Anthony Shafer <anthonyshafer@gmail.com>`.
