# Session radar and manager

`puffr-sessions` (or `/puffr:sessions`) indexes every Claude Code and Codex session on the
machine, across every project, and manages them: name, star, archive, assign to a project, save
before Claude Code's cleanup deletes them, and restore.

```
🐡 puffr radar: 410 sessions, newest 15:

  ●   0m  puffr                           53msg   $1.44  Docs rewrite ◀ you
         claude --resume d850b989-95d6-4b3a-86af-763b9e52aebd
  ○  26m  swingr                          26msg   $0.40  SWINGR-MAIN
         claude --resume 8374adff-1721-4fe2-909c-de16de9b3135
  ·   6h  Abunaico                       414msg  $16.36  ACO-KANI-SETUP
         claude --resume 8345659a-aa3b-43a2-8962-6b55a125b076

  ● <1m  ○ <1h  · idle   ★ starred   cx Codex   $ ≈ API list price   fork: claude --resume <id> --fork-session
```

## Listing

```bash
puffr-sessions                        # newest 15
puffr-sessions --limit 50
puffr-sessions --project swingr       # project name contains it
puffr-sessions --search "burn report" # title, summary, and project name
puffr-sessions --active               # touched in the last hour
puffr-sessions --starred
puffr-sessions --archived
puffr-sessions --tool codex           # or claude
puffr-sessions --json
puffr-sessions --reindex              # rebuild the index from scratch
```

The index lives at `~/.puffr/sessions-cache.json`. Indexing is incremental by byte range: after
one full scan, only new bytes are read, and warm scans take tens of milliseconds.

## Managing

```bash
puffr-sessions name 745491b4 "Burn report build"   # "" clears
puffr-sessions star 745491b4                       # unstar to undo
puffr-sessions archive 3f2a9c01                    # hides it; nothing is deleted. unarchive to undo
puffr-sessions assign 3f2a9c01 hermes              # "-" clears
puffr-sessions merge abunaico --into Abunaico      # fold renamed or duplicate project names
puffr-sessions merge                               # list merges; --into "" unmerges
```

Ids can be any unique prefix. Names, stars, archive flags, and project assignments live in
`~/.puffr/sessions-meta.json`; Claude Code's own files are not touched.

Naming sessions pays off in reports: the first word of a title (`ACME-…`) becomes a workstream
tag in [the burn report](burn.md#by-tool-account-project-session-name).

## Saving transcripts

Claude Code deletes transcripts after `cleanupPeriodDays` (default 30).

```bash
puffr-sessions save                 # starred, plus anything within 7 days of deletion
puffr-sessions save 3f2a9c01        # specific sessions
puffr-sessions save --all           # everything
puffr-sessions save --starred       # or --expiring
puffr-sessions saved                # what's in ~/.puffr/archive; "pruned" means the original is gone
puffr-sessions restore 3f2a9c01
```

`save` copies transcripts, with their subagent transcripts, into `~/.puffr/archive`. puffr never
moves or deletes a transcript.

## Opening a session

`/puffr:open <id | search term>` builds the command and hands it to your terminal; it never runs
an interactive `claude` inside the current session.

- Resume: `claude --resume <id>`
- Fork: `claude --resume <id> --fork-session`

It prefers a tmux split (when `$TMUX` is set), then a Warp launch configuration, and otherwise
prints the command for you to paste. Every id must be a full session UUID, and titles and paths
from transcripts are escaped before they reach a launch file.

## Autoname

On by default. As a `UserPromptSubmit` hook, `puffr-autoname` records a session's first five real
prompts. After the third and the fifth it starts a background Haiku call, so no prompt ever waits,
and the next prompt applies the result as the session title:

```
ACCOUNT-CATEGORY-PROJ-TASK-SUB
```

The vocabulary comes from your own past titles. A title you set yourself (`/rename`, or a resumed
named session) always wins, and autoname stands down.

```bash
puffr-autoname suggest "fix the flaky login test"   # print a name, apply nothing
puffr-config off autoname                            # turn it off
```

Haiku receives the session's first prompts, its folder, and your past session titles. See
[privacy.md](privacy.md).

## Haiku labels

Opt-in, off until you say yes. `puffr-sessions label` asks Haiku, through `claude -p` on your own
login, for a short name and summary for unlabeled sessions.

```bash
puffr-sessions label --limit 20 --dry-run
```

Only titles and first-prompt snippets are sent, never transcripts. The call runs without tools,
MCP servers, or saved settings, and isn't saved as a session. `/puffr:sessions` asks once. Say
"not now" and it asks again on about one run in ten; say "never" and it never asks. Change it any
time with `puffr-config set model.haiku on|off|never`.

## Watch

`puffr-watch` is a cross-session monitor. Run as a Claude Code background monitor, each line it
prints becomes an in-session notification. It reports only other sessions:

- a session that finishes its turn (busy to idle after 60 seconds of no writes),
- a session that stops on an error,
- a session that goes quiet mid-turn (a possible stall),
- a new session.

It polls file stats every 15 seconds (`PUFFR_WATCH_INTERVAL` to change) and reads the tail of a
transcript only on a transition. Sessions idle more than 30 minutes at startup are ignored. It
excludes its own session using `CLAUDE_CODE_SESSION_ID`.

The plugin ships `monitors/monitors.json` empty, so watch is not started for you. Start it
yourself as a background command in a session when you want it. `/puffr:off` or
`puffr-config off watch` silences a running watch within one poll.
