#!/usr/bin/env python3
"""UCEF Monitor Event Contract v1 - fixture generator, validator, checksum helper.

Usage (run with isolated mode so the script directory is not put on sys.path):
    uv run --with jsonschema python3 -I contract_tool.py gen      <staging_dir>
    uv run --with jsonschema python3 -I contract_tool.py validate <staging_dir>
    python3 -I contract_tool.py sums   <staging_dir>
    python3 -I contract_tool.py verify <staging_dir>

All fixture data is synthetic. Fake secrets are assembled at run time from fragments and are
never written to disk; only their scrubbed form is written.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

MAX_LINE_BYTES = 4000
TEXT_HARD_LIMITS = {"reason_text": 240, "description": 120}

# --------------------------------------------------------------------------------------
# Normative reference scrubber (spec section 7). Order matters.
# --------------------------------------------------------------------------------------
SCRUBBERS = [
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"), "[REDACTED:private_key]"),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}"), "[REDACTED:jwt]"),
    ("api_key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"), "[REDACTED:api_key]"),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}"), "[REDACTED:github_token]"),
    ("aws_key_id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "[REDACTED:aws_key_id]"),
    ("bearer", re.compile(r"\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}"), "Bearer [REDACTED:bearer]"),
    ("url_userinfo", re.compile(r"(://)[^/\s:@\[]+:[^/\s@\[]+@"), r"\1[REDACTED:url_userinfo]@"),
    (
        "env_assignment",
        re.compile(
            r"""\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*)(\s*[=:]\s*)(?!\[REDACTED)[^\s'"]{6,}""",
            re.IGNORECASE,
        ),
        r"\1\2[REDACTED:env_assignment]",
    ),
]


def scrub(text: str) -> tuple[str, dict[str, int]]:
    counts: dict[str, int] = {}
    for name, rx, repl in SCRUBBERS:
        text, n = rx.subn(repl, text)
        if n:
            counts[name] = n
    return text, counts


def strip_controls(text: str) -> str:
    out = []
    for ch in text:
        o = ord(ch)
        if ch in "\t\n\r":
            out.append(" ")
        elif o < 32 or 127 <= o <= 159:
            continue
        else:
            out.append(ch)
    return "".join(out)


def finalize_text(raw: str, limit: int) -> tuple[str, dict[str, int], bool, str]:
    """scrub -> strip controls -> truncate. Returns (text, scrub_counts, truncated, sha256_of_scrubbed_full)."""
    scrubbed, counts = scrub(raw)
    scrubbed = strip_controls(scrubbed)
    full_hash = hashlib.sha256(scrubbed.encode("utf-8")).hexdigest()
    truncated = False
    if len(scrubbed) > limit:
        cut = scrubbed[:limit]
        i = cut.rfind("[")
        if i != -1 and "]" not in cut[i:]:
            cut = cut[:i]
        scrubbed, truncated = cut, True
    return scrubbed, counts, truncated, full_hash


def sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def dumps(obj: object) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=True)


# --------------------------------------------------------------------------------------
# Synthetic fixture builder
# --------------------------------------------------------------------------------------
SID = "3f2a9c1e-7b4d-4e8a-9a51-0c6d2b7e4f10"
WS = "demo-workspace_feat-monitor-contract"
BASE = datetime(2026, 2, 3, 14, 0, 0, tzinfo=timezone.utc)
A_SCE, A_MEM, A_TDE, A_SPEC, A_CVA, A_CON = (
    "a0f1c2d3e4b5a6971", "a1e2d3c4b5a6f7082", "a2d3c4b5a6f7e1093", "a3c4b5a6f7e8d10a4", "a4b5a6f7e8d9c10b5", "a5a6f7e8d9c0b10c6",
)


def hook_id_of(hook_name: str) -> str:
    """spec_revision 1.1 section 4.4: hook_id is the part of hook_name before the first '/'."""
    return hook_name.split("/")[0]


def canonical_key(ev: dict) -> str | None:
    """Normative dedupe_key (spec_revision 1.1 section 4.4). Used by producers and by the validator."""
    d, k = ev["data"], ev["kind"]
    if k == "hook_verdict":
        corr = d.get("tool_use_id") or "n%s" % ev["seq"]
        return f"hv|{d['hook_event']}|{corr}|{hook_id_of(d['hook_name'])}"
    if k == "agent_run":
        return f"ar|{ev['agent_id']}|{d['lifecycle']}"
    if k == "phase_gate":
        return f"pg|{d['phase']}|{d['transition']}|{d.get('gate') or '-'}|{ev['atom_id'] or ev['agent_id'] or '-'}"
    if k == "decision":
        digest = (d.get("state_digest") or "")[:16] or "t" + re.sub(r"\D", "", ev["ts"])
        return f"dc|{d['decision_class']}|{d.get('question_id') or '-'}|{digest}"
    return None


PROVENANCE_RANK = {"emitted": 3, "derived": 2, "inferred": 1}


def collapse(events: list[dict]) -> list[dict]:
    """Reference dedupe: group by dedupe_key, keep best provenance, tie -> later ts."""
    best: dict[str, dict] = {}
    for ev in events:
        key = ev.get("dedupe_key") or ev["event_id"]
        cur = best.get(key)
        if cur is None or (PROVENANCE_RANK[ev["provenance"]], ev["ts"]) > (PROVENANCE_RANK[cur["provenance"]], cur["ts"]):
            best[key] = ev
    return list(best.values())


def drop_inferred_phase(events: list[dict]) -> list[dict]:
    """Rule 7: never store an inferred phase position event once an emitted one exists for that phase."""
    pos = {"enter", "exit", "skipped"}
    emitted = {e["data"]["phase"] for e in events if e["kind"] == "phase_gate" and e["provenance"] == "emitted" and e["data"]["transition"] in pos}
    return [e for e in events if not (e["kind"] == "phase_gate" and e["provenance"] == "inferred" and e["data"]["transition"] in pos and e["data"]["phase"] in emitted)]


def phase_status(events: list[dict], phase: str) -> str:
    """Rule 3: any event for the phase, including only a gate_result, renders as 'seen'."""
    return "seen" if any(e["kind"] == "phase_gate" and e["data"]["phase"] == phase for e in events) else "pending"


def agent_rows(raw_lines: list[dict], transcript_agent_ids: set[str] | None = None) -> dict[str, dict]:
    """Rule 2: rows are created ONLY by a start delegation (or a transcript); outcome/stop records only fill status."""
    rows: dict[str, dict] = {}
    for aid in transcript_agent_ids or ():
        rows[aid] = {"status": "unknown"}
    for r in raw_lines:
        e = r.get("extra") or {}
        aid = e.get("agent_id")
        if r.get("event_type") == "agent_delegation" and not e.get("lifecycle") and r.get("agent_invoked") != "stop" and aid:
            rows.setdefault(aid, {"status": "running"})
    for r in raw_lines:
        aid = (r.get("extra") or {}).get("agent_id")
        if aid in rows:
            if r.get("event_type") == "atom_outcome" and r.get("atom_outcome"):
                rows[aid]["status"] = {"succeeded": "succeeded", "failed": "failed", "partial": "failed"}.get(r["atom_outcome"], "unknown")
            elif r.get("event_type") == "agent_delegation" and (e := r.get("extra") or {}).get("lifecycle") == "stop" and rows[aid]["status"] == "running":
                rows[aid]["status"] = "unknown"
    return rows


