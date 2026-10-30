#!/bin/bash
# puffr test battery — regression guards for every audited defect class.
# Run from the plugin root: bash test/run-tests.sh
set -u
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✔ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✘ $1"; }
chk()  { [ "$2" = "$3" ] && ok "$1" || bad "$1 (got: $2, want: $3)"; }

# Sandbox the whole run: no test may read or write the real ~/.claude, ~/.puffr,
# or ~/.cache/puffr, and host env (profiles, API keys, session ids) can't leak in.
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
export HOME="$SANDBOX/home" XDG_CACHE_HOME="$SANDBOX/cache"
mkdir -p "$HOME" "$XDG_CACHE_HOME"
unset CLAUDE_CONFIG_DIR ANTHROPIC_API_KEY CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID PUFFR_MOOD PUFFR_PROFILE_DIRS NO_COLOR COLUMNS PUFFR_HUD_WIDTH
strip_ansi() { LC_ALL=C sed $'s/\033\\[[0-9;]*m//g'; }

echo "— statusline degradation —"
out=$(echo 'not json' | ./statusline.sh 2>&1); echo "$out" | grep -q 'jq:' && bad "garbage stdin silent" || ok "garbage stdin silent"
out=$(echo -n '' | ./statusline.sh 2>&1); echo "$out" | grep -qE 'error|expected' && bad "empty stdin silent" || ok "empty stdin silent"
out=$(echo '{}' | ./statusline.sh 2>/dev/null | tail -1); echo "$out" | grep -q '📁 ?' && ok "empty cwd → ?" || bad "empty cwd → ? (got: $out)"
echo '{"workspace":{"current_dir":"/tmp"}}' | ./statusline.sh >/dev/null 2>&1 && ok "HUD exits 0" || bad "HUD exits non-zero (Claude Code hides it)"
out=$(echo '{"workspace":{"current_dir":"/tmp"},"context_window":{"used_tokens":190000,"context_window_size":200000}}' | ./statusline.sh | head -1)
echo "$out" | grep -q '☠️' && ok "toxin ≥90% (95% input)" || bad "toxin ≥90% (95% input)"

echo "— watch titles —"
# clean() is evaluated on its own: running puffr-watch would start polling.
cl=$(grep '^const clean' bin/puffr-watch)
chk "watch keeps hyphens, drops C0/C1" "$(node -e "$cl; process.stdout.write(clean('fix-auth\u009b-bug\u0007'))")" "fix-auth-bug"

echo "— statusline injection —"
out=$(python3 -c 'import json;print(json.dumps({"model":{"display_name":"Ev]0;pwnil"},"workspace":{"current_dir":"/tmp"}}))' | ./statusline.sh | head -1)
case "$out" in *$'\x1b]'*) bad "ESC stripped from model name";; *) ok "ESC stripped from model name";; esac

echo "— statusline render path never blocks —"
grep -nE 'git (branch|status|rev-parse|diff|log|config|-C)' statusline.sh | grep -v '(' | grep -qv '#' && bad "inline git found" || ok "git only in background subshell"

echo "— fleet —"
out=$(echo '{"tasks":[{"id":"t1","name":"f","status":"running","tokenCount":42300,"contextWindowSize":200000}]}' | ./subagent-statusline.sh)
echo "$out" | jq -e '.id=="t1"' >/dev/null && ok "row JSON valid" || bad "row JSON valid"
out=$(echo '{"tasks":[{"id":"t2","name":"x","status":"s","tokenCount":"NaN"}]}' | ./subagent-statusline.sh 2>&1)
echo "$out" | grep -q 'integer expression' && bad "NaN tokenCount guarded" || ok "NaN tokenCount guarded"
out=$(echo garbage | ./subagent-statusline.sh 2>&1); [ -z "$out" ] && ok "garbage stdin silent" || bad "garbage stdin silent"
fleet() { echo "$1" | ./subagent-statusline.sh | jq -r .content | strip_ansi; }
out=$(fleet '{"tasks":[{"id":"t1","name":"n","status":"running"}]}')
case "$out" in *'['*) bad "no model: fields don't shift (got: $out)";; *'n ▸ running'*) ok "no model: fields don't shift";; *) bad "no model row (got: $out)";; esac
FT='{"columns":COLS,"tasks":[{"id":"t1","name":"semantic-context-evaluator","status":"running","model":"claude-opus-5-5","tokenCount":42300,"contextWindowSize":200000}]}'
fw() { fleet "${FT/COLS/$1}" | python3 -c 'import sys,unicodedata
l=sys.stdin.read().rstrip("\n"); print(sum(0 if c=="\ufe0f" else (2 if unicodedata.east_asian_width(c) in "WF" else 1) for c in l))'; }
fit=1; for w in 20 30 40 50 60 80; do m=$(fw $w); [ "$m" -le $((w - 8)) ] || { fit=0; bad "fleet fits columns=$w (width $m)"; }; done
[ "$fit" = 1 ] && ok "fleet rows fit columns (20–80)"
chk "wide terminal: full row" "$(fleet "${FT/COLS/120}")" "⚡ semantic-context-evaluator [opus-5-5] ▸ running · 42k 21%"
chk "model drops first" "$(fleet "${FT/COLS/60}")" "⚡ semantic-context-evaluator ▸ running · 42k 21%"
chk "name clipped last" "$(fleet "${FT/COLS/30}")" "⚡ semantic-context-e…"
out=$(fleet '{"columns":20,"tasks":[{"id":"t1","name":"日本語のエージェント名です","status":"running"}]}')
case "$out" in *…) ok "multibyte name clipped cleanly";; *) bad "multibyte name clipped cleanly (got: $out)";; esac
echo "$out" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1 && ok "clip never splits a character" || bad "clip split a character"

echo "— radar: carry/resume correctness —"
T=$(mktemp -d); mkdir -p "$T/.claude/projects/-tmp-ct"
F="$T/.claude/projects/-tmp-ct/dddddddd-1111-2222-3333-444444444444.jsonl"
printf '%s\n' '{"type":"user","timestamp":"2026-09-17T01:00:00Z","cwd":"/tmp/ct","message":{"content":"first prompt long enough to pass the two hundred byte size gate for the radar scanner yes indeed truly"}}' > "$F"
printf '{"type":"assistant","timestamp":"2026-09-17T01:00:05Z","message":{"content":[{"type":"text","text":"partial' >> "$F"
chk "mid-line tail counted parseable-only" "$(HOME=$T node bin/puffr-sessions --json | jq -r '.[0].messages')" "1"
printf ' done"}]}}\n{"type":"user","timestamp":"2026-09-17T01:01:00Z","message":{"content":"second"}}\n' >> "$F"
chk "resume after completion (no double)" "$(HOME=$T node bin/puffr-sessions --json | jq -r '.[0].messages')" "3"
printf '{"type":"assistant","timestamp":"2026-09-17T01:02:00Z","message":{"content":[{"type":"text","text":"tail"}]}}' >> "$F"
chk "complete no-newline tail displayed" "$(HOME=$T node bin/puffr-sessions --json | jq -r '.[0].messages')" "4"
printf '\n{"type":"user","timestamp":"2026-09-17T01:03:00Z","message":{"content":"fifth"}}\n' >> "$F"
chk "newline lands + append (no double)" "$(HOME=$T node bin/puffr-sessions --json | jq -r '.[0].messages')" "5"

echo "— radar: UTF-8 chunk boundary —"
python3 -c "
import json
l1=json.dumps({'type':'user','timestamp':'2026-09-17T01:00:00Z','cwd':'/tmp/u8','message':{'content':'x'*1048570}})
l2=json.dumps({'type':'assistant','timestamp':'2026-09-17T01:00:01Z','message':{'content':[{'type':'text','text':'🐡'*100}]}},ensure_ascii=False)
l3=json.dumps({'type':'user','timestamp':'2026-09-17T01:00:02Z','message':{'content':'after'}})
open('$T/.claude/projects/-tmp-ct/cccccccc-1111-2222-3333-444444444444.jsonl','w').write(l1+'\n'+l2+'\n'+l3+'\n')
"
chk "emoji straddling 1MB chunk" "$(HOME=$T node bin/puffr-sessions --json | jq -r '.[]|select(.id[0:1]=="c").messages')" "3"
printf '%s\n' '{"type":"assistant","timestamp":"2026-09-17T01:00:09Z","message":{"content":[{"type":"text","text":"more"}]}}' >> "$T/.claude/projects/-tmp-ct/cccccccc-1111-2222-3333-444444444444.jsonl"
chk "resume across utf8 boundary" "$(HOME=$T node bin/puffr-sessions --json | jq -r '.[]|select(.id[0:1]=="c").messages')" "4"

echo "— radar: title injection + type safety —"
printf '%s\n' '{"type":"user","timestamp":"2026-09-17T01:00:00Z","cwd":"/t","message":{"content":"prompt long enough to pass the two hundred byte size gate for the radar scanner ok fine yes"}}' '{"type":"custom-title","customTitle":42}' > "$T/.claude/projects/-tmp-ct/eeeeeeee-1111-2222-3333-444444444444.jsonl"
HOME=$T node bin/puffr-sessions >/dev/null 2>&1 && ok "numeric customTitle no crash" || bad "numeric customTitle no crash"
printf '%s\n' '{"type":"ai-title","aiTitle":"evil]0;pwntitle"}' >> "$T/.claude/projects/-tmp-ct/eeeeeeee-1111-2222-3333-444444444444.jsonl"
out=$(HOME=$T node bin/puffr-sessions 2>/dev/null)
case "$out" in *$'\x1b]0;pwn'*) bad "title ESC stripped";; *) ok "title ESC stripped";; esac

echo "— radar: flags —"
chk "--limit garbage falls back" "$(HOME=$T node bin/puffr-sessions --limit nope --json | jq 'length > 0')" "true"
HOME=$T node bin/puffr-sessions --limit >/dev/null 2>&1 && ok "--limit at argv end no crash" || bad "--limit at argv end no crash"
rm -rf "$T"

echo "— gate C regressions —"
# 0x1f in a field value must not shift downstream fields
out=$(python3 -c 'import json,sys;sys.stdout.write(json.dumps({"model":{"display_name":"A\u001fB"},"workspace":{"current_dir":"/tmp"},"context_window":{"used_tokens":100000,"context_window_size":200000}}))' | ./statusline.sh | sed -n 2p)
echo "$out" | grep -q '50%' && ok "0x1f in value cannot shift fields" || bad "0x1f in value cannot shift fields (got: $out)"
# fast path must serve the same count as the indexing run (no flicker)
T2=$(mktemp -d); mkdir -p "$T2/.claude/projects/-tmp-fp"
FF="$T2/.claude/projects/-tmp-fp/ffffffff-1111-2222-3333-444444444444.jsonl"
printf '%s\n' '{"type":"user","timestamp":"2026-09-17T01:00:00Z","cwd":"/t","message":{"content":"prompt long enough to pass the two hundred byte size gate for the radar scanner ok fine yes truly"}}' > "$FF"
printf '{"type":"assistant","timestamp":"2026-09-17T01:00:05Z","message":{"content":[{"type":"text","text":"complete tail no newline"}]}}' >> "$FF"
a=$(HOME=$T2 node bin/puffr-sessions --json | jq -r '.[0].messages')
b=$(HOME=$T2 node bin/puffr-sessions --json | jq -r '.[0].messages')
chk "fast path serves display state" "$a/$b" "2/2"
# refresh lock: only one background refresh may spawn per window
rm -rf "$T2"
L="${XDG_CACHE_HOME:-$HOME/.cache}/puffr"
cksum_key=$(printf '%s' "/tmp" | cksum | cut -d' ' -f1)
rm -rf "$L/git-$cksum_key" "$L/git-$cksum_key.lock" 2>/dev/null
echo '{"workspace":{"current_dir":"/tmp"}}' | ./statusline.sh >/dev/null
[ -d "$L/git-$cksum_key.lock" ] || sleep 0.3   # first refresh may already have finished
echo '{"workspace":{"current_dir":"/tmp"}}' | ./statusline.sh >/dev/null
n=$(find "$L" -name ".git-*" 2>/dev/null | wc -l | tr -d ' ')
[ "$n" -le 1 ] && ok "no orphaned refresh tmp files" || bad "orphaned refresh tmp files: $n"

echo "— radar: self marker —"
TY=$(mktemp -d); mkdir -p "$TY/.claude/projects/-tmp-y"
SID=aaaaaaaa-1111-2222-3333-444444444444
printf '%s\n' '{"type":"user","timestamp":"2026-09-17T01:00:00Z","cwd":"/tmp/y","message":{"content":"a prompt long enough to clear the radar two hundred byte gate, padded out with more words and then some more words"}}' > "$TY/.claude/projects/-tmp-y/$SID.jsonl"
out=$(HOME=$TY CLAUDE_CODE_SESSION_ID=$SID node bin/puffr-sessions | strip_ansi)
case "$out" in *'◀ you'*) ok "◀ you via CLAUDE_CODE_SESSION_ID";; *) bad "◀ you via CLAUDE_CODE_SESSION_ID";; esac
out=$(HOME=$TY CLAUDE_SESSION_ID=$SID node bin/puffr-sessions | strip_ansi)
case "$out" in *'◀ you'*) ok "◀ you via legacy CLAUDE_SESSION_ID";; *) bad "◀ you via legacy CLAUDE_SESSION_ID";; esac
out=$(HOME=$TY node bin/puffr-sessions | strip_ansi)
case "$out" in *'◀ you'*) bad "no marker without a session id";; *) ok "no marker without a session id";; esac
rm -rf "$TY"

echo "— watch monitor —"
node --check bin/puffr-watch 2>/dev/null && ok "puffr-watch syntax" || bad "puffr-watch syntax"
TW=$(mktemp -d); mkdir -p "$TW/.claude/projects/-tmp-w"
FW="$TW/.claude/projects/-tmp-w/99999999-1111-2222-3333-444444444444.jsonl"
printf '%s\n' '{"type":"user","timestamp":"2026-09-17T01:00:00Z","cwd":"/t","message":{"content":"padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding"}}' '{"type":"assistant","timestamp":"2026-09-17T01:00:05Z","message":{"content":[{"type":"text","text":"done"}]}}' > "$FW"
out=$(HOME=$TW PUFFR_WATCH_ONCE=1 ./bin/puffr-watch)
[ -z "$out" ] && ok "watch silent on startup backlog" || bad "watch silent on startup backlog (got: $out)"
rm -rf "$TW"

