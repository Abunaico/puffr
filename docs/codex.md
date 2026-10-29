# Codex

puffr reads OpenAI Codex sessions too, from `$CODEX_HOME/sessions` (default `~/.codex`). Each
rollout carries its own folder, subagent threads attach to their parent, and titles (including
Codex's `/rename`) come from `session_index.jsonl`.

## Where they show up

- **Radar.** Codex sessions carry a `cx` marker and a `codex resume <id>` command.
  `puffr-sessions --tool codex` lists only them.
- **Burn report.** Every section includes them, and a BY TOOL section splits Claude Code from
  Codex. Requests come from Codex's cumulative token counts, filed by work type from the tool
  calls (`apply_patch`, `exec`, ...).

The swarm readout, context viewer, and HUD are Claude Code only.

## Prices

puffr ships no OpenAI prices, so Codex shows exact tokens and "unpriced" dollars until you add
your own in `~/.puffr/prices.json`. Keys are an exact model name or a prefix; values are dollars
per million tokens:

```json
{"models": {"<codex model>": {"input": 0, "cached": 0, "output": 0}}}
```
