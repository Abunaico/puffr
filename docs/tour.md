# Building PUFFR with PUFFR

PUFFR was built in Claude Code sessions with PUFFR running, so its own build makes a good tour.

## Watch the gauges while you work

The default `compact` layout packs everything into three lines. Partway through one build session
it read:

```
🐡 Opus 5.5 · 👤 you@example.com (enterprise)
███░░░░░░░ 36% 5h 38% ⏰1h30m →54% 7d 41% ⏰3d0h →71% · $55.60 /compact before a break
📁 ~/puffr
```

`/puffr:detailed` spells the same gauges out in words, one per line; `/puffr:compact` switches
back:

```
🐡 Opus 5.5 · 👤 you@example.com (enterprise)
context      ███░░░░░░░ 36% full · 368k of 1.0M tokens
5-hour limit 38% used · resets in 1h30m (11:35 AM) · on pace for 54% by reset
weekly limit 41% used · resets in 3d0h (Sat 10:05 AM) · on pace for 71% by reset
prompt cache · /compact before a break
cost         $55.60 this session
📁 ~/puffr
```

The nudge on the cost line appears once the context passes 150k tokens: compact before you walk
away, not mid-work.

## Run a report on the project

`puffr-burn --project puffr --git` priced that session:

```
🐡 puffr burn: 2026-09-01 → 2026-10-07 · puffr · 1 sessions · $55.60 ≈ API list price

INSIGHTS                                                    saving / month
  1. Keep sessions shorter                                  ≈$646
     The average request re-reads 368k tokens of context; cache reads are 65% of spend.
  2. Run execution on Sonnet                                ≈$240
     $44.95 of your own edit and shell turns ran on Opus or Fable; the same tokens on Sonnet 5 cost $36.95.

BY PROJECT                             spend  share  sessions  opus-exec  restores  commits   +lines  $/commit
  Abunaico/puffr                         $55.60   100%         1        91%     $0.00       36      11k     $1.54

BY WORK TYPE                                        spend  share  requests
  Shell commands                                     $44.05    79%       385
  Conversation (no tools)                             $5.03     9%        52
  Editing code                                        $2.72     5%        19
```

The lesson was plain: one long Opus session carried 368k tokens into every request, and most of
the spend was shell work (tests, screenshots) that Sonnet could run. Splitting the work into
shorter sessions and running execution on Sonnet are the two biggest levers it found.

## Fix the names with a plain-English rule

Some of the build's folders were called `abunai` and others `abunaico`. One rule merges them in
every report from then on:

```bash
puffr-burn --add-rule "abunai is the same as abunaico. just represent as abunaico."
```

The report header then says `customized: 3 edits from ~/.puffr/report-prompt.md`, and the HTML
report shows the rule and its edits in a Report rules box at the top. See
[burn.md](burn.md#report-rules).

## Share it

```bash
puffr-burn --account work --since-change 2026-09-24 --html ~/reports/
```

That writes `puffr-burn-work-2026-09-10_2026-10-07.html`: one account's before and after, ready
to send. Without `--account` the file is named `all-accounts`.

## Where to go next

- What's eating the window right now: [context.md](context.md)
- What your CLAUDE.md and hooks cost every month: [instructions.md](instructions.md)
- How parallel a busy day was: [swarm.md](swarm.md)