echo "— /puffr:off toggle —"
TOFF=$(mktemp -d)
mkdir -p "$TOFF/.puffr" && touch "$TOFF/.puffr/disabled"
out=$(echo '{"workspace":{"current_dir":"/tmp"},"context_window":{"used_tokens":190000,"context_window_size":200000}}' | HOME=$TOFF ./statusline.sh)
[ -z "$out" ] && ok "statusline silent when disabled" || bad "statusline silent when disabled (got: $out)"
out=$(echo '{"tasks":[{"id":"t1","name":"f","status":"running","tokenCount":42300,"contextWindowSize":200000}]}' | HOME=$TOFF ./subagent-statusline.sh)
[ -z "$out" ] && ok "fleet silent when disabled" || bad "fleet silent when disabled (got: $out)"
out=$(HOME=$TOFF ./hooks/banner.sh)
[ -z "$out" ] && ok "banner silent when disabled" || bad "banner silent when disabled (got: $out)"
out=$(HOME=$TOFF PUFFR_WATCH_ONCE=1 ./bin/puffr-watch)
[ -z "$out" ] && ok "watch silent when disabled" || bad "watch silent when disabled (got: $out)"
rm -f "$TOFF/.puffr/disabled"
out=$(echo '{"workspace":{"current_dir":"/tmp"}}' | HOME=$TOFF ./statusline.sh | head -1)
[ -n "$out" ] && ok "statusline resumes after /puffr:on" || bad "statusline resumes after /puffr:on"
out=$(echo '{"tasks":[{"id":"t1","name":"f","status":"running"}]}' | HOME=$TOFF ./subagent-statusline.sh)
echo "$out" | jq -e '.id=="t1"' >/dev/null && ok "fleet resumes after /puffr:on" || bad "fleet resumes after /puffr:on"
out=$(HOME=$TOFF ./hooks/banner.sh)
[ -n "$out" ] && ok "banner resumes after /puffr:on" || bad "banner resumes after /puffr:on"
rm -rf "$TOFF"

echo "— context viewer —"
TC=$(mktemp -d); mkdir -p "$TC/.claude/projects/-tmp-cv" "$TC/cache/puffr"
CF="$TC/.claude/projects/-tmp-cv/cccccccc-1111-2222-3333-444444444444.jsonl"
python3 - "$CF" <<'PY'
import json, sys
u = lambda i, r, w5, o: {"input_tokens": i, "cache_read_input_tokens": r, "cache_creation_input_tokens": w5,
                         "cache_creation": {"ephemeral_5m_input_tokens": w5, "ephemeral_1h_input_tokens": 0}, "output_tokens": o}
L = [
  {"type": "custom-title", "customTitle": "Ev\u001b]0;pwn\u0007il"},
  {"type": "user", "uuid": "u1", "timestamp": "2026-09-17T10:00:00Z", "cwd": "/tmp/cv", "message": {"content": "hello"}},
  # one request streamed as two lines: usage must count once
  {"type": "assistant", "uuid": "a1", "timestamp": "2026-09-17T10:00:01Z", "message": {"id": "m1", "model": "claude-x", "usage": u(5, 0, 50000, 100), "content": [{"type": "thinking", "thinking": "hm"}]}},
  {"type": "assistant", "uuid": "a1b", "timestamp": "2026-09-17T10:00:01Z", "message": {"id": "m1", "model": "claude-x", "usage": u(5, 0, 50000, 100), "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "cat big"}}]}},
  {"type": "user", "uuid": "u2", "timestamp": "2026-09-17T10:00:02Z", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "x" * 8000}]}},
  {"type": "assistant", "uuid": "a2", "timestamp": "2026-09-17T10:01:00Z", "message": {"id": "m2", "model": "claude-x", "usage": u(5, 50000, 2000, 50), "content": [{"type": "text", "text": "ok"}]}},
  {"type": "user", "uuid": "u3", "timestamp": "2026-09-17T10:19:00Z", "message": {"content": "again"}},
  {"type": "assistant", "uuid": "a3", "timestamp": "2026-09-17T10:20:00Z", "message": {"id": "m3", "model": "claude-x", "usage": u(5, 0, 53000, 20), "content": [{"type": "text", "text": "back"}]}},
]
with open(sys.argv[1], "w") as f:
    for e in L: f.write(json.dumps(e) + "\n")
    f.write("{not json\n")
PY
cv() { HOME=$TC XDG_CACHE_HOME=$TC/cache CLAUDE_CONFIG_DIR= CLAUDE_CODE_SESSION_ID= node bin/puffr-context "$@"; }
J=$(cv cccccccc-1111-2222-3333-444444444444 --json)
chk "streamed request counted once" "$(echo "$J" | jq -r '.cache.requests')" "3"
chk "hit rate from measured usage" "$(echo "$J" | jq -r '.cache.hitRate * 1000 | floor')" "322"
chk "cold start detected" "$(echo "$J" | jq -r '.cache.breaks[0].reason')" "cold start"
echo "$J" | jq -r '.cache.breaks[1].reason' | grep -q '^TTL expired' && ok "idle TTL break detected" || bad "idle TTL break detected"
chk "current context = last request" "$(echo "$J" | jq -r '.context.current')" "53005"
echo "$J" | jq -e '.context.composition[] | select(.cat=="result: Bash")' >/dev/null && ok "tool result attributed to tool" || bad "tool result attributed to tool"
chk "window assumed without HUD record" "$(echo "$J" | jq -r '.context.windowSource')" "assumed"
printf 1000000 > "$TC/cache/puffr/win-cccccccc-1111-2222-3333-444444444444"
chk "window read from HUD record" "$(cv cccccccc-1111-2222-3333-444444444444 --json | jq -r '.context.window')" "1000000"
out=$(cv --project cv); case "$out" in *$'\x1b]'*) bad "title ESC stripped";; *) ok "title ESC stripped";; esac
echo "$out" | grep -q 'CACHE' && ok "--project finds newest session" || bad "--project finds newest session"
printf '%s\n' '{"type":"system","subtype":"compact_boundary","timestamp":"2026-09-17T10:30:00Z","compactMetadata":{"trigger":"auto","preTokens":53005,"postTokens":4000}}' \
  '{"type":"user","uuid":"s1","isCompactSummary":true,"timestamp":"2026-09-17T10:30:01Z","message":{"content":"summary"}}' >> "$CF"
J=$(cv cccccccc-1111-2222-3333-444444444444 --json)
echo "$J" | jq -e '[.context.composition[].cat] | index("result: Bash") == null' >/dev/null && ok "compaction drops pre-boundary items" || bad "compaction drops pre-boundary items"
chk "compaction recorded" "$(echo "$J" | jq -r '.context.compactions[0].trigger')" "auto"
out=$(cv no-such-session 2>&1); echo "$out" | grep -q 'not found' && ok "unknown session reports cleanly" || bad "unknown session reports cleanly"
rm -rf "$TC"

echo "— HUD gauges —"
TH=$(mktemp -d); mkdir -p "$TH/cache"
printf '%s' '{"oauthAccount":{"emailAddress":"hud@example.com","organizationType":"claude_max"}}' > "$TH/.claude.json"
hud() { HOME=$TH XDG_CACHE_HOME=$TH/cache CLAUDE_CONFIG_DIR= ANTHROPIC_API_KEY= ./statusline.sh | LC_ALL=C sed $'s/\033\\[[0-9;]*m//g'; }
NOW=$(date +%s)
# 5h window 80% elapsed at 60% used → pace projects 75%
out=$(jq -nc --argjson r $((NOW + 3600)) '{session_id:"h-1",workspace:{current_dir:"/tmp"},rate_limits:{five_hour:{used_percentage:60,resets_at:$r}}}' | hud | sed -n 2p)
echo "$out" | grep -qE '⏰(59m|1h00m)' && ok "5h reset countdown" || bad "5h reset countdown (got: $out)"
echo "$out" | grep -qE '→7[45]%' && ok "pace projection" || bad "pace projection (got: $out)"
out=$(jq -nc --argjson r $((NOW + 17000)) '{workspace:{current_dir:"/tmp"},rate_limits:{five_hour:{used_percentage:3,resets_at:$r}}}' | hud | sed -n 2p)
echo "$out" | grep -q '→' && bad "no projection early in window (got: $out)" || ok "no projection early in window"
iso=$(date -u -r $((NOW + 2*86400 + 7200)) +%Y-%m-%dT%H:%M:%S.123456+00:00 2>/dev/null || date -u -d @$((NOW + 2*86400 + 7200)) +%Y-%m-%dT%H:%M:%S.123456+00:00)
out=$(jq -nc --arg r "$iso" '{workspace:{current_dir:"/tmp"},rate_limits:{seven_day:{used_percentage:10,resets_at:$r}}}' | hud | sed -n 2p)
echo "$out" | grep -qE '⏰2d[12]h' && ok "ISO resets_at parsed" || bad "ISO resets_at parsed (got: $out)"
out=$(jq -nc --argjson r $(((NOW + 1800) * 1000)) '{workspace:{current_dir:"/tmp"},rate_limits:{five_hour:{used_percentage:10,resets_at:$r}}}' | hud | sed -n 2p)
echo "$out" | grep -qE '⏰(29|30)m' && ok "epoch-ms resets_at parsed" || bad "epoch-ms resets_at parsed (got: $out)"
out=$(echo '{"workspace":{"current_dir":"/tmp"},"context_window":{"used_percentage":42,"context_window_size":1000000}}' | hud | sed -n 2p)
echo "$out" | grep -q ' 42%' && ok "context % from used_percentage" || bad "context % from used_percentage (got: $out)"
out=$(echo '{"workspace":{"current_dir":"/tmp"},"context_window":{"context_window_size":200000,"current_usage":{"input_tokens":1,"cache_read_input_tokens":99999}}}' | hud | sed -n 2p)
echo "$out" | grep -q ' 50%' && ok "context % from current_usage" || bad "context % from current_usage (got: $out)"
out=$(echo '{"workspace":{"current_dir":"/tmp"},"effort":{"level":"high"},"output_style":{"name":"Explanatory"}}' | hud | head -1)
echo "$out" | grep -qF '[high · Explanatory]' && ok "effort + style shown" || bad "effort + style shown (got: $out)"
out=$(echo '{"workspace":{"current_dir":"/tmp"},"output_style":{"name":"default"}}' | hud | head -1)
echo "$out" | grep -q '\[' && bad "default style hidden (got: $out)" || ok "default style hidden"
TT="$TH/t.jsonl"
ts=$(date -u -r $((NOW - 120)) +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d @$((NOW - 120)) +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"type":"assistant","timestamp":"%s","message":{"model":"x","usage":{"input_tokens":1,"cache_creation_input_tokens":9,"cache_creation":{"ephemeral_1h_input_tokens":9}}}}\n' "$ts" > "$TT"
out=$(jq -nc --arg t "$TT" '{session_id:"h-2",workspace:{current_dir:"/tmp"},transcript_path:$t}' | hud | sed -n 2p)
echo "$out" | grep -qE 'cache 5[78]m' && ok "1h cache countdown" || bad "1h cache countdown (got: $out)"
printf '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"model":"x","usage":{"input_tokens":1,"cache_creation_input_tokens":9,"cache_creation":{"ephemeral_5m_input_tokens":9}}}}\n' > "$TT"
out=$(jq -nc --arg t "$TT" '{session_id:"h-3",workspace:{current_dir:"/tmp"},transcript_path:$t}' | hud | sed -n 2p)
echo "$out" | grep -q 'cache cold' && ok "expired cache shows cold" || bad "expired cache shows cold (got: $out)"
jq -nc '{workspace:{current_dir:"/tmp"},rate_limits:{five_hour:{used_percentage:33}}}' | hud >/dev/null
chk "usage recorded per account" "$(cat "$TH"/cache/puffr/usage-* 2>/dev/null | jq -r '.email + " " + .v')" "hud@example.com 33|||"
rm -rf "$TH"

echo "— accounts —"
TA=$(mktemp -d); mkdir -p "$TA/.aimux/profiles/work" "$TA/.aimux/profiles/empty" "$TA/cache/puffr"
R7=$(date -u -r $((NOW + 86400)) +%Y-%m-%dT%H:%M:%S+00:00 2>/dev/null || date -u -d @$((NOW + 86400)) +%Y-%m-%dT%H:%M:%S+00:00)
jq -nc --arg r "$R7" '{oauthAccount:{emailAddress:"me@example.com",organizationType:"claude_max",accountUuid:"u1"},
  cachedUsageUtilization:{fetchedAtMs:1000,accountUuid:"u1",utilization:{five_hour:{utilization:90,resets_at:"2020-01-01T00:00:00+00:00"},seven_day:{utilization:44,resets_at:$r}}}}' > "$TA/.claude.json"
printf '%s' '{"oauthAccount":{"emailAddress":"w\u001b]0;x\u0007@corp.com","organizationType":"claude_team"}}' > "$TA/.aimux/profiles/work/.claude.json"
printf '{}' > "$TA/.aimux/profiles/empty/.claude.json"
k=$(printf '%s' 'me@example.com' | cksum | cut -d' ' -f1)
jq -nc --argjson at "$NOW" '{email:"me@example.com",plan:"max",v:"12|||",at:$at}' > "$TA/cache/puffr/usage-$k"
acc() { HOME=$TA XDG_CACHE_HOME=$TA/cache CLAUDE_CONFIG_DIR= PUFFR_PROFILE_DIRS= node bin/puffr-accounts "$@"; }
J=$(acc --json)
chk "profiles discovered" "$(echo "$J" | jq -r 'length')" "3"
chk "newest reading wins per window" "$(echo "$J" | jq -r '.[] | select(.profile=="default") | "\(.usage.h5) \(.usage.d7)"')" "12 44"
chk "default profile active" "$(echo "$J" | jq -r '.[] | select(.active) | .profile')" "default"
chk "logged-out profile has no email" "$(echo "$J" | jq -r '.[] | select(.profile=="empty") | .email')" "null"
out=$(acc); case "$out" in *$'\x1b]'*) bad "account ESC stripped";; *) ok "account ESC stripped";; esac
jq '.cachedUsageUtilization.utilization.seven_day.resets_at = "2020-01-01T00:00:00+00:00"' "$TA/.claude.json" > "$TA/x" && mv "$TA/x" "$TA/.claude.json"
chk "reset window reads 0" "$(acc --json | jq -r '.[] | select(.profile=="default") | .usage.d7')" "0"
rm -rf "$TA"

echo "— settings —"
TS=$(mktemp -d); mkdir -p "$TS/.puffr"
printf '%s' '{"oauthAccount":{"emailAddress":"s@example.com","organizationType":"claude_pro"}}' > "$TS/.claude.json"
NOW=$(date +%s)
SJ=$(jq -nc --argjson r $((NOW + 3600)) '{workspace:{current_dir:"/tmp"},effort:{level:"high"},cost:{total_cost_usd:1.5},
  rate_limits:{five_hour:{used_percentage:60,resets_at:$r}}}')
cfgrun() { printf '%s\n' "$@" > "$TS/.puffr/config"; echo "$SJ" | HOME=$TS XDG_CACHE_HOME=$TS/cache ./statusline.sh | strip_ansi; }
out=$(cfgrun); for want in '🐡' '[high]' '👤 s@example.com' '5h 60%' '⏰' '→' '$1.50'; do
  case "$out" in *"$want"*) ;; *) bad "all features on by default (missing $want)"; break;; esac; done