class Builder:
    def __init__(self, name: str, session_id: str = SID, workspace_id: str | None = WS, start: datetime = BASE):
        self.name, self.sid, self.ws = name, session_id, workspace_id
        self.clock, self.n, self.lines = start, 0, []

    def tick(self, seconds: float = 1.0) -> str:
        self.clock += timedelta(seconds=seconds)
        return self.clock.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"

    def emit(self, kind, data, *, source, provenance, dt=1.0, agent_id=None, atom_id=None, redaction=None, dedupe=None, ext=None):
        ev = {
            "schema_version": "1",
            "event_id": "ev_" + sha(f"{self.name}:{self.n}")[:20],
            "ts": self.tick(dt),
            "seq": self.n,
            "session_id": self.sid,
            "workspace_id": self.ws,
            "agent_id": agent_id,
            "atom_id": atom_id,
            "source": source,
            "provenance": provenance,
            "kind": kind,
            "data": data,
        }
        key = canonical_key(ev)
        if key:
            ev["dedupe_key"] = key
        if redaction:
            ev["redaction"] = redaction
        if ext:
            ev["ext"] = ext
        self.n += 1
        self.lines.append(ev)
        return ev


def usage(i, o, cr=None, cc=None, basis="per_message_deduped", cache=None):
    u = {"input_tokens": i, "output_tokens": o, "basis": basis}
    if cr is not None:
        u["cache_read_input_tokens"] = cr
    if cc is not None:
        u["cache_creation_input_tokens"] = cc
    if cache is not None:
        u["cache_tokens"] = cache
    return u


def est_cost(usd):
    return {"usd": usd, "basis": "estimated", "price_table_version": "synthetic-v1"}


def hv(event, name, htype, tier, verdict, **kw):
    d = {"hook_event": event, "hook_name": name, "hook_type": htype, "model_tier": tier, "verdict": verdict}
    d.update(kw)
    return d


def agent(atype, lifecycle, status, tier, model_id, **kw):
    d = {"agent_type": atype, "lifecycle": lifecycle, "status": status, "model_tier": tier, "model_id": model_id}
    d.update(kw)
    return d


