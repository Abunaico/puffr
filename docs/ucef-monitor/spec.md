# UCEF Monitor Event Contract v1 (spec_revision 1.1)

`spec_revision: "1.1"`

Status: draft for four consumers (Python Textual TUI, Node panel in puffr, Rust ratatui TUI, tiered-hooks emitter).
Wire version: `schema_version: "1"` (unchanged by revision 1.1). Schema: `ucef-monitor-event.v1.schema.json` (JSON Schema draft 2020-12).
Conformance words MUST / SHOULD / MAY follow RFC 2119.

## Changelog

### 1.1 (from 1.0, driven by the cross-implementation conformance check)

Semantic rules; the wire stays `schema_version: "1"`. Schema changes are additive or producer-side only.

| # | Change | Where |
|---|---|---|
| 1 | `hook_verdict` dedupe key is now `hv\|<hook_event>\|<tool_use_id>\|<hook_id>`; `hook_id` rules for emitters, transcript adapters, prompt/agent hooks; transcript `hookName` is never used | 4.4, 5.5 |
| 2 | An outcome/stop record with no matching delegation/start/transcript for its `agent_id` creates no `agent_run` row; it only fills status | 5.1 |
| 3 | Only true gates produce `gate_result`; `atom_outcome` is not a gate; explicit `phase_gate` key including `atom_id` then `agent_id`; any phase event, even only a `gate_result`, renders `seen` | 4.4, 5.1, 8 |
| 4 | `decision` key `dc\|<class>\|<question>\|<digest>` is mandatory | 4.4 |
| 5 | P4 token totals = finished subagent `agent_run` usage only; decision/judge usage shown separately, never summed | 8 |
| 6 | `fail-open-counts.jsonl` rows are counters: aggregate in `session_meta` health, never per-row `warn` verdicts; `hook-failures.jsonl` stays per-row | 5.4, 6.2 |
| 7 | Inferred phase position events are not stored once an emitted one exists for that phase | 6.2 |
| 8 | SQLite: `mode=ro` plus `query_only`; `immutable=1` only as a labeled fallback with `read_mode: snapshot` in the health line | 1, 6.2 |
| 9 | New fixtures and cases a, b, c, e, g plus a raw orphan fixture (d); `expectations.json` extended | 10 |

Schema deltas (all within `schema_version: "1"`): `dedupe_key` is now REQUIRED for `hook_verdict`, `agent_run`, `phase_gate`, `decision` (producer-side tightening; consumers are unaffected); `session_meta.sources[]` gains optional `count` and `read_mode`. Two additions were not requested: ASSUMPTION: the correlation id for hook events that have no `tool_use_id` (section 4.4), and the `snapshot` representation as `read_mode`.

Evidence labels used throughout: `SOURCE:` (read or measured in this checkout or cited docs), `ASSUMPTION:`
(inference without direct evidence), `OPEN_QUESTION:` (needs an owner decision), `CANNOT_VERIFY:` (not
checkable from here). Measurements were taken 2026-10-24/25 on checkout
`/Volumes/Flash4T/Development/_UCEF/multi-agent-framework`, branch `claude`, Claude Code 2.1.306
(SOURCE: `version` field of `system/stop_hook_summary` records in the session transcript).

---

## 1. Source map

`<root>` = `<repo>/.claude/data` (override: `UCEF_DATA_ROOT`). `<ws>` = workspace id, `<sid>` = session id,
`<aid>` = subagent id (17 hex chars, e.g. `a9b60dba29e8c2a5d`). Panes: P1 hooks+verdicts, P2 agents+model tier,
P3 phase+gates, P4 Jev decisions+cost. L = usable for live tail, R = usable for replay.

| ID | Path pattern | Format | L/R | Panes | Key fields | State in this checkout |
|---|---|---|---|---|---|---|
| S1 | `<root>/workspaces/<ws>/sessions/<sid>/orchestration-audit.jsonl` | JSONL `AuditRecord` (`schema_version` "1.0.0", 11 lines have none) | L+R | P1 P2 P3 | `timestamp, event_type, session_id, workspace_id, atom_id, agent_invoked, input_tokens, output_tokens, cache_tokens, duration_ms, quality_gate_result, extra{}` | 14 files, 5,990 lines (point-in-time; the live file was 1,719 lines at first read and keeps growing). `phase` and `model_id` are null on 100% of lines. |
| S2 | `<root>/orchestration-audit.jsonl` (legacy, flat) | JSONL, no `schema_version`, `ts` key | R | none today | `event_type` = `coordination_dispatch` or `guardian_preflight_disclosed_override` | ABSENT here (`ls` exit 1). CANNOT_VERIFY content; shape known only from `unified-trace-schema.md` section 4. |
| S3 | `<root>/ucef/ucef_data.db` | SQLite. Open ONLY `file:<path>?mode=ro` with `uri=True` (Python) | R, best-effort | P2 P3 P4 | `monitoring_events(id,timestamp,session_id,event_type,payload JSON,workspace_id)`, `phase_transitions`, `atom_outcomes`, `grading_signal_events`, `decision_events` | DEGRADED. `alembic_version` is empty. `monitoring_events` 4,638 rows (`agent_delegation` 578, `tool_use` 2,025, `tool_call_result` 2,025, `session_end` 10, zero `session_start`). `atom_outcomes` 0, `decision_events` 0, `phase_transitions` 1. No `field_stability_events` table. |
| S4 | `<root>/ucef/logs/session-start-failures.log` | text, one line per failure, local-time offset timestamps | R | health only | `UCEF DEGRADED-DB: ... database_migration failed ... table conversations already exists` | 14,150 bytes. Lines contain absolute paths; never render verbatim. |
| S5 | `<root>/decision-telemetry/{authored,proposals,refusals,captures}.jsonl` | JSONL, ASCII, mode 0600 | L+R | P4 | authored: `recorded_at, session_id, point_id, question_id, authored_value, authored_provenance, authored_status, supplied_status, question_digest`. proposals: `tier, provider, model_id, top1, latency_ms, value, point_id, floor, applied` | Only `authored.jsonl` exists (20,393 bytes). `proposals.jsonl` ABSENT, so no real Jev call is recorded here. |
| S6 | `<root>/permission-request.log` | Mixed text: timestamp line, pretty-printed raw payload block, blank line, then `INFO <ts> key=value` lines | L+R | P1 | `INFO` lines only: `defer_reason=`, `deny_capability=unavailable reason=`, `classifier_verdict`, `auto_approval=` | 153,677 bytes. HAZARD: payload blocks for non-Bash tools are NOT hashed (README section 5a hashes only Bash `command` and four ids). One block contained verbatim business content. Parse INFO lines only. |
| S7 | `<root>/workspaces/<ws>/hook-failures.jsonl`, `fail-open-counts.jsonl` | JSONL | L+R | P1 | failures: `timestamp, hook, step, exception_type, message, traceback, session_id`; counts: `timestamp, hook_name, step_name, error_message` | 203 rows each. `hook-failures.jsonl` is per-row (events). `fail-open-counts.jsonl` rows are COUNTERS (spec_revision 1.1): aggregated into `session_meta` health, never verdicts. `traceback`/`message` carry paths and agent ids; never carried into events. |
| S8 | `<root>/workspaces/<ws>/sessions/<sid>/.atom-registry.json`, `.gate-counters.json`, `hook-session-state.json`; dirs `<sid>__<aid>/.trajectory_state.json` | JSON | L+R | P2 P3 | registry `assignments[]{atom_id, agent_type, task_complexity, claimed_by}` | Registry maps `claimed_by` (= `<aid>`) to the semantic `atom_id`. This is the only reliable agent-to-atom join. |
| S9 | `<root>/workspace_metadata.json` | JSON `{workspaces:{<ws>:{...}}}` | discovery | all | workspace ids | 6 workspaces. |
| S10 | `~/.claude/projects/<enc-cwd>/<sid>.jsonl` | JSONL (Claude Code transcript; format undocumented) | L+R | P1 P2 P3 | see section 3 and section 5 | 5.9 MB for this session. `<enc-cwd>` = absolute cwd with every `/` and `_` replaced by `-` (lossy: do not decode; match by listing directories). |
| S11 | `~/.claude/projects/<enc-cwd>/<sid>/subagents/agent-<aid>.jsonl` + `agent-<aid>.meta.json` | JSONL + JSON | L+R | P2 P4 | meta: `agentType, description, toolUseId, spawnDepth, requestShape, finished`. Lines: `message.model`, `message.usage{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`, `message.id`, `message.stop_reason`, `timestamp` | 15 subagent transcripts for this session. |
| S12 | `UCEF_HOOK_DATA` comments in hook stdout | `<!-- UCEF_HOOK_DATA: {json} -->` | L+R via S10 only | P1 | `hook, step, result, bypass_reason, high_stakes, processing_mode, rough_complexity` | Emitted only by `ucef/hooks/UserPromptSubmit/routing_enforcement.py`. Persisted ONLY inside S10 `attachment.stdout`. 35 occurrences (17 `BYPASSED`, 18 `GUIDANCE_PROVIDED`), all `UserPromptSubmit`. Not in S1. |
| S13 | `<root>/workspaces/<ws>/sessions/<sid>/monitor-events.jsonl` | JSONL, this contract | L+R | all | the v1 event | DOES NOT EXIST YET. To be created by the tiered-hooks branch (section 6). |
| S14 | `~/.claude/debug/<sid>.txt` | text | none | none | hook execution detail | Exists only when launched with `--debug` (docs). Not a contract source. |