case "$out" in *'🐡'*'[high]'*'$1.50'*) ok "all features on by default";; esac
chkoff() { local key=$1 gone=$2 out; out=$(cfgrun "$key=off"); case "$out" in *"$gone"*) bad "$key=off hides it (got: $out)";; *) ok "$key=off hides it";; esac; }
chkoff hud.fish '🐡'; chkoff hud.mode '[high]'; chkoff hud.account '👤'; chkoff hud.cost '$1.50'
chkoff hud.reset '⏰'; chkoff hud.pace '→'; chkoff hud.rate '5h'
out=$(cfgrun 'hud.rate = off'); case "$out" in *'5h'*) bad "config tolerates spaces";; *) ok "config tolerates spaces";; esac
out=$(cfgrun 'hud.cost=off' 'garbage line' 'hud.fish=maybe'); case "$out" in *'🐡'*) ok "unknown values ignored";; *) bad "unknown values ignored";; esac
printf 'fleet=off\n' > "$TS/.puffr/config"
out=$(echo '{"tasks":[{"id":"t1","name":"f","status":"running"}]}' | HOME=$TS ./subagent-statusline.sh); [ -z "$out" ] && ok "fleet=off yields default rows" || bad "fleet=off yields default rows"
printf 'banner=off\n' > "$TS/.puffr/config"
out=$(HOME=$TS ./hooks/banner.sh); [ -z "$out" ] && ok "banner=off silent" || bad "banner=off silent"
printf 'watch=off\n' > "$TS/.puffr/config"
out=$(HOME=$TS PUFFR_WATCH_ONCE=1 ./bin/puffr-watch); [ -z "$out" ] && ok "watch=off silent" || bad "watch=off silent"
rm -f "$TS/.puffr/config"
HOME=$TS node bin/puffr-config off hud.cost fleet >/dev/null
chk "puffr-config writes key=off" "$(grep -cE '^[a-z.]+=off$' "$TS/.puffr/config")" "2"
chk "puffr-config file is private" "$(stat -c %a "$TS/.puffr/config" 2>/dev/null || stat -f %Lp "$TS/.puffr/config")" "600"
HOME=$TS node bin/puffr-config on hud.cost >/dev/null
chk "puffr-config on removes key" "$(HOME=$TS node bin/puffr-config --json | jq -r '[.["hud.cost"], .fleet] | map(tostring) | join(" ")')" "true false"
HOME=$TS node bin/puffr-config off nope >/dev/null 2>&1; chk "unknown feature rejected" "$?" "2"
HOME=$TS node bin/puffr-config reset >/dev/null
chk "reset turns all on" "$(HOME=$TS node bin/puffr-config --json | jq '[.[]] | all')" "true"

echo "— layouts —"
mkdir -p "$TS/.puffr/layouts"
lay() { echo "$SJ" | HOME=$TS XDG_CACHE_HOME=$TS/cache "$@" ./statusline.sh | strip_ansi; }
out=$(cfgrun); case "$out" in *'5-hour limit'*) bad "compact by default";; *) ok "compact by default";; esac
out=$(cfgrun 'layout=detailed')
for want in '5-hour limit 60% used' 'resets in' 'cost         $1.50 this session'; do
  case "$out" in *"$want"*) ok "detailed shows '$want'";; *) bad "detailed shows '$want' (got: $out)";; esac; done
case "$out" in *'⏰'*) bad "detailed drops compact gauges";; *) ok "detailed drops compact gauges";; esac
out=$(cfgrun 'layout=detailed' 'hud.cost=off'); case "$out" in *'this session'*) bad "layouts honor hud.cost=off";; *) ok "layouts honor hud.cost=off";; esac
out=$(cfgrun 'layout=detailed' 'hud.reset=off'); case "$out" in *'resets in'*) bad "layouts honor hud.reset=off";; *) ok "layouts honor hud.reset=off";; esac
case "$(cfgrun 'layout=detailed')" in *'weekly limit'*) bad "line with no data is skipped";; *) ok "line with no data is skipped";; esac
out=$(printf 'layout=detailed\n' > "$TS/.puffr/config"; lay env PUFFR_LAYOUT=compact)
case "$out" in *'5-hour limit'*) bad "PUFFR_LAYOUT overrides config";; *) ok "PUFFR_LAYOUT overrides config";; esac
out=$(cfgrun 'layout=all'); case "$out" in *'version'*'session'*'code changes'*) bad "all skips empty lines";; *'session'*) ok "all layout renders";; *) bad "all layout renders (got: $out)";; esac
# Gauge lines only (no emoji), counted in characters rather than bytes.
w=$(printf 'layout=detailed\n' > "$TS/.puffr/config"; lay env COLUMNS=50 | sed '1d;$d' |
  { m=0; while IFS= read -r l; do [ ${#l} -gt $m ] && m=${#l}; done; echo $m; })
[ "$w" -le 46 ] && ok "detailed fits 50 columns" || bad "detailed fits 50 columns (widest $w)"
# A user layout: labels, separators that vanish with an empty widget, quoted text, typos.
cat > "$TS/.puffr/layouts/mine.yaml" <<'EOF'
# mine
lines:
  - [model, "::", cost]       # inline comment
  - spend: [cost, ·, git, |, 5h]
  - [nosuch]
EOF
out=$(cfgrun 'layout=mine')
case "$out" in *'Claude :: $1.50'*) ok "quoted literal between widgets";; *) bad "quoted literal between widgets (got: $out)";; esac
case "$out" in *'spend $1.50 | 5h 60%'*) ok "separator before an empty widget is held for the next";; *) bad "separator before an empty widget is held for the next (got: $out)";; esac
case "$out" in *'?nosuch'*) ok "unknown widget shows as ?name";; *) bad "unknown widget shows as ?name";; esac
printf '%s\n' 'lines:' '  - [model]' > "$TS/.puffr/layouts/compact.yaml"
out=$(cfgrun); case "$out" in *'5h'*) bad "user layout overrides a built-in";; *Claude*) ok "user layout overrides a built-in";; esac
rm -f "$TS/.puffr/layouts/compact.yaml"
out=$(cfgrun 'layout=nope'); case "$out" in *"layout 'nope' not found"*'5h 60%'*|*'5h 60%'*"layout 'nope' not found"*) ok "missing layout falls back to compact with a note";; *) bad "missing layout falls back (got: $out)";; esac
out=$(cfgrun 'layout=../../etc/passwd'); case "$out" in *'5h 60%'*) ok "layout name can't escape the layouts dir";; *) bad "layout name can't escape the layouts dir";; esac
out=$(echo "$SJ" | HOME=$TS XDG_CACHE_HOME=$TS/cache bash -c 'cp statusline.sh "$HOME/sl.sh"; printf "layout=detailed\n" > "$HOME/.puffr/config"; bash "$HOME/sl.sh"' | strip_ansi)
case "$out" in *'5h 60%'*) ok "no layouts folder still renders compact";; *) bad "no layouts folder still renders compact (got: $out)";; esac
rm -f "$TS/.puffr/config"
HOME=$TS node bin/puffr-config layout detailed >/dev/null
chk "puffr-config layout writes layout=" "$(grep -c '^layout=detailed$' "$TS/.puffr/config")" "1"
HOME=$TS node bin/puffr-config off hud.cost >/dev/null
chk "feature switches keep the layout" "$(grep -c '^layout=detailed$' "$TS/.puffr/config")" "1"
HOME=$TS node bin/puffr-config layout nope >/dev/null 2>&1; chk "unknown layout refused" "$?" "2"
HOME=$TS node bin/puffr-config layout new ../x >/dev/null 2>&1; chk "bad new layout name refused" "$?" "2"
HOME=$TS node bin/puffr-config layout new copy >/dev/null
chk "layout new copies the active one" "$(grep -c '5-hour limit' "$TS/.puffr/layouts/copy.yaml")" "1"
HOME=$TS node bin/puffr-config layout new copy >/dev/null 2>&1; chk "layout new never overwrites" "$?" "2"
HOME=$TS node bin/puffr-config layout compact >/dev/null
chk "compact (the default) writes no layout line" "$(grep -c '^layout=' "$TS/.puffr/config")" "0"
HOME=$TS node bin/puffr-config reset >/dev/null
rm -rf "$TS"

echo "— hardening (review fixes) —"
TX=$(mktemp -d)
hasctl() { LC_ALL=C grep -q $'\x1b\\|\r\\|\xc2[\x80-\x9f]'; }
out=$(python3 -c 'import json;print(json.dumps({"model":{"display_name":"Op\u009b2J\u009d0;T\u009c"},"effort":{"level":"hi\rFAKE"},"output_style":{"name":"\u001b]0;x\u0007"},"workspace":{"current_dir":"/tmp/d\u009bx\ry"}}))' | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh | LC_ALL=C sed $'s/\033\\[[0-9;]*m//g')
echo "$out" | hasctl && bad "HUD strips C1 + CR from stdin fields" || ok "HUD strips C1 + CR from stdin fields"
# Injected CR/LF must not add lines: compact is always exactly three.
chk "injected CR/LF adds no HUD lines" "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" "3"
printf '%s' '{"oauthAccount":{"emailAddress":"a\u009b31m\u009d0;pwn\u009c\rEVIL@x.com"}}' > "$TX/.claude.json"
out=$(echo '{"workspace":{"current_dir":"/tmp"}}' | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh | LC_ALL=C sed $'s/\033\\[[0-9;]*m//g')
echo "$out" | hasctl && bad "HUD strips C1 from account email" || ok "HUD strips C1 from account email"
G="$TX/repo"; mkdir -p "$G"; git -C "$G" init -q 2>/dev/null; git -C "$G" checkout -q -b "$(printf 'main\xc2\x9d0;OWNED\xc2\x9c')" 2>/dev/null
echo "{\"workspace\":{\"current_dir\":\"$G\"}}" | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh >/dev/null; sleep 1
out=$(echo "{\"workspace\":{\"current_dir\":\"$G\"}}" | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh | head -1 | LC_ALL=C sed $'s/\033\\[[0-9;]*m//g')
case "$out" in *main*) echo "$out" | hasctl && bad "C1 stripped from git branch" || ok "C1 stripped from git branch";; *) ok "C1 stripped from git branch (git refused name)";; esac
NOW=$(date +%s)
out=$(jq -nc '{workspace:{current_dir:"/tmp"},rate_limits:{five_hour:{used_percentage:62.5}}}' | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh | sed -n 2p | strip_ansi)
echo "$out" | grep -q '5h 63%' && ok "percentages rounded" || bad "percentages rounded (got: $out)"
off=$(date -u -r $((NOW + 7200 - 5*3600)) +%Y-%m-%dT%H:%M:%S.5-05:00 2>/dev/null || date -u -d @$((NOW + 7200 - 5*3600)) +%Y-%m-%dT%H:%M:%S.5-05:00)
out=$(jq -nc --arg r "$off" '{workspace:{current_dir:"/tmp"},rate_limits:{five_hour:{used_percentage:10,resets_at:$r}}}' | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh | sed -n 2p | strip_ansi)
echo "$out" | grep -qE '⏰(1h59m|2h00m)' && ok "non-UTC ISO offset parsed" || bad "non-UTC ISO offset parsed (got: $out)"
out=$(jq -nc --arg r "$((NOW + 1800))" '{workspace:{current_dir:"/tmp"},rate_limits:{five_hour:{used_percentage:10,resets_at:$r}}}' | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh | sed -n 2p | strip_ansi)
echo "$out" | grep -qE '⏰(29|30)m' && ok "epoch-as-string parsed" || bad "epoch-as-string parsed (got: $out)"
out=$(jq -nc --argjson r $((NOW + 17000)) '{workspace:{current_dir:"/tmp"},rate_limits:{five_hour:{used_percentage:99,resets_at:$r}}}' | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh | sed -n 2p | strip_ansi)
echo "$out" | grep -q '→' && bad "no projection before 10% (99% used)" || ok "no projection before 10% (99% used)"
out=$(jq -nc --argjson r $((NOW + 16000)) '{workspace:{current_dir:"/tmp"},rate_limits:{five_hour:{used_percentage:99,resets_at:$r}}}' | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh | sed -n 2p | strip_ansi)
echo "$out" | grep -qE '→(88[0-9]|89[0-9])%' && ok "steep pace projects past 100%" || bad "steep pace projects past 100% (got: $out)"
out=$(jq -nc --argjson r $((NOW + 4*86400)) '{workspace:{current_dir:"/tmp"},rate_limits:{seven_day:{used_percentage:30,resets_at:$r}}}' | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh | sed -n 2p | strip_ansi)
echo "$out" | grep -qE '7d 30% ⏰(3d23h|4d0h) →(69|70)%' && ok "7d projection uses 7d window" || bad "7d projection uses 7d window (got: $out)"
printf '{"type":"user","message":{"content":"hi"}}\n' > "$TX/u.jsonl"
out=$(jq -nc --arg t "$TX/u.jsonl" '{session_id:"x-1",workspace:{current_dir:"/tmp"},transcript_path:$t}' | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh 2>&1 | sed -n 2p | strip_ansi)
case "$out" in *cache*) bad "no assistant lines → no cache gauge (got: $out)";; *) ok "no assistant lines → no cache gauge";; esac
ts=$(date -u -r $((NOW - 60)) +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d @$((NOW - 60)) +%Y-%m-%dT%H:%M:%S.000Z)
python3 - "$TX/big.jsonl" "$ts" <<'PY'
import json, sys
with open(sys.argv[1], "w") as f:
    pad = json.dumps({"type": "assistant", "message": {"model": "x", "usage": {"input_tokens": 1}, "content": [{"type": "text", "text": "y" * 300000}]}})
    f.write(pad + "\n")
    f.write(json.dumps({"type": "assistant", "timestamp": sys.argv[2], "message": {"model": "x", "usage": {"input_tokens": 1, "cache_creation_input_tokens": 5, "cache_creation": {"ephemeral_5m_input_tokens": 5}}}}) + "\n")
PY
out=$(jq -nc --arg t "$TX/big.jsonl" '{session_id:"x-2",workspace:{current_dir:"/tmp"},transcript_path:$t}' | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh | sed -n 2p | strip_ansi)
echo "$out" | grep -qE 'cache [34]m' && ok "truncated first tail line skipped" || bad "truncated first tail line skipped (got: $out)"
printf '%s' '{"oauthAccount":{"emailAddress":"sym@example.com"}}' > "$TX/.claude.json"
mkdir -p "$TX/c/puffr"; k=$(printf '%s' 'sym@example.com' | cksum | cut -d' ' -f1)
echo keep > "$TX/victim"; ln -s "$TX/victim" "$TX/c/puffr/usage-$k"
jq -nc '{workspace:{current_dir:"/tmp"},rate_limits:{five_hour:{used_percentage:5}}}' | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh >/dev/null
chk "symlinked usage file not followed" "$(cat "$TX/victim")" "keep"
ln -s "$TX/victim" "$TX/c/puffr/win-x-3"
jq -nc '{session_id:"x-3",workspace:{current_dir:"/tmp"},context_window:{context_window_size:1000000}}' | HOME=$TX XDG_CACHE_HOME=$TX/c ./statusline.sh >/dev/null
chk "symlinked window file not followed" "$(cat "$TX/victim")" "keep"
out=$(echo '{"workspace":{"current_dir":"/tmp"}}' | HOME=$TX XDG_CACHE_HOME=$TX/c ANTHROPIC_API_KEY=sk-secret-1234 ./statusline.sh | head -1)
case "$out" in *'API key'*) case "$out" in *sk-secret*|*sym@*) bad "API key mode hides key and email";; *) ok "API key mode hides key and email";; esac;; *) bad "API key mode shown (got: $out)";; esac
# puffr-context: hostile transcript strings and string-typed numbers
mkdir -p "$TX/.claude/projects/-tmp-h"; HF="$TX/.claude/projects/-tmp-h/eeeeeeee-1111-2222-3333-444444444444.jsonl"
python3 - "$HF" <<'PY'
import json, sys
L = [{"type": "user", "cwd": "/tmp/\u001b]0;CWD\u0007", "message": {"content": "hi"}},
     {"type": "assistant", "timestamp": "2026-09-17T10:00:00Z", "message": {"id": "m1", "model": "\u001b]0;MODEL\u0007", "usage": {"input_tokens": "\u001b]0;USAGE\u0007", "cache_read_input_tokens": 5}}},
     {"type": "system", "subtype": "compact_boundary", "compactMetadata": {"trigger": "\u001b]0;TRIG\u0007", "preTokens": "\u001b]0;PRE\u0007"}}]
