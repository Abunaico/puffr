#!/bin/bash
# puffr fleet dashboard — subagentStatusLine
# stdin: {columns, tasks:[{id,name,type,status,model,tokenCount,contextWindowSize,...}]}
# stdout: one {"id","content"} JSON line per row override.
# One jq pass for ALL rows (no per-row forks); task names are untrusted
# model-generated text and are control-stripped before rendering.

GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'
CYN=$'\033[36m'; DIM=$'\033[2m'; RST=$'\033[0m'

input=$(cat)
# /puffr:off drops this marker; always drain stdin first so the pipe never stalls.
[ -f "$HOME/.puffr/disabled" ] && exit 0
# /puffr:settings: fleet=off hands every row back to Claude Code's default rendering.
grep -qE '^[[:space:]]*fleet[[:space:]]*=[[:space:]]*off[[:space:]]*$' "$HOME/.puffr/config" 2>/dev/null && exit 0

# Rows sit indented under the prompt, so the usable width is `columns` minus a
# margin. Unknown width means no fitting.
FLEET_MARGIN=8

# Character counts below need a UTF-8 locale (name clipping must not split a
# multibyte character).
t='⚡'
if [ "${#t}" -ne 1 ]; then
  for loc in C.UTF-8 en_US.UTF-8 C.utf8; do LC_ALL=$loc; t='⚡'; [ "${#t}" -eq 1 ] && break; done 2>/dev/null
fi

echo "$input" | jq -r '
  (.columns // "" | tostring),
  (.tasks[]? | [
    (.id // ""),
    (.name // .type // "agent"),
    (.status // "?"),
    (.model // ""),
    (.tokenCount // 0),
    (.contextWindowSize // 0)
  ] | map(tostring | gsub("\\p{Cc}"; " ")) | join("\u001f"))' 2>/dev/null | {
read -r cols
cols=${PUFFR_FLEET_WIDTH:-$cols}
case "$cols" in ''|*[!0-9]*) cols=0;; esac
budget=0; [ "$cols" -gt 0 ] && budget=$(( cols - FLEET_MARGIN ))

# 0x1f, not tab: tab is IFS whitespace, so an empty field (no model) would
# collapse and shift every later field. Controls were already stripped in jq.
while IFS=$'\x1f' read -r id name status model tok cws; do
  [ -z "$id" ] && continue
  case "$tok" in ''|*[!0-9]*) tok=0;; esac
  case "$cws" in ''|*[!0-9]*) cws=0;; esac
  model=$(printf '%s' "$model" | sed -E 's/claude-//; s/-[0-9]{8}$//')

  case "$status" in
    running|in_progress) icon="⚡"; sc="$GRN" ;;
    completed|done)      icon="✅"; sc="$DIM" ;;
    failed|error)        icon="💥"; sc="$RED" ;;
    *)                   icon="🐡"; sc="$YLW" ;;
  esac

  if [ "$tok" -ge 1000 ]; then tokfmt="$((tok/1000))k"; else tokfmt="$tok"; fi
  pct=""; pc="$GRN"
  if [ "$cws" -gt 0 ] && [ "$tok" -gt 0 ]; then
    pct=$(( tok * 100 / cws ))
    [ "$pct" -ge 70 ] && pc="$YLW"; [ "$pct" -ge 90 ] && pc="$RED"
  fi

  # Fit: shed detail lowest-value first (model, context %, tokens, status),
  # then clip the name. The icon (2 columns + space) always stays.
  show_model=1; show_pct=1; show_tok=1; show_status=1
  [ -z "$model" ] && show_model=0
  [ -z "$pct" ] && show_pct=0
  if [ "$budget" -gt 0 ]; then
    width() {
      W=$(( 3 + ${#name} ))
      [ "$show_model" = 1 ]  && W=$(( W + ${#model} + 3 ))     # " [model]"
      [ "$show_status" = 1 ] && W=$(( W + ${#status} + 3 ))    # " ▸ status"
      [ "$show_tok" = 1 ]    && W=$(( W + ${#tokfmt} + 3 ))    # " · 42k"
      [ "$show_pct" = 1 ]    && W=$(( W + ${#pct} + 2 ))       # " 21%"
    }
    width
    for drop in show_model show_pct show_tok show_status; do
      [ "$W" -le "$budget" ] && break
      eval "$drop=0"; width
    done
    if [ "$W" -gt "$budget" ]; then
      keep=$(( ${#name} - (W - budget) - 1 ))
      [ "$keep" -lt 1 ] && keep=1
      name="${name:0:keep}…"
    fi
  fi

  # Keep the braces: under a UTF-8 locale bash can read a multibyte char's first
  # byte as part of a bare variable name ($DIM·).
  content="${icon} ${CYN}${name}${RST}"
  [ "$show_model" = 1 ]  && content="${content} ${DIM}[${model}]${RST}"
  [ "$show_status" = 1 ] && content="${content} ${DIM}▸${RST} ${sc}${status}${RST}"
  [ "$show_tok" = 1 ]    && content="${content} ${DIM}·${RST} ${tokfmt}"
  [ "$show_pct" = 1 ]    && content="${content} ${pc}${pct}%${RST}"
  jq -cn --arg id "$id" --arg content "$content" '{id:$id, content:$content}'
done
}
