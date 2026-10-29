# Troubleshooting

Start with `/puffr:hud` (or `puffr-hud`). It reports what's wired, which puffr copy is live, any
leftover copies, and any mutes.

## The HUD doesn't show

- **Not installed.** The statusLine is a user setting the plugin can't set by itself. Run
  `/puffr:hud install`, then start a new session.
- **Another statusLine is set.** `install` refuses to replace a statusLine that isn't puffr's.
  Remove or move yours first.
- **A different profile.** The setting is per profile. With `CLAUDE_CONFIG_DIR` set, run
  `/puffr:hud install` in each profile.
- **Muted.** `/puffr:off` was run (`~/.puffr/disabled` exists). Run `/puffr:on`.
- **VS Code extension.** The Claude Code VS Code extension never runs the statusLine. Use the
  [VS Code panel](panels.md#vs-code) instead.
- **Missing `jq`.** The HUD is bash and `jq`. Install `jq`.

## The HUD is stale after an update

The launcher runs whichever puffr copy the last session start recorded. Start a new session, or
run `/puffr:hud repair` to re-point it at the current copy.

## The rate meters are missing

They need a Pro or Max login and appear after the first response of a session. With
`ANTHROPIC_API_KEY` set there are no subscription limits to show.

## The context % looks wrong

Transcripts don't record the window size, so the HUD records it on each render. Sessions the HUD
never rendered for are assumed to have a 200k window, or 1M if they ever went past 200k. Pass
`puffr-context --window <tokens>` to override.

## The HUD is slow on a network drive

It shouldn't be: git status is never run inline. It is cached for 5 seconds per folder and
refreshed in the background. If renders still lag, `puffr-config off hud.git` takes git out
entirely.

## Segments are missing at the end of a line

The HUD fits the width Claude Code passes and drops lower-value segments first. Widen the
terminal, switch to the `detailed` layout, or set `PUFFR_HUD_WIDTH`.

## Costs don't match my bill

Costs are estimates at API list prices from transcript usage. On a subscription they are relative
weight, not a bill. For a reconciliation against an invoice, use
`puffr-swarm --bill <usd>` with every machine's transcripts passed as `--root`; it lists the
usual reasons for a gap (other machines, claude.ai and desktop use, deleted sessions, price-table
drift). The burn report also counts a forked or rewound copy of a session again; the swarm readout
doesn't.

## Codex dollars say "unpriced"

puffr ships no OpenAI prices. Add yours to `~/.puffr/prices.json`; see [codex.md](codex.md).

## The radar is missing sessions or looks wrong

`puffr-sessions --reindex` rebuilds the index from scratch. Sessions older than Claude Code's
`cleanupPeriodDays` (default 30) are deleted by Claude Code; `puffr-sessions save` keeps copies
before that happens.

## Duplicate project names in reports

Folders renamed over time, or the same repo cloned twice, show as separate projects. Fold them
with `puffr-sessions merge <name>... --into <project>`, name folders in `~/.puffr/projects.json`,
or add a plain-English [report rule](burn.md#report-rules).

## The VS Code panel can't find puffr

The installed extension carries its own copy of puffr's `bin/`. If you point a `puffr.*Path`
setting somewhere else, that path must exist. Reinstall with `npx github:Abunaico/puffr --vscode`
and reload the window.

## The UCEF view says the database is unavailable

The database source needs Node 22 or newer (`node:sqlite`). The other sources still work without
it. A `snapshot` label means the database was read as an immutable snapshot and can lag a live
writer; see [panels.md](panels.md#ucef-view).