open(sys.argv[1], "w").write("".join(json.dumps(e) + "\n" for e in L))
PY
out=$(HOME=$TX node bin/puffr-context eeeeeeee-1111-2222-3333-444444444444 2>&1)
case "$out" in *$'\x1b]'*) bad "puffr-context strips transcript strings";; *) ok "puffr-context strips transcript strings";; esac
out=$(HOME=$TX node bin/puffr-sessions 2>&1); case "$out" in *$'\x1b]'*) bad "radar strips project path";; *) ok "radar strips project path";; esac
chk "radar cache is private" "$(stat -c %a "$TX/.puffr/sessions-cache.json" 2>/dev/null || stat -f %Lp "$TX/.puffr/sessions-cache.json")" "600"
chk "radar cache dir is private" "$(stat -c %a "$TX/.puffr" 2>/dev/null || stat -f %Lp "$TX/.puffr")" "700"
rm -rf "$TX"

echo "— accounts: discovery —"
TP=$(mktemp -d); mkdir -p "$TP/extra/one" "$TP/parent/two" "$TP/.aimux/profiles/work"
printf '{}' > "$TP/.claude.json"
for d in extra/one parent/two .aimux/profiles/work; do printf '{"oauthAccount":{"emailAddress":"%s@x.com"}}' "${d##*/}" > "$TP/$d/.claude.json"; done
J=$(HOME=$TP XDG_CACHE_HOME=$TP/c PUFFR_PROFILE_DIRS="$TP/extra/one:$TP/parent" node bin/puffr-accounts --json)
chk "PUFFR_PROFILE_DIRS: dir and parent-of-dirs" "$(echo "$J" | jq -r '[.[].profile] | sort | join(",")')" "default,one,two,work"
J=$(HOME=$TP XDG_CACHE_HOME=$TP/c CLAUDE_CONFIG_DIR="$TP/.aimux/profiles/work" node bin/puffr-accounts --json)
chk "CLAUDE_CONFIG_DIR marks active profile" "$(echo "$J" | jq -r '[.[] | select(.active) | .profile] | join(",")')" "work"
mkdir -p "$TP/.aimux/profiles/$(printf 'w\033]0;DIR\007')"; printf '{}' > "$TP/.aimux/profiles/$(printf 'w\033]0;DIR\007')/.claude.json"
out=$(HOME=$TP XDG_CACHE_HOME=$TP/c CLAUDE_CONFIG_DIR="$TP/extra/one" node bin/puffr-accounts 2>&1)
case "$out" in *$'\x1b]'*) bad "accounts strips profile dir";; *) ok "accounts strips profile dir";; esac
rm -rf "$TP"

echo "— responsive layout —"
TR=$(mktemp -d); NOW=$(date +%s)
printf '%s' '{"oauthAccount":{"emailAddress":"someone.long@example.com","organizationType":"claude_max"}}' > "$TR/.claude.json"
RJ=$(jq -nc --argjson r5 $((NOW+5400)) --argjson r7 $((NOW+3*86400)) --argjson pe $((NOW+3100)) '{model:{display_name:"Opus 5.5"},
  workspace:{current_dir:"/tmp"},context_window:{used_percentage:17},effort:{level:"high"},output_style:{name:"Explanatory"},cost:{total_cost_usd:4.12},
  rate_limits:{five_hour:{used_percentage:62,resets_at:$r5},seven_day:{used_percentage:41,resets_at:$r7}},prompt_cache:{expires_at:$pe,ttl:"1h"}}')
hudw() { echo "$RJ" | HOME=$TR XDG_CACHE_HOME=$TR/c COLUMNS=$1 ./statusline.sh | strip_ansi; }
cols() { python3 -c 'import sys,unicodedata
print(max(sum(0 if c=="️" else (2 if unicodedata.east_asian_width(c) in "WF" else 1) for c in l.rstrip("\n")) for l in sys.stdin))'; }
fit=1; for w in 30 40 50 60 70 80 100; do m=$(hudw $w | cols); [ "$m" -le $((w - 4)) ] || { fit=0; bad "fits COLUMNS=$w (widest line $m)"; }; done
[ "$fit" = 1 ] && ok "every line fits its width (30–100 cols)"
out=$(echo "$RJ" | HOME=$TR XDG_CACHE_HOME=$TR/c ./statusline.sh | strip_ansi)
case "$out" in *'Explanatory'*'(max)'*'→'*'$4.12'*) ok "no COLUMNS: nothing dropped";; *) bad "no COLUMNS: nothing dropped (got: $out)";; esac
out=$(hudw 60); case "$out" in *'→'*) bad "pace drops before meters (60 cols)";; *'5h 62%'*'7d 41%'*) ok "pace drops before meters (60 cols)";; *) bad "meters kept at 60 cols (got: $out)";; esac
out=$(hudw 30); case "$out" in *'5h 62%'*) ok "5h meter survives 30 cols";; *) bad "5h meter survives 30 cols (got: $out)";; esac
orphan=""; for w in 40 45 50 55; do out=$(hudw $w | head -1); case "$out" in *'(max)'*) case "$out" in *'👤'*) ;; *) orphan="$orphan $w";; esac;; esac; done
[ -z "$orphan" ] && ok "plan never shown without account" || bad "plan shown without account at:$orphan"
orphan=""; for w in 40 50 60; do out=$(hudw $w | sed -n 2p); case "$out" in *'⏰'*) case "$out" in *'5h 62% ⏰'*|*'7d 41% ⏰'*) ;; *) orphan="$orphan $w";; esac;; esac; done
[ -z "$orphan" ] && ok "reset never orphaned from its meter" || bad "reset orphaned at:$orphan"
out=$(PUFFR_HUD_WIDTH=40 bash -c 'echo "$0" | HOME='"$TR"' XDG_CACHE_HOME='"$TR"'/c COLUMNS=200 ./statusline.sh' "$RJ" | strip_ansi | cols)
[ "$out" -le 36 ] && ok "PUFFR_HUD_WIDTH overrides COLUMNS" || bad "PUFFR_HUD_WIDTH overrides COLUMNS (widest $out)"
out=$(hudw 170 | sed -n 2p); echo "$out" | grep -qE 'cache 5[01]m' && ok "cache countdown from prompt_cache.expires_at" || bad "cache countdown from prompt_cache.expires_at (got: $out)"
out=$(jq -nc --argjson pe $((NOW-5)) '{workspace:{current_dir:"/tmp"},prompt_cache:{expires_at:$pe,ttl:"5m"}}' | HOME=$TR XDG_CACHE_HOME=$TR/c ./statusline.sh | sed -n 2p | strip_ansi)
echo "$out" | grep -q 'cache cold' && ok "expired prompt_cache shows cold" || bad "expired prompt_cache shows cold (got: $out)"
rm -rf "$TR"

echo "— hud install / launcher —"
TH=$(mktemp -d); mkdir -p "$TH/.claude"
hudcli() { HOME=$TH CLAUDE_CONFIG_DIR= node bin/puffr-hud "$@"; }
printf '%s' '{"permissions":{"allow":["Bash(ls)"]},"model":"opus"}' > "$TH/.claude/settings.json"
hudcli install >/dev/null
chk "install points settings at launcher" "$(jq -r .statusLine.command "$TH/.claude/settings.json")" "$TH/.puffr/bin/statusline"
chk "install keeps other keys" "$(jq -c '[.permissions.allow[0], .model]' "$TH/.claude/settings.json")" '["Bash(ls)","opus"]'
ls "$TH/.claude/"settings.json.bak.* >/dev/null 2>&1 && ok "install backs up settings" || bad "install backs up settings"
[ -x "$TH/.puffr/bin/statusline" ] && ok "launcher executable" || bad "launcher executable"
chk "root seeded to this copy" "$(cat "$TH/.puffr/root")" "$PWD"
out=$(echo '{"workspace":{"current_dir":"/tmp"}}' | HOME=$TH XDG_CACHE_HOME=$TH/c "$TH/.puffr/bin/statusline" | strip_ansi | tail -1)
case "$out" in *'📁 /tmp'*) ok "launcher renders the HUD";; *) bad "launcher renders the HUD (got: $out)";; esac
hudcli status >/dev/null; chk "status healthy → exit 0" "$?" "0"
# a plugin update moves the copy: the next session records it, the launcher follows
NEW="$TH/newcopy"; mkdir -p "$NEW"; printf '#!/bin/bash\ncat >/dev/null; echo NEWCOPY\n' > "$NEW/statusline.sh"
HOME=$TH CLAUDE_PLUGIN_ROOT=$NEW ./hooks/banner.sh >/dev/null
chk "session start records loaded copy" "$(cat "$TH/.puffr/root")" "$NEW"
chk "launcher follows the recorded copy" "$(echo '{}' | HOME=$TH "$TH/.puffr/bin/statusline")" "NEWCOPY"
mkdir -p "$TH/.puffr"; touch "$TH/.puffr/disabled"; NEW2="$TH/newer"; mkdir -p "$NEW2"; cp "$NEW/statusline.sh" "$NEW2/"
HOME=$TH CLAUDE_PLUGIN_ROOT=$NEW2 ./hooks/banner.sh >/dev/null; rm -f "$TH/.puffr/disabled"
chk "copy recorded even while muted" "$(cat "$TH/.puffr/root")" "$NEW2"
rm -rf "$NEW2"
chk "launcher falls back when recorded copy is gone" "$(echo '{"workspace":{"current_dir":"/tmp"}}' | HOME=$TH XDG_CACHE_HOME=$TH/c "$TH/.puffr/bin/statusline" | strip_ansi | tail -1 | grep -c '📁 /tmp')" "1"
HOME=$TH CLAUDE_PLUGIN_ROOT="$TH/nope" ./hooks/banner.sh >/dev/null
chk "bogus plugin root not recorded" "$(cat "$TH/.puffr/root")" "$NEW2"
# migration from a fixed-path install; foreign statusLine is refused
jq --arg c "$PWD/statusline.sh" '.statusLine = {type:"command",command:$c,refreshInterval:10}' "$TH/.claude/settings.json" > "$TH/x" && mv "$TH/x" "$TH/.claude/settings.json"
hudcli status >/dev/null; chk "status flags fixed-path install → exit 1" "$?" "1"
hudcli repair >/dev/null
chk "repair migrates to launcher, keeps refresh" "$(jq -c '[.statusLine.command == "'"$TH"'/.puffr/bin/statusline", .statusLine.refreshInterval]' "$TH/.claude/settings.json")" "[true,10]"
jq '.statusLine = {type:"command",command:"~/my-own-line.sh"}' "$TH/.claude/settings.json" > "$TH/x" && mv "$TH/x" "$TH/.claude/settings.json"
hudcli install >/dev/null 2>&1; chk "install refuses foreign statusLine" "$?" "1"
hudcli remove >/dev/null; chk "remove leaves foreign statusLine" "$(jq -r .statusLine.command "$TH/.claude/settings.json")" "~/my-own-line.sh"
jq 'del(.statusLine)' "$TH/.claude/settings.json" > "$TH/x" && mv "$TH/x" "$TH/.claude/settings.json"
hudcli install >/dev/null; hudcli remove >/dev/null
chk "remove drops puffr's statusLine" "$(jq -r '.statusLine // "none"' "$TH/.claude/settings.json")" "none"
[ -e "$TH/.puffr/bin/statusline" ] && bad "remove deletes launcher" || ok "remove deletes launcher"
printf '{not json' > "$TH/.claude/settings.json"
hudcli install >/dev/null 2>&1; chk "invalid settings refused" "$?" "1"
chk "invalid settings untouched" "$(cat "$TH/.claude/settings.json")" "{not json"
printf '{}' > "$TH/real.json"; rm -f "$TH/.claude/settings.json"; ln -s "$TH/real.json" "$TH/.claude/settings.json"
hudcli install >/dev/null
[ -L "$TH/.claude/settings.json" ] && [ "$(jq -r '.statusLine.command | length > 0' "$TH/real.json")" = true ] && ok "symlinked settings edited at target" || bad "symlinked settings edited at target"
rm -rf "$TH"

echo "— autoname —"
TN="$SANDBOX/an"; mkdir -p "$TN/.puffr"
printf '#!/bin/sh\ncat >/dev/null; printf "Sure:\\n  acme bd reach!! pkg\\n"\n' > "$TN/stub"; chmod +x "$TN/stub"
SID=aaaaaaaa-1111-2222-3333-444444444444; TR_="$TN/t.jsonl"; : > "$TR_"
an() { jq -cn --arg p "$1" --arg s "${2:-$SID}" --arg t "$TR_" '{session_id:$s, transcript_path:$t, cwd:"/x/acme", prompt:$p}' \
  | HOME=$TN PUFFR_AUTONAME_CLAUDE=$TN/stub node bin/puffr-autoname hook; }
waitp() { for _ in $(seq 50); do [ -f "$TN/.puffr/autoname/$SID.pending" ] && return; sleep 0.1; done; }
chk "slash command not counted" "$(an /puffr:on)$(an one)$(an two)" ""
chk "no title before 3 prompts" "$(jq '.prompts|length' "$TN/.puffr/autoname/$SID.json")" "2"
an three >/dev/null; waitp
chk "worker normalizes name" "$(jq -r .title "$TN/.puffr/autoname/$SID.pending")" "ACME-BD-REACH-PKG"
chk "next prompt applies title" "$(an four | jq -r .hookSpecificOutput.sessionTitle)" "ACME-BD-REACH-PKG"
echo '{"type":"custom-title","customTitle":"ACME-BD-REACH-PKG"}' >> "$TR_"; an mid >/dev/null
chk "own title not mistaken for user's" "$(jq .done "$TN/.puffr/autoname/$SID.json")" "false"
echo '{"type":"custom-title","customTitle":"MINE"}' >> "$TR_"
an five >/dev/null
chk "user rename wins" "$(jq .done "$TN/.puffr/autoname/$SID.json")" "true"
chk "child process never names" "$(PUFFR_AUTONAME_CHILD=1 an x bbbbbbbb-1; ls "$TN/.puffr/autoname" | grep -c bbbbbbbb)" "0"
echo 'autoname=off' > "$TN/.puffr/config"; an x cccccccc-1 >/dev/null
chk "autoname=off respected" "$(ls "$TN/.puffr/autoname" | grep -c cccccccc)" "0"
chk "bad session id ignored" "$(an x '../../etc'; ls "$TN/.puffr" | grep -c etc)" "0"
rm -rf "$TN"


