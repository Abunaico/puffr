---
name: open
argument-hint: "[session-id | fork <id> | search term]"
description: Open, resume, or fork a Claude Code session in a new terminal pane/tab. Use when the user says "open that session", "resume X in a new tab", "fork this session", or picks a session from the radar.
---

# Session open / resume / fork

Arguments: "$ARGUMENTS" — may be a session id, a radar row reference, "fork <id>", or a search term (resolve it via `puffr-sessions --search <term> --json` first).

PUFFR never runs interactive `claude` inside this session. It builds the command and hands it to the terminal:

## Build the command (switchboard's argv contract)

- Resume: `claude --resume <id>`
- Fork:   `claude --resume <id> --fork-session`
- New in project: `claude`, started in `<project>` (see the hand-off for how)
- Every `<id>` must match `^[0-9a-f-]{36}$` before it is used anywhere. Refuse otherwise.
- Add `--permission-mode plan` etc. only if the user asked.

## Hand off, in preference order

1. **tmux** (if `$TMUX` is set): pass argv, never a shell string, so a hostile project path can't run code: `tmux split-window -h -c "$project" claude --resume "$id"` (omit `--resume "$id"` for a new session).
2. **Warp**: write a launch config and open it. **Escape untrusted values first**: session titles and project paths come from transcript content — strip control characters and double-quote YAML values (or refuse titles containing `"`/newlines and fall back to the session id as the tab title). Never interpolate a raw title into `exec:`; the exec line must contain ONLY `claude --resume <uuid>` where the uuid matches `^[0-9a-f-]{36}$`.
   ```bash
   mkdir -p ~/.warp/launch_configurations
   cat > ~/.warp/launch_configurations/puffr-open.yaml <<EOF
   name: puffr-open
   windows:
     - tabs:
         - title: "🐡 <session-title>"
           layout:
             cwd: "<project-path>"
             commands:
               - exec: <cmd>
   EOF
   open "warp://launch/puffr-open.yaml"
   ```
   If the `warp://` open fails, fall back to 3.
3. **Print it**: show the command on its own line for the user to paste. Never run it here.

Get `<project-path>` from the radar's `--json` output (`project` field).