SOURCE: `ls` and Python read-only reads on 2026-10-24/25; hooks README section 5a; `unified-trace-schema.md`.

DB access notes. SOURCE: `sqlite3 'file:<path>?mode=ro' .tables` exited 1 with "unable to open database file" on this
machine (cause unverified, ASSUMPTION: CLI built without URI support). Python `sqlite3.connect('file:<path>?mode=ro', uri=True)`
worked. Monitors MUST open with the read-only URI form `file:<path>?mode=ro` (plus `PRAGMA query_only=ON` where the driver supports it), MUST NOT fall back to a plain
path, and MAY fall back to `file:<path>?mode=ro&immutable=1` ONLY when `mode=ro` fails. `immutable=1` tells SQLite the file cannot change, so on a live database it can return stale or inconsistent pages; therefore the fallback MUST be labeled: the `ucef_db` health entry carries `read_mode: "snapshot"` (rule 8, spec_revision 1.1). Monitors MUST treat S3 as best-effort: the DB still accepted writes after the failed migration (newest
`monitoring_events` row 2026-10-25T05:38), so "degraded" means untrusted, not empty.

Degraded-DB signals (any one marks `ucef_db` as `degraded`): `alembic_version` has zero rows; S4 contains `UCEF DEGRADED-DB`;
S10 contains an `attachment.type = hook_system_message` starting `[session-start] step database_migration failed`;
`ucef_data.db.migrate.lock` exists.

### 1.1 Redacted sample, one real record per source (ids shortened, content truncated)

```text
S1  {"schema_version":"1.0.0","timestamp":"2026-10-25T05:39:03.416409+00:00","event_type":"atom_outcome","session_id":"95401a50...","workspace_id":"multi-agent-framework_feat-hook-orchestration-bypass","agent_invoked":"a51f6cbf054a201d9","quality_gate_result":{"gate":"error_detection","passed":true},"atom_id":"a51f6cbf054a201d9","atom_outcome":"succeeded","extra":{"agent_id":"a51f6cbf054a201d9"}}
S1  {"event_type":"completion_gate","agent_invoked":"ucef-core:meta:completion-verification-agent","quality_gate_result":{"gate":"completion","source":"verifier","score":0.9,"threshold":0.92,"passed":false,"status":"fail"},"extra":{"verification_status":"failed"}}
S1  {"event_type":"hook_step_report","hook":"subagent-stop","step":"gate_counters","atom_id":null,"violations":["cva_cycles:unkeyed"],"details":{"cva_cycles":0}}
S3  monitoring_events | 2026-10-25 05:38:36.887360 | 95401a50... | {"event_type":"tool_use","tool_name":"Bash","duration_ms":120058.0,"success":true,...}
S5  {"authored_provenance":"inferred","authored_status":"option","authored_value":"convergent","point_id":"stability_mode_selection","question_id":"stability_mode","question_digest":"b74fcd35...","recorded_at":"2026-10-25T03:48:25Z","session_id":"95401a50...","supplied_status":"none"}
S6  INFO 2026-10-25T05:36:40Z deny_capability=unavailable reason=missing_dep:shfmt        (payload blocks above it are NOT safe to read)
S7  {"timestamp":"2026-10-25T05:39:05.203199+00:00","hook":"subagent-stop","step":"conversation_lifecycle","exception_type":"Exception","message":"Conversation closure incomplete for unknown (agent_id=ab91c546...","session_id":"8ad03fd5-..."}
S8  {"atom_id":"scott-v12-cva","agent_type":"ucef-core:meta:completion-verification-agent","task_complexity":0.48,"claimed_by":"a9b60dba29e8c2a5d"}
S10 {"type":"attachment","attachment":{"type":"hook_success","hookEvent":"UserPromptSubmit","hookName":"UserPromptSubmit","exitCode":0,"durationMs":<n>,"stdout":"... <!-- UCEF_HOOK_DATA: {\"hook\": \"user-prompt-submit\", \"step\": \"routing_enforcement\", \"result\": \"BYPASSED\", \"bypass_reason\": \"short_prompt\", ...} -->"}}
S10 {"type":"system","subtype":"stop_hook_summary","hookCount":3,"hookInfos":[{"command":"${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.sh","durationMs":425},{"command":"<prompt text...>","promptText":"<prompt text...>"}],"hookErrors":[],"preventedContinuation":false,"stopReason":""}
S10 {"type":"user","isMeta":true,"message":{"role":"user","content":"Stop hook feedback:\n[<hook identifier>]: <reason>"}}
S11 {"agentType":"ucef-core:meta:completion-verification-agent","description":"Phase 4.1 CVA on ...","toolUseId":"toolu_01LKNV...","spawnDepth":1,"requestShape":"background","requestNonInteractive":true,"finished":true}
S11 assistant line: message{id:"msg_011CgN...",model:"claude-opus-5-5",stop_reason:null|"tool_use"|"end_turn",usage{input_tokens:2,cache_creation_input_tokens:48223,output_tokens:3,service_tier:"standard"}}
```

S12 sample: `<!-- UCEF_HOOK_DATA: {"hook": "user-prompt-submit", "step": "routing_enforcement", "result": "GUIDANCE_PROVIDED", "processing_mode": "...", "rough_complexity": ...} -->`
(SOURCE: S10 `hook_success` attachments).

Real-data hazards found while sampling (all SOURCE: measured):

