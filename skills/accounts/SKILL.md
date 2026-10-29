---
name: accounts
description: Show every Claude Code login on this machine with its last-known 5h/7d usage and reset times. Use when the user asks which accounts they have, which account has quota left, "which login should I use", or wants to compare usage across profiles.
---

# Accounts

Run the bundled viewer (already on PATH while puffr is enabled):

```bash
puffr-accounts
```

- Present the output as-is. `●` marks the profile this session runs under.
- Usage is the last reading the puffr HUD or Claude Code itself saw for that account; the age column says how old it is. A window whose reset time has passed shows 0%. "never seen" means the account hasn't been used with the HUD yet.
- To use another account, the user launches a new Claude Code with that profile: `CLAUDE_CONFIG_DIR=<profile dir> claude` (the output prints an example). Never copy, move, or read credential files to switch accounts.
- Profiles are found in `~/.claude.json`, `$CLAUDE_CONFIG_DIR`, `~/.aimux/profiles/*`, `~/.claude-profiles/*`, and `$PUFFR_PROFILE_DIRS` (colon-separated).
- For machine-readable work use `--json`.
