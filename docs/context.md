# Context and cache viewer

`puffr-context` (or `/puffr:context`) shows what is filling a session's context window, how well
the prompt cache is holding, and why it broke when it did.

```bash
puffr-context                        # this session
puffr-context <session-id>           # any session
puffr-context --project myrepo       # newest session in a project
puffr-context --turns 30 --top 15    # more history, more items
puffr-context --window 1000000       # override the assumed window size
puffr-context --json                 # machine-readable
```

```
CONTEXT
  █████████████████████████░░░░░ 166k / 200k  83%
  autocompact at 80% · threshold passed

  hooks & attachments      ≈   74k  44% ████████████████
  system prompt + tools        63k  38% ██████████████░░
  result: Bash             ≈   16k  10% ███░░░░░░░░░░░░░
  ...

  largest items
    ≈14k  15:09  Read /path/to/README.md
    ...

CACHE
  hit rate 96% over 29 requests · input billed at 17% of uncached
  read 3.85M · write 140k (5m 0 / 1h 140k) · uncached 58 · output 27k

  cache breaks (1)
  14:02  rewrote   90k  cold start

  time     ctx    read   write  uncach  out   hit
  14:51    91k     90k     354       2   197  100%
  ...
```

## Sections

- **Context.** The window fill, the autocompact mark, and a breakdown by category: system prompt
  and tools, hooks and attachments, each tool's results, tool calls, skills, assistant text, and
  your prompts.
- **Largest items.** The biggest single things in context, with when they arrived.
- **Cache.** Hit rate, the effective input price as a share of uncached, and totals for reads,
  writes (5-minute and 1-hour tiers), uncached input, and output.
- **Cache breaks.** Requests that rewrote a large part of the prefix instead of reading it, with
  a likely cause.
- **Per turn.** Context size, reads, writes, uncached input, output, and hit rate for each recent
  request.
- **Subagents.** Their usage, when the session ran any.

## What's measured and what's estimated

- **Measured:** every usage number, the hit rate, the per-turn table, and cache breaks. These come
  straight from the API usage Claude Code records in the session transcript, deduplicated per
  request, since one streamed response is logged as several lines.
- **Estimated (`≈`):** the per-category breakdown and largest items. Content is sized by character
  count, then scaled so the categories add up to the measured window. "System prompt + tools" is
  the first request's measured size minus the first prompt. Thinking from earlier turns is left
  out, since the API drops it.
- **Cache break causes** are inferred: idle past the cache TTL (5 minutes or 1 hour), a
  compaction, a model switch, or a changed prefix (tools, MCP servers, or system prompt changed
  mid-session). The first request of a session shows as `cold start`.
- **"Input billed at X% of uncached"** applies the standard cache multipliers (read 0.1×,
  5-minute write 1.25×, 1-hour write 2×) to your actual token mix. It is model-agnostic; no price
  table is involved.
- **Window size** is recorded by the HUD on each render, since transcripts don't carry it.
  Without the HUD it is assumed: 200k, or 1M if the session ever went past 200k. Override with
  `--window`.

## Reading it

A big "hooks & attachments" share usually means a per-prompt hook or a large CLAUDE.md riding
along on every request; [instructions.md](instructions.md) prices each one. A long run of cache
breaks after idle means you came back after the TTL; compacting before a break makes the rewrite
the summary instead of the whole history.