def build_normal() -> Builder:
    b = Builder("normal-session")
    srcs = [{"source": s, "state": "ok", "reason_code": None, "last_event_ts": None} for s in ("monitor_events", "audit_jsonl", "transcript", "ucef_db", "decision_telemetry")]
    b.emit("session_meta", {"lifecycle": "start", "model_id": "claude-opus-5-5", "model_tier": "opus", "claude_version": "2.1.306",
                            "git_branch": "feat/monitor-contract", "project_ref": "demo-project", "sources": srcs},
           source="transcript", provenance="derived", dt=0.5)
    # Pane 1: UserPromptSubmit routing verdicts (UCEF_HOOK_DATA, command hook)
    # Transcript adapters: hook_name = hook_id = sanitized basename of attachment.command; correlation id = attachment.toolUseID.
    b.emit("hook_verdict", hv("UserPromptSubmit", "user-prompt-submit", "command", "none", "bypass", tool_use_id="5f0c1d2e-0001-4000-8000-000000000001",
                              reason_code="short_prompt", latency_ms=61, exit_code=0),
           source="transcript", provenance="derived")
    b.emit("hook_verdict", hv("UserPromptSubmit", "user-prompt-submit", "command", "none", "guidance", tool_use_id="5f0c1d2e-0001-4000-8000-000000000002",
                              reason_code="guidance_provided", latency_ms=58, exit_code=0),
           source="transcript", provenance="derived")
    # Phase 1 + SCE
    b.emit("phase_gate", {"phase": "1", "transition": "enter"}, source="audit_jsonl", provenance="inferred", dt=2)
    b.emit("agent_run", agent("ucef-core:meta:semantic-context-evaluator", "start", "running", "sonnet", "claude-sonnet-5-5",
                              model_source="transcript_message_model", started_at=b.clock.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z", spawn_depth=1, background=False),
           source="subagent_transcript", provenance="derived", agent_id=A_SCE, dedupe=f"ar|{A_SCE}|start")
    b.emit("hook_verdict", hv("PreToolUse", "pre-tool-use/guard-rm", "command", "none", "allow", tool_name="Bash", tool_use_id="toolu_demo0001",
                              command_head="ls", reason_code="no_match", latency_ms=12, exit_code=0),
           source="monitor_events", provenance="emitted", agent_id=A_SCE, dt=3)
    b.emit("agent_run", agent("ucef-core:meta:semantic-context-evaluator", "stop", "succeeded", "sonnet", "claude-sonnet-5-5",
                              model_source="transcript_message_model", duration_ms=9800, usage=usage(120, 3400, 52000, 9000), cost=est_cost(0.0412),
                              spawn_depth=1, tool_calls=4, stop_reason="end_turn"),
           source="subagent_transcript", provenance="derived", agent_id=A_SCE, dt=10, dedupe=f"ar|{A_SCE}|stop")
    b.emit("decision", {"tier": "deterministic", "decision_class": "routing_band_selection", "question_id": "routing_band", "value": "specialized_agent",
                        "provider": None, "path": None, "latency_ms": 0.4, "confidence": None},
           source="decision_telemetry", provenance="derived", dt=0.2)
    b.emit("phase_gate", {"phase": "1", "transition": "exit"}, source="audit_jsonl", provenance="inferred", dt=0.1)
    b.emit("phase_gate", {"phase": "1", "transition": "gate_result", "gate": "field_stability", "status": "pass", "score": 0.95, "threshold": 0.9,
                          "stability_mode": "convergent", "checkpoint": "post_phase_1"}, source="transcript", provenance="inferred", dt=0.5)
    # Phase 1.5 memory-coordinator (haiku)
    b.emit("phase_gate", {"phase": "1.5", "transition": "enter"}, source="audit_jsonl", provenance="inferred", dt=1)
    b.emit("agent_run", agent("ucef-core:memory:memory-coordinator", "start", "running", "haiku", "claude-haiku-5-0",
                              model_source="agent_definition", spawn_depth=1), source="subagent_transcript", provenance="derived", agent_id=A_MEM, dedupe=f"ar|{A_MEM}|start")
    b.emit("agent_run", agent("ucef-core:memory:memory-coordinator", "stop", "succeeded", "haiku", "claude-haiku-5-0", model_source="agent_definition",
                              duration_ms=4100, usage=usage(60, 900, 8000, 1200), cost=est_cost(0.0031), spawn_depth=1, stop_reason="end_turn"),
           source="subagent_transcript", provenance="derived", agent_id=A_MEM, dt=4, dedupe=f"ar|{A_MEM}|stop")
    b.emit("phase_gate", {"phase": "1.5", "transition": "exit"}, source="audit_jsonl", provenance="inferred", dt=0.1)
    # Phase 2 TDE (opus)
    b.emit("phase_gate", {"phase": "2", "transition": "enter"}, source="audit_jsonl", provenance="inferred", dt=1)
    b.emit("agent_run", agent("ucef-core:meta:task-decomposition-expert", "start", "running", "opus", "claude-opus-5-5",
                              model_source="transcript_message_model", spawn_depth=1), source="subagent_transcript", provenance="derived", agent_id=A_TDE, dedupe=f"ar|{A_TDE}|start")
    b.emit("agent_run", agent("ucef-core:meta:task-decomposition-expert", "stop", "succeeded", "opus", "claude-opus-5-5", model_source="transcript_message_model",
                              duration_ms=31200, usage=usage(300, 7100, 91000, 14000), cost=est_cost(0.5120), spawn_depth=1, stop_reason="end_turn"),
           source="subagent_transcript", provenance="derived", agent_id=A_TDE, dt=31, dedupe=f"ar|{A_TDE}|stop")
    b.emit("phase_gate", {"phase": "2", "transition": "exit"}, source="audit_jsonl", provenance="inferred", dt=0.1)
    # Phase 3: specialist + all hook verdict kinds
    b.emit("phase_gate", {"phase": "3", "transition": "enter"}, source="audit_jsonl", provenance="inferred", dt=1)
    b.emit("agent_run", agent("general-purpose", "start", "running", "sonnet", "claude-sonnet-5-5", model_source="transcript_message_model",
                              spawn_depth=1, background=True, description="Implement the example change"),
           source="subagent_transcript", provenance="derived", agent_id=A_SPEC, atom_id="atom_1", dedupe=f"ar|{A_SPEC}|start")
    b.emit("hook_verdict", hv("PreToolUse", "pre-tool-use/guard-rm", "command", "none", "block", tool_name="Bash", tool_use_id="toolu_demo0002", command_head="rm",
                              input_digest={"sha256": sha("rm -rf /"), "len": 8, "basis": "verbatim"}, reason_code="rm_rf_root", latency_ms=9, exit_code=2),
           source="monitor_events", provenance="emitted", agent_id=A_SPEC, atom_id="atom_1", dt=5)
    b.emit("hook_verdict", hv("PreToolUse", "pre-tool-use/guard-git-force-push", "command", "none", "block", tool_name="Bash", tool_use_id="toolu_demo0003", command_head="git",
                              input_digest={"sha256": sha("git push --force origin main"), "len": 29, "basis": "verbatim"}, reason_code="force_push", latency_ms=8, exit_code=2),
           source="monitor_events", provenance="emitted", agent_id=A_SPEC, atom_id="atom_1", dt=4)
    b.emit("hook_verdict", hv("PreToolUse", "pre-tool-use/guard-env-read", "command", "none", "block", tool_name="Read", tool_use_id="toolu_demo0004",
                              reason_code="env_file_read", latency_ms=7, exit_code=2),
           source="monitor_events", provenance="emitted", agent_id=A_SPEC, atom_id="atom_1", dt=3)
    b.emit("hook_verdict", hv("SubagentStop", "subagent-stop/conversation_lifecycle", "command", "none", "warn", reason_code="hook_exception", fail_open=True, exit_code=1),
           source="hook_failures", provenance="derived", agent_id=A_SPEC, atom_id="atom_1", dt=2)
    # Haiku SubagentStop prompt hook: ok:false then ok:true, transcript-inferred (no model, latency, tokens)
    b.emit("hook_verdict", hv("SubagentStop", "haiku-done-judge", "prompt", "haiku", "not_done",
                              reason_text="Acceptance test output is missing. Run the test command and report the result.", judge={"model": None, "impossible": False, "continue_on_block": None}),
           source="subagent_transcript", provenance="inferred", agent_id=A_SPEC, atom_id="atom_1", dt=6, dedupe=f"hv|SubagentStop|{A_SPEC}|1",
           redaction={"policy": "v1", "level": "scrubbed", "secrets_scrubbed": 0})
    b.emit("hook_verdict", hv("SubagentStop", "haiku-done-judge", "prompt", "haiku", "ok", judge={"model": None}),
           source="subagent_transcript", provenance="inferred", agent_id=A_SPEC, atom_id="atom_1", dt=40, dedupe=f"hv|SubagentStop|{A_SPEC}|2")
    # Opus agent hook on PreToolUse Bash(git push *): wrapper-emitted allow (full fidelity) and transcript-inferred block (reduced fidelity)
    b.emit("hook_verdict", hv("PreToolUse", "opus-push-review", "agent", "opus", "allow", tool_name="Bash", tool_use_id="toolu_demo0005", command_head="git",
                              reason_text="Staged diff matches the stated change. No secrets or unrelated files.", latency_ms=21400,
                              judge={"model": "opus", "turns": 7, "usage": usage(900, 2100, 40000, 6000), "cost": est_cost(0.2874)}),
           source="monitor_events", provenance="emitted", agent_id=A_SPEC, atom_id="atom_1", dt=12, dedupe="hv|PreToolUse|toolu_demo0005")
    b.emit("hook_verdict", hv("PreToolUse", "opus-push-review", "agent", "opus", "block", tool_name="Bash", tool_use_id="toolu_demo0006", command_head="git",
                              reason_text="Staged diff includes an unrelated generated file.", judge={"model": None}),
           source="transcript", provenance="inferred", agent_id=None, atom_id=None, dt=30, dedupe="hv|PreToolUse|toolu_demo0006")
    b.emit("agent_run", agent("general-purpose", "stop", "succeeded", "sonnet", "claude-sonnet-5-5", model_source="transcript_message_model", duration_ms=184000,
                              usage=usage(2200, 31000, 640000, 52000), cost=est_cost(0.9411), spawn_depth=1, background=True, tool_calls=57, stop_reason="end_turn",
                              description="Implement the example change"),
           source="subagent_transcript", provenance="derived", agent_id=A_SPEC, atom_id="atom_1", dt=20, dedupe=f"ar|{A_SPEC}|stop")
    b.emit("phase_gate", {"phase": "3", "transition": "exit"}, source="audit_jsonl", provenance="inferred", dt=0.1)
    b.emit("phase_gate", {"phase": "3", "transition": "gate_result", "gate": "field_stability", "status": "pass", "score": 0.82, "threshold": 0.7,
                          "stability_mode": "consolidating", "checkpoint": "post_phase_3"}, source="transcript", provenance="inferred", dt=0.5)
    # Phase 4: completion fail then pass; constitutional pass
    b.emit("phase_gate", {"phase": "4", "transition": "enter"}, source="audit_jsonl", provenance="inferred", dt=1)
    b.emit("agent_run", agent("ucef-core:meta:completion-verification-agent", "start", "running", "opus", "claude-opus-5-5", model_source="transcript_message_model", spawn_depth=1, background=True),
           source="subagent_transcript", provenance="derived", agent_id=A_CVA, atom_id="cva_1", dedupe=f"ar|{A_CVA}|start")
    b.emit("phase_gate", {"phase": "4", "transition": "gate_result", "gate": "completion", "status": "fail", "score": 0.90, "threshold": 0.92, "reason_code": "below_threshold"},
           source="audit_jsonl", provenance="derived", agent_id=A_CVA, atom_id="cva_1", dt=60)
    b.emit("agent_run", agent("ucef-core:meta:completion-verification-agent", "stop", "succeeded", "opus", "claude-opus-5-5", model_source="transcript_message_model", duration_ms=95000,
                              usage=usage(410, 12800, 210000, 33000), cost=est_cost(0.8123), spawn_depth=1, background=True, stop_reason="end_turn"),
           source="subagent_transcript", provenance="derived", agent_id=A_CVA, atom_id="cva_1", dt=1, dedupe=f"ar|{A_CVA}|stop")
    b.emit("phase_gate", {"phase": "4", "transition": "gate_result", "gate": "completion", "status": "pass", "score": 0.95, "threshold": 0.92},
           source="audit_jsonl", provenance="derived", agent_id=A_CVA, atom_id="cva_2", dt=120)
    b.emit("agent_run", agent("ucef-core:meta:constitutional-ai-agent", "start", "running", "opus", "claude-opus-5-5", model_source="transcript_message_model", spawn_depth=1, background=True),
           source="subagent_transcript", provenance="derived", agent_id=A_CON, atom_id="con_1", dedupe=f"ar|{A_CON}|start")
    b.emit("phase_gate", {"phase": "4", "transition": "gate_result", "gate": "constitutional", "status": "pass", "score": 0.98, "threshold": 0.97},
           source="subagent_transcript", provenance="inferred", agent_id=A_CON, atom_id="con_1", dt=70)
    b.emit("agent_run", agent("ucef-core:meta:constitutional-ai-agent", "stop", "failed", "opus", "claude-opus-5-5", model_source="transcript_message_model", duration_ms=71000,
                              usage=usage(380, 9900, 150000, 21000), cost=est_cost(0.6290), spawn_depth=1, background=True, stop_reason="max_tokens"),
           source="subagent_transcript", provenance="derived", agent_id=A_CON, atom_id="con_1", dt=1, dedupe=f"ar|{A_CON}|stop")
    b.emit("phase_gate", {"phase": "4", "transition": "exit"}, source="audit_jsonl", provenance="inferred", dt=0.1)
    # Phases 5, 5.5, 6
    b.emit("phase_gate", {"phase": "5", "transition": "enter"}, source="audit_jsonl", provenance="inferred", dt=1)
    b.emit("phase_gate", {"phase": "5", "transition": "gate_result", "gate": "field_stability", "status": "pass", "score": 0.94, "threshold": 0.9,
                          "stability_mode": "convergent", "checkpoint": "pre_phase_5"}, source="transcript", provenance="inferred", dt=0.5)
    b.emit("phase_gate", {"phase": "5", "transition": "exit"}, source="audit_jsonl", provenance="inferred", dt=8)
    b.emit("phase_gate", {"phase": "5.5", "transition": "skipped", "reason_code": "complexity_below_threshold"}, source="audit_jsonl", provenance="inferred", dt=1)
    b.emit("phase_gate", {"phase": "6", "transition": "enter"}, source="audit_jsonl", provenance="inferred", dt=1)
    b.emit("phase_gate", {"phase": "6", "transition": "exit"}, source="audit_jsonl", provenance="inferred", dt=3)
    # Pane 4: decisions (deterministic, jev, llm)
    b.emit("decision", {"tier": "jev", "decision_class": "mode_enum_conservative", "question_id": "stability_mode", "value": "convergent", "provider": "jev_sdk",
                        "model_id": "jev-example", "path": "fast_path_accept", "confidence": 0.97, "floor": 0.9, "latency_ms": 41.2, "call_status": "success",
                        "state_digest": sha("synthetic-state-1")},
           source="decision_telemetry", provenance="derived", dt=0.3)
    b.emit("decision", {"tier": "llm", "decision_class": "quality_gate_input", "question_id": "gate_ready", "value": "ready", "provider": "jev_sdk", "model_id": "claude-haiku-5-0",
                        "path": "fallback_llm", "fallback_reason": "below_floor", "confidence": 0.62, "floor": 0.9, "latency_ms": 2312.5, "call_status": "success",
                        "state_digest": sha("synthetic-state-2"), "usage": usage(1200, 80, basis="reported"), "cost": est_cost(0.0007)},
           source="decision_telemetry", provenance="derived", dt=0.3)
    b.emit("decision", {"tier": "deterministic", "decision_class": "register_mode_selection", "question_id": "register_mode", "value": "analytical_technical",
                        "value_provenance": "defaulted", "provider": None, "path": None, "confidence": None, "latency_ms": None},
           source="decision_telemetry", provenance="derived", dt=0.3)
    b.emit("session_meta", {"lifecycle": "end", "duration_ms": 412000, "success": True}, source="transcript", provenance="derived", dt=5)
    return b


def build_degraded() -> Builder:
    b = Builder("degraded-db", session_id="9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d", start=datetime(2026, 2, 4, 9, 30, 0, tzinfo=timezone.utc))
    srcs = [
        {"source": "ucef_db", "state": "degraded", "reason_code": "migration_failed", "last_event_ts": None},
        {"source": "decision_telemetry", "state": "missing", "reason_code": "proposals_log_absent", "last_event_ts": None},
        {"source": "monitor_events", "state": "missing", "reason_code": "not_emitted", "last_event_ts": None},
        {"source": "audit_jsonl", "state": "ok", "reason_code": None, "last_event_ts": None},
        {"source": "transcript", "state": "ok", "reason_code": None, "last_event_ts": None},
        {"source": "permission_log", "state": "ok", "reason_code": None, "last_event_ts": None},
        # Rule 6: fail-open-counts.jsonl rows are counters; they surface here as an aggregate, never as per-row warn verdicts.
        {"source": "hook_failures", "state": "ok", "reason_code": "fail_open_counters", "count": 17, "last_event_ts": None},
    ]
    b.emit("session_meta", {"lifecycle": "health", "sources": srcs}, source="adapter", provenance="derived", dt=0.1)
    b.emit("session_meta", {"lifecycle": "start", "model_id": "claude-opus-5-5", "model_tier": "opus", "claude_version": "2.1.306", "project_ref": "demo-project"},
           source="transcript", provenance="derived", dt=0.2)
    b.emit("phase_gate", {"phase": "3", "transition": "enter"}, source="audit_jsonl", provenance="inferred", dt=5)
    # audit_jsonl has no model_id: tier unknown, cost unknown, usage only from audit record (combined cache tokens)
    b.emit("agent_run", agent("general-purpose", "stop", "succeeded", "unknown", None, model_source="unknown", usage=usage(32, 14182, basis="audit_record", cache=1309117),
                              cost={"usd": None, "basis": "unknown", "price_table_version": None}, stop_reason=None),
           source="audit_jsonl", provenance="derived", agent_id="a9f8e7d6c5b4a3921", atom_id="atom_1", dt=30, dedupe="ar|a9f8e7d6c5b4a3921|stop")
    b.emit("hook_verdict", hv("SubagentStop", "subagent-stop/conversation_lifecycle", "command", "none", "warn", reason_code="hook_exception", fail_open=True, exit_code=1),
           source="hook_failures", provenance="derived", agent_id="a9f8e7d6c5b4a3921", atom_id="atom_1", dt=1)
    b.emit("hook_verdict", hv("PermissionRequest", "permission-request", "command", "none", "warn", tool_name="Bash", reason_code="deny_capability_unavailable:missing_dep_shfmt", fail_open=True),
           source="permission_log", provenance="derived", dt=20)
    b.emit("phase_gate", {"phase": "4", "transition": "gate_result", "gate": "completion", "status": "fail", "score": 0.90, "threshold": 0.92},
           source="audit_jsonl", provenance="derived", agent_id="a8e7d6c5b4a3f9210", atom_id="cva_1", dt=40)
    b.emit("session_meta", {"lifecycle": "health", "sources": [
        # Rule 8: mode=ro failed, labeled immutable=1 fallback used, so the health line says snapshot.
        {"source": "ucef_db", "state": "degraded", "reason_code": "migration_failed", "read_mode": "snapshot", "last_event_ts": None},
        {"source": "audit_jsonl", "state": "ok", "reason_code": None, "last_event_ts": b.clock.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"},
    ]}, source="adapter", provenance="derived", dt=0.1)
    return b


def fake(*parts: str) -> str:
    return "".join(parts)


def build_secret() -> tuple[Builder, list[str]]:
    b = Builder("secret-bearing", session_id="5c4b3a29-1807-4f6e-9d5c-4b3a29180716", start=datetime(2026, 2, 5, 16, 0, 0, tzinfo=timezone.utc))
    notes: list[str] = []

    def hook_with_text(raw, name, htype, tier, verdict, event, **kw):
        text, counts, truncated, full_hash = finalize_text(raw, 240)
        classes = sorted(counts)
        red = {"policy": "v1", "level": "scrubbed", "secrets_scrubbed": sum(counts.values()), "scrub_classes": classes,
               "truncated_fields": ["reason_text"] if truncated else []}
        notes.append(f"{name}: scrubbed={sum(counts.values())} classes={classes} truncated={truncated}")
        b.emit("hook_verdict", hv(event, name, htype, tier, verdict, reason_text=text, reason_sha256=full_hash, **kw),
               source="monitor_events", provenance="emitted", dt=2, redaction=red)

    sk = fake("sk-", "FAKE", "0123456789", "abcdefghij")
    b.emit("session_meta", {"lifecycle": "start", "model_id": "claude-opus-5-5", "model_tier": "opus"}, source="transcript", provenance="derived", dt=0.1)
    hook_with_text(f"Missing credential setup: export OPENAI_API_KEY={sk} then rerun the failing test.", "haiku-done-judge", "prompt", "haiku", "not_done", "SubagentStop",
                   judge={"model": "haiku"}, latency_ms=830)
    hook_with_text(fake("Remote is https://deploy:", "FAKEpass99", "@git.example.invalid/r.git which embeds credentials."), "opus-push-review", "agent", "opus", "block", "PreToolUse",
                   tool_name="Bash", command_head="git", judge={"model": "opus", "turns": 5})
    hook_with_text(fake("Header leaks Authorization: Bearer ", "FAKEtokenFAKEtoken1234", " and id ", "AKIA", "FAKEFAKEFAKE1234", " and ", "ghp_", "FAKEFAKEFAKEFAKEFAKEFAKE1234",
                        " and jwt ", "eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJmYWtlIn0K", ".", "c2lnbmF0dXJl", " and DB_PASSWORD=", "hunter2hunter2"),
                   "opus-push-review", "agent", "opus", "block", "PreToolUse", tool_name="Bash", command_head="curl")
    hook_with_text("Terminal hijack attempt: \x1b]777;notify;x\x07 done " + ("padding " * 40) + fake("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIFAKEBODY\n-----END RSA ", "PRIVATE KEY-----"),
                   "haiku-done-judge", "prompt", "haiku", "not_done", "SubagentStop", judge={"model": None})
    # A command body is never carried; only head + digest. The digest is over the scrubbed command because a secret was found.
    cmd = fake("curl -H 'Authorization: Bearer ", "FAKEtokenFAKEtoken1234", "' https://api.example.invalid/x")
    scrubbed_cmd, counts = scrub(cmd)
    b.emit("hook_verdict", hv("PreToolUse", "pre-tool-use/guard-secret-in-command", "command", "none", "block", tool_name="Bash", command_head="curl",
                              input_digest={"sha256": sha(scrubbed_cmd), "len": len(scrubbed_cmd.encode("utf-8")), "basis": "scrubbed"}, reason_code="secret_in_command", exit_code=2),
           source="monitor_events", provenance="emitted", dt=2,
           redaction={"policy": "v1", "level": "hashed", "secrets_scrubbed": sum(counts.values()), "scrub_classes": sorted(counts), "hashed_fields": ["input_digest"]})
    b.emit("session_meta", {"lifecycle": "end", "success": True}, source="transcript", provenance="derived", dt=3)
    return b, notes


CASE_SID = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d"


def build_cases() -> Builder:
    """spec_revision 1.1 conformance cases a, b, c, e, g. Events carry ext.case so a harness can group them."""
    b = Builder("dedupe-cases", session_id=CASE_SID, start=datetime(2026, 2, 6, 10, 0, 0, tzinfo=timezone.utc))
    guard = lambda tool_use, verdict, **kw: hv("PreToolUse", "pre-tool-use/command_guardrails", "command", "none", verdict, tool_name="Bash", tool_use_id=tool_use, **kw)
    # (a) emitted + transcript verdict from the SAME hook on one tool_use_id -> 1 row, emitted wins.
    b.emit("hook_verdict", guard("toolu_v11a", "block", command_head="rm", reason_code="rm_rf_root", latency_ms=9, exit_code=2),
           source="monitor_events", provenance="emitted", ext={"case": "a"})
    b.emit("hook_verdict", hv("PreToolUse", "pre-tool-use", "command", "none", "block", tool_name="Bash", tool_use_id="toolu_v11a", exit_code=2, latency_ms=31),
           source="transcript", provenance="derived", ext={"case": "a"})
    # (b) two distinct hooks (transcript command basenames) on one tool_use_id -> 2 rows.
    b.emit("hook_verdict", hv("PreToolUse", "pre-tool-use", "command", "none", "allow", tool_name="Bash", tool_use_id="toolu_v11b", exit_code=0, latency_ms=22),
           source="transcript", provenance="derived", ext={"case": "b"})
    b.emit("hook_verdict", hv("PreToolUse", "push-guard", "command", "none", "allow", tool_name="Bash", tool_use_id="toolu_v11b", exit_code=0, latency_ms=18),
           source="transcript", provenance="derived", ext={"case": "b"})
    # (c) emitted guardrail + emitted push-guard on one tool_use_id -> 2 rows.
    b.emit("hook_verdict", guard("toolu_v11c", "allow", command_head="git", reason_code="no_match", latency_ms=8, exit_code=0),
           source="monitor_events", provenance="emitted", ext={"case": "c"})
    b.emit("hook_verdict", hv("PreToolUse", "push-guard", "command", "none", "block", tool_name="Bash", tool_use_id="toolu_v11c", command_head="git", reason_code="force_push", latency_ms=12, exit_code=2),
           source="monitor_events", provenance="emitted", ext={"case": "c"})
    # (e) a phase whose only event is a gate_result renders 'seen'; a phase with no event is 'pending'.
    b.emit("phase_gate", {"phase": "4", "transition": "gate_result", "gate": "completion", "status": "fail", "score": 0.9, "threshold": 0.92},
           source="audit_jsonl", provenance="derived", atom_id="cva_9", ext={"case": "e"})
    # (g) rule 7: an emitted phase event exists, so inferred position events for that phase are not stored.
    b.emit("phase_gate", {"phase": "2", "transition": "enter"}, source="monitor_events", provenance="emitted", ext={"case": "g"})
    b.emit("phase_gate", {"phase": "2", "transition": "enter"}, source="audit_jsonl", provenance="inferred", ext={"case": "g"})
    b.emit("phase_gate", {"phase": "2", "transition": "exit"}, source="audit_jsonl", provenance="inferred", ext={"case": "g"})
    return b


def build_raw_orphans() -> list[str]:
    base = {"schema_version": "1.0.0", "session_id": CASE_SID, "workspace_id": WS}
    a, orphan_b, orphan_c, orphan_d = "a7000000000000001", "a7000000000000002", "a7000000000000003", "a7000000000000004"
    rows = [
        {**base, "timestamp": "2026-02-06T10:00:00.000000+00:00", "event_type": "agent_delegation", "agent_invoked": "general-purpose", "extra": {"agent_id": a}},
        {**base, "timestamp": "2026-02-06T10:00:09.000000+00:00", "event_type": "atom_outcome", "agent_invoked": a, "atom_id": a, "atom_outcome": "succeeded", "extra": {"agent_id": a}},
        {**base, "timestamp": "2026-02-06T10:00:10.000000+00:00", "event_type": "atom_outcome", "agent_invoked": orphan_b, "atom_id": orphan_b, "atom_outcome": "succeeded", "extra": {"agent_id": orphan_b}},
        {**base, "timestamp": "2026-02-06T10:00:11.000000+00:00", "event_type": "agent_delegation", "agent_invoked": "stop", "extra": {"lifecycle": "stop", "agent_id": orphan_c}},
        {**base, "timestamp": "2026-02-06T10:00:12.000000+00:00", "event_type": "agent_delegation", "agent_invoked": "general-purpose", "input_tokens": 10, "output_tokens": 20, "extra": {"lifecycle": "stop", "agent_id": orphan_d}},
    ]
    return [dumps(r) for r in rows]


def build_unknown(valid_line: dict) -> list[str]:
    ok = dict(valid_line)
    ok["event_id"] = "ev_" + sha("unknown:0")[:20]
    future = json.loads(json.dumps(ok))
    future["event_id"] = "ev_" + sha("unknown:1")[:20]
    future["schema_version"] = "2"
    wrong_type = json.loads(json.dumps(ok))
    wrong_type["event_id"] = "ev_" + sha("unknown:2")[:20]
    wrong_type["schema_version"] = 1
    future_extra = json.loads(json.dumps(future))
    future_extra["event_id"] = "ev_" + sha("unknown:3")[:20]
    future_extra["new_field_in_v2"] = {"anything": True}
    return [dumps(ok), dumps(future), dumps(wrong_type), dumps(future_extra)]


def write_lines(path: Path, lines: list[str]) -> None:
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def cmd_gen(root: Path) -> int:
    fx = root / "fixtures"
    fx.mkdir(exist_ok=True)
    normal = build_normal()
    degraded = build_degraded()
    secret, notes = build_secret()
    write_lines(fx / "normal-session.jsonl", [dumps(e) for e in normal.lines])
    write_lines(fx / "degraded-db.jsonl", [dumps(e) for e in degraded.lines])
    write_lines(fx / "secret-bearing.jsonl", [dumps(e) for e in secret.lines])
    valid = next(e for e in normal.lines if e["kind"] == "hook_verdict" and e["data"]["verdict"] == "allow")
    write_lines(fx / "unknown-schema-version.jsonl", build_unknown(valid))
    cases = build_cases()
    write_lines(fx / "dedupe-cases.jsonl", [dumps(e) for e in cases.lines])
    (fx / "raw").mkdir(exist_ok=True)
    write_lines(fx / "raw" / "s1-orphan-agents.jsonl", build_raw_orphans())
    expectations = {
        "normal-session.jsonl": {"lines": len(normal.lines), "invalid_lines": [], "collapsed_rows": len(normal.lines)},
        "dedupe-cases.jsonl": {"lines": len(cases.lines), "invalid_lines": [], "cases": {
            "a": {"rows": 1, "winner_provenance": "emitted"}, "b": {"rows": 2}, "c": {"rows": 2},
            "e": {"rows": 1, "phase_status": {"4": "seen", "5": "pending"}}, "g": {"rows": 1, "winner_provenance": "emitted"}}},
        "raw/s1-orphan-agents.jsonl": {"kind": "raw", "lines": 5, "agent_rows": {"a7000000000000001": "succeeded"}},
        "degraded-db.jsonl": {"lines": len(degraded.lines), "invalid_lines": []},
        "secret-bearing.jsonl": {"lines": len(secret.lines), "invalid_lines": []},
        "unknown-schema-version.jsonl": {"lines": 4, "invalid_lines": [2, 3, 4]},
    }
    (fx / "expectations.json").write_text(json.dumps(expectations, indent=2) + "\n", encoding="utf-8")
    for n in notes:
        print("redaction-note:", n)
    print("generated:", {k: v["lines"] for k, v in expectations.items()})
    return 0


# --------------------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------------------
def load_vectors(root: Path):
    return json.loads((root / "redaction-vectors.json").read_text(encoding="utf-8"))["vectors"]


def cmd_validate(root: Path) -> int:
    from jsonschema import Draft202012Validator
    from jsonschema.exceptions import best_match

    schema = json.loads((root / "ucef-monitor-event.v1.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    print("schema: draft 2020-12 metaschema check OK")
    failures: list[str] = []
    fx = root / "fixtures"
    expectations = json.loads((fx / "expectations.json").read_text(encoding="utf-8"))
    parsed: dict[str, list[dict | None]] = {}

    for name, exp in expectations.items():
        if exp.get("kind") == "raw":
            raw_objs = [json.loads(x) for x in (fx / name).read_text(encoding="utf-8").splitlines()]
            rows = agent_rows(raw_objs)
            got = {k: v["status"] for k, v in rows.items()}
            ok = len(raw_objs) == exp["lines"] and got == exp["agent_rows"]
            print(f"{'PASS' if ok else 'FAIL'} {name} raw_lines={len(raw_objs)} agent_rows={got} orphan_records_ignored={len({(r.get('extra') or {}).get('agent_id') for r in raw_objs} - set(rows))}")
            if not ok:
                failures.append(f"{name}: agent rows {got} != {exp['agent_rows']}")
            continue
        raw = (fx / name).read_bytes()
        if raw.startswith(b"\xef\xbb\xbf"):
            failures.append(f"{name}: BOM present")
        text = raw.decode("utf-8")
        if not text.endswith("\n"):
            failures.append(f"{name}: missing final newline")
        lines = text.split("\n")[:-1]
        objs, invalid = [], []
        for i, line in enumerate(lines, start=1):
            if len(line.encode("utf-8")) > MAX_LINE_BYTES:
                failures.append(f"{name}:{i}: line exceeds {MAX_LINE_BYTES} bytes")
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                failures.append(f"{name}:{i}: not JSON ({exc})")
                objs.append(None)
                continue
            objs.append(obj)
            err = best_match(validator.iter_errors(obj))
            if err is not None:
                invalid.append(i)
                path = "/".join(str(p) for p in err.absolute_path) or "<root>"
                print(f"REJECT {name} line {i}: at {path}: {err.message[:110]}")
        parsed[name] = objs
        status = "PASS" if invalid == exp["invalid_lines"] and len(lines) == exp["lines"] else "FAIL"
        print(f"{status} {name} lines={len(lines)} valid={len(lines) - len(invalid)} invalid={len(invalid)} expected_invalid={exp['invalid_lines']}")
        if status == "FAIL":
            failures.append(f"{name}: expected invalid {exp['invalid_lines']}, got {invalid}")
        if name != "unknown-schema-version.jsonl":
            bad_keys = [i for i, o in enumerate(objs, 1) if o and canonical_key(o) != o.get("dedupe_key")]
            lens = max((len(o.get("dedupe_key", "")) for o in objs if o), default=0)
            print(f"dedupe-key check {name}: noncanonical_lines={bad_keys} max_len={lens}")
            if bad_keys or lens > 128:
                failures.append(f"{name}: noncanonical or over-long dedupe_key {bad_keys}")
            if "collapsed_rows" in exp:
                n_rows = len(collapse([o for o in objs if o]))
                print(f"collapse {name}: {len(objs)} lines -> {n_rows} rows (expected {exp['collapsed_rows']})")
                if n_rows != exp["collapsed_rows"]:
                    failures.append(f"{name}: unexpected collapse {n_rows}")
            for case, cexp in exp.get("cases", {}).items():
                evs = [o for o in objs if o and o.get("ext", {}).get("case") == case]
                rows = collapse(drop_inferred_phase(evs))
                ok = len(rows) == cexp["rows"]
                if "winner_provenance" in cexp:
                    ok = ok and all(r["provenance"] == cexp["winner_provenance"] for r in rows)
                for ph, want in cexp.get("phase_status", {}).items():
                    got_ps = phase_status(evs, ph)
                    ok = ok and got_ps == want
                    print(f"  case {case} phase {ph}: {got_ps} (expected {want})")
                print(f"case {case}: {len(evs)} lines -> {len(rows)} rows (expected {cexp['rows']}) {'OK' if ok else 'FAIL'}")
                if not ok:
                    failures.append(f"{name} case {case}")
        ids = [o["event_id"] for o in objs if isinstance(o, dict) and "event_id" in o]
        if name != "unknown-schema-version.jsonl" and len(ids) != len(set(ids)):
            failures.append(f"{name}: duplicate event_id")
        stamps = [o["ts"] for o in objs if isinstance(o, dict) and "ts" in o]
        if stamps != sorted(stamps):
            failures.append(f"{name}: ts not non-decreasing")

    # Unknown-version line: monitors must reject, and must still accept the neighbouring valid line.
    uv = parsed["unknown-schema-version.jsonl"]
    print("unknown-version check: line1 schema_version=%r accepted; line2 %r rejected (only the version differs); line3 %r (int) rejected; line4 %r plus an unknown key rejected"
          % (uv[0]["schema_version"], uv[1]["schema_version"], uv[2]["schema_version"], uv[3]["schema_version"]))

    # Coverage assertions on the normal session (all four panes).
    ns = [o for o in parsed["normal-session.jsonl"] if o]
    verdicts = {o["data"]["verdict"] for o in ns if o["kind"] == "hook_verdict"}
    want_v = {"allow", "bypass", "guidance", "warn", "block", "ok", "not_done"}
    tiers = {o["data"]["model_tier"] for o in ns if o["kind"] == "agent_run"}
    dtiers = {o["data"]["tier"] for o in ns if o["kind"] == "decision"}
    phases = {o["data"]["phase"] for o in ns if o["kind"] == "phase_gate"}
    gates = {o["data"].get("gate") for o in ns if o["kind"] == "phase_gate" and o["data"]["transition"] == "gate_result"}
    for label, got, want in (("verdicts", verdicts, want_v), ("agent tiers", tiers, {"opus", "sonnet", "haiku"}), ("decision tiers", dtiers, {"deterministic", "jev", "llm"}),
                             ("phases", phases, {"1", "1.5", "2", "3", "4", "5", "5.5", "6"}), ("gates", gates, {"completion", "constitutional", "field_stability"})):
        ok = want <= got
        print(f"coverage {label}: {'OK' if ok else 'MISSING ' + str(sorted(want - got))} {sorted(got)}")
        if not ok:
            failures.append(f"coverage {label}")
    kinds = {o["kind"] for o in ns}
    if kinds != {"hook_verdict", "agent_run", "phase_gate", "decision", "session_meta"}:
        failures.append("normal-session does not cover all kinds")

    # No raw secret-shaped strings anywhere in fixtures (scrubber must be a no-op on fixture text, ignoring placeholders).
    for name in expectations:
        if name == "unknown-schema-version.jsonl":
            continue
        txt = (fx / name).read_text(encoding="utf-8")
        _, counts = scrub(txt)
        print(f"secret-scan {name}: raw secret-shaped matches={sum(counts.values())}")
        if counts:
            failures.append(f"{name}: raw secret-shaped content {counts}")
    sb = [o for o in parsed["secret-bearing.jsonl"] if o]
    total = sum(o.get("redaction", {}).get("secrets_scrubbed", 0) for o in sb)
    classes = sorted({c for o in sb for c in o.get("redaction", {}).get("scrub_classes", [])})
    print(f"secret-bearing: events={len(sb)} secrets_scrubbed_total={total} classes={classes}")
    if total < 8 or len(classes) < 7:
        failures.append("secret-bearing fixture does not exercise enough scrub classes")

    # Normative redaction vectors.
    for v in load_vectors(root):
        raw = "".join(v["input_parts"])
        got, counts = scrub(raw)
        got = strip_controls(got)
        ok = got == v["expected"] and sorted(counts) == sorted(v["classes"])
        print(f"vector {v['name']}: {'OK' if ok else 'FAIL'} -> {got!r}")
        if not ok:
            failures.append(f"vector {v['name']}")

    # Negative controls: each mutation of a valid event must be rejected by the schema.
    base = next(o for o in ns if o["kind"] == "hook_verdict" and o["data"]["verdict"] == "block" and o["data"].get("command_head") == "rm")
    judge_ok = next(o for o in ns if o["kind"] == "hook_verdict" and o["data"]["verdict"] == "ok")
    agent_start = next(o for o in ns if o["kind"] == "agent_run" and o["data"]["lifecycle"] == "start")
    decision = next(o for o in ns if o["kind"] == "decision" and o["data"]["tier"] == "jev")
    text_ev = next(o for o in ns if o["kind"] == "hook_verdict" and o["data"].get("reason_text"))

    def mut(src, fn):
        c = json.loads(json.dumps(src))
        fn(c)
        return c

    negatives = {
        "verdict_deny_not_in_enum": mut(base, lambda c: c["data"].__setitem__("verdict", "deny")),
        "ts_missing_Z": mut(base, lambda c: c.__setitem__("ts", "2026-02-03T14:00:00.000+00:00")),
        "extra_top_level_key": mut(base, lambda c: c.__setitem__("surprise", 1)),
        "kind_data_mismatch": mut(base, lambda c: c.__setitem__("kind", "agent_run")),
        "wrong_schema_version": mut(base, lambda c: c.__setitem__("schema_version", "1.0")),
        "missing_atom_id_key": mut(base, lambda c: c.pop("atom_id")),
        "ok_verdict_on_pretooluse": mut(judge_ok, lambda c: c["data"].__setitem__("hook_event", "PreToolUse")),
        "command_hook_with_model_tier": mut(base, lambda c: c["data"].__setitem__("model_tier", "opus")),
        "agent_start_not_running": mut(agent_start, lambda c: c["data"].__setitem__("status", "succeeded")),
        "decision_tier_not_in_enum": mut(decision, lambda c: c["data"].__setitem__("tier", "rule")),
        "decision_free_text_value": mut(decision, lambda c: c["data"].__setitem__("value", "free text with spaces")),
        "raw_secret_in_reason_text": mut(text_ev, lambda c: c["data"].__setitem__("reason_text", "use " + fake("sk-", "FAKE", "0123456789", "abcdefghij"))),
        "env_assignment_in_reason_text": mut(text_ev, lambda c: c["data"].__setitem__("reason_text", "DB_PASSWORD=" + "hunter2hunter2")),
        "escape_sequence_in_reason_text": mut(text_ev, lambda c: c["data"].__setitem__("reason_text", "bad \x1b]777;x\x07 text")),
        "reason_text_over_240": mut(text_ev, lambda c: c["data"].__setitem__("reason_text", "x" * 241)),
        "estimated_cost_without_table_version": mut(agent_start, lambda c: c["data"].__setitem__("cost", {"usd": 1.0, "basis": "estimated", "price_table_version": None})),
        "hook_verdict_missing_dedupe_key": mut(base, lambda c: c.pop("dedupe_key")),
        "decision_missing_dedupe_key": mut(decision, lambda c: c.pop("dedupe_key")),
        "read_mode_not_in_enum": mut(next(o for o in parsed["degraded-db.jsonl"] if o["kind"] == "session_meta" and o["data"]["lifecycle"] == "health"),
                                     lambda c: c["data"]["sources"][0].__setitem__("read_mode", "live")),
        "health_without_sources": {**json.loads(json.dumps(next(o for o in parsed["degraded-db.jsonl"] if o["kind"] == "session_meta"))), "data": {"lifecycle": "health"}},
    }
    for label, ev in negatives.items():
        err = best_match(validator.iter_errors(ev))
        print(f"negative-control {label}: {'rejected' if err else 'ACCEPTED (BUG)'}")
        if err is None:
            failures.append(f"negative control accepted: {label}")

    # Positive control: a scrubbed placeholder is allowed in free text.
    pos = mut(text_ev, lambda c: c["data"].__setitem__("reason_text", "export OPENAI_API_KEY=[REDACTED:api_key] then rerun"))
    if best_match(validator.iter_errors(pos)) is not None:
        failures.append("positive control rejected: scrubbed placeholder")
    else:
        print("positive-control scrubbed placeholder in reason_text: accepted")

    if failures:
        print("FAILED:")
        for f in failures:
            print("  -", f)
        return 1
    print("ALL CHECKS PASSED")
    return 0


# --------------------------------------------------------------------------------------
# Checksums
# --------------------------------------------------------------------------------------
def staged_files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file() and p.name != "SHA256SUMS" and "__pycache__" not in p.parts)


def cmd_sums(root: Path) -> int:
    rows = [f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(root).as_posix()}" for p in staged_files(root)]
    (root / "SHA256SUMS").write_text("\n".join(rows) + "\n", encoding="utf-8")
    print("\n".join(rows))
    return 0


def cmd_verify(root: Path) -> int:
    listed = {}
    for line in (root / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        digest, rel = line.split("  ", 1)
        listed[rel] = digest
    actual = {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in staged_files(root)}
    bad = [r for r in actual if listed.get(r) != actual[r]] + [r for r in listed if r not in actual]
    for rel in sorted(actual):
        print(("OK   " if rel not in bad else "FAIL ") + rel)
    print("every staged file covered and matching" if not bad else f"MISMATCH: {bad}")
    return 0 if not bad else 1


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in {"gen", "validate", "sums", "verify"}:
        print(__doc__)
        return 2
    root = Path(argv[2])
    return {"gen": cmd_gen, "validate": cmd_validate, "sums": cmd_sums, "verify": cmd_verify}[argv[1]](root)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