1. S1 `phase` and `model_id` are null on every line, and `grading_signal` records `cannot_verify_reason: model_id_not_available`. Model tier and phase position MUST come from S10/S11/S8, not S1.
2. S1 `agent_delegation` rows in the live session file (197 at the second read; the file is still being appended to, so every count in this document is point-in-time): 165 stop rows carry the placeholder `agent_invoked: "stop"` with no tokens; 14 stop rows carry the real agent type, `input_tokens`, `output_tokens`, `cache_tokens`, `request_id`; 18 start rows have no `extra.lifecycle`. ASSUMPTION: the placeholder rows are re-fires and carry no information beyond "a stop hook ran".
3. S1 `atom_outcome.atom_id` is the hex agent id in 418 of 499 rows (84%) and a semantic atom id in 81. Join to S8 by `claimed_by` to obtain the semantic id.
4. S11 assistant lines repeat per content block: the sampled transcript had 31 assistant lines for 14 distinct `message.id`, and `cache_creation_input_tokens` repeats on each. Summing lines over-counts. Rule: group by `message.id`, take the line with the largest `output_tokens`, then sum groups.
5. S10 hook stdout can contain terminal escape sequences (observed OSC 777 `terminalSequence` JSON from a third-party plugin). Never print raw stdout to a terminal.
6. S3 `decision_events` has no writer (SOURCE: docstring of `ucef/shared/database/orm/models/decision.py`: "The table has no writer ... it stays empty").
7. S3 `phase_transitions` rows hold agent state names (`completed` to `active`), not the 8-phase position, so it is unusable for P3.

---

## 2. Check of `unified-trace-schema.md` (tsv1) against real files

Verdict: DESIGN-ONLY. Its own Status section says "No production code accompanies this document".

| tsv1 element | Real-file finding | Contract decision |
|---|---|---|
| `trace_schema_version`, `event_id`, `wave_index` | Zero occurrences in all 14 S1 files (5,990 lines) and in `plugins/ucef-core/ucef/**/*.py` | Not reused. v1 uses `schema_version` (wire) and a producer/adapter-assigned `event_id`. `wave_index` is excluded (nothing produces it). |
| Join key `session_id` | Present on every S1/S3/S5/S7/S10 record | REUSED as envelope `session_id`. |
| Join key `atom_id` | S1: only `atom_outcome`/`grading_signal`/some `hook_step_report`. Hex agent id in 84% of `atom_outcome` rows (section 1 hazard 3) | REUSED as nullable `atom_id`; adapters resolve it via S8 and the `UCEF_ATOM:` first line of `Agent` dispatch prompts (SOURCE: 25 `Agent` dispatch prompts in the sampled transcript begin with it; the total number of dispatches was not counted). |
| `workspace_id` | Present on S1/S3/S5(no)/S7(dir) | REUSED (nullable). |
| `phase`, `model_id` hook-populated | Never populated (0 of 5,990) | Contradicts tsv1 section 2.1 ("often null"). Contract takes them from S8/S10/S11. |
| `duration_ms ?? extra.duration_ms` | `tool_use`: top-level populated 2,123/2,123. `tool_call_result`: top-level 159/2,123, `extra.duration_ms` otherwise | Rule confirmed; adapters MUST coalesce. |
| Event types listed | Real files also contain `hook_step_report` (54), `completion_gate` (1), `session_quality_grade` (11), `field_stability_coverage_audit` (11), `session_end` (11) | Adapter table (section 5) covers the first two; the rest are out of v1 scope. |
| Reject-unknown versions (V-3), field-presence detection (V-1) | Design only | ADOPTED: consumers reject-and-count lines whose `schema_version` is not exactly `"1"`. Detection by presence of the `schema_version` key with a string value is safe here because S1 uses `schema_version: "1.0.0"`, which is also rejected by `const "1"`. |
| Additive-vs-breaking (V-2) | Design only | ADOPTED: new optional fields are additive within v1; the closed-world schema is the producer-side gate, consumers tolerate unknown keys. |

SOURCE: `grep`-equivalent Python scans of all `orchestration-audit.jsonl` files; `grep -rln` over `plugins/ucef-core/ucef` for `trace_schema_version|tsv1` returned nothing.

---

## 3. Prompt and agent hook verdict visibility

### 3.1 What the Claude Code docs state

SOURCE: https://code.claude.com/docs/en/hooks.md (fetched 2026-10-24), sections "Hook handler fields", "Prompt-based hooks",
"Agent-based hooks", "PreToolUse decision control", "PostToolUseFailure", "PermissionDenied", "Stop".

- `model` is supported on prompt hooks: "`model` | no | Model to use for evaluation. Defaults to the model Claude Code uses for background functionality" (Prompt hook configuration table).
- Agent hooks: "The configuration fields are the same as prompt hooks, except that agent hooks have a longer default timeout of 60 seconds and no `continueOnBlock` field" (Agent hook configuration). So `model` applies to agent hooks as well. Agent hooks are labelled experimental. Up to 50 turns.
- Both are valid on `PreToolUse`, `Stop`, `SubagentStop` (and other events). `PermissionRequest` accepts prompt but not agent hooks.
- `if` is a common field for all hook types (`"Bash(git push *)"`), evaluated on tool events only, best-effort; the docs advise using the permission system, not hooks, for hard enforcement.
- Response schema: `{"ok": true|false, "reason": "...", "impossible": true|false}`. On `Stop`/`SubagentStop`, `ok:false` feeds the reason back and the turn continues (unless `impossible:true`). On `PreToolUse`, `ok:false` denies the call; for prompt hooks the turn ends by default and the reason shows as a warning line, with `continueOnBlock:true` the reason returns to Claude as the tool error. An agent hook on `ok:false` behaves like a prompt hook with `continueOnBlock:true`.
- Docs on visibility: stdout of a successful command hook "is never shown in the transcript and is recorded in the debug log" (JSON output table, `suppressOutput` row); for `Stop` the transcript "labels it `Stop hook feedback`"; `stop_hook_active` is `true` on a Stop hook input "when Claude Code is already continuing as a result of a stop hook"; `PermissionDenied` does not fire when a `PreToolUse` hook blocks a call; `PostToolUseFailure` does not fire for permission denials.

### 3.2 What is actually on disk (Claude Code 2.1.306)

SOURCE: measured on the session transcript `95401a50-...jsonl` (5.9 MB, 587 attachments) and on three transcripts from other projects that contain blocked-stop records.

DISCREPANCY: the docs say successful hook stdout is not shown in the transcript, but the on-disk JSONL persists it. `attachment.type` values `hook_success` (407), `hook_non_blocking_error` (3), `hook_system_message` (1), `hook_additional_context` (2) carry `hookEvent, hookName, command, exitCode, durationMs, stdout, stderr`. This is how S12 (`UCEF_HOOK_DATA`) is observable. The format is undocumented, so treat it as unstable (CANNOT_VERIFY across versions).

For prompt-type hooks the following is observable:

| Evidence | Where | What it gives |
|---|---|---|
| Hook presence | `system/stop_hook_summary.hookInfos[]` entry `{command: <prompt text>, promptText: <prompt text>}` | That a prompt hook ran on this Stop. NO `durationMs`, NO model, NO verdict, NO tokens. |
| `ok:false` | Next `user` entry with `isMeta: true`, content `Stop hook feedback:\n[<identifier>]: <reason>`. The bracketed identifier is the prompt text (257 chars in the sample) | Verdict `not_done` and the reason. |
| `ok:true` | Nothing beyond the `hookInfos` entry | Verdict `ok` only by absence of feedback. |
| `preventedContinuation` | `stop_hook_summary` | Observed `false` even on turns that received feedback, so it is NOT a block indicator. |