echo "— burn: usage, dedupe, cache breaks, compactions —"
TB=$(mktemp -d); mkdir -p "$TB/.claude/projects/-tmp-burn" "$TB/repo/.git"
D=$(date +%Y-%m-%d)
BF="$TB/.claude/projects/-tmp-burn/eeeeeeee-1111-2222-3333-444444444444.jsonl"
asst() { # id ts model input read w5 w1h out [tool]
  local tool=""; [ -n "${9:-}" ] && tool=",{\"type\":\"tool_use\",\"id\":\"t$1\",\"name\":\"$9\",\"input\":{\"command\":\"git commit -m x\"}}"
  printf '{"type":"assistant","timestamp":"%sT%s","message":{"id":"%s","model":"%s","usage":{"input_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":%s,"cache_creation":{"ephemeral_5m_input_tokens":%s,"ephemeral_1h_input_tokens":%s},"output_tokens":%s},"content":[{"type":"text","text":"x"}%s]}}\n' \
    "$D" "$2" "$1" "$3" "$4" "$5" $(( $6 + $7 )) "$6" "$7" "$8" "$tool"
}
{
  printf '{"type":"user","timestamp":"%sT01:00:00Z","cwd":"%s/repo","message":{"content":"<b>&lt;script&gt;alert(1)</b> first prompt padded past the two hundred byte size gate for the radar scanner, yes indeed"}}\n' "$D" "$TB"
  printf '{"type":"custom-title","customTitle":"<img src=x onerror=alert(1)>"}\n'
  asst m1 01:00:01Z claude-opus-5 10 0 0 100000 1000 Bash
  asst m1 01:00:02Z claude-opus-5 10 0 0 100000 3000
  asst m2 01:01:00Z claude-sonnet-5 10 100000 0 0 500 Edit
  asst m3 03:00:00Z claude-sonnet-5 10 0 0 100000 500
  printf '{"type":"system","subtype":"compact_boundary","timestamp":"%sT03:01:00Z","compactMetadata":{"trigger":"manual","preTokens":120000,"postTokens":20000}}\n' "$D"
  asst m4 03:02:00Z claude-sonnet-5 10 0 0 20000 500
  printf '{"type":"pr-link","prUrl":"https://example.com/pull/1","timestamp":"%sT03:03:00Z"}\n' "$D"
} > "$BF"
burn() { HOME=$TB node bin/puffr-burn "$@"; }
J=$(burn --json)
chk "streamed usage counted once (opus output 3000)" "$(echo "$J" | jq '.A.models["claude-opus-5"].u[4]')" "3000"
chk "requests deduped" "$(echo "$J" | jq '[.A.models[].u[5]] | add')" "4"
# opus: 10*5 + 100000*10 (1h write) + 3000*25 → $1.07505; sonnet: 30*2 + 100000*.2 + 120000*4 + 1500*10 → $0.51506
chk "cost at list price" "$(echo "$J" | jq '.A.usd * 100000 | round')" "159011"
chk "idle return detected as cache break" "$(echo "$J" | jq '.A.brk.idle.n')" "1"
chk "compaction break attributed" "$(echo "$J" | jq '.A.brk.compact.n')" "1"
chk "manual early compaction counted" "$(echo "$J" | jq '.A.comp[1]')" "1"
chk "compaction then work within 15m" "$(echo "$J" | jq '.A.comp[3]')" "1"
chk "commits + PRs counted" "$(echo "$J" | jq '[.A.commits, .A.prs] | join(" ")' -r)" "1 1"
chk "cost drivers sum to total" "$(echo "$J" | jq '(.A.drv.read + .A.drv.write + .A.drv.out + .A.drv.input - .A.usd) | fabs < 0.000001')" "true"
chk "prompts counted" "$(echo "$J" | jq '.A.prompts')" "1"
chk "fixed prefix = first request context" "$(burn --json | jq '.A.prefixTok / .A.mainReqs | round')" "100010"
chk "opus share of execution" "$(echo "$J" | jq '.A.exec.opus')" "1"
chk "project from git root" "$(echo "$J" | jq -r '.A.projects | keys[0]')" "repo"
burn --html "$TB/r.html" >/dev/null
grep -q '<img src=x\|<script>alert' "$TB/r.html" && bad "html escapes transcript text" || ok "html escapes transcript text"
grep -c 'src="data:image/png;base64,' "$TB/r.html" | grep -q '^1$' && grep -q 'class="flat" src="data:image/png' "$TB/r.html" && grep -q 'class="puff" src="data:image/png' "$TB/r.html" && ok "flat and puffed fish inline in the header" || bad "flat and puffed fish inline in the header"
grep -q 'rel="icon" href="data:image/png;base64,' "$TB/r.html" && ok "fish favicon embedded" || bad "fish favicon embedded"
grep -q 'PUFFR <em>\[ ' "$TB/r.html" && grep -q '<p class="tagline">Fu the Bloat. Cool the Burn.</p>' "$TB/r.html" && ok "heading PUFFR [range] with tagline" || bad "heading PUFFR [range] with tagline"
grep -qE '(src|href)="(https?:)?//' "$TB/r.html" && bad "report has no external URLs" || ok "report has no external URLs"
grep -q '<td class="n" data-v="[^"]*">Hermes' "$TB/r2.html" && bad "text cells are not numeric" || ok "text cells are not numeric"
HOME=$TB node bin/puffr-burn --html "$TB/r3.html" >/dev/null; grep -q '<th tabindex="0">Project</th>' "$TB/r3.html" && ok "text column headers left-aligned" || bad "text column headers left-aligned"
burn --since-change "$D" | grep -q 'Spend per day' && ok "before/after renders" || bad "before/after renders"
burn --since-change "$D" | grep -q 'BY AGENT' && ok "before/after carries the full report" || bad "before/after carries the full report"
burn --since-change "$D" --html "$TB/c.html" >/dev/null; grep -c 'class="panel"' "$TB/c.html" | grep -q 2 && ok "compare html has before and after panels" || bad "compare html has before and after panels"
grep -q '</script><img\|"t":"<img' "$TB/r.html" && bad "session data blob escapes markup" || ok "session data blob escapes markup"
chk "untagged title falls back to its start" "$(echo "$J" | jq -r '.A.list[0].tag')" "<IMG SRC=X ONERR"
chk "insights ranked by saving" "$(echo "$J" | jq '[.insights[].save] | . == (sort | reverse)')" "true"
chk "puffr cost footer present" "$(echo "$J" | jq '.puffr.skillTok > 100')" "true"
chk "git off unless asked" "$(echo "$J" | jq '.git')" "null"
chk "rates count from the first active day" "$(burn --since 2020-01-01 --json | jq '.A.days < 5')" "true"
burn --since-change nope >/dev/null 2>&1; chk "bad date rejected" "$?" "2"

echo "— burn: clock-time windows, exclude, hourly timeline —"
# Fixture timestamps are UTC: requests at 01:00, 01:01, 03:00, 03:02. Hour keys follow the
# indexer's time zone, so these runs pin TZ=UTC and re-index.
hw() { TZ=UTC HOME=$TB node bin/puffr-burn --reindex "$@"; }
chk "clock window keeps only its hours" "$(hw --since "$D 02:00" --until "$D 04:00" --json | jq '[.A.models[].u[5]] | add')" "2"
chk "window length in whole hours" "$(hw --since "$D 02:00" --until "$D 04:00" --json | jq '.A.hours')" "2"
chk "a partial last hour is included" "$(hw --since "$D 00:00" --until "$D 01:01" --json | jq '[.A.models[].u[5]] | add')" "2"
chk "timeline keeps empty hours" "$(hw --since "$D 00:00" --until "$D 06:00" --json | jq '.A.hourly | length')" "6"
chk "timeline adds up to the total" "$(hw --since "$D 00:00" --until "$D 06:00" --json | jq '([.A.hourly[].usd] | add) - .A.usd | fabs < 0.000001')" "true"
hw --since "$D 00:00" --until "$D 06:00" | grep -q 'BY HOUR' && ok "text shows BY HOUR for a clock window" || bad "text shows BY HOUR for a clock window"
hw --since "$D 00:00" --until "$D 06:00" --html "$TB/h.html" >/dev/null; grep -q '<h2>By hour' "$TB/h.html" && ok "html has the hour table" || bad "html has the hour table"
chk "--exclude drops a session by id prefix" "$(burn --exclude eeeeeeee --json | jq '.A.sessions')" "0"
hw --since "$D 05:00" --until "$D 04:00" >/dev/null 2>&1; chk "window that ends before it starts is rejected" "$?" "2"
TK=$(mktemp -d); mkdir -p "$TK/.claude/projects/-tmp-case" "$TK/Repo/.git"
if [ -d "$TK/REPO" ]; then   # case-insensitive disk, as on a default macOS volume
  for c in Repo repo; do
    printf '{"type":"user","timestamp":"%sT01:00:00Z","cwd":"%s/%s","message":{"content":"padding the first prompt past the two hundred byte size gate used by the radar scanner, padding padding padding"}}\n' "$D" "$TK" "$c" > "$TK/.claude/projects/-tmp-case/$c-0000-1111-2222-333333333333.jsonl"
    printf '{"type":"assistant","timestamp":"%sT01:00:01Z","message":{"id":"x%s","model":"claude-sonnet-5","usage":{"input_tokens":10,"output_tokens":10},"content":[]}}\n' "$D" "$c" >> "$TK/.claude/projects/-tmp-case/$c-0000-1111-2222-333333333333.jsonl"
  done
  chk "one folder in two letter cases is one project" "$(HOME=$TK node bin/puffr-burn --json | jq '.A.projects | keys | length')" "1"
else ok "case folding skipped (case-sensitive disk)"; fi
rm -rf "$TK"

echo "burn: UCEF tokens saved (estimated, vanity metric), no UCEF telemetry present (graceful degradation)"
grep -q 'UCEF_BASELINE_REWORK_FACTOR' bin/puffr-burn && ok "methodology baseline constant present in source" || bad "methodology baseline constant present in source"
grep -q 'Vanity metric, not a measured fact' bin/puffr-burn && ok "methodology note states this is modeled, not measured" || bad "methodology note states this is modeled, not measured"
chk "no ucef subagents in the fixture -> ucef field is null" "$(burn --json | jq '.ucef')" "null"
burn | grep -q 'UCEF TOKENS SAVED' && bad "UCEF section appears with no UCEF telemetry" || ok "UCEF section omitted with no UCEF telemetry"
burn --html "$TB/nou.html" >/dev/null
grep -q 'UCEF tokens saved' "$TB/nou.html" && bad "html UCEF section appears with no UCEF telemetry" || ok "html UCEF section omitted with no UCEF telemetry"
burn >/dev/null; chk "report still exits 0 with no UCEF telemetry" "$?" "0"

echo "— burn: accounts —"
TA=$(mktemp -d); P="$TA/.claude/projects/-tmp-acct"
mkdir -p "$P/aaaaaaaa-0000-0000-0000-000000000001/subagents" "$TA/.aimux/profiles/work"
printf '{"oauthAccount":{"emailAddress":"me@home.test","organizationUuid":"org-home","organizationType":"claude_max","organizationRateLimitTier":"default_claude_max_20x","organizationName":"me@home.test'"'"'s Organization"}}' > "$TA/.claude.json"
printf '{"oauthAccount":{"emailAddress":"me@work.test","organizationUuid":"org-work","organizationType":"claude_enterprise","organizationName":"Work Inc"},"projects":{"/tmp/w":{"lastSessionId":"aaaaaaaa-0000-0000-0000-000000000002"}}}' > "$TA/.aimux/profiles/work/.claude.json"
up() { printf '{"type":"user","timestamp":"%sT01:00:00Z","cwd":"/tmp/acct","message":{"content":"a prompt long enough to clear the two hundred byte size gate of the radar scanner, padded out with words"}}\n' "$D"; }
org() { printf '{"type":"attachment","timestamp":"%sT01:00:00Z","attachment":{"type":"credential_org","organizationUuid":"%s"}}\n' "$D" "$1"; }
{ up; org org-home; asst a1 01:00:01Z claude-opus-5 1000000 0 0 0 0; org org-work; asst a2 01:00:02Z claude-sonnet-5 1000000 0 0 0 0; } > "$P/aaaaaaaa-0000-0000-0000-000000000001.jsonl"
asst s1 01:00:03Z claude-haiku-4-5 1000000 0 0 0 0 > "$P/aaaaaaaa-0000-0000-0000-000000000001/subagents/agent-x.jsonl"
{ up; asst b1 01:00:01Z claude-sonnet-5 1000000 0 0 0 0; } > "$P/aaaaaaaa-0000-0000-0000-000000000002.jsonl"
{ up; asst c1 01:00:01Z claude-haiku-4-5 1000000 0 0 0 0; } > "$P/aaaaaaaa-0000-0000-0000-000000000003.jsonl"
AJ=$(HOME=$TA node bin/puffr-burn --json)
acct() { echo "$AJ" | jq --arg n "$1" '.A.accounts[$n].usd // 0 | round'; }
chk "account switch mid-session splits spend" "$(acct 'me@home.test (Max 20x)')" "5"
chk "subagent inherits account; profile fallback" "$(acct 'me@work.test (Enterprise, Work Inc)')" "5"
chk "no record → unknown" "$(acct 'unknown (before Claude Code recorded the account)')" "1"
chk "--account keeps sessions by majority spend" "$(HOME=$TA node bin/puffr-burn --account work --json | jq '.A.sessions')" "1"
rm -rf "$TA"

echo "— burn: agents and work types —"
TW=$(mktemp -d); WP="$TW/.claude/projects/-w"; WS="$WP/cccccccc-0000-0000-0000-000000000001"; mkdir -p "$WS/subagents"
tl() { printf '{"type":"assistant","timestamp":"%sT01:00:0%sZ","message":{"id":"%s","model":"claude-sonnet-5","usage":{"input_tokens":1000000,"output_tokens":0},"content":[%s]}}\n' "$D" "$2" "$1" "$3"; }
{
  printf '{"type":"user","timestamp":"%sT01:00:00Z","cwd":"/tmp/w","message":{"content":"a prompt long enough to clear the two hundred byte size gate of the radar scanner, padded with words"}}\n' "$D"
  tl w1 1 '{"type":"text","text":"thinking out loud"}'
  tl w1 2 '{"type":"tool_use","id":"a","name":"Edit","input":{"file_path":"/tmp/w/README.md"}}'
  tl w2 3 '{"type":"tool_use","id":"b","name":"Edit","input":{"file_path":"/tmp/w/app.js"}}'
  tl w3 4 '{"type":"tool_use","id":"c","name":"Bash","input":{"command":"ls"}}'
  tl w4 5 '{"type":"text","text":"done"}'
} > "$WS.jsonl"
tl s1 6 '{"type":"text","text":"x"}' > "$WS/subagents/agent-1.jsonl"
printf '{"agentType":"ucef-core:quality:qa-engineer"}' > "$WS/subagents/agent-1.meta.json"
WJ=$(HOME=$TW node bin/puffr-burn --json)
chk "response reclassed when a later line edits docs" "$(echo "$WJ" | jq '[.A.work.docs.reqs, .A.work.code.reqs, .A.work.shell.reqs, .A.work.talk.reqs] | join(" ")' -r)" "1 1 1 2"
chk "work types sum to total" "$(echo "$WJ" | jq '([.A.work[].usd] | add) - .A.usd | fabs < 0.000001')" "true"
chk "subagent cost by agent type" "$(echo "$WJ" | jq '[.A.agents["ucef-core:quality:qa-engineer"].usd, .A.agents["ucef-core:quality:qa-engineer"].runs] | join(" ")' -r)" "2 1"
chk "main thread is your turns" "$(echo "$WJ" | jq '.A.agents[""].usd')" "8"

