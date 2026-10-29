# Command reference

Every skill is a thin layer over a CLI in `bin/`. The CLIs are on PATH inside Claude Code while
the plugin is enabled; from another terminal, call them from the plugin folder or the repo.

## Skills

| Skill | Arguments | Runs |
|---|---|---|
| `/puffr:hud` | `status`, `install`, `repair`, `remove` | `puffr-hud` |
| `/puffr:layout` | `<name>`, `new <name> [from]`, `edit <name>` | `puffr-config layout` |
| `/puffr:compact` | | `puffr-config layout compact` |
| `/puffr:detailed` | | `puffr-config layout detailed` |
| `/puffr:settings` | `on\|off <feature>...`, `all`, `reset` | `puffr-config` |
| `/puffr:context` | `[session-id \| project] [--turns N] [--top N]` | `puffr-context` |
| `/puffr:burn` | days, project, account, a time window, `since-change <date>`, `html` | `puffr-burn` |
| `/puffr:swarm` | days, a time window, `root <dir>`, `bill <usd>`, `html` | `puffr-swarm` |
| `/puffr:instructions` | `[--days N] [--project <substr>] [--top N]` | `puffr-instructions` |
| `/puffr:sessions` | project, N, `active`, a search term, or a subcommand | `puffr-sessions` |
| `/puffr:open` | session id, `fork <id>`, or a search term | builds a `claude --resume` command |
| `/puffr:accounts` | | `puffr-accounts` |
| `/puffr:fleet` | | explains `subagent-statusline.sh` |
| `/puffr:update` | `check` | `puffr-update` |
| `/puffr:off`, `/puffr:on` | | toggles `~/.puffr/disabled` |
| `/puffr:help` | | `puffr-help` |

Skills that take free-form arguments map plain words to flags: "last week" becomes `--days 7`, "the
hackathon Tuesday 9am to Thursday 5pm" becomes `--since` and `--until`, "share it" becomes `--html`.

## CLIs

### puffr-install

The `npx github:Abunaico/puffr` entry point. See [install.md](install.md).

```
npx github:Abunaico/puffr [install|update|uninstall|status]
    [--scope user|project] [--vscode|--no-vscode] [--warp|--no-warp] [--no-hud] [-y] [--dry-run]
```

### puffr-hud

```
puffr-hud [status|install|repair|remove]
```

### puffr-config

```
puffr-config                               every feature and its state
puffr-config on|off <feature>...           switch features
puffr-config on|off all                    every feature at once
puffr-config reset                         everything on; model.haiku is left alone
puffr-config layout [<name>]               show or switch the HUD layout
puffr-config layout new <name> [from]      copy a layout to ~/.puffr/layouts/<name>.yaml
puffr-config set|get <setting> [value]     model.haiku: ask, on, off, never
puffr-config haiku-check                   should a skill offer Haiku now? prints on, ask, or skip
puffr-config --json
```

Features are listed in [configuration.md](configuration.md#features).

### puffr-context

```
puffr-context [<session-id> | --project <substr>] [--turns N] [--top N] [--window TOKENS] [--json]
```

See [context.md](context.md).

### puffr-burn

```
puffr-burn [--days N | --since WHEN [--until WHEN]]
           [--project <substr>] [--account <substr>] [--exclude <id>[,...]] [--since-change YYYY-MM-DD]
           [--git | --full] [--json] [--html [file]] [--reindex]
puffr-burn --add-rule "<text>" | --rules | --recompile
```

`WHEN` is `YYYY-MM-DD` or local `"YYYY-MM-DD HH:MM"`. See [burn.md](burn.md).

### puffr-swarm

```
puffr-swarm [--days N | --since WHEN [--until WHEN]] [--root [LABEL=]DIR]... [--config FILE]
            [--lane NAME=REGEX]... [--rename NAME=REGEX]... [--phase "NAME=FROM..TO"]...
            [--orchestrated-agent REGEX] [--orchestrated-prompt REGEX]
            [--bill USD] [--exclude ID,...] [--min-usd N] [--anon] [--json] [--html [file]]
```

`WHEN` is `YYYY-MM-DD`, local `"YYYY-MM-DD HH:MM"`, or absolute `2026-10-21T13:00Z`. See
[swarm.md](swarm.md).

### puffr-instructions

```
puffr-instructions [--days N] [--project <substr>] [--top N] [--json]
```

See [instructions.md](instructions.md).

### puffr-sessions

```
puffr-sessions [--limit N] [--json] [--project <substr>] [--active]
               [--search <text>] [--starred] [--archived] [--tool claude|codex] [--reindex]
puffr-sessions name <id> <text...>                   "" clears
puffr-sessions star|unstar|archive|unarchive <id>...
puffr-sessions assign <id> <project>                 "-" clears
puffr-sessions merge [<name>... --into <project>]    no arguments lists; --into "" unmerges
puffr-sessions save [<id>...] [--starred] [--expiring] [--all]
puffr-sessions saved
puffr-sessions restore <id>
puffr-sessions label [--limit N] [--dry-run]         Haiku, opt-in
```

See [sessions.md](sessions.md).

### puffr-accounts

```
puffr-accounts [--json]
```

See [accounts.md](accounts.md).

### puffr-dash

```
puffr-dash [--project <substr>] [--every <seconds>] [--once]
           [--ucef] [--ucef-data-dir <dir>] [--ucef-session <id>] [--ucef-no-redact]
```

Keys: `r` refresh, `g` regenerate insights, `u` UCEF view, `[` `]` older and newer UCEF session,
`l` live, `q` quit. See [panels.md](panels.md).

### puffr-update

```
puffr-update [--check]
```

### puffr-autoname

```
puffr-autoname hook                               the UserPromptSubmit hook (stdin: hook payload)
puffr-autoname generate <session-id>              the background worker
puffr-autoname suggest [--cwd <dir>] <prompt>...  print a name, apply nothing
```

### puffr-watch

No arguments. Runs until stopped, printing one line per event. See
[sessions.md](sessions.md#watch).

### puffr-help

```
puffr-help            every command, with PUFFR drawn in truecolor ANSI pixels
puffr-help --puff     the puffed one
```