Agent-type hooks: no local transcript contains one. CANNOT_VERIFY how an agent hook (and a `PreToolUse` `ok:false` denial) is rendered in the transcript. ASSUMPTION: the reason arrives as an error `tool_result` for that `tool_use_id` (consistent with the docs' "returned to Claude as the tool error").

CANNOT_VERIFY: the model that actually served a prompt/agent hook, its latency and token cost. None of the observed entries contain them. Whether the hook's LLM call is visible through OpenTelemetry (docs mention `prompt.id` correlation) was not checked.

ASSUMPTION: the `Stop hook feedback` entries examined came from a prompt-type hook because `hookInfos` shows a `promptText` field. The hook configuration producing them was not readable from here.

### 3.3 Can a monitor observe verdicts? Options

| Mechanism | Verdict | Model | Latency | Tokens/cost | Reason | Fidelity label |
|---|---|---|---|---|---|---|
| A. Transcript reconstruction (S10/S11) | yes for Stop/SubagentStop (`ok` by absence, `not_done` by feedback); PreToolUse agent hook unverified | no | no | no | yes for `ok:false` | `provenance: inferred` |
| B. Sibling command hook on the same event | Cannot see the sibling's verdict. Can see `stop_hook_active=true` (a previous stop was continued by some hook) and, for a `PreToolUse` gate, whether a matching `PostToolUse` for the same `tool_use_id` fires (ASSUMPTION: it does not fire for a denied call) | no | no | no | no | `inferred` |
| C. Replace the judge with a `type: command` wrapper that calls the model and prints the decision JSON itself | exact | exact | exact | exact if the wrapper measures it | yes | `provenance: emitted` |
| D. Debug log (`--debug`) | yes | unverified | unverified | no | yes | Not usable: off by default, text format. |

### 3.4 Recommendation for the tiered-hooks branch

1. Create a new per-session file `monitor-events.jsonl` (S13) in the same directory as `orchestration-audit.jsonl`, written with the same safe-append primitives (`ensure_session_dir`, `append_text`: `O_APPEND|O_NOFOLLOW`, directory 0700). Reuse `workspace_context` so subagent hooks write to the PARENT session's file with `agent_id` set. Details in section 6.
2. Deterministic command guardrails (rm -rf, force push, `.env` read): emit `hook_verdict` (`provenance: emitted`) from inside the hook script BEFORE exiting. A failed telemetry write MUST NOT change the guard's decision or exit code.
3. Haiku `prompt` hooks on Stop/SubagentStop: keep them native (as planned). Monitors reconstruct `ok`/`not_done` via mechanism A and mark them `inferred`. The branch MUST begin every judge prompt with a stable marker line `[hook:<name>]` (pattern `^\[hook:[a-z0-9_-]{1,48}\]`; `<name>` is the `hook_id`, spec_revision 1.1) so that adapters can name and key the hook without carrying the prompt text. The transcript bracket identifier contains the prompt text, which MUST NOT be rendered (section 7).
4. Opus `agent` hook on `PreToolUse` `Bash(git push *)`: choose by what the operator needs.
   - If only allow/block visibility is needed, keep it native and add one `type: command` hook on `PostToolUse` with the same `if` that emits `hook_verdict` `allow` (`emitted`, correlated by `tool_use_id`). A push that never reaches `PostToolUse` is inferred `block`.
   - If the model, latency, turns and cost of the review matter (P4 token and cost totals, plus an audit of a hook that can block pushes), implement the reviewer as a command wrapper (mechanism C) that prints the PreToolUse decision JSON and emits the event. Cost: the native agent-hook toolset and defaults are forfeited. OPEN_QUESTION: how a wrapper invokes a model without re-triggering its own hooks (not verified; do not assume a CLI flag).
5. Whichever option is chosen, adapters MUST dedupe by `dedupe_key`, preferring `emitted` over `derived` over `inferred` (section 4.4).

---

## 4. Normalized event model

One JSON object per line, UTF-8, no BOM, `\n` terminator, at most 4,000 bytes per line (POSIX append atomicity, same bound the audit writer relies on). The schema is closed-world for producers (`additionalProperties: false`); consumers MUST ignore unknown keys when `schema_version` is `"1"`.

### 4.1 Envelope

| Field | Type | Notes |
|---|---|---|
| `schema_version` | const `"1"` | A consumer MUST skip and count any line where this is missing, not a string, or not exactly `"1"` (including `"1.0.0"`, `"2"`, integer `1`). It MUST NOT stop reading. |
| `event_id` | string | Producers: unique. Adapters: `ev_` + first 20 hex of sha256 over `source\|natural-key`, so replays are idempotent. |
| `dedupe_key` | string | REQUIRED on `hook_verdict`, `agent_run`, `phase_gate`, `decision` (1.1); cross-source collapse key, formats in section 4.4. |
| `ts` | RFC 3339 UTC `...Z`, 0-6 fractional digits | Adapters normalize S1 (`+00:00`), S3 (naive UTC with space), S6 (`Z`, seconds), S10 (`Z`, ms). |
| `seq` | int or null | Per-file line counter for emitted events; tie-break after `ts`. |
| `session_id` | string | Raw session id (needed to join transcripts). |
| `workspace_id` | string or null | Key REQUIRED present. |
| `agent_id` | string or null | Subagent id; null for the main session. Key REQUIRED present. |
| `atom_id` | string or null | Semantic atom id, never the hex agent id. Key REQUIRED present. |
| `source` | enum | `monitor_events, audit_jsonl, audit_jsonl_legacy, ucef_db, decision_telemetry, permission_log, hook_failures, transcript, subagent_transcript, atom_registry, adapter` (`adapter` = synthesized in memory by a read-only monitor). |
| `provenance` | enum | `emitted` (producer wrote it at decision time), `derived` (mechanical map of a structured field), `inferred` (heuristic; monitors SHOULD mark these visibly). |
| `kind` | enum | `hook_verdict, agent_run, phase_gate, decision, session_meta` |
| `redaction` | object, optional | `{policy:"v1", level: metadata_only\|truncated\|hashed\|scrubbed, secrets_scrubbed, scrub_classes[], truncated_fields[], hashed_fields[]}` |
| `data` | object | Per-kind (below). |
| `ext` | object, optional | At most 16 keys, `^[a-z][a-z0-9_]{0,39}$`, scalar values, strings limited to 120 chars and subject to the free-text backstop. |

### 4.2 `hook_verdict` (P1)

`hook_event` (PreToolUse, PostToolUse, Stop, SubagentStop, UserPromptSubmit, PermissionRequest, ...), `hook_name`
(emitters and S1/S6/S7 adapters: `<hook>/<step>` or a bare name such as `push-guard`; transcript adapters: exactly the `hook_id` derived in 4.4; unmarked prompt/agent hooks: `prompt-<12 hex>`), `hook_type` (command, prompt, agent, http, mcp_tool, unknown),
`model_tier` (opus, sonnet, haiku, other, unknown for prompt/agent; `none` REQUIRED for command), `verdict`, plus optional
`tool_name, tool_use_id, command_head, input_digest{sha256,len,basis}, reason_code, reason_text (<=240), reason_sha256, latency_ms, exit_code, fail_open, judge{model,impossible,continue_on_block,turns,usage,cost}`.

Verdict enum and semantics:

| `verdict` | Meaning | Valid `hook_event` | Typical source |
|---|---|---|---|
| `allow` | The hook passed the action (tool gate) or the check reported no violations | any | command guards, `hook_step_report` with empty `violations`, PreToolUse agent `ok:true` |
| `block` | The hook denied the action (exit 2 or deny decision or `ok:false` on PreToolUse) | PreToolUse, PermissionRequest, others | command guards, Opus reviewer |
| `warn` | Non-blocking problem or lost capability, including fail-open hook crashes (`fail_open: true`) and `deny_capability=unavailable` | any | S7, S6, `hook_non_blocking_error` |
| `bypass` | Routing hook intentionally did not intervene | UserPromptSubmit, Other | S12 `BYPASSED` |
| `guidance` | Routing hook supplied guidance | UserPromptSubmit, Other | S12 `GUIDANCE_PROVIDED` |
| `ok` | Stop judge accepted the stop (`ok:true`) | Stop, SubagentStop, Other | prompt hooks |
| `not_done` | Stop judge refused the stop (`ok:false`); the turn continues | Stop, SubagentStop, Other | prompt hooks |

An adapter MUST NOT emit a `hook_verdict` whose verdict it cannot determine. Command hooks that exit 0 with no decision map to `allow` on tool events and `ok` on Stop events. To keep volume manageable (407 `hook_success` attachments in one session), monitors SHOULD aggregate `allow` and `ok` into counters and list non-`allow` rows individually.

### 4.3 Other kinds

- `agent_run` (P2): `agent_type`, `lifecycle` (start\|stop), `status` (running\|succeeded\|failed\|cancelled\|unknown; `start` REQUIRES `running`, `stop` forbids it), `model_id`, `model_tier` (opus\|sonnet\|haiku\|other\|unknown), `model_source` (transcript_message_model\|agent_definition\|dispatch_override\|unknown), `started_at, ended_at, duration_ms, usage, cost, spawn_depth, parent_agent_id, background, tool_calls, stop_reason`, `description` (<=120, scrubbed). `usage{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_tokens (combined, when only a total is known), basis}`. `cost{usd, basis: reported\|estimated\|unknown, price_table_version}`; `estimated` REQUIRES a numeric `usd` and a `price_table_version`. Tier derivation: lower-case `model_id` containing `opus`, `sonnet` or `haiku`; any other non-null id is `other`; null is `unknown`.
- `phase_gate` (P3): `phase` in `1, 1.5, 2, 3, 4, 5, 5.5, 6` (the 8 lifecycle phases; Phase 4 covers 4.1 completion and 4.2 constitutional), `transition` (enter\|exit\|gate_result\|skipped), and only true gate sources (completion, constitutional, field_stability, consensus, error_detection as reported by a gate producer; never an `atom_outcome`) produce `gate_result` rows. For `gate_result` REQUIRED `gate` (completion\|constitutional\|field_stability\|consensus\|error_detection) and `status` (pass\|fail\|unknown), with optional `score`, `threshold` (0..1), `stability_mode`, `checkpoint` (e.g. `post_phase_3`), `reason_code`. Thresholds from `.claude/CLAUDE.md`: completion above 0.92, constitutional above 0.97, field stability 0.9/0.7 by mode (SOURCE: project instructions). Monitors display the threshold carried by the event, never a hardcoded one.
- `decision` (P4): `tier` (deterministic\|jev\|llm), `decision_class`, `question_id`, `value` (a closed-vocabulary token `^[A-Za-z0-9][A-Za-z0-9_.:+/-]{0,63}$`, number, boolean or null; free text is never carried), `value_provenance`, `confidence`, `floor` (0..1), `latency_ms`, `provider`, `model_id`, `path` (fast_path_accept\|fallback_llm\|deny\|defer), `fallback_reason` (below_floor, no_corroboration, registry_miss, unavailable, breaker_open, canary_failed), `call_status` (the code's `DecisionTier` outcome values), `state_digest` (sha256), `usage`, `cost`. Tier derivation (ASSUMPTION; the code has no field named deterministic/jev/llm): provider `jev_sdk` or `laya_mlx` answering with `fast_path_accept`, `deny` or `defer` is `jev`; `fallback_llm` is `llm`; provider `null`/absent, a bank default, or `authored_provenance: defaulted` is `deterministic`; authored values with provenance `inferred` or `supplied` are `llm` (the orchestrating model authored them).
- `session_meta`: `lifecycle` (start\|end\|health), `model_id`, `model_tier`, `claude_version`, `git_branch`, `project_ref` (basename only), `duration_ms`, `success`, and `sources[]{source, state: ok\|degraded\|missing\|unreadable\|schema_mismatch\|stale, reason_code, last_event_ts}` (REQUIRED, non-empty when `lifecycle` is `health`).

### 4.4 Natural keys and precedence

`dedupe_key` is REQUIRED on `hook_verdict`, `agent_run`, `phase_gate` and `decision` (schema-enforced), at most 128 characters, and the formats below are mandatory for every implementation. `contract_tool.py` function `canonical_key` is the reference and the validator checks every fixture line against it.

| Kind | `dedupe_key` (spec_revision 1.1) |
|---|---|
| hook_verdict | `hv\|<hook_event>\|<tool_use_id>\|<hook_id>` |
| agent_run | `ar\|<agent_id>\|<lifecycle>` |
| phase_gate | `pg\|<phase>\|<transition>\|<gate or ->\|<atom_id, else agent_id, else ->` |
| decision | `dc\|<decision_class>\|<question_id or ->\|<digest>`, where `<digest>` is the first 16 hex of `state_digest`, else `t` plus the digits of `ts` |

`hook_id` rules:

| Producer | `hook_id` |
|---|---|
| Emitters (and S1/S6/S7 adapters) | The part of `hook_name` before the first `/`: `pre-tool-use/command_guardrails` gives `pre-tool-use`; `push-guard` gives `push-guard`. |
| Transcript adapters | Lower-cased basename of the attachment's `command`, extension stripped, sanitized to `[a-z0-9][a-z0-9_-]{0,31}`; the result is also used as `hook_name`. Tokenize `command` shell-style; take the last token containing `/`, else the first token; basename is the text after the final `/`; strip one trailing `.ext` of at most 5 characters. If `command` is absent, no key is formed and the event is not emitted. The transcript `hookName` (for example `PreToolUse:Bash`) MUST NOT be used: it was identical for 556 of 616 multi-hook tool calls across 6 real transcripts (reported by the conformance check; not re-measured here). |
| Prompt and agent hooks | The `<name>` of the `[hook:<name>]` marker. Without a marker: `prompt-<first 12 hex of sha256(identifier)>`. |

Cardinality: an emitter MUST send at most one event per `(hook_event, tool_use_id, hook_id)`. A hook with several internal rules (for example three guard patterns) reports the deciding rule in `reason_code`.

Correlation id when a hook event has no `tool_use_id` (Stop, SubagentStop, UserPromptSubmit): use the transcript attachment's `toolUseID` when the producer is a transcript adapter (it is present on these events in the sampled transcript); otherwise `n<seq>`. Events keyed by `n<seq>` do not collapse across sources. ASSUMPTION: this fallback is not in the coordinator's rule and needs owner confirmation (OPEN_QUESTION 7).

Collapse: when two events share a `dedupe_key`, keep `emitted` over `derived` over `inferred`; for equal provenance keep the later `ts`. Fields missing on the winner MAY be filled from the loser only for `usage`, `cost`, `model_id`. Two different `hook_id` values on one `tool_use_id` are two rows (fixture cases b and c); the same `hook_id` reported by an emitter and by the transcript is one row (case a).

---

## 5. Adapter table: raw source field to event field

Adapters live in each monitor; this table is normative. "n/a" = not carried.

### 5.1 S1 `orchestration-audit.jsonl`

| Raw record | Event | Mapping |
|---|---|---|
| `agent_delegation`, no `extra.lifecycle` | `agent_run` start | `agent_type`=`agent_invoked`; `agent_id`=`extra.agent_id`; `ts`=`timestamp`; `status`=`running`; `atom_id` via S8 (`claimed_by == agent_id`); `model_*` from S11 (else `unknown`) |
| `agent_delegation`, `extra.lifecycle=stop`, `agent_invoked != "stop"` | `agent_run` stop | `usage.input_tokens`=`input_tokens`; `usage.output_tokens`=`output_tokens`; `usage.cache_tokens`=`cache_tokens`; `usage.basis`=`audit_record`; `duration_ms`; `status` from the paired `atom_outcome` |
| `agent_delegation`, `agent_invoked == "stop"` | none | Placeholder row (hazard 2); ignore |
| Row-creation rule (rule 2) | | An `agent_run` row is created ONLY by a start delegation (S1 `agent_delegation` without `extra.lifecycle`), an S11 transcript, or an emitted `agent_run`. Any stop or outcome record (`atom_outcome`, named stop, placeholder stop) whose `agent_id` matches none of these MUST NOT create a row; it only fills `status`/`usage` on an existing one, or is dropped. Real data: one conformance run showed about 196 `unknown` rows against 11 real agents. Reference: `agent_rows()` in `contract_tool.py`, fixture `fixtures/raw/s1-orphan-agents.jsonl` (5 raw lines, 1 row). |
| `atom_outcome` | status fill ONLY | Sets `status` on an EXISTING agent row for `extra.agent_id`: succeeded to `succeeded`, failed to `failed`, partial to `failed`. It never creates a row and is NOT a gate: `quality_gate_result{gate:error_detection}` on an `atom_outcome` produces no `phase_gate` (rule 3). `atom_id` resolved through S8. |
| `completion_gate` | `phase_gate` | phase `4`, `gate_result`, `gate: completion`, `status`=`quality_gate_result.status`, `score`, `threshold`, `reason_code`=`quality_gate_result.reason` (sanitized to the token pattern or null); `agent_id`=`extra.agent_id` |
| `hook_step_report` | `hook_verdict` | `hook_event` from `hook` (`pre-tool-use` to PreToolUse, `subagent-stop` to SubagentStop); `hook_name`=`<hook>/<step>`; `hook_type`=command, `model_tier`=none; `verdict`=`warn` if `violations` non-empty (`reason_code`=first violation, lower-cased and sanitized) else `allow`; `atom_id`=`atom_id` |
| `tool_use`, `tool_call_result` | none | Only aggregated into `agent_run.tool_calls` by `extra.agent_id` |
| everything else | none | Out of v1 scope |

### 5.2 S3 `ucef_data.db` (read-only, best-effort)

| Raw | Event | Mapping |
|---|---|---|
| `monitoring_events` `agent_delegation` (`payload.agent_id`, `payload.task_type`) | `agent_run` | Same as S1; prefer S1 when both exist (dedupe) |
| `monitoring_events` `session_end` (`payload.duration_ms`, `success`) | `session_meta` end | `duration_ms`, `success` |
| `decision_events` | `decision` | `id` to `event_id` suffix; `created_at` to `ts`; `path_taken` to `path`; `provider`; `model_id`; `returned_value` to `value` (token-safe only); `returned_confidence` to `confidence`; `floor_in_effect` to `floor`; `latency_ms`; `fallback_reason`; `state_sha256` to `state_digest`; tier per 4.3. Table has 0 rows and no writer, so this adapter is dormant. |
| `phase_transitions` | none | Wrong vocabulary (hazard 7) |
| `alembic_version` empty, or open failure | `session_meta` health | `ucef_db` `degraded`/`unreadable`, `reason_code: migration_failed` or `open_failed` |

### 5.3 S5 `decision-telemetry`

| Raw | Event | Mapping |
|---|---|---|
| `authored.jsonl` line | `decision` | `ts`=`recorded_at`; `decision_class`=`point_id`; `question_id`; `value`=`authored_value` if it matches the token pattern else null; `value_provenance`=`authored_provenance`; `state_digest`=`question_digest`; tier: `defaulted` to deterministic, else llm (ASSUMPTION) |
| `proposals.jsonl` line (absent here; shape from `telemetry/records.py`) | `decision` | `tier` by provider (4.3); `provider`; `model_id`; `latency_ms`; `confidence`=`top1`; `floor`; `value`; `decision_class`=`point_id`; `state_digest`=`question_digest`; `ext.applied`=`applied`. Never carry `state_fields`. |
| `refusals.jsonl`, `captures.jsonl` | none | `captures.jsonl` holds sanitized request state; MUST NOT be read by monitors |

### 5.4 S6 / S7 hook logs

| Raw | Event | Mapping |
|---|---|---|
| S6 `INFO ... deny_capability=unavailable reason=<r>` | `hook_verdict` | PermissionRequest, `permission-request`, command, none, `warn`, `fail_open: true`, `reason_code: deny_capability_unavailable:<r>` (sanitized) |
| S6 `INFO ... defer_reason=<r>` | none (v1) | A defer is neither allow nor block |
| S6 payload blocks | none | Never read (section 1 hazard) |
| S7 `hook-failures.jsonl` line | `hook_verdict` | `hook_event` from `hook`; `hook_name`=`<hook>/<step>`; `warn`; `fail_open: true`; `reason_code: hook_exception`; `ts`; `session_id`; drop `message`, `traceback` (per-row, unchanged) |
| S7 `fail-open-counts.jsonl` line | none per row | COUNTERS (rule 6). Aggregate into the session's `session_meta` health event as `sources[]{source: hook_failures, state: ok, reason_code: fail_open_counters, count: <rows>}`. Never a per-row `warn`. |

### 5.5 S10 / S11 / S12 transcripts

| Raw | Event | Mapping |
|---|---|---|
| `attachment.type=hook_success`, command hook, stdout carries `UCEF_HOOK_DATA` with `result: BYPASSED` | `hook_verdict` | `bypass`; `reason_code`=`bypass_reason`; `latency_ms`=`durationMs`; `exit_code`=`exitCode`; `hook_name` = `hook_id` per section 4.4 (`user-prompt-submit` for command `uv run --script .../user-prompt-submit.py`); the S12 `step` is not part of the key. Parse only the JSON inside the comment; discard the rest of stdout. |
| same, `result: GUIDANCE_PROVIDED` | `hook_verdict` | `guidance`; `reason_code: guidance_provided` |
| `attachment.type=hook_success`, other hook, `exitCode` 0 | `hook_verdict` | `allow` (tool events) or `ok` (Stop); `hook_name` = `hook_id` from the attachment's `command` (section 4.4), NEVER from `hookName`; `tool_use_id` = `toolUseID`; the `command` string itself is NOT carried; no `command` means no event |
| `attachment.type=hook_non_blocking_error` | `hook_verdict` | `warn`, `fail_open: true`, `exit_code`, `latency_ms`; `stderr` NOT carried |
| `system/stop_hook_summary.hookInfos[]` with `promptText` | `hook_verdict` | `hook_type: prompt`; `hook_event` Stop or SubagentStop; `verdict` `ok` unless the next `isMeta` user entry carries `Stop hook feedback:` for it, then `not_done`; `hook_name` = `<name>` of the `[hook:<name>]` marker if present else `prompt-` + first 12 hex of sha256(identifier); `latency_ms` null; `judge.model` null; `provenance: inferred` |
| `user` `isMeta` entry `Stop hook feedback:\n[<id>]: <reason>` | enriches the `not_done` above | `reason_text`=scrub+truncate(reason, 240); `reason_sha256`=sha256 of the scrubbed full reason |
| top-level `permissionDecision{decision, source}` (122 lines, all `accept`) | `hook_verdict` | PermissionRequest; `accept` to `allow`; `source` to `reason_code`; other decision values CANNOT_VERIFY, so do not map them |
| `Agent` tool_use `input.prompt` first line `UCEF_ATOM: atom_id=<id> task_complexity=<c>` | `atom_id` for the run whose `.meta.json` `toolUseId` equals the tool_use `id` | `ext.task_complexity`=`<c>` |
| S11 `.meta.json` | `agent_run` | `agent_type`=`agentType`; `description`=scrub+truncate(120); `spawn_depth`=`spawnDepth`; `background`=(`requestShape == "background"`); stop when `finished == true` |
| S11 assistant lines | `agent_run` stop | `model_id`=`message.model`; `model_tier` per 4.3; `model_source: transcript_message_model`; `usage` per hazard 4 with `basis: per_message_deduped`; `started_at`/`ended_at`=first/last `timestamp`; `duration_ms`=difference; `status`: last `stop_reason` of `end_turn` to `succeeded`, `max_tokens` or `refusal` to `failed`, no final assistant message and `finished` false to `running`, otherwise `unknown`; `tool_calls`=count of `tool_use` blocks |
| `cost` | `agent_run.cost` | Transcripts carry no price. Monitors compute `usd` from a versioned price table they own and set `basis: estimated`, `price_table_version`. CANNOT_VERIFY: current per-model prices, so none are shipped in this contract. |
| `mcp__...__field_stability_measure` tool_use + result | `phase_gate` `gate_result` field_stability | `checkpoint`=`input.phase`; phase from checkpoint (`post_phase_1`=1, `post_phase_1_5`=1.5, `post_phase_2`=2, `post_phase_3`=3, `pre_phase_5`=5); `score`, `threshold`, `stability_mode`, `status` from the result. OPEN_QUESTION: unverified here, the sampled session made 0 such calls and the degraded DB has no `field_stability_events` table. |
| Constitutional verdict | `phase_gate` constitutional | Final assistant message of the `constitutional-ai-agent` run: first fenced `yaml` block `compliance_score` (sample: a run reported 0.858 and `status: rejected`). `provenance: inferred`. Fragile; see OPEN_QUESTION 3. |
| Phase position when no emitted `phase_gate` | `phase_gate` `enter`/`exit` | Inferred from `agent_type`: semantic-context-evaluator to 1; memory-coordinator to 1.5 (before the first task-decomposition-expert) or 5.5 (after Phase 4); task-decomposition-expert to 2; completion-verification-agent and constitutional-ai-agent to 4; all other dispatches to 3; the main-session final answer to 5/6. `provenance: inferred`. |

---

## 6. Transport: `monitor-events.jsonl`, live tail, replay

### 6.1 Writer contract (tiered-hooks branch)

- Path: `<root>/workspaces/<ws>/sessions/<sid>/monitor-events.jsonl`. Subagents write to the parent session's file.
- Primitive: the existing `ensure_session_dir` plus `append_text` (`O_APPEND|O_NOFOLLOW`, directory mode 0700). One `write(2)` per line, line at most 4,000 bytes. If an event exceeds it, drop `ext`, then truncate `reason_text`, never split a line.
- Fail-open for telemetry only: an exception in the writer is swallowed (note once on stderr by exception class name, as `decision-telemetry` does); the guard's own decision is computed first and is unaffected.
- Producers set `provenance: "emitted"`, `source: "monitor_events"`, assign `event_id` (any unique string, UUIDv4 acceptable) and `seq`.
- Opt-out: honor an env switch analogous to `UCEF_DECISION_TELEMETRY` (name is an OPEN_QUESTION for the branch). Off under pytest.

### 6.2 Reader contract (monitors, read-only)

1. Discovery: list `<root>/workspaces/*/sessions/*/` (S9 as an index). The live session is the directory with the newest mtime among S1/S13. Directories named `<sid>__<aid>` are per-agent state, not sessions.
2. Live tail: remember `(inode, offset)`. If size < offset, the file was truncated or rotated: rewind and re-dedupe. Do not consume a final line lacking `\n` (torn write); retry on the next poll. Poll interval 250 ms to 1 s. Never take a lock, never write, never `chmod`.
3. Replay: read S13, S1, S7, S5, S8 fully; read S10/S11 line by line without loading whole files (the main transcript is 5.9 MB, a subagent transcript up to 6.4 MB). Ordering key `(ts, seq or 0, source order)`.
4. Unknown or malformed lines: count per file, show the counter in a status line, skip. A line over 4,000 bytes or invalid UTF-8 is malformed.
5. Rendering: every string from an event is untrusted; strip C0/C1 controls before drawing (section 7).
6. Degraded sources: when a source is missing or unreadable, synthesize a `session_meta` `health` event (`source: adapter`) and keep the other panes running. A pane that depends only on missing sources MUST say "no data source" rather than show zeros.
7. S3 is opened per section 1 (`mode=ro` plus `query_only`; labeled `immutable=1` fallback only if `mode=ro` fails, with `read_mode: snapshot` on the health line), in a short-lived connection; any other error maps to `ucef_db: unreadable`.
8. Inferred phase events (rule 7): an implementation MUST NOT store an `inferred` `enter`/`exit`/`skipped` phase event for a phase once ANY `emitted` phase position event exists for that phase, including when the emitted event arrives later (evict the stored inferred ones). Gate results are unaffected. Non-normative note: one implementation stored 64 phase rows where the reference stores 50; that divergence is now disallowed. Reference: `drop_inferred_phase()`, fixture case g.
9. Counters (rule 6): aggregate `fail-open-counts.jsonl` into the health event; never create a `hook_verdict` from a counter row.

---

## 7. Redaction policy (normative)

Default is metadata only. Nothing in an event is allowed to carry:

| Never carried | Instead |
|---|---|
| Tool input bodies, commands, file contents, prompts, assistant text, hook `stdout`/`stderr`, prompt-hook prompt text, tracebacks, S6 payload blocks, `captures.jsonl` | `command_head` (first token, 32 chars), `input_digest`, `reason_code`, bounded `reason_text` |
| Absolute paths, `cwd`, `transcript_path`, home directories | `project_ref` (basename), or omit |
| Free text in `value` | closed-vocabulary token only |

Pipeline for any free-text field (`reason_text`, `description`, `ext` strings), in this order:

1. Scrub secret-shaped substrings, replacing each with `[REDACTED:<class>]`. Classes and order: `private_key, jwt, api_key, github_token, aws_key_id, bearer, url_userinfo, env_assignment`. Reference regexes are in `contract_tool.py` (`SCRUBBERS`); conformance vectors are in `redaction-vectors.json`. Key-prefix classes are anchored with `\b` because an unanchored `sk-` matched inside `task-decomposition-expert` during testing.
2. Strip controls: tab, newline, CR to a space; drop all other C0 and C1 characters (an OSC 777 terminal sequence was observed in real hook stdout).
3. Truncate to the field limit (240 for `reason_text`, 120 for `description` and `ext` strings), AFTER scrubbing and never inside a `[REDACTED:...]` token.
4. `reason_sha256` is the sha256 of the scrubbed, untruncated text, never of the raw text (a hash of a short secret is brute-forceable).
5. Set `redaction` with `secrets_scrubbed`, `scrub_classes`, `truncated_fields`. `level` is the strongest applied: `scrubbed` > `hashed` > `truncated` > `metadata_only`.

`input_digest.sha256` over a command is verbatim (`basis: verbatim`) so that it matches the `sha256:<hex>:len=<n>` fingerprint in `permission-request.log` (README section 5a). If the scrubber finds a secret in the command, the producer MUST hash the scrubbed command instead and set `basis: scrubbed` (the secret-bearing fixture shows this).

Defense in depth: the schema rejects free text containing control characters or secret-shaped substrings (`$defs/noSecretNoControl`), but its list is narrower than the scrubber (uppercase env names only). Consumers MUST scrub again at render time, MUST NOT render `ext` keys they do not recognise as anything but plain text, and MUST NOT log events at debug level in a shared location.

Known gaps: the scrubber does not detect high-entropy strings without a recognizable prefix (OPEN_QUESTION 5); `accepted_over_redaction` shows that lower-case prose such as `token: refreshed` is redacted, which is acceptable.

---

## 8. Pane to event mapping

| Pane | Kinds | Live source | Replay source | Fields shown |
|---|---|---|---|---|
| P1 hooks + verdicts | `hook_verdict` | S13 (emitted), S12 via S10, S7, S6 INFO | same + S1 `hook_step_report` | `ts, hook_event, hook_name, hook_type, model_tier, verdict, reason_code, latency_ms, provenance` |
| P2 agents + model tier | `agent_run` | S1 start rows + S11 `.meta.json` | + S11 transcripts | `agent_type, model_tier, status, duration_ms, atom_id, usage` |
| P3 phase + gates | `phase_gate` | S1 `completion_gate`, S10 dispatch order | + S13 emitted | position among 8 phases; completion (0.92) and constitutional (0.97) verdicts. A phase with ANY `phase_gate` event, including only a `gate_result`, renders `seen`; only a phase with no event renders `pending` (rule 3; fixture case e). |
| P4 Jev decisions + cost | `decision`; `agent_run.usage/cost` | S5 (`authored.jsonl` only here), S13 | + S3 `decision_events` (empty) | `tier, confidence, latency_ms`. Token and cost TOTALS (rule 5) = sum over finished subagent `agent_run` stop events only, after dedupe. `decision.usage/cost` and `hook_verdict.judge.usage/cost` are shown in separate "decision" and "judge" lines and are never added into the total, because the same tokens may already be counted in an `agent_run` or be outside any subagent. |

Fixtures: `fixtures/normal-session.jsonl` (all four panes), `degraded-db.jsonl` (now with the `fail_open_counters` aggregate and `read_mode: snapshot`), `secret-bearing.jsonl`, `unknown-schema-version.jsonl`, and new in 1.1: `dedupe-cases.jsonl` (cases a, b, c, e, g grouped by `ext.case`; expected rows in `expectations.json`) and `raw/s1-orphan-agents.jsonl` (case d, raw S1 lines, not events). All values are synthetic; model ids such as `claude-haiku-5-0` and every price are placeholders, not claims about real models or rates.

---

## 9. Annotation register (for downstream atoms)

SOURCE
- S-1 hooks docs, prompt/agent `model` field: Prompt hook configuration table; agent hooks share fields (Agent hook configuration).
- S-2 `Stop hook feedback` label and `stop_hook_active`: docs, Stop section.
- S-3 prompt hooks listed in `stop_hook_summary.hookInfos` with `promptText`, no model or duration: measured on 3 transcripts.
- S-4 `UCEF_HOOK_DATA` persisted only in transcript hook attachments; single emitter `routing_enforcement.py`: grep of `plugins/ucef-core/{hooks,ucef/hooks,ucef/shared}` plus 35 transcript occurrences.
- S-5 `decision_events` has no writer and 0 rows; `proposals.jsonl` absent: ORM docstring and `ls`.
- S-6 tsv1 is design-only: zero occurrences of its keys in code and data.
- S-7 `permission-request.log` payload blocks for non-Bash tools are unhashed: observed.

ASSUMPTION
- A-1 `agent_delegation` rows with `agent_invoked: "stop"` are non-informative re-fires.
- A-2 Decision `tier` derivation from `provider`/`path_taken`/`authored_provenance` (section 4.3).
- A-3 A prompt hook's `ok:true` leaves no record beyond `hookInfos`, so `ok` is inferred by absence of feedback.
- A-4 A denied `PreToolUse` call does not fire `PostToolUse` (docs state this only for `PostToolUseFailure`).
- A-5 The `Stop hook feedback` entries examined came from prompt-type hooks.
- A-6 The event shown for an agent-hook denial would be an error `tool_result` for the same `tool_use_id`.

OPEN_QUESTION
- Q-1 Name of the opt-out env switch for `monitor-events.jsonl` (owner: tiered-hooks branch).
- Q-2 How a command wrapper can call a model without re-triggering hooks (owner: tiered-hooks branch).
- Q-3 Constitutional and completion verdicts are only structured for completion (1 `completion_gate` record across 14 files) and there is no constitutional event; should a SubagentStop step emit `phase_gate` events? Until then P3 constitutional is `inferred` from a YAML block.
- Q-4 `field_stability_measure` is the only source for field-stability gates and was not called in the sampled session; confirm the orchestrator emits it before P3 relies on it.
- Q-5 Whether to add an entropy-based scrubber class for prefix-less secrets.
- Q-6 Whether the legacy S2 file should be supported at all (absent here).
- Q-7 (1.1) Correlation id for hook events with no `tool_use_id` (Stop, SubagentStop, UserPromptSubmit): this revision uses the transcript `toolUseID` for transcript adapters and `n<seq>` for emitters, so emitted and transcript rows for the same Stop do not collapse. Owner decision needed on whether emitters can obtain the same id.
- Q-8 (1.1) The "556 of 616 multi-hook tool calls in 6 real transcripts" figure comes from the conformance check and was not re-measured in this revision.
- Q-9 (1.1) The `command` tokenization rule in 4.4 (last token containing `/`, else first) is my specification of "basename of the command"; confirm it against the implementations' hook commands that carry trailing arguments.

CANNOT_VERIFY
- C-1 Transcript hook-attachment format stability across Claude Code versions (only 2.1.306 observed).
- C-2 Model, latency, token cost of prompt/agent hook calls: not present in any observed entry; OpenTelemetry route not checked.
- C-3 Rendering of agent-hook denials in the transcript: no sample exists locally.
- C-4 Other `permissionDecision.decision` values: only `accept` observed.
- C-5 Current per-model prices (no price table is shipped).
- C-6 Cause of the `sqlite3` CLI `file:` URI failure.
- C-7 Content and writer of the legacy `<root>/orchestration-audit.jsonl`.

---

## 10. Conformance

Run from the staging directory (script placed here, executed isolated):

```text
uv run --with jsonschema python3 -I contract_tool.py validate <staging_dir>
python3 -I contract_tool.py verify <staging_dir>
```

`validate` checks: schema metaschema; every fixture line against the schema; per-file expectations in `fixtures/expectations.json` (the unknown-version file MUST have line 1 accepted and lines 2 (`"2"`), 3 (integer `1`) and 4 (`"2"` plus an unknown key) rejected); coverage of all 7 verdicts, 3 model tiers, 3 decision tiers, 8 phases and 3 gate types; absence of raw secrets in fixtures; the redaction vectors; canonical `dedupe_key` on every keyed fixture line (and at most 128 characters); that the normal session collapses to the same number of rows as lines (no accidental merges); the per-case row counts for cases a, b, c, e, g and the raw orphan case d; 20 negative controls and 1 positive control. A new consumer is conformant when it reaches the same accept/reject result on every fixture line and the same scrub output on every vector.
