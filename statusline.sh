#!/bin/bash
# puffr HUD — Claude Code statusline
# stdin: session JSON. stdout: one line per line of the active layout, a small
# YAML file naming which widgets go on which line (layouts/*.yaml, or the
# user's own in ~/.puffr/layouts/). Every widget is computed here; the layout
# only picks and orders them, so a new layout never needs code.
# Render path never blocks: git status is served from cache and refreshed
# by a detached background job — a hung SMB mount can never stall the HUD.
# Meme dial: PUFFR_MOOD=off deflates the fish. At 90% context the toxin comes out.

input=$(cat)
# /puffr:off drops this marker; always drain stdin first so the pipe never stalls.
[ -f "$HOME/.puffr/disabled" ] && exit 0
echo "$input" | jq -e . >/dev/null 2>&1 || input='{}'

# /puffr:settings writes `key=off` lines to ~/.puffr/config, and /puffr:layout a
# `layout=<name>` line. Parsed in pure bash so a render costs no extra process.
PUFFR_OFF=" "; cfg_layout=""
if [ -f "$HOME/.puffr/config" ]; then
  while IFS='=' read -r k v || [ -n "$k" ]; do
    k=${k//[[:space:]]/}; v=${v//[[:space:]]/}
    [ "$v" = off ] && PUFFR_OFF="$PUFFR_OFF$k "
    [ "$k" = layout ] && cfg_layout=$v
  done < "$HOME/.puffr/config"
fi
[ "$PUFFR_MOOD" = "off" ] && PUFFR_OFF="${PUFFR_OFF}hud.fish "
feat() { case "$PUFFR_OFF" in *" $1 "*) return 1;; esac; }

