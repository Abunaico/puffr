# Burn report

`puffr-burn` (or `/puffr:burn`) reports where the tokens went across every Claude Code and Codex
session on the machine, ranks the habits that cost the most by what changing them would save per
month, and compares before and after a habit change. It reads the radar's index and makes no
network or model calls.

```bash
puffr-burn                                    # last 30 days, every project
puffr-burn --days 7 --project swingr          # narrower
puffr-burn --account work                     # one login's sessions
puffr-burn --since-change 2026-10-01          # before vs after a habit change
puffr-burn --since "2026-10-21 08:00" --until "2026-10-23 16:00"   # an event window, to the hour
puffr-burn --exclude 7d16603a,a0b0aa03        # leave sessions out by id prefix
puffr-burn --git                              # add commits and lines changed per repo
puffr-burn --html report.html                 # one self-contained file to share
puffr-burn --html ~/reports/                  # a folder: the file is named for you
puffr-burn --json
```

## Options

| Option | Effect |
|---|---|
| `--days N` | The last N days. Default 30. |
| `--since WHEN`, `--until WHEN` | A window instead of `--days`. `WHEN` is `YYYY-MM-DD` or local `"YYYY-MM-DD HH:MM"`. Windows round out to whole hours. |
| `--project <substr>` | Only projects whose name contains it |
| `--account <words>` | Only sessions mostly on that login. Every word must match: `--account "work enterprise"`. |
| `--exclude <id>[,<id>...]` | Leave sessions out by id prefix (the current one, say) |
| `--since-change YYYY-MM-DD` | Compare the period since that date with an equal period before it |
| `--git` | Add commits and lines changed per repo. `--full` and `--html` include it. |
| `--full` | Every section, including git |
| `--html [file or folder]` | Write one self-contained HTML file. Given a folder, the name is `puffr-burn-<account or all-accounts>[-<project>]-<from>_<to>.html`. |
| `--json` | Machine-readable output |
| `--reindex` | Rebuild the radar index before reporting |
| `--add-rule "<text>"`, `--rules`, `--recompile` | Report rules; see [below](#report-rules) |

## Sections

Sections appear when they have something to show.

### Insights

The biggest levers, ranked by a monthly saving computed from your own data and scaled to 30
days:

- execution turns and subagents on Opus or Fable, repriced at Sonnet,
- long sessions (average context above 150k to 200k re-read on every request),
- cache restores after idle,
- fixed prompt overhead above 30k tokens,
- mid-session model switches,
- compactions.

Each comes with the one action to take. The savings overlap, so don't add them up.

### UCEF tokens saved

Shown only when [UCEF](panels.md#ucef-view) orchestration ran in the window. A request counts as
UCEF-run when a `ucef-core:*` or `ucef-*:*` subagent answered it. The saving is **modeled, not
measured**: it assumes an equivalent deliverable without UCEF's verification phases would take
about 35% more turns in rework and re-prompts. puffr can't read completion or constitutional
scores from a transcript, so this confirms that orchestration ran, not that its quality gates
passed.

### By tool, account, project, session name

- **By tool** splits Claude Code and Codex when both are present.
- **By account** splits spend per request by the organization Claude Code records for each
  session (`credential_org`), so a session that switched logins is split correctly and
  subagents follow their parent. Older transcripts that predate that record fall back to a
  profile's last session per project, else show as unknown. Labels (email, plan, org) come from
  each profile's `.claude.json`.
- **By project** shows spend, share, sessions, the share of execution on Opus, and cache
  restores. With git, also commits, lines added, and dollars per commit.
- **By session name** groups sessions by the first word of their `/rename` title (`ACME-…`,
  `ACO-…`), so renaming sessions gives spend by workstream.

Projects come from each session's git root, or its folder when there's no repo. A project folder
inside another is named `Parent/child` (`Abunaico/puffr`); drive roots and your home folder never
count as parents. To name a folder and nest everything under it, add it to
`~/.puffr/projects.json`:

```json
{"projects": {"Abunaico": ["/Volumes/Flash4T/Development"]}}
```

Fold duplicate names together with `puffr-sessions merge` (case-insensitive aliases, full nested
names too), or move one session with `puffr-sessions assign`. Folder names that differ only in
letter case resolve to the on-disk spelling, so they count as one project.

### Top sessions

The costliest sessions with their project, days active, requests, and id.

### By hour

For windows up to two weeks, a timeline per local hour: spend, typed prompts, and the sessions
that spent it. It shows in text for clock-time windows (`--since "... HH:MM"`) or windows up to
3 days, and always in HTML and JSON.

### By agent

Spend split between your own turns (the main thread) and subagents by type, with UCEF
specialists (`ucef-*`) grouped and counted by runs. Subagents record their type beside their
transcript, so this is exact.

### By work type

Each response is filed under the highest-ranked tool it called: editing code, editing docs
(`.md`, `.txt`), shell, delegating to agents, reading and searching, other tools, conversation
with no tools, or rewriting the cache after a compaction. It sums to the total. The compaction
summary call itself isn't in transcripts, so it is estimated separately from each compaction's
size and left out of the totals.

### Cost drivers

Every dollar split into cache reads, cache writes (normal growth versus returns after idle,
session starts, compactions, model switches, and prefix changes), output, and uncached input;
main thread versus subagents; the fixed prompt overhead each request carries (system prompt,
tools, skills, CLAUDE.md); and requests per prompt.

### By model

Spend, requests, cache reads and writes, and output per model.

### Practices

Each maps one habit to one number:

```
PRACTICES
  ▲ Big models doing execution     69% of Edit/Write/Bash calls ran on Opus or Fable
    Opus-High to plan and review, Sonnet-High to execute (infra excepted).
  ▲ Cache restores after idle      248 returns after the cache expired · $825 (9% of spend)
    Coming back after the cache TTL rewrites the whole context. Compact before a long break.
```

- execution tool calls by model family,
- manual compactions followed by more work within 15 minutes, versus before a break,
- cache rewrites after the TTL expired, priced as the write cost above a cache read,
- CLAUDE.md and memory tokens times requests,
- files read in three or more sessions,
- fixed prompt overhead,
- the auto-compact threshold.

### Value

With git: commits and PRs per dollar and lines changed, found from the repos your sessions edited
files in. Each repo is queried with a 4 second timeout. These are rough proxies; judging the work
itself stays with people.

### What puffr costs

Closes every report: the report itself is $0, the skill listings puffr adds to each request, and
Haiku calls if you opted in (counted in `~/.puffr/spend.json`).

## Before and after

`--since-change <date>` compares the period since a date with an equal period before it, as rates
per day or per unit (spend per commit, per PR), so unequal periods compare fairly. In HTML it adds
Before and After tabs, each a full report.

## The HTML report

One file with no network:

- every table sorts by column, and tables over 12 rows get a filter box,
- hovering a project, account, tag, agent, work type, model, or session shows a card with its
  spend, model mix, work mix, agents, and top sessions,
- clicking opens a drawer with every session behind it,
- report rules, if you have any, sit in a box at the top,
- light and dark themes.

A pixel PUFFR swims along the bottom as you scroll. He turns to face the way he swims, rocks with
each tail beat, trails bubbles when he's going fast, and blinks and pulls faces now and then.
Click him to go back to the top. The whole fish is about 5 KB of PNG, and he sits still if your
system asks for reduced motion.

## How costs are counted

Costs are estimates at Anthropic API list prices, from the usage each response records. A
response streamed over several lines counts once, and subagents are included. On a subscription
they show relative weight, not your bill.

The burn report reads each transcript on its own: a rewound or forked copy of a session in a
second file repeats its message ids and is counted again. [`puffr-swarm`](swarm.md) counts every
id once across all files and machines; use it when that matters.

Codex sessions show exact tokens and unpriced dollars until you add prices; see
[codex.md](codex.md).

## Report rules

`~/.puffr/report-prompt.md` holds plain-English rules for how reports read. It ships empty.

```bash
puffr-burn --add-rule "abunai is the same as abunaico; show it as Abunaico"
puffr-burn --rules        # the rules, and the edits they compiled to
puffr-burn --recompile    # compile again without changing the rules
```

The next report sends Haiku the rules and the names it may change (projects and tags, plus
accounts only when a rule mentions them; never transcripts) and gets back a fixed set of edits:
project renames, tag renames, account labels, and hidden projects. puffr keeps only edits to names
that exist, applies them in code, and caches them until the rules change, so ordinary runs make no
Haiku call. Your own `~/.puffr/projects.json` always wins.

Rules need `puffr-config set model.haiku on`. Reports then say
`customized: N edits from ~/.puffr/report-prompt.md`, and the HTML version lists the rules
(without the file's comment block) and the edits they made.
