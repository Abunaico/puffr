# Install, update, uninstall

## Requirements

- Claude Code
- `jq`
- `node` 18 or newer (the installer, the reports, and the panels). The UCEF view's database
  source needs Node 22 or newer for `node:sqlite`.
- macOS or Linux
- VS Code 1.85 or newer, for the VS Code panel only
- A Pro or Max login for the rate meters, which appear after the first response
- `python3`, for the test battery only

## One command

```bash
npx github:Abunaico/puffr
```

The installer drives the `claude plugin` CLI. It:

1. adds the `puffr-tools` marketplace,
2. installs `puffr@puffr-tools` at user scope,
3. points your statusLine at the HUD launcher (with a timestamped backup of your settings),
4. asks whether to add the VS Code panel and a Warp launch configuration with `puffr-dash` in a
   side pane.

| Option | Effect |
|---|---|
| `--scope user\|project` | Plugin scope. Default `user`, or `$PLUGIN_SCOPE`. |
| `--vscode` / `--no-vscode` | Install the VS Code panel, or skip the question |
| `--warp` / `--no-warp` | Add the Warp side pane, or skip the question |
| `--no-hud` | Leave the statusLine alone |
| `-y`, `--yes` | Accept the defaults without asking |
| `--dry-run` | Print what would run and change nothing |

Other commands: `npx github:Abunaico/puffr update`, `... uninstall`, `... status`.

## Inside Claude Code

```
/plugin marketplace add Abunaico/puffr
/plugin install puffr@puffr-tools
```

Start a new session, then:

```
/puffr:hud install   # point your statusLine at puffr's launcher
/puffr:sessions      # scan the radar
/puffr:context       # see what's in your context
```

The fleet rows, banner, and autoname hook need no setup: they come with the plugin.

## Try it for one session

```bash
git clone https://github.com/Abunaico/puffr.git
claude --plugin-dir ./puffr
```

Nothing is installed. The HUD still needs `/puffr:hud install` if you want it in that session.

## How updates reach the HUD

Claude Code lets a plugin ship the subagent row renderer, but the main statusLine is a user
setting that holds a path. So `/puffr:hud install` points it at a small launcher,
`~/.puffr/bin/statusline`, instead of at one plugin copy. Each session start records which puffr
copy Claude Code loaded (`~/.puffr/root`), and the launcher runs that copy. After a plugin update,
the next session runs the new version with no reinstall.

`/puffr:hud` with no argument reports what's wired, which copy is live, any leftover copies, and
any mutes. `/puffr:hud repair` re-points the launcher at the current copy and reinstalls it.
`install` refuses to replace a statusLine that isn't puffr's.

The statusLine setting is per profile. If you run several profiles with `CLAUDE_CONFIG_DIR`, run
`/puffr:hud install` once in each.

## Updating

```bash
puffr-update --check   # installed vs latest; changes nothing
puffr-update           # or /puffr:update
```

`puffr-update` fast-forwards a git-clone marketplace (only a clean `main`; any other branch or a
local change is left alone and reported), refreshes the marketplace catalog, and runs
`claude plugin update` for every install scope. Profiles under `~/.aimux` share one plugin folder,
so they update together. New sessions load the update; restart or `/resume` running ones.

`npx github:Abunaico/puffr update` does the same and also refreshes the VS Code panel if it is
installed.

## Uninstalling

```bash
npx github:Abunaico/puffr uninstall
```

It removes the plugin, the marketplace, the HUD statusLine, the VS Code panel, and the Warp pane,
and asks first.

By hand: `/puffr:hud remove` (it only removes a statusLine that is puffr's), then remove the
plugin with `/plugin`.

Neither route deletes PUFFR's data in `~/.puffr` (settings, the radar index, saved transcripts) or
`~/.cache/puffr`. Delete those folders yourself if you want them gone. Check
`~/.puffr/archive` first: it holds any transcripts you saved.

## Muting without uninstalling

`/puffr:off` silences the HUD, fleet rows, banner, autoname, and watch notifications at once.
`/puffr:on` brings them back. See [configuration.md](configuration.md#the-off-switch).