echo "burn: UCEF tokens saved (estimated, vanity metric), present when a ucef-* subagent ran"
chk "ucef-* subagent presence -> savings estimated" "$(echo "$WJ" | jq '(.ucef.reqs == 1) and (.ucef.savedTok > 0) and (.ucef.savedUsd > 0)')" "true"
UWT=$(HOME=$TW node bin/puffr-burn)
echo "$UWT" | grep -q 'UCEF TOKENS SAVED' && ok "text report shows the UCEF section when a ucef subagent ran" || bad "text report shows the UCEF section when a ucef subagent ran"
echo "$UWT" | grep -qi 'estimated' && ok "UCEF figure carries the estimated qualifier" || bad "UCEF figure carries the estimated qualifier"
HOME=$TW node bin/puffr-burn --html "$TW/u.html" >/dev/null
grep -q 'UCEF tokens saved' "$TW/u.html" && grep -qi 'estimated' "$TW/u.html" && ok "html report shows the UCEF section when a ucef subagent ran" || bad "html report shows the UCEF section when a ucef subagent ran"
rm -rf "$TW"

echo "— codex —"
TC=$(mktemp -d); CX="$TC/.codex/sessions/2026/10/01"; mkdir -p "$CX" "$TC/.claude/projects"
cxl() { printf '%s\n' "$1" >> "$2"; }
P1="$CX/rollout-2026-10-01T10-00-00-11111111-2222-3333-4444-555555555555.jsonl"
cxl '{"timestamp":"'$D'T10:00:00Z","type":"session_meta","payload":{"id":"11111111-2222-3333-4444-555555555555","cwd":"/tmp/cxproj","originator":"codex-tui"}}' "$P1"
cxl '{"timestamp":"'$D'T10:00:01Z","type":"turn_context","payload":{"model":"gpt-test-codex","cwd":"/tmp/cxproj"}}' "$P1"
cxl '{"timestamp":"'$D'T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md injected block, not a prompt"}]}}' "$P1"
cxl '{"timestamp":"'$D'T10:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix the login bug please"}]}}' "$P1"
cxl '{"timestamp":"'$D'T10:00:02Z","type":"event_msg","payload":{"type":"task_started"}}' "$P1"
cxl '{"timestamp":"'$D'T10:00:03Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch\n*** Update File: src/app.js\n"}}' "$P1"
cxl '{"timestamp":"'$D'T10:00:04Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50}}}}' "$P1"
cxl '{"timestamp":"'$D'T10:00:05Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50}}}}' "$P1"
cxl '{"timestamp":"'$D'T10:00:06Z","type":"response_item","payload":{"type":"function_call","name":"exec","arguments":"{\"cmd\":\"git commit -m x\"}"}}' "$P1"
cxl '{"timestamp":"'$D'T10:00:07Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3000,"cached_input_tokens":2400,"output_tokens":80}}}}' "$P1"
cxl '{"timestamp":"'$D'T10:00:08Z","type":"compacted","payload":{"message":""}}' "$P1"
P2="$CX/rollout-2026-10-01T10-05-00-66666666-7777-8888-9999-000000000000.jsonl"
cxl '{"timestamp":"'$D'T10:05:00Z","type":"session_meta","payload":{"id":"66666666-7777-8888-9999-000000000000","cwd":"/tmp/cxproj","source":{"subagent":{"thread_spawn":{"parent_thread_id":"11111111-2222-3333-4444-555555555555","agent_role":"explorer"}}}}}' "$P2"
cxl '{"timestamp":"'$D'T10:05:01Z","type":"turn_context","payload":{"model":"gpt-test-codex"}}' "$P2"
cxl '{"timestamp":"'$D'T10:05:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":500,"cached_input_tokens":0,"output_tokens":10}}}}' "$P2"
printf '{"id":"11111111-2222-3333-4444-555555555555","thread_name":"Fix login bug"}\n' > "$TC/.codex/session_index.jsonl"
CJ=$(HOME=$TC node bin/puffr-burn --json)
chk "codex requests from token totals (repeat ignored)" "$(echo "$CJ" | jq '.A.models["gpt-test-codex"].u[5]')" "3"
chk "codex uncached / cached / output split" "$(echo "$CJ" | jq -c '.A.models["gpt-test-codex"].u[0:5]')" "[1100,2400,0,0,90]"
chk "codex work types from tool calls" "$(echo "$CJ" | jq -c '[.A.work.code.reqs, .A.work.shell.reqs, .A.work.talk.reqs]')" "[1,1,1]"
chk "codex subagent attached to its parent" "$(echo "$CJ" | jq '[.A.sessions, .A.agents["codex:explorer"].runs] | join(" ")' -r)" "1 1"
chk "codex prompts, commits, compaction" "$(echo "$CJ" | jq -c '[.A.prompts, .A.commits, .A.comp[0]]')" "[1,1,1]"
chk "codex unpriced without prices.json" "$(echo "$CJ" | jq '[.A.usd, (.A.unpriced | index("gpt-test-codex") != null)] | join(" ")' -r)" "0 true"
chk "codex account label" "$(echo "$CJ" | jq -r '.A.accounts | keys[0]')" "Codex (ChatGPT login)"
mkdir -p "$TC/.puffr"; printf '{"models":{"gpt-test":{"input":2,"cached":0.5,"output":8}}}' > "$TC/.puffr/prices.json"
# (600 + 500 uncached) × $2 + 2400 cached × $0.5 + 90 output × $8 = $0.004120
chk "prices.json prices codex by prefix" "$(HOME=$TC node bin/puffr-burn --json | jq '.A.usd * 1e6 | round')" "4120"
R=$(HOME=$TC node bin/puffr-sessions --tool codex --json)
chk "radar lists codex with its title and resume" "$(echo "$R" | jq -r '.[0] | [.title, .resume] | join(" | ")')" "Fix login bug | codex resume 11111111-2222-3333-4444-555555555555"
chk "radar --tool claude excludes codex" "$(HOME=$TC node bin/puffr-sessions --tool claude --json | jq length)" "0"
HOME=$TC node bin/puffr-sessions save 11111111 >/dev/null; rm "$P1"
HOME=$TC node bin/puffr-sessions restore 11111111 >/dev/null
[ -f "$P1" ] && ok "codex save and restore keep the rollout path" || bad "codex save and restore keep the rollout path"
rm -rf "$TC"

echo "— prices: Sonnet 5.5 and Opus 5.5 cache reads —"
# 1M cache-read tokens: Sonnet 5.5 and Opus 5.5 are 0.05× input; Sonnet 5 and Opus 5 keep their own rates.
chk "sonnet-5-5 / sonnet-5 / opus-5-5 / opus-5 cache-read price" "$(node -e "const F=require('./lib/puffr.js'); const c=m=>F.costOf(m,[0,1e6,0,0,0]).toFixed(2); console.log([c('claude-sonnet-5-5'),c('claude-sonnet-5'),c('claude-opus-5-5'),c('claude-opus-5')].join(' '))")" "0.10 0.20 0.20 0.50"
chk "dated sonnet-5-5 id takes the same row" "$(node -e "const F=require('./lib/puffr.js'); console.log(F.costOf('claude-sonnet-5-5-20261001',[0,1e6,0,0,0]).toFixed(2))")" "0.10"
chk "sonnet-5-5 input and output unchanged" "$(node -e "const F=require('./lib/puffr.js'); console.log(F.costOf('claude-sonnet-5-5',[1e6,0,0,0,1e6]))")" "12"

echo "— prices: Haiku 5.5 (lower tier) and puffr-context read rate —"
# Haiku 5.5 list prices up to 100k prompt tokens, $/MTok: input 0.10, 5m write 0.125, 1h write 0.20,
# cache read 0.01, output 0.50. 1M tokens of one kind each, so the cost reads as the rate.
hk() { node -e "const F=require('./lib/puffr.js'); const u=[0,0,0,0,0]; u[$1]=1e6; console.log(F.costOf('$2',u).toFixed(3))"; }
chk "haiku-5-5 input 0.10" "$(hk 0 claude-haiku-5-5)" "0.100"
chk "haiku-5-5 cache read 0.01" "$(hk 1 claude-haiku-5-5)" "0.010"
chk "haiku-5-5 5m write 0.125" "$(hk 2 claude-haiku-5-5)" "0.125"
chk "haiku-5-5 1h write 0.20" "$(hk 3 claude-haiku-5-5)" "0.200"
chk "haiku-5-5 output 0.50" "$(hk 4 claude-haiku-5-5)" "0.500"
chk "dated haiku-5-5 id takes the same row" "$(hk 0 claude-haiku-5-5-20261001)" "0.100"
chk "haiku-5-5 is a listed price" "$(node -e "const F=require('./lib/puffr.js'); console.log(F.price('claude-haiku-5-5').listed)")" "true"
chk "haiku-5-5 rewrite premium (5m 0.115, 1h 0.19)" "$(node -e "const F=require('./lib/puffr.js'); console.log(F.rewriteCost('claude-haiku-5-5',1e6,0).toFixed(3), F.rewriteCost('claude-haiku-5-5',0,1e6).toFixed(3))")" "0.115 0.190"
chk "haiku-4-5 input unchanged" "$(hk 0 claude-haiku-4-5)" "1.000"
chk "other haiku ids keep the estimated 1/5/0.1 fallback" "$(node -e "const F=require('./lib/puffr.js'); const p=F.price('claude-haiku-9'); console.log([p.i,p.o,p.r,p.listed].join(' '))")" "1 5 0.1 false"
# KNOWN LIMIT: a request whose prompt (input + cache read + both writes) is over 100k pays 5x on every
# rate. Day buckets keep no per-request prompt length, so costOf prices every Haiku 5.5 request at the
# lower tier; fixing it needs a state shape change and a cache version bump.
chk "haiku-5-5 LIMIT: 150k-token prompt priced at the lower tier (over-100k 5x not applied)" "$(node -e "const F=require('./lib/puffr.js'); console.log(F.costOf('claude-haiku-5-5',[150000,0,0,0,0]).toFixed(4))")" "0.0150"

# puffr-context weights cache reads by the model that made each turn: Opus 5.5 and Sonnet 5.5 read at
# 0.05x input, Fable 5.1 at 0.025x, other priced models at 0.1x; an unpriced model keeps 0.1x and is named.
TD=$(mktemp -d); mkdir -p "$TD/.claude/projects/-tmp-rd" "$TD/cache"
cvd() { HOME=$TD XDG_CACHE_HOME=$TD/cache CLAUDE_CONFIG_DIR= CLAUDE_CODE_SESSION_ID= node bin/puffr-context "$@"; }
# rdt FILE ID MINUTE MODEL INPUT READ W5 W1H: one assistant turn (write total = W5 + W1H)
rdt() { printf '{"type":"assistant","timestamp":"2026-09-17T10:0%s:00Z","message":{"id":"%s","model":"%s","usage":{"input_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":%s,"output_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":%s,"ephemeral_1h_input_tokens":%s}},"content":[]}}\n' "$3" "$2" "$4" "$5" "$6" "$(($7 + $8))" "$7" "$8" >> "$1"; }
RD="$TD/.claude/projects/-tmp-rd"
ratio() { cvd "$1" --json | jq -r '.cache.costVsUncached * 10000 | round'; }
rdt "$RD/d0000001-0000-0000-0000-000000000001.jsonl" a1 1 claude-opus-5-5 0 1000000 0 0
rdt "$RD/d0000002-0000-0000-0000-000000000002.jsonl" b1 1 claude-sonnet-5-5 0 1000000 0 0
rdt "$RD/d0000003-0000-0000-0000-000000000003.jsonl" c1 1 claude-opus-5 0 1000000 0 0
rdt "$RD/d0000004-0000-0000-0000-000000000004.jsonl" d1 1 claude-fable-5-1 0 1000000 0 0
rdt "$RD/d0000005-0000-0000-0000-000000000005.jsonl" e1 1 claude-opus-5-5 0 1000000 0 0
rdt "$RD/d0000005-0000-0000-0000-000000000005.jsonl" e2 2 claude-opus-5 0 1000000 0 0
rdt "$RD/d0000006-0000-0000-0000-000000000006.jsonl" f1 1 gpt-test-unpriced 0 1000000 0 0
rdt "$RD/d0000007-0000-0000-0000-000000000007.jsonl" g1 1 claude-opus-5-5 1000000 1000000 1000000 1000000
chk "opus-5-5 reads at 0.05x" "$(ratio d0000001-0000-0000-0000-000000000001)" "500"
chk "sonnet-5-5 reads at 0.05x" "$(ratio d0000002-0000-0000-0000-000000000002)" "500"
chk "opus-5 (a 0.1x model) reads at 0.1x" "$(ratio d0000003-0000-0000-0000-000000000003)" "1000"
chk "fable-5-1 reads at 0.025x" "$(ratio d0000004-0000-0000-0000-000000000004)" "250"
chk "mixed session weights each turn by its own model (0.05x and 0.1x → 0.075)" "$(ratio d0000005-0000-0000-0000-000000000005)" "750"
chk "writes and uncached input keep 1.25x, 2x, 1x on opus-5-5" "$(ratio d0000007-0000-0000-0000-000000000007)" "10750"
chk "unpriced model keeps the 0.1x assumption" "$(ratio d0000006-0000-0000-0000-000000000006)" "1000"
chk "unpriced model is named in --json" "$(cvd d0000006-0000-0000-0000-000000000006 --json | jq -r '.cache.unpricedModels | join(",")')" "gpt-test-unpriced"
cvd d0000006-0000-0000-0000-000000000006 | grep -q 'assumed 0.1× for unpriced: gpt-test-unpriced' && ok "unpriced assumption stated in the report" || bad "unpriced assumption stated in the report"
chk "priced models list no unpriced entry" "$(cvd d0000005-0000-0000-0000-000000000005 --json | jq -r '.cache.unpricedModels | length')" "0"
cvd d0000005-0000-0000-0000-000000000005 | grep -q 'unpriced' && bad "no unpriced note when every model is priced" || ok "no unpriced note when every model is priced"
rm -rf "$TD"