# --- layout: which widgets go on which line ---
# The format is a strict subset of YAML, read line by line in bash (no YAML
# library, no extra process per render):
#   lines:
#     - [fish, model, mode]              one HUD line, widgets left to right
#     - context: [context-bar, ·, ...]   a labeled line
# A name puffr doesn't know shows up red as ?name, so typos are visible.
# PUFFR_LAYOUT beats the saved choice so one terminal can differ from the rest.
layout=${PUFFR_LAYOUT:-$cfg_layout}
layout=${layout//[!A-Za-z0-9_-]/}   # names a file below: no slashes or dots
[ -z "$layout" ] && layout=compact
case "${BASH_SOURCE[0]}" in */*) here=${BASH_SOURCE[0]%/*};; *) here=.;; esac
layout_file=""
for f in "$HOME/.puffr/layouts/$layout.yaml" "$HOME/.puffr/layouts/$layout.yml" "$here/layouts/$layout.yaml"; do
  [ -f "$f" ] && { layout_file=$f; break; }
done
layout_note=""
if [ -z "$layout_file" ]; then
  layout_note="layout '$layout' not found, showing compact"
  layout_file="$here/layouts/compact.yaml"
fi

trim() { local t=$1; t=${t#"${t%%[![:space:]]*}"}; t=${t%"${t##*[![:space:]]}"}; T=$t; }
L_LBL=(); L_ITEMS=(); USED=" "; lblw=0
parse_layout() { # yaml on stdin → L_LBL / L_ITEMS (items joined by 0x1f), USED, lblw
  local l rest lbl body item items
  while IFS= read -r l || [ -n "$l" ]; do
    trim "${l%$'\r'}"; l=$T
    case "$l" in '-'*) ;; *) continue;; esac
    trim "${l#-}"; rest=$T; lbl=""
    case "$rest" in
      '['*) ;;
      *:*'['*) trim "${rest%%:*}"; lbl=$T; trim "${rest#*:}"; rest=$T
               lbl=${lbl#[\"\']}; lbl=${lbl%[\"\']};;
      *) continue;;
    esac
    case "$rest" in '['*']'*) ;; *) continue;; esac
    body=${rest#\[}; body=${body%%\]*}; items=""
    while [ -n "$body" ]; do
      item=${body%%,*}
      if [ "$item" = "$body" ]; then body=""; else body=${body#*,}; fi
      trim "$item"; item=$T
      [ -z "$item" ] && continue
      case "$item" in
        \"*\"|\'*\') item="=${item:1:${#item}-2}";;   # quoted: literal text
        *) USED="$USED$item ";;
      esac
      items="$items$item"$'\x1f'
    done
    L_LBL+=("$lbl"); L_ITEMS+=("$items")
    [ "${#lbl}" -gt "$lblw" ] && lblw=${#lbl}
  done
}
if [ -f "$layout_file" ]; then
  parse_layout < "$layout_file"
else
  # Even with the layouts folder gone, the HUD still renders.
  parse_layout <<'EOF'
- [fish, model, mode, ·, account, plan]
- [context-bar, context-pct, 5h, 5h-reset, 5h-pace, 7d, 7d-reset, 7d-pace, cache, ·, cost]
- [dir, ·, git]
EOF
fi
uses() { case "$USED" in *" $1 "*) return 0;; esac; return 1; }
uses_any() { local w; for w in "$@"; do uses "$w" && return 0; done; return 1; }

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'
MAG=$'\033[35m'; DIM=$'\033[2m'; RST=$'\033[0m'; BOLD=$'\033[1m'

strip_ctrl() { tr -d '\000-\037\177'; }

# File mtime in epoch secs. GNU first: on Linux `stat -f` is a real flag
# (filesystem info) that prints junk before failing; BSD rejects -c cleanly.
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

# One jq pass for every field. Every value is stripped of C0/C1 controls (ESC,
# CSI, OSC, CR, LF, and the 0x1f separator) before it can reach the terminal.
# resets_at arrives as ISO text (any offset) or epoch; normalized to epoch secs.
IFS=$'\x1f' read -r model cwd used upct size cost h5 h5r d7 d7r sid effort style tpath pc_exp pc_ttl \
  version dur_ms api_ms ladd ldel < <(
  echo "$input" | jq -r '
    def ep:
      if . == null or . == "" then ""
      elif type == "number" then (if . > 1e12 then . / 1000 else . end | floor)
      elif (tostring | test("^[0-9]+(\\.[0-9]+)?$")) then (tostring | tonumber | ep)
      else ((tostring | capture("^(?<d>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\\.[0-9]+)?(?<z>Z|[+-][0-9]{2}:?[0-9]{2})?$")
             | ((.d + "Z") | fromdateiso8601)
               - (if (.z // "Z") == "Z" then 0 else (.z | capture("(?<s>[+-])(?<h>[0-9]{2}):?(?<m>[0-9]{2})")
                   | ((.h | tonumber) * 3600 + (.m | tonumber) * 60) * (if .s == "-" then -1 else 1 end)) end)) // "")
      end;
    def pctnum: if type == "number" then (. + 0.5 | floor) else (. // "") end;
    [
    (.model.display_name // "Claude"),
    (.workspace.current_dir // .cwd // ""),
    (.context_window.used_tokens // .context_window.total_tokens_used
      // (.context_window.current_usage | if type == "object"
           then (.input_tokens // 0) + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0)
           else null end) // 0),
    (.context_window.used_percentage | pctnum),
    (.context_window.context_window_size // ""),
    (.cost.total_cost_usd // ""),
    (.rate_limits.five_hour.used_percentage | pctnum),
    (.rate_limits.five_hour.resets_at | ep),
    (.rate_limits.seven_day.used_percentage | pctnum),
    (.rate_limits.seven_day.resets_at | ep),
    (.session_id // ""),
    (.effort.level // ""),
    (.output_style.name // ""),
    (.transcript_path // ""),
    (.prompt_cache.expires_at | ep),
    (.prompt_cache.ttl // ""),
    (.version // ""),
    (.cost.total_duration_ms // ""),
    (.cost.total_api_duration_ms // ""),
    (.cost.total_lines_added // ""),
    (.cost.total_lines_removed // "")
  ] | map(tostring | gsub("\\p{Cc}"; " ")) | join("\u001f")' 2>/dev/null
)

model=${model:-Claude}
case "$used" in ''|*[!0-9]*) used=0;; esac
case "$upct" in ''|*[!0-9]*) upct="";; esac
case "$h5r" in *[!0-9]*) h5r="";; esac
case "$d7r" in *[!0-9]*) d7r="";; esac
case "$pc_exp" in *[!0-9]*) pc_exp="";; esac
for v in dur_ms api_ms ladd ldel; do case "${!v}" in *[!0-9.]*) printf -v "$v" '';; esac; done
dur_ms=${dur_ms%%.*}; api_ms=${api_ms%%.*}; ladd=${ladd%%.*}; ldel=${ldel%%.*}
# The session id names cache files below; nothing but [A-Za-z0-9-] may reach a path.
sid=${sid//[!A-Za-z0-9-]/}
now=$(date +%s)

# All cache writes are skipped unless we own a real (non-symlink) cache dir, so a
# shared or pre-planted XDG_CACHE_HOME can't be used to redirect them.
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/puffr"
mkdir -p "$cache_dir" 2>/dev/null && chmod 700 "$cache_dir" 2>/dev/null
cache_ok=""; [ -d "$cache_dir" ] && [ ! -L "$cache_dir" ] && [ -O "$cache_dir" ] && cache_ok=1

dur() { # secs → 43m / 1h28m / 2d4h
  local s=$1
  if   [ "$s" -lt 60 ];    then printf '<1m'
  elif [ "$s" -lt 3600 ];  then printf '%dm' $(( s / 60 ))
  elif [ "$s" -lt 86400 ]; then printf '%dh%02dm' $(( s / 3600 )) $(( s % 3600 / 60 ))
  else printf '%dd%dh' $(( s / 86400 )) $(( s % 86400 / 3600 )); fi
}

# Record the true window size for puffr-context (transcripts don't carry it).
# One tiny write only when the value changes. Only a size Claude Code actually
# reported is recorded, never the fallback.
case "$size" in ''|*[!0-9]*) size="";; esac
if [ -n "$cache_ok" ] && [ -n "$sid" ] && [ -n "$size" ]; then
  wfile="$cache_dir/win-$sid"
  if [ "$(cat "$wfile" 2>/dev/null)" != "$size" ]; then
    [ ! -L "$wfile" ] && printf '%s' "$size" > "$wfile" 2>/dev/null
  fi
fi
[ -z "$size" ] && size=200000
case "$cost" in *[!0-9.]*|'') cost="";; esac

dir="?"
if [ -n "$cwd" ]; then
  dir="${cwd/#$HOME/~}"; [ -z "$dir" ] && dir="/"
fi

# --- git: cached, never inline (SMB mounts here can hang in D-state) ---
git_seg=""
if [ -n "$cwd" ] && [ -n "$cache_ok" ] && feat hud.git && uses git; then
  cache="$cache_dir/git-$(printf '%s' "$cwd" | cksum | cut -d' ' -f1)"
  [ -L "$cache" ] && rm -f "$cache"

  age=999
  [ -f "$cache" ] && age=$(( now - $(mtime "$cache") ))
  if [ "$age" -gt 5 ]; then
    # Refresh out of band; this render serves whatever the cache last held.
    # Single-flight lock: a hung mount pins ONE subshell, not one per render.
    lock="$cache.lock"
    if mkdir "$lock" 2>/dev/null; then
      (
        tmp=""
        trap 'rm -f "$tmp" 2>/dev/null; rmdir "$lock" 2>/dev/null' EXIT
        tmp=$(mktemp "$cache_dir/.git-XXXXXX") || exit
        if branch=$(cd "$cwd" 2>/dev/null && git branch --show-current 2>/dev/null) && [ -n "$branch" ]; then
          # Branch names come from the repo (a clone controls them): drop UTF-8 C1
          # controls as well as C0 before they are cached for rendering.
          branch=$(printf '%s' "$branch" | LC_ALL=C sed $'s/\xc2[\x80-\x9f]//g' | tr -d '\000-\037\177')
          if [ -n "$(cd "$cwd" && git status --porcelain 2>/dev/null | head -1)" ]; then m="✗"; else m="✔"; fi
          printf '%s %s' "$branch" "$m" > "$tmp"
        else
          : > "$tmp"
        fi
        mv -f "$tmp" "$cache" && tmp=""
      ) >/dev/null 2>&1 &
      disown 2>/dev/null
    else
      # Reap a stale lock (killed subshell or reboot mid-refresh) after 120s.
      lockage=$(( now - $(mtime "$lock") ))
      [ "$lockage" -gt 120 ] && rmdir "$lock" 2>/dev/null
    fi
  fi
  gitinfo=""
  [ -f "$cache" ] && gitinfo=$(LC_ALL=C sed $'s/\xc2[\x80-\x9f]//g' "$cache" | strip_ctrl)
  [ -n "$gitinfo" ] && git_seg="${MAG}${gitinfo}${RST}"
fi

# --- account: which login this session bills to ---
# CLAUDE_CONFIG_DIR is inherited from the claude process, so profile launches
# (CLAUDE_CONFIG_DIR=... claude) show their own login. An API key in env overrides OAuth.
acct_seg=""; acct=""; acct_email=""; acct_plan=""; acct_org=""
if [ -n "$ANTHROPIC_API_KEY" ]; then
  acct="API key"
else
  IFS=$'\x1f' read -r acct_email acct_plan acct_org < <(jq -r '.oauthAccount | select(.emailAddress)
    | [.emailAddress, (.organizationType // "" | sub("^claude_"; "")), (.organizationName // "")]
    | map(tostring | gsub("\\p{Cc}"; " ")) | join("\u001f")' \
    "${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json" 2>/dev/null | head -1)
  acct="$acct_email${acct_plan:+ ($acct_plan)}"
fi
acct_plan_seg=""; acct_org_seg=""
if [ -n "$acct" ] && feat hud.account; then
  if [ -n "$acct_email" ]; then
    acct_seg="👤 ${acct_email}"
    [ -n "$acct_plan" ] && acct_plan_seg="(${acct_plan})"
    acct_org_seg=$acct_org
  else
    acct_seg="👤 ${acct}"
  fi
fi

# Last-seen rate limits per account, for puffr-accounts. Written at most once a
# minute (or when a number moves), so the render path stays one stat() per frame.
if [ -n "$cache_ok" ] && [ -n "$acct_email" ] && { [ -n "$h5" ] || [ -n "$d7" ]; }; then
  ufile="$cache_dir/usage-$(printf '%s' "$acct_email" | cksum | cut -d' ' -f1)"
  vals="$h5|$h5r|$d7|$d7r"
  uage=999
  [ -f "$ufile" ] && uage=$(( now - $(mtime "$ufile") ))
  if [ ! -L "$ufile" ] && { [ "$uage" -gt 60 ] || ! grep -qF "\"v\":\"$vals\"" "$ufile" 2>/dev/null; }; then
    utmp=$(mktemp "$cache_dir/.usage-XXXXXX" 2>/dev/null) && {
      jq -nc --arg e "$acct_email" --arg p "$acct_plan" --arg v "$vals" --argjson at "$now" \
        '{email: $e, plan: $p, v: $v, at: $at}' > "$utmp" 2>/dev/null && mv -f "$utmp" "$ufile" || rm -f "$utmp"
    }
  fi
fi

# --- prompt cache: time until it goes cold ---
# Only the transcript's tail is read, so cost stays flat as sessions grow. Cache
# hits refresh the TTL; the TTL tier (5m or 1h) comes from the last cache write.
cache_seg=""
cache_left=""; cache_tier=""
if ! uses_any cache cache-words cache-why; then :
elif feat hud.cache && [ -n "$pc_exp" ]; then
  # Newer Claude Code sends prompt_cache.{expires_at,ttl} directly.
  case "$pc_ttl" in 1h) cache_tier=3600;; 5m) cache_tier=300;; *[!0-9]*|'') cache_tier=300;; *) cache_tier=$pc_ttl;; esac
  cache_left=$(( pc_exp - now ))
elif [ -n "$tpath" ] && [ -f "$tpath" ] && feat hud.cache; then
  IFS=$'\x1f' read -r last_ts tier < <(tail -c 262144 "$tpath" 2>/dev/null | grep -E '"type": ?"assistant"' | jq -R -r -s '
    [split("\n")[] | fromjson? | select(.message.usage? and .message.model != "<synthetic>")] as $a
    | if ($a | length) == 0 then "" else
      [ ($a[-1].timestamp // "" | sub("\\.[0-9]+"; "") | (try fromdateiso8601 catch "")),
        ([$a[] | select((.message.usage.cache_creation_input_tokens // 0) > 0)]
          | if length == 0 then "" elif (.[-1].message.usage.cache_creation.ephemeral_1h_input_tokens // 0) > 0 then "3600" else "300" end)
      ] | map(tostring) | join("\u001f") end' 2>/dev/null)
  tfile="$cache_dir/ttl-$sid"
  if [ -n "$tier" ] && [ -n "$sid" ] && [ -n "$cache_ok" ]; then
    [ "$(cat "$tfile" 2>/dev/null)" != "$tier" ] && [ ! -L "$tfile" ] && printf '%s' "$tier" > "$tfile" 2>/dev/null
  elif [ -n "$sid" ]; then
    tier=$(cat "$tfile" 2>/dev/null)
  fi
  case "$tier" in 300|3600) ;; *) tier=300;; esac
  case "$last_ts" in ''|*[!0-9]*) ;; *) cache_tier=$tier; cache_left=$(( last_ts + tier - now ));; esac
fi
if [ -n "$cache_left" ]; then
  if [ "$cache_left" -gt 0 ]; then
    cc="$GRN"; [ "$cache_left" -lt $(( cache_tier / 4 )) ] && cc="$YLW"
    cache_seg="${DIM}cache${RST} ${cc}$(dur "$cache_left")${RST}"
  else
    cache_seg="${DIM}cache${RST} ${RED}cold${RST}"
  fi
fi

pct=0
if [ -n "$upct" ]; then pct=$upct
elif [ "$size" -gt 0 ]; then pct=$(( used * 100 / size )); fi
[ "$pct" -gt 100 ] && pct=100
if   [ "$pct" -ge 90 ]; then bc="$RED"
elif [ "$pct" -ge 70 ]; then bc="$YLW"
else bc="$GRN"; fi
filled=$(( pct / 10 )); bar=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  if [ "$i" -le "$filled" ]; then bar="${bar}█"; else bar="${bar}░"; fi
done

# Wall-clock time for an epoch: BSD date takes -r secs, GNU takes -d @secs.
clk() { date -r "$1" "+$2" 2>/dev/null || date -d "@$1" "+$2" 2>/dev/null; }

# One rate window, both ways: M_* are the compact gauges (5h 8% ⏰4h04m →43%),
# X_* the same facts in words. Empty when there's nothing to show.
meter() { # pct label reset_epoch window_secs
  local p=$1 lbl=$2 reset=$3 win=$4 c="$GRN"
  M_pct=""; M_reset=""; M_pace=""; X_pct=""; X_reset=""; X_clock=""; X_pace=""; X_pace_short=""
  case "$p" in ''|*[!0-9]*) return;; esac
  [ "$p" -ge 60 ] && c="$YLW"; [ "$p" -ge 85 ] && c="$RED"
  M_pct="${DIM}${lbl}${RST} ${c}${p}%${RST}"
  X_pct="${c}${p}% used${RST}"
  if [ -n "$reset" ] && [ "$reset" -gt "$now" ]; then
    local left=$(( reset - now )) elapsed
    if feat hud.reset; then
      M_reset="${DIM}⏰$(dur "$left")${RST}"
      # Word forms cost a subshell each, so only when the layout shows them.
      uses "$lbl-resets" && X_reset="resets in $(dur "$left")"
      # date forks, so only when a layout shows the clock.
      if uses "$lbl-clock"; then
        local fmt='%-I:%M %p' at; [ "$left" -ge 86400 ] && fmt='%a %-I:%M %p'
        at=$(clk "$reset" "$fmt")
        [ -n "$at" ] && X_clock="${DIM}(${at})${RST}"
      fi
    fi
    # Linear pace to end of window; skipped in the first 10% where it's noise.
    elapsed=$(( win - left ))
    if feat hud.pace && [ "$p" -gt 0 ] && [ "$elapsed" -gt $(( win / 10 )) ]; then
      local proj=$(( p * win / elapsed )) pc="$DIM"
      [ "$proj" -gt 999 ] && proj=999
      [ "$proj" -ge 85 ] && pc="$YLW"; [ "$proj" -ge 100 ] && pc="$RED"
      # The arrow only earns its space when the projection differs from now.
      [ "$proj" -ge $(( p + 5 )) ] && M_pace="${pc}→${proj}%${RST}"
      if [ "$p" -ge 100 ]; then
        X_pace="${RED}limit reached${RST}"
      elif [ "$proj" -ge 100 ]; then
        # Same linear rate, solved for when usage crosses 100%.
        uses "$lbl-pace-words" && X_pace="${pc}on pace to hit the limit in $(dur $(( elapsed * 100 / p - elapsed )))${RST}"
        X_pace_short="${pc}pace →${proj}%${RST}"
      else
        [ "$pc" = "$DIM" ] && pc=""
        X_pace="${pc}on pace for ${proj}% by reset${pc:+$RST}"
        X_pace_short="${pc}pace →${proj}%${pc:+$RST}"
      fi
    fi
  fi
}

# --- widgets ---
# Every name a layout can use. wd NAME PRIORITY TEXT [SHORT-TEXT] [HEADS]
#   PRIORITY: when a line is too wide, the lowest goes first; 99 never drops.
#   SHORT-TEXT: tried before dropping the widget outright.
#   HEADS: widgets this one qualifies (the plan after the email); if one of them
#          is on the same line, this one only shows alongside it.
# The priorities reproduce the original compact HUD's shedding order.
KNOWN=" "
wd() {
  KNOWN="$KNOWN$1 "
  case "$USED" in *" $1 "*) ;; *) return;; esac   # unused widgets cost nothing more
  local v=${1//-/_}
  printf -v "W_$v" '%s' "$3"; printf -v "P_$v" '%s' "$2"
  printf -v "A_$v" '%s' "${4:-}"; printf -v "H_$v" '%s' "${5:-}"
}

fish=""
if feat hud.fish; then fish="🐡"; [ "$pct" -ge 90 ] && fish="🐡☠️"; fi
wd fish 99 "$fish"
wd model 99 "$BOLD$CYN$model$RST"
mode=""; mode_short=""; eff=""; sty=""
# A big context rewrites at the cache-write price on a return after the cache
# expires; compacting before a break makes that rewrite small.
nudge=""; nudge_short=""
if feat hud.nudge && [ "$used" -ge 150000 ]; then
  nc="$DIM"; [ -n "$cache_left" ] && [ "$cache_left" -lt 600 ] && nc="$YLW"
  nudge="${nc}/compact before a break${RST}"; nudge_short="${nc}/compact?${RST}"
fi
wd nudge 8 "$nudge" "$nudge_short"
if feat hud.mode; then
  mode=$effort
  # The default output style is the unremarkable case, so it stays quiet.
  [ -n "$style" ] && [ "$style" != "default" ] && mode="${mode:+$mode · }$style"
  [ -n "$effort" ] && [ "$mode" != "$effort" ] && mode_short="${DIM}[${effort}]${RST}"
  eff=$effort; sty=$style
fi
wd mode 3 "${mode:+$DIM[$mode]$RST}" "$mode_short"
wd effort 3 "$eff"
wd style 3 "$sty"
wd account 6 "$acct_seg"
wd plan 4 "$acct_plan_seg" "" "account"
wd org 4 "$acct_org_seg" "" "account"
wd version 2 "${version:+${DIM}v${version}${RST}}"
wd session 1 "${sid:+${DIM}${sid}${RST}}" "${sid:+${DIM}${sid:0:8}${RST}}"

tok() { # 84000 → 84k, 1200000 → 1.2M
  if [ "$1" -ge 1000000 ]; then printf '%d.%dM' $(( $1 / 1000000 )) $(( $1 % 1000000 / 100000 ))
  else printf '%dk' $(( ($1 + 500) / 1000 )); fi
}
wd context-bar 13 "$bc$bar$RST"
wd context-pct 99 "$pct%"
wd context-full 99 "${bc}${pct}% full${RST}"
ctx_tok=""; [ "$used" -gt 0 ] && uses context-tokens && ctx_tok="$(tok "$used") of $(tok "$size") tokens"
wd context-tokens 30 "$ctx_tok"
ctx_warn=""; [ "$pct" -ge 90 ] && ctx_warn="${RED}nearly full, compaction soon${RST}"
wd context-warning 20 "$ctx_warn"

rate_widgets() { # name pct reset_epoch window_secs, then priorities: pct reset pace
  local n=$1 ppct=$5 preset=$6 ppace=$7
  M_pct=""; X_pct=""; M_reset=""; X_reset=""; X_clock=""; M_pace=""; X_pace=""; X_pace_short=""
  feat hud.rate && meter "$2" "$1" "$3" "$4"
  wd "$n" "$ppct" "$M_pct"
  wd "$n-used" "$ppct" "$X_pct"
  wd "$n-reset" "$preset" "$M_reset" "" "$n $n-used"
  wd "$n-resets" "$preset" "$X_reset" "" "$n $n-used"
  wd "$n-clock" 8 "$X_clock" "" "$n $n-used"
  wd "$n-pace" "$ppace" "$M_pace" "" "$n $n-used"
  wd "$n-pace-words" "$ppace" "$X_pace" "$X_pace_short" "$n $n-used"
}
# 5h widgets outrank 7d ones: the short window is the one that runs out mid-task.
rate_widgets 5h "$h5" "$h5r" 18000 50 12 10
rate_widgets 7d "$d7" "$d7r" 604800 40 11 9

wd cache 20 "$cache_seg"
xcache=""; xcache_why=""
if [ -n "$cache_seg" ] && uses_any cache-words cache-why; then
  tier_lbl="5m"; [ "${cache_tier:-300}" -ge 3600 ] && tier_lbl="1h"
  if [ "$cache_left" -gt 0 ]; then
    xcache="${cc}warm, $(dur "$cache_left") left${RST}"
    xcache_why="${DIM}(${tier_lbl} tier, every message resets it)${RST}"
  else
    xcache="${RED}cold${RST}"
    xcache_why="${DIM}(next message re-writes the whole context)${RST}"
  fi
fi
wd cache-words 20 "$xcache"
wd cache-why 5 "$xcache_why" "" "cache-words"

cost_txt=""
[ -n "$cost" ] && feat hud.cost && cost_txt="${YLW}\$$(printf '%.2f' "$cost" 2>/dev/null)${RST}"
wd cost 15 "$cost_txt"
wd cost-words 15 "${cost_txt:+$cost_txt ${DIM}this session${RST}}"
d_txt=""; [ -n "$dur_ms" ] && uses duration && d_txt="$(dur $(( dur_ms / 1000 ))) total"
a_txt=""; [ -n "$api_ms" ] && uses api-time && a_txt="$(dur $(( api_ms / 1000 ))) in API"
wd duration 7 "$d_txt"
wd api-time 6 "$a_txt"
lines_txt=""
[ -n "$ladd$ldel" ] && lines_txt="${GRN}+${ladd:-0}${RST} ${RED}-${ldel:-0}${RST} ${DIM}lines${RST}"
wd lines 7 "$lines_txt"
wd dir 99 "📁 $dir"
wd git 5 "$git_seg"

# --- fitting each line to the terminal width ---
# Claude Code passes COLUMNS and truncates anything wider, which would cut the
# most important gauges off the end. Instead, segments are dropped (or swapped
# for a shorter form) lowest-priority first until the line fits. Priority 99
# never drops. Order of the arrays is display order.
W=${PUFFR_HUD_WIDTH:-${COLUMNS:-0}}
case "$W" in ''|*[!0-9]*) W=0;; esac
budget=$(( W - 4 ))

# Visible width: strip our own color codes, then count characters; wide emoji
# take two columns. Character counting needs a UTF-8 locale.
t='🐡'
if [ "${#t}" -ne 1 ]; then
  for loc in C.UTF-8 en_US.UTF-8 C.utf8; do LC_ALL=$loc; t='🐡'; [ "${#t}" -eq 1 ] && break; done 2>/dev/null
fi
vw() {
  local s=$1 e c
  for c in "$RED" "$GRN" "$YLW" "$CYN" "$MAG" "$DIM" "$RST" "$BOLD"; do s=${s//"$c"/}; done
  # One literal pass per emoji: bash 3.2 (macOS /bin/bash) matches [..] brackets
  # byte-wise, which would also eat █ and → (they share a UTF-8 lead byte).
  e=${s//🐡/}; e=${e//📁/}; e=${e//👤/}; e=${e//⏰/}
  VW=$(( ${#s} + ${#s} - ${#e} ))
}

render() { # fits SEG / PRI / ALT / DEP (global arrays), prints one line
  local n=${#SEG[@]} i total min mi best bi p
  local orig=("${SEG[@]}") alt=("${ALT[@]}")
  if [ "$budget" -gt 0 ]; then
    # Drop (or shorten) the lowest-priority segment until the line fits.
    while :; do
      total=0
      for (( i = 0; i < n; i++ )); do [ -n "${SEG[i]}" ] && { vw "${SEG[i]}"; total=$(( total + VW )); }; done
      [ "$total" -le "$budget" ] && break
      min=99; mi=-1
      for (( i = 0; i < n; i++ )); do
        [ -n "${SEG[i]}" ] && [ "${PRI[i]}" -lt "$min" ] && { min=${PRI[i]}; mi=$i; }
      done
      [ "$mi" -lt 0 ] && break
      if [ -n "${ALT[mi]}" ]; then SEG[mi]=${ALT[mi]}; ALT[mi]=""; else SEG[mi]=""; fi
    done
    # Dropping one long segment can free room for a shorter one dropped earlier:
    # put segments back, highest priority first, in full or short form.
    for (( p = 98; p > 0; p-- )); do
      for (( i = 0; i < n; i++ )); do
        [ "${PRI[i]}" -eq "$p" ] && [ -z "${SEG[i]}" ] && [ -n "${orig[i]}" ] || continue
        [ -n "${DEP[i]}" ] && [ -z "${SEG[${DEP[i]}]}" ] && continue
        for cand in "${orig[i]}" "${alt[i]}"; do
          [ -n "$cand" ] || continue
          vw "$cand"; [ $(( total + VW )) -le "$budget" ] && { SEG[i]=$cand; total=$(( total + VW )); break; }
        done
      done
    done
  fi
  # A segment that qualifies another (the plan after the email) goes with it.
  for (( i = 0; i < n; i++ )); do [ -n "${DEP[i]}" ] && [ -z "${SEG[${DEP[i]}]}" ] && SEG[i]=""; done
  # Every segment carries the space before it; the line's first one drops it.
  local out=""
  for (( i = 0; i < n; i++ )); do
    [ -z "${SEG[i]}" ] && continue
    if [ -z "$out" ]; then out=${SEG[i]# }; else out="$out${SEG[i]}"; fi
  done
  printf '%s\n' "$out"
}

# One layout line → SEG/PRI/ALT/DEP → render. A separator (·, |, or any quoted
# text) is held until the next widget that has something to show and is glued
# to its front, so it disappears with that widget instead of dangling. When an
# empty widget sits between two separators, the later one replaces the earlier.
layout_line() { # label, items joined by 0x1f
  local lbl=$1 items=$2 it v ref body alt pri heads h j lit="" stale="" any="" n=0 pad
  SEG=(); PRI=(); ALT=(); DEP=(); NAMES=()
  if [ -n "$lbl" ]; then
    printf -v pad '%-*s' "$lblw" "$lbl"
    SEG[0]="$DIM$pad$RST"; PRI[0]=99; ALT[0]=""; DEP[0]=""; NAMES[0]=""; n=1
  fi
  while [ -n "$items" ]; do
    it=${items%%$'\x1f'*}; items=${items#*$'\x1f'}
    case "$it" in =*) [ -n "$stale" ] && lit=""; stale=""; lit="${lit:+$lit }$DIM${it#=}$RST"; continue;; esac
    case "$KNOWN" in
      *" $it "*)
        v=${it//-/_}
        ref="W_$v"; body=${!ref}; ref="A_$v"; alt=${!ref}
        ref="P_$v"; pri=${!ref}; ref="H_$v"; heads=${!ref};;
      *)
        case "$it" in
          *[A-Za-z0-9]*) body="$RED?$it$RST"; alt=""; pri=1; heads="";;
          *) [ -n "$stale" ] && lit=""; stale=""; lit="${lit:+$lit }$DIM$it$RST"; continue;;
        esac;;
    esac
    if [ -z "$body" ]; then [ -n "$lit" ] && stale=1; continue; fi
    any=1; stale=""
    SEG[n]=" ${lit:+$lit }$body"; ALT[n]="${alt:+ ${lit:+$lit }$alt}"; PRI[n]=$pri; DEP[n]=""; NAMES[n]=$it
    lit=""
    for h in $heads; do
      for (( j = 0; j < n; j++ )); do [ "${NAMES[j]}" = "$h" ] && { DEP[n]=$j; break 2; }; done
    done
    n=$(( n + 1 ))
  done
  # A line whose widgets all came up empty (no rate limits yet, say) is skipped.
  [ -n "$any" ] && render
}

for (( li = 0; li < ${#L_LBL[@]}; li++ )); do layout_line "${L_LBL[li]}" "${L_ITEMS[li]}"; done
[ -n "$layout_note" ] && printf '%s\n' "${YLW}🐡 ${layout_note}${RST}"
# Claude Code hides the HUD on a non-zero exit, and the test above leaves 1 behind.
exit 0
# A big context rewrites at the cache-write price on a return after the cache
# expires; compacting before a break makes that rewrite small.
nudge=""; nudge_short=""
if feat hud.nudge && [ "$used" -ge 150000 ]; then
  nc="$DIM"; [ -n "$cache_left" ] && [ "$cache_left" -lt 600 ] && nc="$YLW"
  nudge="${nc}/compact before a break${RST}"; nudge_short="${nc}/compact?${RST}"
fi
wd nudge 8 "$nudge" "$nudge_short"
