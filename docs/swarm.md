# Swarm readout

For a run with many sessions at once (a sprint, an event, an overnight fleet), `puffr-swarm` (or
`/puffr:swarm`) streams the transcripts in a window and reports how parallel the work was, what
each lane cost, and how much of your bill the transcripts explain. Claude Code transcripts only.

```bash
puffr-swarm                                                       # last 7 days on this machine
puffr-swarm --since 2026-10-21T13:00Z --until 2026-10-23T21:00Z   # a window; end exclusive
puffr-swarm --root ~/.claude/projects --root mini=/Volumes/other/.claude/projects   # several machines
puffr-swarm --lane "api=^API" --rename "api=^API-"                # lanes by title pattern
puffr-swarm --phase "Build=2026-10-22 09:00..2026-10-22 17:00"    # named spans, repeatable
puffr-swarm --bill 3120.50                                        # reconcile with an invoice
puffr-swarm --html swarm.html                                     # one self-contained file
```

## Options

| Option | Effect |
|---|---|
| `--days N` | The last N days. Default 7. |
| `--since WHEN`, `--until WHEN` | `WHEN` is `YYYY-MM-DD`, local `"YYYY-MM-DD HH:MM"`, or absolute `2026-10-21T13:00Z`. The end is exclusive. |
| `--root [LABEL=]DIR` | A transcript root, one per machine. Repeatable. `LABEL=` names it. Default `~/.claude/projects`. |
| `--lane NAME=REGEX` | Collect sessions whose title matches into lane NAME. Repeatable. |
| `--rename NAME=REGEX` | Rewrite matching titles to NAME first, so a restarted or renamed session merges into its lane. Repeatable. |
| `--phase "NAME=FROM..TO"` | A named span to report on. Repeatable. |
| `--bill USD` | Reconcile against an invoice or credits figure |
| `--orchestrated-agent REGEX`, `--orchestrated-prompt REGEX` | What counts as an orchestrated subagent (see below) |
| `--exclude ID,...` | Leave sessions out |
| `--min-usd N` | Sessions under this are left out of lanes and counts. Default $1. They stay in machine totals and the bill check. |
| `--anon` | Swap lane names for `lane-01…` and drop descriptions, for sharing |
| `--config FILE` | A config file. Default `~/.puffr/swarm.json`. |
| `--json` | Machine-readable output |
| `--html [file]` | One self-contained file, light and dark, in the burn report's style |

## What it reports

- **Lanes.** Sessions grouped by title. With no rules there is one lane per session title. Each
  lane shows its spend.
- **Concurrency.** Per 15 minutes, a lane is active when its main thread made requests or one of
  its subagents was running; a subagent is running from its first to its last request. You get
  the peak (when, lanes, subagents), average parallelism over the window and while active,
  lane-hours, subagent-hours, and the hours in which you typed a prompt, plus a concurrency
  chart.
- **Phases.** Spend, lanes, subagents, peak, Claude-hours, and your prompt-hours per span.
- **Cross-session messages.** The `<cross-session-message>` notes one session sends another:
  totals, sent and received per lane, and ack-only replies (short messages, or a plain "got it"
  or "thanks").
- **Orchestrated subagents.** The share whose agent type matches `--orchestrated-agent` (default
  `^ucef-`) or whose first prompt matches `--orchestrated-prompt` (default `^\s*UCEF_ATOM:`).
- **Costliest subagents.**
- **Machines and dedupe.** Each root is a machine. Every assistant message id is counted once
  across all files and roots (the fullest copy keeps it), so a rewound or forked session isn't
  counted twice. The report shows the repeats and dollars removed, per machine.
- **Bill.** With `--bill` or a `bills` entry in the config: "transcripts explain $X of $Y (Z%)",
  the unexplained remainder, and the usual reasons it isn't 100%: machines not passed with
  `--root`, claude.ai and desktop use, deleted sessions, and price-table drift. No bill, no
  section.

## Config file

`~/.puffr/swarm.json`, or `--config FILE`. Flags are layered on top.

```json
{
  "roots": ["/Users/me/.claude/projects", {"path": "/Volumes/other/.claude/projects", "label": "mini"}],
  "lanes": [
    {"name": "api", "match": "^API", "role": "backend lane"},
    {"name": "web", "match": "^WEB"}
  ],
  "renames": [{"match": "^API-", "to": "api"}],
  "otherLane": "(other)",
  "phases": [{"name": "Build", "from": "2026-10-22 09:00", "to": "2026-10-22 17:00"}],
  "orchestrated": {"agentPattern": "^ucef-", "promptPattern": "^\\s*UCEF_ATOM:"},
  "bills": [{"month": "2026-10", "usd": 3120.5, "account": "work"}],
  "exclude": ["7d16603a"],
  "minUsd": 1
}
```

| Key | Shape |
|---|---|
| `roots` | Paths, or `{"path", "label"}` objects |
| `lanes` | `{"name", "match", "role"}`; `match` is a regex tested against the title and the session id; `role` is an optional description |
| `renames` | `{"match", "to"}` |
| `otherLane` | The lane for titles no lane matches, when lanes are defined. Default `(other)`. |
| `phases` | `{"name", "from", "to"}`, with the same time formats as `--since`. Phases may not overlap. |
| `orchestrated` | `{"agentPattern", "promptPattern"}` regexes |
| `bills` | `{"usd", "month", "account"}`; `month` and `account` are optional |
| `exclude` | Session id prefixes |
| `minUsd` | Number |

## Reading another machine

Copy or mount that machine's `~/.claude/projects` and pass it as a second `--root` with a label.
The dedupe is by message id, so overlapping copies are safe.