echo "— swarm: roots, rewind dedupe, lanes, messages, phases, bill —"
TS=$(mktemp -d); R1="$TS/m1/.claude/projects/-p"; R2="$TS/m2/.claude/projects/-p"; mkdir -p "$R1" "$R2"
OP=claude-opus-5; SN=claude-sonnet-5
S1=11111111-0000-0000-0000-000000000001; S1B=11111111-0000-0000-0000-00000000000b; S2=11111111-0000-0000-0000-000000000002
S3=11111111-0000-0000-0000-000000000003; S4=11111111-0000-0000-0000-000000000004; S5=11111111-0000-0000-0000-000000000005
swa() { printf '{"type":"assistant","timestamp":"2026-10-20T%sZ","message":{"id":"%s","model":"%s","usage":{"input_tokens":%s,"output_tokens":0},"content":[]}}\n' "$2" "$1" "$3" "$4"; }
swu() { printf '{"type":"user","uuid":"%s","timestamp":"2026-10-20T%sZ","message":{"content":"%s"}}\n' "$1" "$2" "$3"; }
swt() { printf '{"type":"custom-title","customTitle":"%s"}\n' "$1"; }
swq() { printf '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-20T%sZ","content":"<cross-session-message from-name=\\"%s\\" to=\\"x\\">%s</cross-session-message>"}\n' "$1" "$2" "$3"; }
swpad() { printf '{"type":"user","isMeta":true,"timestamp":"2026-10-20T10:21:00Z","message":{"content":"%s"}}\n' "$(printf 'x%.0s' $(seq "$1"))"; }
# Laptop: the session (padded, so it is the fuller copy), its three subagents, a restart under a new title, a tiny session.
{ swt WORK-API; swu u1 10:01:00 "plan the api"; swa m1 10:05:00 $OP 1000000; swu u2 10:15:00 "next step"; swa m2 10:20:00 $OP 1000000
  swa m9 09:00:00 $OP 1000000; swa m10 14:00:00 $OP 1000000; swpad 1500; } > "$R1/$S1.jsonl"
mkdir -p "$R1/$S1/subagents"
{ swu sua 10:09:00 "check the thing"; swa sa1 10:10:00 $SN 1000000; swa sa2 10:40:00 $SN 1000000; } > "$R1/$S1/subagents/agent-a1.jsonl"
printf '{"agentType":"ucef-core:qa","description":"verify output"}' > "$R1/$S1/subagents/agent-a1.meta.json"
{ swu sub 10:19:00 "UCEF_ATOM: atom_id=x task_complexity=0.3"; swa sa3 10:20:00 $SN 1000000; } > "$R1/$S1/subagents/agent-a2.jsonl"
printf '{"agentType":"general-purpose"}' > "$R1/$S1/subagents/agent-a2.meta.json"
{ swu suc 10:24:00 "look around"; swa sa4 10:25:00 $SN 1000000; } > "$R1/$S1/subagents/agent-a3.jsonl"
printf '{"agentType":"Explore"}' > "$R1/$S1/subagents/agent-a3.meta.json"
{ swt WORK-API-restart; swu u3 11:00:00 "continue"; swa m3 11:00:00 $OP 1000000; } > "$R1/$S2.jsonl"
{ swt tiny; swa m8 10:00:00 claude-haiku-4-5 1000; } > "$R1/$S4.jsonl"
# Mini: a rewound copy of the first session (same message ids and prompt uuids, plus one new message), the receiver of two
# cross-session messages (one repeated in the copy), and a UI session.
{ swt WORK-API; swu u1 10:01:00 "plan the api"; swa m1 10:05:00 $OP 1000000; swu u2 10:15:00 "next step"; swa m2 10:20:00 $OP 1000000
  swa m5 10:50:00 $OP 1000000; swq 10:30:00 WORK-API "ok thanks"; } > "$R2/$S1B.jsonl"
{ swt ops-1; swa m6 11:30:00 $SN 1000000; swq 10:30:00 WORK-API "ok thanks"
  swq 11:10:00 WORK-API-restart "Please rebase the api branch onto main before the review starts and tell me when the deploy preview is up again"; swpad 3000; } > "$R2/$S3.jsonl"
{ swt WORK-UI; swu u5 12:31:00 "ui pass"; swa m7 12:30:00 $SN 1000000; } > "$R2/$S5.jsonl"
SWA=(--since 2026-10-20T10:00Z --until 2026-10-20T14:00Z --root "laptop=$TS/m1/.claude/projects" --root "mini=$TS/m2/.claude/projects")
PH=(--phase "A=2026-10-20T10:00Z..2026-10-20T12:00Z" --phase "B=2026-10-20T12:00Z..2026-10-20T14:00Z")
sw() { TZ=UTC node bin/puffr-swarm "${SWA[@]}" "$@"; }
WJ=$(sw --rename 'api=^WORK-API' "${PH[@]}" --json)
chk "two roots: spend per machine" "$(echo "$WJ" | jq -r '.machines | map({(.label): (.usd | round)}) | add | "\(.laptop) \(.mini)"')" "23 9"
chk "combined spend counts each message id once" "$(echo "$WJ" | jq '.totals.usd | round')" "32"
chk "sessions after the minimum-spend filter" "$(echo "$WJ" | jq '.totals.sessions')" "5"
chk "tiny session counted aside, not in lanes" "$(echo "$WJ" | jq -r '"\(.totals.smallSessions) \(.totals.allUsd | round)"')" "1 32"
chk "rewound copy: repeated messages removed" "$(echo "$WJ" | jq '.dedupe.messages')" "2"
chk "rewound copy: dollars removed" "$(echo "$WJ" | jq '.dedupe.usd | round')" "10"
chk "rewound copy: transcripts affected" "$(echo "$WJ" | jq '.dedupe.files')" "1"
chk "dedupe is credited to the machine holding the copy" "$(echo "$WJ" | jq -r '.machines | map(.dedupedMessages) | join(" ")')" "0 2"
chk "rename map merges restarted sessions into one lane" "$(echo "$WJ" | jq '.totals.lanes')" "3"
chk "merged lane carries all its sessions' spend" "$(echo "$WJ" | jq '.lanes[] | select(.name == "api") | .usd | round')" "28"
chk "default lanes: one per session title" "$(sw --json | jq '.totals.lanes')" "4"
chk "subagents counted per kind" "$(echo "$WJ" | jq -r '.orchestrated.byKind | "\(.typed) \(.prompted) \(.general) \(.other)"')" "1 1 0 1"
chk "orchestrated share of subagents" "$(echo "$WJ" | jq -r '"\(.orchestrated.subagents) of \(.totals.subagents)"')" "2 of 3"
chk "orchestrated agent pattern is configurable" "$(sw --orchestrated-agent '^zzz' --json | jq '.orchestrated.subagents')" "1"
chk "cross-session messages counted" "$(echo "$WJ" | jq '.messages.total')" "2"
chk "ack-only messages" "$(echo "$WJ" | jq '.messages.ackOnly')" "1"
chk "messages per sender follow the rename map" "$(echo "$WJ" | jq '.messages.senders[] | select(.name == "api") | .sent')" "2"
chk "a message repeated in a rewound copy counts once" "$(echo "$WJ" | jq '.dedupe.crossSessionMessages')" "1"
chk "peak: when, lanes, subagents" "$(echo "$WJ" | jq -r '.totals.peak | "\(.n) \(.lanes) \(.subs) \(.at / 1000 | todate)"')" "4 1 3 2026-10-20T10:15:00Z"
chk "lane-hours" "$(echo "$WJ" | jq '.totals.laneHours')" "1.75"
chk "subagent-hours" "$(echo "$WJ" | jq '.totals.subagentHours * 100 | round')" "53"
chk "your typed prompts, rewound copies not repeated" "$(echo "$WJ" | jq '.totals.prompts')" "4"
chk "typed-prompt hours" "$(echo "$WJ" | jq '.totals.promptHours')" "3"
chk "phase spend" "$(echo "$WJ" | jq -r '.phases | map(.usd | round) | join(" ")')" "30 2"
chk "phase subagents and orchestrated" "$(echo "$WJ" | jq -r '.phases[0] | "\(.subagents) \(.orchestrated)"')" "3 2"
chk "phase peak" "$(echo "$WJ" | jq '.phases[0].peak.n')" "4"
chk "phase prompts and prompt-hours" "$(echo "$WJ" | jq -r '.phases | map("\(.prompts)/\(.promptHours)") | join(" ")')" "3/2 1/1"
chk "no --bill: no reconciliation" "$(echo "$WJ" | jq '.reconcile')" "null"
sw | grep -q 'RECONCILE' && bad "text has no reconciliation without a bill" || ok "text has no reconciliation without a bill"
sw --exclude "$S2" --json | jq -e '.totals.excludedSessions == 1 and (.totals.sessions == 4)' >/dev/null && ok "--exclude drops a session by id prefix" || bad "--exclude drops a session by id prefix"
chk "window end is exclusive, start inclusive" "$(sw --since 2026-10-20T09:00Z --until 2026-10-20T10:00Z --json | jq '.totals.reqs')" "1"
BJ=$(sw --bill 40 --json)
chk "bill: transcripts explain pct" "$(echo "$BJ" | jq '.reconcile.rows[0].pct * 100 | round')" "80"
chk "bill: unexplained remainder" "$(echo "$BJ" | jq '.reconcile.rows[0].gap | round')" "8"
chk "bill: under-explained lists reasons" "$(echo "$BJ" | jq '.reconcile.rows[0] | (.status == "under") and (.reasons | length >= 4)')" "true"
chk "bill: close figure matches" "$(sw --bill 32 --json | jq -r '.reconcile.rows[0].status')" "match"
chk "bill: transcripts above the bill" "$(sw --bill 20 --json | jq -r '.reconcile.rows[0].status')" "over"
sw --bill 40 | grep -q 'transcripts explain \$32.00 of \$40.00 (80%)' && ok "text: transcripts explain \$X of \$Y (Z%)" || bad "text: transcripts explain \$X of \$Y (Z%)"
cat > "$TS/cfg.json" <<'EOF'
{"lanes":[{"name":"API","match":"^WORK-API","role":"backend"},{"name":"UI","match":"UI$"}],"bills":[{"month":"2026-10","usd":40},{"month":"2025-01","usd":999}]}
EOF
CJ=$(sw --config "$TS/cfg.json" --json)
chk "config lanes group by pattern, the rest go to (other)" "$(echo "$CJ" | jq -r '.lanes | map(.name) | sort | join(",")')" "(other),API,UI"
chk "config bill for the window's month" "$(echo "$CJ" | jq -r '.reconcile.rows | map("\(.billed)") | join(",")')" "40"
sw --lane '<b>x</b>=WORK-UI' --html "$TS/s.html" >/dev/null
grep -q '<svg class="chart"' "$TS/s.html" && grep -q 'Concurrency' "$TS/s.html" && grep -q 'prefers-color-scheme:dark' "$TS/s.html" && ok "html: chart, sections, light and dark theme" || bad "html: chart, sections, light and dark theme"
grep -q '<b>x</b>' "$TS/s.html" && bad "html escapes lane names" || ok "html escapes lane names"
grep -qE '(src|href)="(https?:)?//' "$TS/s.html" && bad "swarm report has no external URLs" || ok "swarm report has no external URLs"
sw --bill 40 --html "$TS/b.html" >/dev/null; grep -q 'Reconcile against the bill' "$TS/b.html" && ok "html: reconciliation section with --bill" || bad "html: reconciliation section with --bill"
grep -q 'Reconcile against the bill' "$TS/s.html" && bad "html: no reconciliation without --bill" || ok "html: no reconciliation without --bill"
chk "--anon relabels lanes" "$(sw --anon --json | jq -r '.lanes[0].name')" "lane-01"
sw --anon | grep -q 'WORK-' && bad "--anon keeps lane names out of the text" || ok "--anon keeps lane names out of the text"
sw --bill nope >/dev/null 2>&1; chk "bad --bill rejected" "$?" "2"
sw --lane 'x=[' >/dev/null 2>&1; chk "bad lane pattern rejected" "$?" "2"
sw --since 2026-02-31 >/dev/null 2>&1; chk "impossible date rejected" "$?" "2"
sw --since 2026-10-21 --until 2026-10-20 >/dev/null 2>&1; chk "window that ends before it starts rejected" "$?" "2"
sw --phase "X=2026-10-20T10:00Z..2026-10-20T12:00Z" --phase "Y=2026-10-20T11:00Z..2026-10-20T13:00Z" >/dev/null 2>&1; chk "overlapping phases rejected" "$?" "2"
echo '{"nope":1}' > "$TS/bad.json"; sw --config "$TS/bad.json" >/dev/null 2>&1; chk "unknown config key rejected" "$?" "2"
TZ=UTC node bin/puffr-swarm --root "$TS/missing" >/dev/null 2>&1; chk "missing root rejected" "$?" "2"
TZ=UTC node bin/puffr-swarm --frobnicate >/dev/null 2>&1; chk "unknown option rejected" "$?" "2"
# One root, no flags beyond the window: streamed repeats of one response count once, the same as puffr-burn.
TX=$(mktemp -d); mkdir -p "$TX/.claude/projects/-x"
{ printf '{"type":"user","timestamp":"2026-10-20T10:00:00Z","cwd":"/tmp/x","message":{"content":"first prompt padded past the two hundred byte size gate used by the scanner, padded padding padding padding padding padding padding padding"}}\n'
  swa r1 10:01:00 $OP 1000000; swa r1 10:01:01 $OP 1000000; swa r1 10:01:02 $OP 1000000; swa r2 10:02:00 $SN 1000000; } > "$TX/.claude/projects/-x/22222222-0000-0000-0000-000000000001.jsonl"
BU=$(HOME=$TX TZ=UTC node bin/puffr-burn --reindex --since 2026-10-20 --until 2026-10-20 --json | jq '.A.usd * 1000 | round')
SU=$(HOME=$TX TZ=UTC node bin/puffr-swarm --since 2026-10-20 --until 2026-10-20 --min-usd 0 --json | jq '.totals.usd * 1000 | round')
chk "swarm and burn agree: a streamed response counts once" "$SU" "$BU"
chk "default root is ~/.claude/projects" "$(HOME=$TX TZ=UTC node bin/puffr-swarm --since 2026-10-20 --until 2026-10-20 --min-usd 0 --json | jq -r '.sources | join(",")')" "this machine"
rm -rf "$TS" "$TX"

