# Development

## Layout

| Path | What's there |
|---|---|
| `statusline.sh` | The HUD. Bash and `jq`, run on every render. |
| `subagent-statusline.sh` | The fleet rows renderer |
| `settings.json` | Plugin settings: wires `subagentStatusLine` to the fleet renderer |
| `hooks/` | `hooks.json` and `banner.sh`: the SessionStart banner and the autoname `UserPromptSubmit` hook |
| `bin/` | One CLI per command: `puffr-install`, `puffr-hud`, `puffr-config`, `puffr-context`, `puffr-burn`, `puffr-swarm`, `puffr-instructions`, `puffr-sessions`, `puffr-accounts`, `puffr-dash`, `puffr-watch`, `puffr-autoname`, `puffr-update`, `puffr-help` |
| `lib/` | Shared JS. `puffr.js` is the core: transcript scanning and incremental indexing, prices, projects, accounts, config. `swarm.js` is the swarm scan and analysis, `report-page.js` the shared HTML page for burn and swarm, `instructions.js` the instruction-cost analysis, `report.css` the report styles. |
| `skills/` | One folder per slash command (`/puffr:<name>`). Each `SKILL.md` tells Claude which CLI to run and how to map the user's words to flags. |
| `layouts/` | Built-in HUD layouts and the layout format reference |
| `monitors/` | `monitors.json`, the plugin's background monitors (ships empty) |
| `panel/` | The panels: `core.js` gathers data, `server.js` serves the browser page, `tui.js` is `puffr-dash`, `ucef*.js` is the UCEF view, `insights.js` the Haiku insights |
| `vscode-ext/` | The VS Code extension wrapping the panel |
| `docs/` | These docs, and `ucef-monitor/` (the UCEF view's spec, JSON schema, fixtures, and contract tool) |
| `assets/` | The fish: pixel art, ANSI art, banner SVG, bowl animation |
| `test/` | `run-tests.sh` and `ucef-panel-tests.js` |
| `.claude-plugin/` | `plugin.json` and `marketplace.json` (the `puffr-tools` marketplace, plugin source `./`) |
| `package.json` | The `@abunaico/puffr` npm package: the installer |

## How the pieces fit

- **Data.** Everything starts from transcripts. `lib/puffr.js` scans `~/.claude/projects` (and
  Codex's sessions) into `~/.puffr/sessions-cache.json`, reading only new byte ranges on each
  pass. Usage is deduplicated per request, since one streamed response is logged as several
  lines.
- **The HUD** doesn't use the index. It reads the JSON Claude Code passes on stdin, the tail of
  the current transcript when it needs to, and its own cache in `~/.cache/puffr`. It must stay
  fast and must never block, so git runs in a detached background job.
- **Reports** (`puffr-burn`, `puffr-instructions`, `puffr-sessions`) read the index.
  `puffr-swarm` streams transcripts itself, so it can dedupe message ids across files and
  machines.
- **Panels** call the CLIs with `--json` and render the result. They compute nothing themselves.
- **Skills** call the CLIs and present the output.

## Tests

```bash
bash test/run-tests.sh
```

Needs `jq`, `node`, and `python3`. The battery covers degraded input, terminal-escape injection,
the non-blocking render path, incremental indexing edge cases, the off and on toggle, the context
viewer's usage math, the burn and swarm reports, and the UCEF view (paths, redaction, read-only
guarantees, and CLI exit codes). Add a test with every fix.

CI (`.github/workflows/test.yml`) runs a syntax check (`bash -n` on the shell scripts,
`node --check` on `bin/`) and the battery on Ubuntu and macOS with Node 20.

## Running from a checkout

```bash
claude --plugin-dir .
```

For the VS Code extension, symlink the folder so edits apply on reload:

```bash
ln -s "$PWD/vscode-ext" ~/.vscode/extensions/puffr-dev
```

For the browser panel, `node panel/server.js`.

## Adding a command

A user-facing command is a pair: `skills/<name>/SKILL.md` and `bin/puffr-<name>`. Add both. Keep
the logic in the CLI so it works from any terminal, and keep the skill to mapping the user's words
to flags and presenting the output. Give the CLI `--help` and, for reports, `--json`. Add it to
`bin/puffr-help`, [commands.md](commands.md), and the README's command table.

Rules every command follows:

- Read only what Claude Code or Codex already wrote. Write only under `~/.puffr` or
  `~/.cache/puffr`, with private permissions.
- Strip control characters from any text that came from a transcript, repo, or config before
  printing it.
- Never delete or move a transcript.
- A model call is opt-in, goes through the user's own `claude` login, and never sends a
  transcript.

## Releasing

Keep the version in sync across `package.json`, `.claude-plugin/plugin.json`, and
`.claude-plugin/marketplace.json`. Users pick it up with `/puffr:update` or
`npx github:Abunaico/puffr update`.

## Attribution

Anthony Shafer is the sole author. Commits and PRs carry no AI co-author trailers.
