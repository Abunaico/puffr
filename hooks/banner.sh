#!/bin/bash
# puffr session banner — SessionStart hook.
# Its stdout is added to Claude's context: keep it tiny, and treat it as a trust
# boundary (any dynamic value added here must be control-char-stripped first).

# Record which puffr copy Claude Code loaded this session, for the HUD launcher
# (~/.puffr/bin/statusline). Done before any mute check so updates are picked up
# even while puffr is quiet. One write, only when the copy changed.
if [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -f "$CLAUDE_PLUGIN_ROOT/statusline.sh" ]; then
  mkdir -p "$HOME/.puffr" 2>/dev/null && chmod 700 "$HOME/.puffr" 2>/dev/null
  cur=""; read -r cur < "$HOME/.puffr/root" 2>/dev/null
  if [ "$cur" != "$CLAUDE_PLUGIN_ROOT" ] && [ ! -L "$HOME/.puffr/root" ]; then
    ( umask 077; printf '%s\n' "$CLAUDE_PLUGIN_ROOT" > "$HOME/.puffr/root" ) 2>/dev/null
  fi
fi
# /puffr:off drops this marker — go fully silent, don't even spend the find().
[ -f "$HOME/.puffr/disabled" ] && exit 0
# /puffr:settings: banner=off in ~/.puffr/config.
grep -qE '^[[:space:]]*banner[[:space:]]*=[[:space:]]*off[[:space:]]*$' "$HOME/.puffr/config" 2>/dev/null && exit 0
n=$(find "$HOME/.claude/projects" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
cat <<EOF
🐡 puffr served. ABUNAI — HANDLE WITH CARE.
Session radar covers ${n} project dirs — /puffr:sessions to scan.
EOF