echo "— update —"
TU=$(mktemp -d); mkdir -p "$TU/.claude/plugins" "$TU/proj"
git init -q --bare "$TU/origin.git"; git -C "$TU/origin.git" symbolic-ref HEAD refs/heads/main; git clone -q "$TU/origin.git" "$TU/mp" 2>/dev/null
mkdir -p "$TU/mp/.claude-plugin"; printf '{"version":"1.0.0"}' > "$TU/mp/.claude-plugin/plugin.json"
git -C "$TU/mp" add -A; git -C "$TU/mp" -c user.email=t@t -c user.name=t commit -qm one; git -C "$TU/mp" push -q origin HEAD:main 2>/dev/null; git -C "$TU/mp" branch -q -M main
git clone -q "$TU/origin.git" "$TU/up" 2>/dev/null; printf '{"version":"1.1.0"}' > "$TU/up/.claude-plugin/plugin.json"
git -C "$TU/up" -c user.email=t@t -c user.name=t commit -qam two; git -C "$TU/up" push -q origin HEAD:main 2>/dev/null
printf '{"puffr-tools":{"source":{"source":"directory","path":"%s"}}}' "$TU/mp" > "$TU/.claude/plugins/known_marketplaces.json"
printf '{"plugins":{"puffr@puffr-tools":[{"scope":"user","version":"1.0.0"},{"scope":"project","version":"1.0.0","projectPath":"%s"}]}}' "$TU/proj" > "$TU/.claude/plugins/installed_plugins.json"
printf '#!/bin/sh\necho "$PWD $*" >> "%s/calls"\n' "$TU" > "$TU/claude"; chmod +x "$TU/claude"
upd() { HOME=$TU PUFFR_CLAUDE=$TU/claude node bin/puffr-update "$@"; }
upd --check >/dev/null
chk "--check changes nothing" "$(jq -r .version "$TU/mp/.claude-plugin/plugin.json") $( [ -f "$TU/calls" ] && echo called || echo none)" "1.0.0 none"
printf 'local edit' >> "$TU/mp/.claude-plugin/plugin.json"; upd >/dev/null 2>&1
chk "dirty clone never pulled" "$(git -C "$TU/mp" rev-list --count HEAD)" "1"
git -C "$TU/mp" checkout -q -- .; : > "$TU/calls"; upd >/dev/null 2>&1
chk "clean main fast-forwarded" "$(jq -r .version "$TU/mp/.claude-plugin/plugin.json")" "1.1.0"
chk "marketplace refreshed, each scope updated" "$(cut -d' ' -f2- "$TU/calls" | tr '\n' ';')" "plugin marketplace update puffr-tools;plugin update puffr@puffr-tools --scope user;plugin update puffr@puffr-tools --scope project;"
chk "project scope runs in its project" "$(grep -c "/proj plugin update puffr@puffr-tools --scope project" "$TU/calls")" "1"
rm -rf "$TU"

echo "— report customizations —"
TR=$(mktemp -d); RP="$TR/.claude/projects/-r"; mkdir -p "$RP" "$TR/.puffr" "$TR/w/abunai" "$TR/w/scratch"
rs() { printf '{"type":"user","timestamp":"%sT01:00:00Z","cwd":"%s","message":{"content":"a prompt long enough to clear the two hundred byte size gate of the radar scanner, padded with words"}}\n' "$D" "$2" > "$RP/$1.jsonl"
  [ -n "${3:-}" ] && printf '{"type":"custom-title","customTitle":"%s"}\n' "$3" >> "$RP/$1.jsonl"; asst r$1 01:00:01Z claude-haiku-4-5 1000000 0 0 0 0 >> "$RP/$1.jsonl"; }
rs dddddddd-0000-0000-0000-000000000001 "$TR/w/abunai" "ABUNAI-SITE"
rs dddddddd-0000-0000-0000-000000000002 "$TR/w/scratch"
# Stub Haiku: logs each call, answers with valid edits plus junk that must be dropped.
printf '#!/bin/sh\ncat > /dev/null; echo call >> "%s/calls"\nprintf %%s '"'"'{"result":"{\\"project_aliases\\":{\\"abunai\\":\\"Abunaico\\",\\"nope\\":\\"X\\"},\\"tag_aliases\\":{\\"ABUNAI\\":\\"ABUNAICO\\"},\\"hide_projects\\":[\\"scratch\\",\\"ghost\\"],\\"evil\\":{\\"a\\":\\"b\\"}}","total_cost_usd":0.001}'"'"'\n' "$TR" > "$TR/stub"; chmod +x "$TR/stub"
rb() { HOME=$TR PUFFR_CLAUDE=$TR/stub node bin/puffr-burn "$@"; }
rb --json >/dev/null; chk "empty prompt makes no Haiku call" "$([ -f "$TR/calls" ] && echo called || echo none)" "none"
grep -q 'This file ships empty' "$TR/.puffr/report-prompt.md" && ok "prompt file ships empty with instructions" || bad "prompt file ships empty with instructions"
rb --add-rule "abunai is abunaico; hide scratch" --json >/dev/null
chk "rules need Haiku on" "$(rb --rules | grep -c 'status: haiku-off')" "1"
HOME=$TR node bin/puffr-config set model.haiku on >/dev/null
RJ=$(rb --json)
chk "compiled rules applied to projects" "$(echo "$RJ" | jq -r '.A.projects | keys | join(",")')" "Abunaico"
chk "tag alias applied" "$(echo "$RJ" | jq -r '.A.tags | keys | join(",")')" "ABUNAICO"
chk "unknown names and keys dropped" "$(jq -c '.rules | [keys, (.project_aliases|keys), .hide_projects]' "$TR/.puffr/report-rules.json")" '[["hide_projects","project_aliases","tag_aliases"],["abunai"],["scratch"]]'
rb --json >/dev/null; chk "cached until the rules change" "$(wc -l < "$TR/calls" | tr -d ' ')" "1"
rb --recompile --json >/dev/null; chk "--recompile forces a call" "$(wc -l < "$TR/calls" | tr -d ' ')" "2"
rb | grep -q 'customized: 3 edits' && ok "report says it was customized" || bad "report says it was customized"
rb --html "$TR/r.html" >/dev/null
grep -q '<h2>Report rules <small>customized: 3 edits from ~/.puffr/report-prompt.md</small></h2>' "$TR/r.html" && ok "rules box with status in the header" || bad "rules box with status in the header"
grep -q '<li><b>abunai is abunaico; hide scratch</b></li>' "$TR/r.html" && ok "rules box lists the rules" || bad "rules box lists the rules"
grep -q 'ships empty' "$TR/r.html" && bad "rules box hides the template comment" || ok "rules box hides the template comment"
rm -rf "$TR"

echo "— help —"
hp=$(node bin/puffr-help --plain)
case "$hp" in *$'\x1b'*) bad "plain help has no escape codes";; *) ok "plain help has no escape codes";; esac
echo "$hp" | grep -q "PUFFR v$(jq -r .version .claude-plugin/plugin.json)" && ok "help shows the manifest version" || bad "help shows the manifest version"
echo "$hp" | grep -q 'puffr-burn --add-rule' && ok "help explains report customizations" || bad "help explains report customizations"
chk "color help draws the fish" "$(node bin/puffr-help --color | grep -c '▀')" "9"
chk "plain help starts with the one-color fish" "$(node bin/puffr-help --plain | head -13 | grep -c '█')" "11"
grep -q -- '--puffr-body:url(data:image/png;base64,' "$TB/r.html" && grep -q -- '--cels:url(data:image/png;base64,' "$TB/r.html" && grep -q -- '--strip:1428px' "$TB/r.html" && ok "pixel fish and cel strip embedded" || bad "pixel fish and cel strip embedded"
grep -q 'data-mood' "$TB/r.html" && bad "fish ignores the report's results" || ok "fish ignores the report's results"
grep -q 'class="totop"' "$TB/r.html" && grep -q -- '--puff-cels:url(data:image/png;base64,' "$TB/r.html" && grep -q "body.animate(" "$TB/r.html" && ok "fish back-to-top button puffs" || bad "fish back-to-top button puffs"
TD=$(mktemp -d); burn --html "$TD" >/dev/null; ls "$TD" | grep -qE '^puffr-burn-all-accounts-[0-9-]+(_[0-9-]+)?\.html$' && ok "html into a folder is named for all accounts" || bad "html into a folder is named for all accounts"
burn --account "Acme Corp" --html "$TD" >/dev/null; ls "$TD" | grep -qE '^puffr-burn-acme-corp-[0-9-]+(_[0-9-]+)?\.html$' && ok "one account names the file" || bad "one account names the file"
rm -rf "$TD"
chk "--puff draws the puffed fish" "$(node bin/puffr-help --color --puff | grep -c .▀.)" "15"
chk "NO_COLOR skips the art" "$(NO_COLOR=1 node bin/puffr-help --color | grep -c '▀')" "0"
chk "Claude Code ! commands get the fish" "$(CLAUDECODE=1 COLORTERM=truecolor node bin/puffr-help | grep -c '▀')" "9"
chk "piped output elsewhere stays plain" "$(env -u CLAUDECODE -u FORCE_COLOR COLORTERM= node bin/puffr-help | grep -c '▀')" "0"

echo "— projects: nesting —"
TN=$(mktemp -d); NP="$TN/.claude/projects/-n"; mkdir -p "$NP" "$TN/work/app/.git" "$TN/work/docs"
nest() { printf '{"type":"user","timestamp":"%sT01:00:00Z","cwd":"%s","message":{"content":"a prompt long enough to clear the two hundred byte size gate of the radar scanner, padded out with more words"}}\n' "$D" "$2" > "$NP/$1.jsonl"; asst n$1 01:00:01Z claude-haiku-4-5 10 0 0 0 0 >> "$NP/$1.jsonl"; }
nest bbbbbbbb-0000-0000-0000-000000000001 "$TN/work"
nest bbbbbbbb-0000-0000-0000-000000000002 "$TN/work/app/src"
nest bbbbbbbb-0000-0000-0000-000000000003 "$TN/work/docs"
pn() { HOME=$TN node bin/puffr-sessions --json | jq -r --arg id "$1" '.[] | select(.id | startswith($id)) | .projectName'; }
chk "git root nested in a project folder" "$(pn bbbbbbbb-0000-0000-0000-000000000002)" "work/app"
chk "plain folder nested" "$(pn bbbbbbbb-0000-0000-0000-000000000003)" "work/docs"
printf '{"projects":{"Studio":["%s/work"]},"aliases":{"studio/docs":"Docs"}}' "$TN" > "$TN/.puffr/projects.json"
chk "mapped parent names the prefix" "$(pn bbbbbbbb-0000-0000-0000-000000000002)" "Studio/app"
chk "alias on a nested name" "$(pn bbbbbbbb-0000-0000-0000-000000000003)" "Docs"
rm -rf "$TN"

echo "— sessions: metadata, save, restore —"
ss() { HOME=$TB node bin/puffr-sessions "$@"; }
ss name eeeeeeee "Auth refactor" >/dev/null
chk "name shows as title" "$(ss --json | jq -r '.[0].title')" "Auth refactor"
ss star eeeeee >/dev/null; chk "star" "$(ss --json | jq '.[0].star')" "true"
ss assign eeeeeeee Hermes >/dev/null; chk "assign project" "$(ss --json | jq -r '.[0].projectName')" "Hermes"
chk "assigned project used by burn" "$(burn --json | jq -r '.A.projects | keys[0]')" "Hermes"
ss assign eeeeeeee '<img src=x onerror=alert(1)>' >/dev/null; burn --html "$TB/r2.html" >/dev/null
grep -q '<img src=x' "$TB/r2.html" && bad "html escapes project names" || ok "html escapes project names"
ss assign eeeeeeee Hermes >/dev/null
ss assign eeeeeeee hermes-old >/dev/null; ss merge HERMES-OLD --into Hermes >/dev/null
chk "merge folds a name in (any case)" "$(ss --json | jq -r '.[0].projectName')" "Hermes"
chk "merge applies to burn" "$(burn --json | jq -r '.A.projects | keys[0]')" "Hermes"
ss merge hermes-old --into "" >/dev/null; chk "unmerge" "$(ss --json | jq -r '.[0].projectName')" "hermes-old"
ss merge x >/dev/null 2>&1; chk "merge without --into refused" "$?" "2"
ss assign eeeeeeee Hermes >/dev/null
ss archive eeeeeeee >/dev/null; chk "archive hides" "$(ss --json | jq length)" "0"
chk "--archived shows" "$(ss --archived --json | jq length)" "1"
ss unarchive eeeeeeee >/dev/null
ss name ee x >/dev/null 2>&1; chk "short id refused" "$?" "2"
chk "meta file is private" "$(stat -c %a "$TB/.puffr/sessions-meta.json" 2>/dev/null || stat -f %Lp "$TB/.puffr/sessions-meta.json")" "600"
ss save >/dev/null
SV="$TB/.puffr/archive/-tmp-burn/eeeeeeee-1111-2222-3333-444444444444.jsonl"
[ -f "$SV" ] && ok "save copies starred session" || bad "save copies starred session"
chk "saved copy is private" "$(stat -c %a "$SV" 2>/dev/null || stat -f %Lp "$SV")" "600"
rm "$BF"
chk "saved lists pruned" "$(ss saved --json | jq '.[0].live')" "false"
ss restore eeeeeeee >/dev/null
cmp -s "$SV" "$BF" && ok "restore puts it back" || bad "restore puts it back"
HOME=$TB node bin/puffr-sessions label >/dev/null 2>&1; chk "label refuses while Haiku is off" "$?" "3"

echo "— config: Haiku opt-in —"
cfg() { HOME=$TB node bin/puffr-config "$@"; }
chk "haiku unset → ask" "$(cfg haiku-check)" "ask"
cfg set model.haiku off >/dev/null
chk "off → re-ask on a 1-in-10 roll" "$(PUFFR_ROLL=0.05 cfg haiku-check)" "ask"
chk "off → skip otherwise" "$(PUFFR_ROLL=0.5 cfg haiku-check)" "skip"
cfg off hud.git >/dev/null
chk "feature toggles keep the setting" "$(cfg get model.haiku)" "off"
cfg set model.haiku never >/dev/null; cfg reset >/dev/null
chk "never survives reset" "$(PUFFR_ROLL=0 cfg haiku-check)" "skip"
cfg set model.haiku maybe >/dev/null 2>&1; chk "bad value refused" "$?" "2"
cfg set model.haiku on >/dev/null; chk "on → on" "$(cfg haiku-check)" "on"

echo "— HUD nudge —"
NJ='{"workspace":{"current_dir":"/tmp"},"context_window":{"used_tokens":USED,"context_window_size":1000000}}'
echo "${NJ/USED/400000}" | HOME=$TB ./statusline.sh | strip_ansi | grep -q 'compact before a break' && ok "nudge on big context" || bad "nudge on big context"
echo "${NJ/USED/40000}" | HOME=$TB ./statusline.sh | strip_ansi | grep -q 'compact' && bad "no nudge on small context" || ok "no nudge on small context"
cfg off hud.nudge >/dev/null
echo "${NJ/USED/400000}" | HOME=$TB ./statusline.sh | strip_ansi | grep -q 'compact' && bad "nudge switch off" || ok "nudge switch off"
rm -rf "$TB"

echo "— ucef panel —"
# Contract fixtures, redaction vectors, every adapter, read-only guarantees, CLI exit codes.
# The node script prints the same ✔/✘ lines as this file; fold them into the totals here.
uo=$(node test/ucef-panel-tests.js 2>&1); urc=$?
printf '%s\n' "$uo" | grep -E '^(—|  ✔|  ✘)'
PASS=$((PASS + $(printf '%s\n' "$uo" | grep -c '^  ✔')))
un=$(printf '%s\n' "$uo" | grep -c '^  ✘'); FAIL=$((FAIL + un))
[ "$urc" -eq 0 ] || [ "$un" -gt 0 ] || bad "ucef panel tests exited $urc without a failing check"

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
