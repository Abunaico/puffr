# Accounts

`puffr-accounts` (or `/puffr:accounts`) lists every Claude Code login on the machine with its
last-known 5-hour and weekly usage and reset times, side by side. It tells you which account has
room without spending a token.

```
🐡 puffr accounts — 3 profiles

  ● you@example.com      max   5h ███░░░  45% ⏰2h10m  7d ██░░░░  31% ⏰4d6h   3m ago  default
    you@work.example     team  5h ░░░░░░   4% ⏰4h02m  7d █░░░░░  12% ⏰2d1h   1h ago  work
    side@example.com     pro   5h    —                 7d    —                never seen  side

  ● this session. Usage is the last reading the HUD or Claude Code saw; a window that has reset shows 0%.
  launch another: CLAUDE_CONFIG_DIR=~/.aimux/profiles/work claude
```

`--json` gives the same data machine-readable.

## Where the numbers come from

Usage per account is the newer of two readings:

- what the HUD saw the last time it rendered for that account (`~/.cache/puffr`), and
- the utilization Claude Code caches in the profile's `.claude.json`.

A window whose reset time has passed shows 0%. An account the HUD has never rendered for, and
whose profile has no cached reading, shows `never seen`.

## Where profiles are found

- `~/.claude.json` (the default profile)
- `$CLAUDE_CONFIG_DIR`
- `~/.aimux/profiles/*`
- `~/.claude-profiles/*`
- `$PUFFR_PROFILE_DIRS`, colon-separated

## Switching accounts

Start Claude Code with that profile:

```bash
CLAUDE_CONFIG_DIR=<profile dir> claude
```

puffr never copies, reads, or swaps credentials. It reads only the email, organization name, and
plan type from each profile.
