# Instruction cost

`puffr-instructions` (or `/puffr:instructions`) prices every always-on instruction source: the
blocks that ride along on every request whether you need them or not.

```bash
puffr-instructions                    # last 30 days
puffr-instructions --days 7
puffr-instructions --project swingr
puffr-instructions --top 40           # more rows
puffr-instructions --json
```

```
🐡 PUFFR instructions · last 30 days · 1464 sessions · 53,199 requests

  Always-on instructions cost $408 over 30 days, ≈$408/mo, re-read on every request.
  ≈ chars/4 tokens · cache-read price per request carried, plus one cache write · API list price

  SOURCE                                                SIZE     IN   CARRIED      ≈/MO
  agent listing                                          16k    621       31k      $123
  skill listing (95 skills)                              33k    859       45k    $77.24
  ~/work/.claude/CLAUDE.md                              8.2k    545       17k    $44.26
  UserPromptSubmit hook · user-prompt-submit.py          201   5232      574k    $29.49
  MCP server instructions                               3.3k   1495       52k    $26.10
  ~/.claude/CLAUDE.md                                    344    742       28k     $2.98

  First move: agent listing
  Disable servers or agents a project doesn't use (project settings).

  SIZE = tokens per injection · IN = times injected · CARRIED = requests it sat in context for
```

## What it counts

Only what the model actually received: attachments with a rendered payload. That covers
CLAUDE.md and rules files, memory, hook output injected as context, and the skill, agent, and
MCP listings. Hook runs that never reach the model are not counted.

## How it prices

A block stays in context for every later request in its session until a compaction. So its cost
is its size times the requests it was carried for, at that model's cache-read price, plus one
cache write. Tokens are estimated as characters divided by 4. Dollars are API list price, not a
subscription bill.

## What to do with it

- **A per-prompt hook** (IN far above the session count) accumulates. Shorten it, or inject only
  when it changes something.
- **A big CLAUDE.md.** Keep it a short map, and move detail into skills or `paths:` rules that
  load on demand.
- **Skill or agent listings.** Disable plugins a project doesn't use, or set `skillOverrides` to
  `name-only`.

The burn report's "Trim the fixed prompt overhead" insight is the total of these; this command is
the itemized bill.
