// UCEF data layer for `puffr-dash --ucef`. Read-only: it never writes, locks, chmods or
// migrates anything under the UCEF data root, and never opens a transcript for writing.
// Contract: docs/ucef-monitor/spec.md (event model v1). Builtins plus lib/puffr.js only.
//
// Flow:  sources S1/S3/S5/S6/S7/S8/S10/S11/S12/S13 -> adapters -> contract v1 events
//        -> finalizeEvents (dedupe, order, phase inference) -> summarize (four panes).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const lib = require('../lib/puffr');
const R = require('./ucef-redact');
const PKG = require('../package.json');

const WIRE = '1';
const MAX_LINE_BYTES = 4000;      // contract bound for monitor-events.jsonl lines
const MAX_CARRY_BYTES = 32 << 20; // a line longer than this without a newline is dropped
const PHASES = ['1', '1.5', '2', '3', '4', '5', '5.5', '6'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENT_RE = /^[A-Za-z0-9]{1,64}$/;
const HEX_AGENT = /^[0-9a-f]{17}$/;
const TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/;
const VALUE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:+/-]{0,63}$/;
const KINDS = new Set(['hook_verdict', 'agent_run', 'phase_gate', 'decision', 'session_meta']);
const SOURCES = new Set(['monitor_events', 'audit_jsonl', 'audit_jsonl_legacy', 'ucef_db', 'decision_telemetry',
  'permission_log', 'hook_failures', 'transcript', 'subagent_transcript', 'atom_registry', 'adapter']);
const RANK = { emitted: 3, derived: 2, inferred: 1 };
const HOOK_EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'PermissionDenied', 'SubagentStart', 'SubagentStop', 'Stop', 'PreCompact', 'Notification', 'Other']);
const HOOK_EVENT_OF = { 'session-start': 'SessionStart', 'session-end': 'SessionEnd', 'user-prompt-submit': 'UserPromptSubmit',
  'pre-tool-use': 'PreToolUse', 'post-tool-use': 'PostToolUse', 'post-tool-use-failure': 'PostToolUseFailure',
  'permission-request': 'PermissionRequest', 'permission-denied': 'PermissionDenied', 'subagent-start': 'SubagentStart',
  'subagent-stop': 'SubagentStop', stop: 'Stop', 'pre-compact': 'PreCompact', notification: 'Notification' };
const CHECKPOINT_PHASE = { post_phase_1: '1', post_phase_1_5: '1.5', post_phase_2: '2', post_phase_3: '3', pre_phase_5: '5' };
const HOOK_DATA_RE = /<!--\s*UCEF_HOOK_DATA:\s*(\{[\s\S]*?\})\s*-->/;
const DB_FAIL_MARK = '[session-start] step database_migration failed';
const LIVE_MS = 120000;

class UcefError extends Error { constructor(code, message) { super(message); this.code = code; } }

// ---------- small helpers ----------
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nn = v => { const x = num(v); return x !== null && x >= 0 ? x : null; };
const nint = v => { const x = nn(v); return x === null ? null : Math.round(x); };
const iso = ts => { const t = typeof ts === 'number' ? ts : Date.parse(ts); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const ms = ts => { const t = Date.parse(ts); return Number.isFinite(t) ? t : 0; };
const lstatOrNull = p => { try { return fs.lstatSync(p); } catch { return null; } };
const isFile = p => { const s = lstatOrNull(p); return !!s && s.isFile(); };
const isDir = p => { const s = lstatOrNull(p); return !!s && s.isDirectory(); };
const ls = d => { try { return fs.readdirSync(d); } catch { return []; } };
const rcode = s => { const t = String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9_:.-]/g, '_').replace(/^[^a-z0-9]+/, '').slice(0, 64); return t || null; };
const hname = s => { const t = String(s == null ? '' : s).replace(/[^A-Za-z0-9_.:/-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 96); return t || 'unknown'; };
const atype = s => { const t = String(s == null ? '' : s).replace(/[^A-Za-z0-9_.:-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 128); return t || 'unknown'; };
const modelId = s => (typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/.test(s) ? s : null);
const tierOf = id => { if (!id) return 'unknown'; const l = id.toLowerCase(); return l.includes('opus') ? 'opus' : l.includes('sonnet') ? 'sonnet' : l.includes('haiku') ? 'haiku' : 'other'; };
const sha = s => R.sha256(s);
const eventId = (source, key) => `ev_${sha(`${source}|${key}`).slice(0, 20)}`;
const shortType = t => String(t || '').split(':').pop();
const round6 = x => Math.round(x * 1e6) / 1e6;

// ---------- contract acceptance (spec section 4.1 and 6.2) ----------
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Accept or reject one wire line. Never throws. reason: 'malformed' | 'version'. */
function acceptLine(input, { limit = MAX_LINE_BYTES } = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  if (limit && buf.length > limit) return { ok: false, reason: 'malformed' };
  let o;
  try { o = JSON.parse(utf8.decode(buf)); } catch { return { ok: false, reason: 'malformed' }; }
  if (!isObj(o)) return { ok: false, reason: 'malformed' };
  if (typeof o.schema_version !== 'string' || o.schema_version !== WIRE) return { ok: false, reason: 'version' };
  const has = k => Object.prototype.hasOwnProperty.call(o, k);
  const good = typeof o.event_id === 'string' && typeof o.ts === 'string' && TS_RE.test(o.ts) && typeof o.session_id === 'string'
    && has('workspace_id') && has('agent_id') && has('atom_id') && SOURCES.has(o.source) && Object.hasOwn(RANK, o.provenance)
    && KINDS.has(o.kind) && isObj(o.data);
  return good ? { ok: true, event: o } : { ok: false, reason: 'malformed' };
}

// ---------- incremental, torn-write-safe JSONL reader (spec 6.2) ----------
class Tail {
  constructor(init) { this.init = init; this.reset(); }
  reset() { this.offset = 0; this.ino = null; this.state = this.init(); this.exists = false; }
  /** Feed complete new lines to onLine(buf, state). Returns 'ok' | 'missing' | 'unreadable'. */
  pump(file, onLine) {
    const st = lstatOrNull(file); // lstat: a symlink is never followed
    if (!st) { this.exists = false; return 'missing'; }
    if (!st.isFile()) return 'unreadable';
    if (this.ino !== null && (st.ino !== this.ino || st.size < this.offset)) this.reset(); // rotated or truncated
    this.ino = st.ino; this.exists = true;
    if (st.size === this.offset) return 'ok';
    let fd;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); } catch { return 'unreadable'; }
    try {
      const CH = 1 << 20, buf = Buffer.allocUnsafe(CH);
      let consumed = 0, carry = Buffer.alloc(0);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, CH, this.offset + consumed + carry.length);
        if (n <= 0) break;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
        let p = 0, nl;
        while ((nl = data.indexOf(10, p)) !== -1) {
          let end = nl;
          if (end > p && data[end - 1] === 13) end--;
          if (end > p) onLine(data.subarray(p, end), this.state);
          consumed += nl + 1 - p; p = nl + 1;
        }
        carry = data.subarray(p);
        if (carry.length > MAX_CARRY_BYTES) { consumed += carry.length; carry = Buffer.alloc(0); this.state.malformed = (this.state.malformed || 0) + 1; }
      }
      this.offset += consumed; // a final line without \n stays unconsumed until it is completed
      return 'ok';
    } catch { return 'unreadable'; } finally { try { fs.closeSync(fd); } catch {} }
  }
}

function parseJson(buf) { try { const o = JSON.parse(buf.toString('utf8')); return isObj(o) ? o : null; } catch { return null; } }

// ---------- event construction ----------
// Correlation id for hook events with no tool_use_id is n<seq> (spec 4.4). The counter is reset per snapshot,
// so numbers are unique within one build and such events never collapse with another source.
let seqCounter = 0;
const resetSeq = () => { seqCounter = 0; };

/** Normative dedupe_key (spec_revision 1.1 section 4.4); same function as contract_tool.py canonical_key. */
function canonicalKey(e) {
  const d = e.data;
  let k = null;
  if (e.kind === 'hook_verdict') k = `hv|${d.hook_event}|${d.tool_use_id || `n${e.seq}`}|${String(d.hook_name).split('/')[0]}`;
  else if (e.kind === 'agent_run') k = `ar|${e.agent_id}|${d.lifecycle}`;
  else if (e.kind === 'phase_gate') k = `pg|${d.phase}|${d.transition}|${d.gate || '-'}|${e.atom_id || e.agent_id || '-'}`;
  else if (e.kind === 'decision') k = `dc|${d.decision_class}|${d.question_id || '-'}|${(d.state_digest || '').slice(0, 16) || `t${String(e.ts).replace(/\D/g, '')}`}`;
  return k && k.slice(0, 128);
}

function makeEvent(source, key, o) {
  const e = {
    schema_version: WIRE, event_id: eventId(source, key), ts: iso(o.ts), seq: null, session_id: o.session_id,
    workspace_id: o.workspace_id || null, agent_id: o.agent_id || null, atom_id: o.atom_id || null,
    source, provenance: o.provenance, kind: o.kind, data: o.data,
  };
  if (o.kind === 'hook_verdict' && !o.data.tool_use_id) e.seq = ++seqCounter;
  const dk = canonicalKey(e);
  if (dk) e.dedupe_key = dk;
  if (o.redaction) e.redaction = o.redaction;
  return e.ts ? e : null;
}

// Shell-style split (quotes and backslashes), enough to find the script path in a hook command.
function shellTokens(str) {
  const out = [];
  let cur = '', q = null, has = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"' && i + 1 < str.length) cur += str[++i]; else cur += ch; }
    else if (ch === "'" || ch === '"') { q = ch; has = true; }
    else if (ch === '\\' && i + 1 < str.length) { cur += str[++i]; has = true; }
    else if (/\s/.test(ch)) { if (has || cur) { out.push(cur); cur = ''; has = false; } }
    else { cur += ch; has = true; }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Spec 4.4 transcript hook_id: lower-cased basename of the attachment command, one short extension stripped. Never hookName. */
function hookIdFromCommand(cmd) {
  if (typeof cmd !== 'string') return null;
  const toks = shellTokens(cmd);
  const t = [...toks].reverse().find(x => x.includes('/')) || toks[0];
  if (!t) return null;
  const base = t.slice(t.lastIndexOf('/') + 1).replace(/\.[^./]{1,5}$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 32);
  return base || null;
}
const toolUseIdOf = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);

function priceVersion(p) { return `puffr-${PKG.version}${p.user ? '+user-prices' : ''}${!p.listed && !p.user ? '+family-fallback' : ''}`; }
const NO_COST = () => ({ usd: null, basis: 'unknown', price_table_version: null });

/** Cost from puffr's own price table (lib/puffr.js), always labelled `estimated`. */
function estimateCost(model, usage) {
  if (!model || !usage || usage.basis !== 'per_message_deduped') return NO_COST();
  const p = lib.price(model);
  if (!p) return NO_COST();
  // ASSUMPTION: cache creation is billed at the 5-minute write rate; transcripts do not split 5m/1h here.
  const usd = lib.costOf(model, [usage.input_tokens || 0, usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0, 0, usage.output_tokens || 0]);
  return { usd: round6(usd), basis: 'estimated', price_table_version: priceVersion(p) };
}

// ---------- S1: orchestration-audit.jsonl ----------
const auditInit = () => ({ starts: [], stops: new Map(), outcomes: [], gates: [], hooks: [], tools: new Map(), malformed: 0, n: 0, last: null });

function onAudit(buf, s) {
  const o = parseJson(buf);
  if (!o) { s.malformed++; return; }
  s.n++;
  const ts = iso(o.timestamp), ex = isObj(o.extra) ? o.extra : {};
  if (ts) s.last = ts;
  const aid = typeof ex.agent_id === 'string' && AGENT_RE.test(ex.agent_id) ? ex.agent_id : null;
  switch (o.event_type) {
    case 'agent_delegation':
      if (!ts || !aid) break;
      if (ex.lifecycle === 'stop') {
        if (o.agent_invoked && o.agent_invoked !== 'stop') { // "stop" is a placeholder re-fire (hazard 2)
          s.stops.set(aid, { ts, type: o.agent_invoked, input: nint(o.input_tokens), output: nint(o.output_tokens), cache: nint(o.cache_tokens), dur: nn(o.duration_ms) });
        }
      } else if ((!ex.lifecycle || ex.lifecycle === 'start') && o.agent_invoked) s.starts.push({ ts, aid, type: o.agent_invoked });
      break;
    case 'atom_outcome': {
      if (!ts) break;
      const raw = typeof o.atom_id === 'string' ? o.atom_id : null;
      const qg = isObj(o.quality_gate_result) ? o.quality_gate_result : {};
      s.outcomes.push({ ts, aid: aid || (raw && HEX_AGENT.test(raw) ? raw : null), atom: raw && !HEX_AGENT.test(raw) ? raw : null, outcome: o.atom_outcome, gate: qg.gate, passed: qg.passed });
      break;
    }
    case 'completion_gate':
      if (ts && isObj(o.quality_gate_result)) s.gates.push({ ts, aid, atom: typeof o.atom_id === 'string' && !HEX_AGENT.test(o.atom_id) ? o.atom_id : null, qg: o.quality_gate_result });
      break;
    case 'hook_step_report': {
      const hook = o.hook || ex.hook, step = o.step || ex.step;
      if (ts && hook) s.hooks.push({ ts, hook, step, violations: Array.isArray(o.violations) ? o.violations : [], atom: typeof o.atom_id === 'string' && !HEX_AGENT.test(o.atom_id) ? o.atom_id : null });
      break;
    }
    case 'tool_use': if (aid) s.tools.set(aid, (s.tools.get(aid) || 0) + 1); break;
    default: break; // out of v1 scope (spec 5.1)
  }
}

/**
 * c.creators: agent ids that already have an agent_run row from a source that may create one (a transcript or an
 * emitted event). Rule 2: only a start delegation or those create a row; stop and outcome records only fill status.
 */
function auditEvents(s, c) {
  const out = [], push = (key, o) => { const e = makeEvent('audit_jsonl', key, { session_id: c.sid, workspace_id: c.ws, provenance: 'derived', ...o }); if (e) out.push(e); };
  const outcomeOf = new Map();
  for (const x of s.outcomes) if (x.aid) outcomeOf.set(x.aid, x); // atom_outcome is a status fill only, never a gate (rule 3)
  const statusOf = aid => { const oc = outcomeOf.get(aid); return oc ? (oc.outcome === 'succeeded' ? 'succeeded' : oc.outcome === 'failed' || oc.outcome === 'partial' ? 'failed' : 'unknown') : 'unknown'; };
  const started = new Set(s.starts.map(r => r.aid));
  for (const r of s.starts) {
    push(`start|${r.aid}`, { ts: r.ts, agent_id: r.aid, atom_id: c.atomOf(r.aid), kind: 'agent_run',
      data: { agent_type: atype(r.type), lifecycle: 'start', status: 'running', model_tier: 'unknown', model_source: 'unknown', started_at: iso(r.ts) } });
  }
  const hasRow = aid => started.has(aid) || (c.creators && c.creators.has(aid));
  for (const [aid, r] of s.stops) {
    if (!hasRow(aid)) continue; // orphan named stop: no row
    const usage = { basis: 'audit_record' };
    if (r.input !== null) usage.input_tokens = r.input;
    if (r.output !== null) usage.output_tokens = r.output;
    if (r.cache !== null) usage.cache_tokens = r.cache;
    const data = { agent_type: atype(r.type), lifecycle: 'stop', status: statusOf(aid), model_tier: 'unknown', model_source: 'unknown', usage, cost: NO_COST(), stop_reason: null };
    if (r.dur !== null) data.duration_ms = r.dur;
    if (s.tools.has(aid)) data.tool_calls = s.tools.get(aid);
    push(`stop|${aid}`, { ts: r.ts, agent_id: aid, atom_id: c.atomOf(aid), kind: 'agent_run', data });
  }
  for (const aid of started) { // a started agent with an outcome but no stop record: the outcome fills its status
    if (s.stops.has(aid) || !outcomeOf.has(aid)) continue;
    const oc = outcomeOf.get(aid), st = s.starts.find(r => r.aid === aid);
    push(`outcome|${aid}`, { ts: oc.ts, agent_id: aid, atom_id: c.atomOf(aid), kind: 'agent_run',
      data: { agent_type: atype(st.type), lifecycle: 'stop', status: statusOf(aid), model_tier: 'unknown', model_source: 'unknown', stop_reason: null } });
  }
  s.gates.forEach((x, i) => { // only a true gate source (completion_gate) produces gate_result
    const q = x.qg, st = q.status === 'pass' || q.passed === true ? 'pass' : q.status === 'fail' || q.passed === false ? 'fail' : 'unknown';
    const data = { phase: '4', transition: 'gate_result', gate: 'completion', status: st };
    const sc = num(q.score), th = num(q.threshold);
    if (sc !== null && sc >= 0 && sc <= 1) data.score = sc;
    if (th !== null && th >= 0 && th <= 1) data.threshold = th;
    if (q.reason) data.reason_code = rcode(q.reason);
    push(`gate|${i}`, { ts: x.ts, agent_id: x.aid, atom_id: x.atom || (x.aid && c.atomOf(x.aid)) || null, kind: 'phase_gate', data });
  });
  s.hooks.forEach((x, i) => {
    const v = x.violations.length ? 'warn' : 'allow';
    const data = { hook_event: HOOK_EVENT_OF[String(x.hook).toLowerCase()] || 'Other', hook_name: hname(`${x.hook}/${x.step || 'step'}`), hook_type: 'command', model_tier: 'none', verdict: v };
    if (v === 'warn') data.reason_code = rcode(String(x.violations[0]));
    push(`hook|${i}`, { ts: x.ts, atom_id: x.atom, kind: 'hook_verdict', data });
  });
  return out;
}

// ---------- S10 / S11: Claude Code transcripts ----------
const txInit = ({ sub, keepText }) => ({
  sub, keepText, n: 0, malformed: 0, first: null, last: null, version: null, branch: null, cwdBase: null, model: null,
  atoms: new Map(), hooks: [], pend: null, fsPend: new Map(), fsGates: [], dbDegraded: false, msgs: new Map(), tools: new Set(),
  lastStop: null, lastMsg: null, ord: 0,
});
const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '');

function pushHook(s, ts, data, extra = {}) { if (ts) s.hooks.push({ ts, data, ...extra }); }

function onTx(buf, s) {
  const o = parseJson(buf);
  if (!o) { s.malformed++; return; }
  s.n++;
  const ts = iso(o.timestamp);
  if (ts) { if (!s.first) s.first = ts; s.last = ts; }
  if (!s.version && typeof o.version === 'string' && /^[0-9A-Za-z.+_-]{1,32}$/.test(o.version)) s.version = o.version;
  if (!s.branch && typeof o.gitBranch === 'string' && o.gitBranch) s.branch = R.token(o.gitBranch).slice(0, 64);
  if (!s.cwdBase && typeof o.cwd === 'string' && o.cwd) s.cwdBase = R.token(path.basename(o.cwd)).slice(0, 64); // basename only, never the path
  const pd = o.permissionDecision;
  if (isObj(pd) && pd.decision === 'accept') { // C-4: other decision values are not mapped
    pushHook(s, ts, { hook_event: 'PermissionRequest', hook_name: 'permission-request', hook_type: 'command', model_tier: 'none', verdict: 'allow', reason_code: rcode(pd.source) }, { corr: toolUseIdOf(o.toolUseID) });
  }
  if (o.type === 'attachment') onAttachment(o.attachment, s, ts);
  else if (o.type === 'system' && o.subtype === 'stop_hook_summary') onStopSummary(o, s, ts);
  else if (o.type === 'user') onUser(o, s);
  else if (o.type === 'assistant') onAssistant(o, s, ts);
}

function onAttachment(a, s, ts) {
  if (!isObj(a)) return;
  const he = HOOK_EVENTS.has(a.hookEvent) ? a.hookEvent : 'Other';
  const lat = nn(a.durationMs);
  const id = hookIdFromCommand(a.command), corr = toolUseIdOf(a.toolUseID); // hookName is NOT used: it is shared by distinct hooks (spec 4.4)
  if (a.type === 'hook_success') {
    if (a.exitCode !== 0 || !id) return; // only an exit-0 success with a command maps to a verdict (spec 5.5)
    let u = null;
    const m = HOOK_DATA_RE.exec(typeof a.stdout === 'string' ? a.stdout : ''); // everything else in stdout is discarded here
    if (m) { try { u = JSON.parse(m[1]); } catch { u = null; } }
    const data = { hook_event: he, hook_name: id, hook_type: 'command', model_tier: 'none', verdict: he === 'Stop' || he === 'SubagentStop' ? 'ok' : 'allow', exit_code: 0 };
    if (isObj(u) && (u.result === 'BYPASSED' || u.result === 'GUIDANCE_PROVIDED')) {
      data.hook_event = 'UserPromptSubmit';
      data.verdict = u.result === 'BYPASSED' ? 'bypass' : 'guidance';
      data.reason_code = u.result === 'BYPASSED' ? rcode(u.bypass_reason) : 'guidance_provided';
    }
    if (lat !== null) data.latency_ms = lat;
    pushHook(s, ts, data, { corr });
  } else if (a.type === 'hook_non_blocking_error') {
    if (!id) return;
    const data = { hook_event: he, hook_name: id, hook_type: 'command', model_tier: 'none', verdict: 'warn', reason_code: 'hook_non_blocking_error', fail_open: true };
    if (Number.isInteger(a.exitCode)) data.exit_code = a.exitCode;
    if (lat !== null) data.latency_ms = lat; // stderr is deliberately not carried
    pushHook(s, ts, data, { corr });
  } else if (a.type === 'hook_system_message' && typeof a.content === 'string' && a.content.startsWith(DB_FAIL_MARK)) s.dbDegraded = true;
}

function onStopSummary(o, s, ts) {
  s.pend = null;
  const prompts = (Array.isArray(o.hookInfos) ? o.hookInfos : []).filter(i => isObj(i) && typeof i.promptText === 'string');
  if (!prompts.length) return;
  const ev = s.sub ? 'SubagentStop' : 'Stop', items = [];
  for (const i of prompts) {
    const m = /^\[hook:([a-z0-9_-]{1,48})\]/.exec(i.promptText);
    const name = m ? m[1] : `prompt-${sha(i.promptText).slice(0, 12)}`; // the prompt text itself is never kept
    items.push({ idx: s.hooks.length, text: i.promptText, done: false });
    pushHook(s, ts, { hook_event: ev, hook_name: name, hook_type: 'prompt', model_tier: 'unknown', verdict: 'ok', judge: { model: null } }, { prov: 'inferred', corr: toolUseIdOf(o.toolUseID) });
  }
  if (items.length) s.pend = { items };
}

function onUser(o, s) {
  const c = o.message && o.message.content;
  if (o.isMeta === true) {
    const txt = textOf(c);
    if (txt.startsWith('Stop hook feedback:') && s.pend) onFeedback(txt, s);
    return;
  }
  if (!Array.isArray(c) || !s.fsPend.size) return;
  for (const b of c) {
    if (!isObj(b) || b.type !== 'tool_result' || !s.fsPend.has(b.tool_use_id)) continue;
    const req = s.fsPend.get(b.tool_use_id);
    s.fsPend.delete(b.tool_use_id);
    resolveFieldStability(req, b, s);
  }
}

function onFeedback(txt, s) {
  const rest = txt.slice('Stop hook feedback:'.length).replace(/^\s+/, '');
  for (const it of s.pend.items) {
    if (it.done) continue;
    const head = `[${it.text}]`;
    let reason = null;
    if (rest.startsWith(head)) reason = rest.slice(head.length).replace(/^:\s*/, '');
    else if (s.pend.items.length === 1 && rest.startsWith(`[${it.text.slice(0, 40)}`)) { const k = rest.indexOf(']: '); reason = k >= 0 ? rest.slice(k + 3) : ''; }
    if (reason === null) continue;
    it.done = true;
    const h = s.hooks[it.idx], f = R.finalize(reason, 240);
    h.data.verdict = 'not_done';
    h.data.reason_text = f.text;
    h.data.reason_sha256 = f.sha256;
    h.data.judge = { model: null, impossible: false };
    h.red = { reason_text: f };
    it.text = ''; // drop the prompt text as soon as it has served its purpose
    return;
  }
}

function resolveFieldStability(req, block, s) {
  const phase = CHECKPOINT_PHASE[req.phase];
  if (!phase) return;
  let parsed = null;
  const t = textOf(block.content);
  try { parsed = JSON.parse(t); } catch { const m = /\{[\s\S]*\}/.exec(t); if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = null; } } }
  const data = { phase, transition: 'gate_result', gate: 'field_stability', status: 'unknown', checkpoint: req.phase };
  if (isObj(parsed) && block.is_error !== true) {
    const score = num(parsed.aggregate_score ?? parsed.score);
    const eff = isObj(parsed.effective_thresholds) ? parsed.effective_thresholds : {};
    const th = num(eff.field_stability_floor ?? parsed.threshold);
    if (score !== null && score >= 0 && score <= 1) data.score = score;
    if (th !== null && th >= 0 && th <= 1) data.threshold = th;
    if (typeof parsed.passed === 'boolean') data.status = parsed.passed ? 'pass' : 'fail';
    const mode = parsed.stability_mode || req.mode;
    if (mode === 'convergent' || mode === 'consolidating' || mode === 'exploratory') data.stability_mode = mode;
  }
  s.fsGates.push({ ts: req.ts, data });
}

function onAssistant(o, s, ts) {
  const m = o.message;
  if (!isObj(m)) return;
  if (!s.model && typeof m.model === 'string') s.model = m.model;
  s.lastStop = typeof m.stop_reason === 'string' ? m.stop_reason : null;
  if (typeof m.id === 'string') {
    s.lastMsg = m.id;
    const out = nn(isObj(m.usage) ? m.usage.output_tokens : null) ?? 0, prev = s.msgs.get(m.id);
    if (!prev || out >= prev.out) s.msgs.set(m.id, { out, usage: isObj(m.usage) ? m.usage : {}, model: m.model, text: prev ? prev.text : '' });
  }
  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (!isObj(b)) continue;
    if (b.type === 'text' && s.keepText && s.lastMsg && s.msgs.has(s.lastMsg)) { const r = s.msgs.get(s.lastMsg); if (r.text.length < 20000) r.text += `${b.text}\n`; }
    if (b.type !== 'tool_use' || typeof b.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.id)) continue;
    s.tools.add(b.id);
    const input = isObj(b.input) ? b.input : {};
    if ((b.name === 'Agent' || b.name === 'Task') && typeof input.prompt === 'string') {
      const a = /^UCEF_ATOM:\s*atom_id=([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})(?:\s+task_complexity=([0-9.]+))?/.exec(input.prompt.split('\n', 1)[0]);
      if (a) s.atoms.set(b.id, { atom: a[1], cx: a[2] ? Number(a[2]) : null });
    } else if (typeof b.name === 'string' && /field_stability_measure$/.test(b.name) && ts) {
      s.fsPend.set(b.id, { ts, phase: input.phase, mode: input.stability_mode });
    }
  }
}

/** Usage per message.id deduped (hazard 4): largest output_tokens per id, then summed. */
function usageOf(s) {
  const u = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, basis: 'per_message_deduped' };
  for (const r of s.msgs.values()) {
    u.input_tokens += nint(r.usage.input_tokens) || 0;
    u.output_tokens += nint(r.usage.output_tokens) || 0;
    u.cache_read_input_tokens += nint(r.usage.cache_read_input_tokens) || 0;
    u.cache_creation_input_tokens += nint(r.usage.cache_creation_input_tokens) || 0;
  }
  return u;
}

function hookEvents(s, c, agentId, atomId) {
  const out = [];
  s.hooks.forEach((h, i) => {
    const data = { ...h.data };
    if (h.corr) data.tool_use_id = h.corr;
    const e = makeEvent(agentId ? 'subagent_transcript' : 'transcript', `hook|${agentId || 'main'}|${i}`, {
      ts: h.ts, session_id: c.sid, workspace_id: c.ws, agent_id: agentId, atom_id: atomId, provenance: h.prov || 'derived',
      kind: 'hook_verdict', data, redaction: h.red ? R.redactionRecord(h.red) : undefined,
    });
    if (e) out.push(e);
  });
  return out;
}

function mainEvents(s, c) {
  const out = [];
  if (s.first) {
    const mid = modelId(s.model), data = { lifecycle: 'start', model_id: mid, model_tier: tierOf(mid), claude_version: s.version, git_branch: s.branch, project_ref: s.cwdBase };
    const e = makeEvent('transcript', 'meta', { ts: s.first, session_id: c.sid, workspace_id: c.ws, provenance: 'derived', kind: 'session_meta', data });
    if (e) out.push(e);
  }
  out.push(...hookEvents(s, c, null, null));
  s.fsGates.forEach((g, i) => {
    const e = makeEvent('transcript', `fs|${i}`, { ts: g.ts, session_id: c.sid, workspace_id: c.ws, provenance: 'inferred', kind: 'phase_gate', data: g.data });
    if (e) out.push(e);
  });
  return out;
}

/** Best-effort constitutional verdict from the agent's final YAML block (OPEN_QUESTION Q-3, always `inferred`). */
function constitutionalGate(s) {
  const r = s.lastMsg && s.msgs.get(s.lastMsg);
  if (!r || !r.text) return null;
  const fence = /```ya?ml\s*\n([\s\S]*?)```/i.exec(r.text);
  const body = fence ? fence[1] : '';
  const sc = /compliance_score:\s*([0-9]*\.?[0-9]+)/.exec(body);
  if (!sc) return null;
  const score = Number(sc[1]);
  const st = /status:\s*["']?([A-Za-z_]+)/.exec(body);
  const word = st ? st[1].toLowerCase() : '';
  const data = { phase: '4', transition: 'gate_result', gate: 'constitutional', status: /^(pass|passed|approved|compliant|accepted)$/.test(word) ? 'pass' : /^(fail|failed|reject|rejected|violation|non_compliant)$/.test(word) ? 'fail' : 'unknown' };
  if (score >= 0 && score <= 1) data.score = score; // the threshold is not in the data, so none is shown
  return data;
}

function subEvents(aid, meta, s, c) {
  const out = [], mid = modelId(s.model), tier = tierOf(mid), type = atype(meta && meta.agentType);
  const atomRef = meta && s.atomsFromMain && s.atomsFromMain.get(meta.toolUseId);
  const atom = (atomRef && atomRef.atom) || c.atomOf(aid) || null;
  const desc = meta && typeof meta.description === 'string' ? (c.redact ? R.finalize(meta.description, 120) : { text: R.safe(meta.description, 120, { redact: false }), counts: {}, truncated: false }) : null;
  const depth = nint(meta && meta.spawnDepth);
  const base = { model_id: mid, model_tier: tier, model_source: mid ? 'transcript_message_model' : 'unknown' };
  const common = {};
  if (depth !== null) common.spawn_depth = depth;
  if (meta && typeof meta.requestShape === 'string') common.background = meta.requestShape === 'background';
  if (desc && desc.text) common.description = desc.text;
  const red = desc && desc.text ? R.redactionRecord({ description: desc }) : undefined;
  const startTs = s.first || c.fallbackTs;
  const mk = (ts, data, key) => makeEvent('subagent_transcript', key, { ts, session_id: c.sid, workspace_id: c.ws, agent_id: aid, atom_id: atom, provenance: 'derived', kind: 'agent_run', data, redaction: red });
  const start = mk(startTs, { agent_type: type, lifecycle: 'start', status: 'running', ...base, started_at: iso(startTs), ...common }, `ar|${aid}|start`);
  if (start) out.push(start);
  if (meta && meta.finished === true) {
    const usage = usageOf(s);
    const status = s.lastStop === 'end_turn' ? 'succeeded' : s.lastStop === 'max_tokens' || s.lastStop === 'refusal' ? 'failed' : 'unknown';
    const data = { agent_type: type, lifecycle: 'stop', status, ...base, usage, cost: estimateCost(mid, usage), tool_calls: s.tools.size, stop_reason: s.lastStop, ...common };
    if (s.first) data.started_at = s.first;
    if (s.last) data.ended_at = s.last;
    if (s.first && s.last) data.duration_ms = Math.max(0, ms(s.last) - ms(s.first));
    const stop = mk(s.last || startTs, data, `ar|${aid}|stop`);
    if (stop) out.push(stop);
    if (/constitutional-ai-agent$/.test(type)) {
      const g = constitutionalGate(s);
      const e = g && makeEvent('subagent_transcript', `con|${aid}`, { ts: s.last || startTs, session_id: c.sid, workspace_id: c.ws, agent_id: aid, atom_id: atom, provenance: 'inferred', kind: 'phase_gate', data: g });
      if (e) out.push(e);
    }
  }
  out.push(...hookEvents(s, c, aid, atom));
  return out;
}

// ---------- S5 / S6 / S7 ----------
const seen = (map, k) => map.get(k) || map.set(k, []).get(k);
const sharedBySid = () => ({ bySid: new Map(), malformed: 0 });

function onSidRows(buf, s) {
  const o = parseJson(buf);
  if (!o) { s.malformed++; return; }
  if (typeof o.session_id !== 'string' || !ID_RE.test(o.session_id)) return;
  const rows = seen(s.bySid, o.session_id);
  if (rows.length < 2000) rows.push(o);
}

function tierFromProvider(provider, pth) {
  if (pth === 'fallback_llm') return 'llm';
  if ((provider === 'jev_sdk' || provider === 'laya_mlx') && ['fast_path_accept', 'deny', 'defer'].includes(pth)) return 'jev';
  return !provider ? 'deterministic' : 'jev'; // ASSUMPTION A-2: a provider with no recorded path is a Jev call
}

function authoredEvent(o, c) {
  const prov = o.authored_provenance;
  const pc = rcode(o.point_id);
  if (!pc) return null;
  const av = o.authored_value;
  const data = {
    tier: prov === 'defaulted' ? 'deterministic' : 'llm', // ASSUMPTION A-2
    decision_class: pc, question_id: typeof o.question_id === 'string' ? (R.token(o.question_id) || null) : null,
    value: (typeof av === 'string' && VALUE_TOKEN.test(av)) || typeof av === 'number' || typeof av === 'boolean' ? av : null,
    value_provenance: prov === 'inferred' || prov === 'defaulted' || prov === 'supplied' ? prov : null,
    provider: null, path: null, confidence: null, latency_ms: null,
  };
  if (typeof o.question_digest === 'string' && /^[0-9a-f]{64}$/.test(o.question_digest)) data.state_digest = o.question_digest;
  return makeEvent('decision_telemetry', `authored|${o.recorded_at}|${o.point_id}|${o.question_digest}`, { ts: o.recorded_at, session_id: c.sid, workspace_id: c.ws, provenance: 'derived', kind: 'decision', data });
}

function proposalEvent(o, c, i) {
  const pc = rcode(o.point_id);
  if (!pc) return null;
  const provider = typeof o.provider === 'string' ? R.token(o.provider).slice(0, 40) : null, pth = o.path || o.path_taken;
  const data = { tier: tierFromProvider(provider, pth), decision_class: pc, question_id: typeof o.question_id === 'string' ? (R.token(o.question_id) || null) : null, provider };
  const val = o.value;
  data.value = (typeof val === 'string' && VALUE_TOKEN.test(val)) || typeof val === 'number' || typeof val === 'boolean' ? val : null;
  const mid = modelId(o.model_id); if (mid) data.model_id = mid;
  const conf = num(o.top1), fl = num(o.floor), lat = nn(o.latency_ms);
  data.confidence = conf !== null && conf >= 0 && conf <= 1 ? conf : null;
  if (fl !== null && fl >= 0 && fl <= 1) data.floor = fl;
  data.latency_ms = lat;
  data.path = ['fast_path_accept', 'fallback_llm', 'deny', 'defer'].includes(pth) ? pth : null;
  if (typeof o.question_digest === 'string' && /^[0-9a-f]{64}$/.test(o.question_digest)) data.state_digest = o.question_digest; // state_fields are never carried
  return makeEvent('decision_telemetry', `proposal|${o.recorded_at || o.ts}|${i}`, { ts: o.recorded_at || o.ts, session_id: c.sid, workspace_id: c.ws, provenance: 'derived', kind: 'decision', data });
}

function hookFailureEvents(rows, c) {
  const out = [];
  rows.forEach((o, i) => {
    if (typeof o.hook !== 'string') return;
    const data = { hook_event: HOOK_EVENT_OF[o.hook.toLowerCase()] || 'Other', hook_name: hname(`${o.hook}/${o.step || 'step'}`), hook_type: 'command', model_tier: 'none', verdict: 'warn', reason_code: 'hook_exception', fail_open: true }; // message and traceback are dropped
    const e = makeEvent('hook_failures', `fail|${o.timestamp}|${i}`, { ts: o.timestamp, session_id: c.sid, workspace_id: c.ws, provenance: 'derived', kind: 'hook_verdict', data });
    if (e) out.push(e);
  });
  return out;
}

// S6: only `INFO <ts> key=value` lines are ever interpreted. Payload blocks are not parsed, not stored.
const PERM_INFO = /^INFO (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) (.*)$/;
function onPerm(buf, s) {
  if (buf.length < 30 || buf[0] !== 0x49 || buf[1] !== 0x4e || buf[2] !== 0x46 || buf[3] !== 0x4f) return; // not "INFO"
  const m = PERM_INFO.exec(buf.toString('utf8', 0, Math.min(buf.length, 400)));
  if (!m) return;
  const d = /\bdeny_capability=unavailable\s+reason=(\S+)/.exec(m[2]);
  if (d && s.rows.length < 5000) s.rows.push({ ts: m[1], reason: d[1] });
}

// ---------- merge, dedupe, order, phase inference ----------
function mergeAgent(win, lose) {
  const w = { ...win, data: { ...win.data } };
  const wu = w.data.usage, lu = lose.data.usage;
  if (lu && (!wu || (wu.basis === 'audit_record' && lu.basis === 'per_message_deduped'))) { // deduped transcript usage beats the audit total (hazard 4)
    w.data.usage = lu; w.data.cost = lose.data.cost;
  } else if (!w.data.cost && lose.data.cost) w.data.cost = lose.data.cost;
  if (!w.data.model_id && lose.data.model_id) { w.data.model_id = lose.data.model_id; w.data.model_tier = lose.data.model_tier; w.data.model_source = lose.data.model_source; }
  if (w.data.status === 'unknown' && lose.data.status && lose.data.status !== 'unknown') w.data.status = lose.data.status;
  for (const k of ['duration_ms', 'tool_calls', 'spawn_depth', 'background', 'description', 'started_at', 'ended_at']) if (w.data[k] === undefined && lose.data[k] !== undefined) w.data[k] = lose.data[k];
  if (!w.atom_id && lose.atom_id) w.atom_id = lose.atom_id;
  return w;
}

/** Spec 4.4: emitted > derived > inferred; equal provenance keeps the later ts. */
function dedupe(events) {
  const byKey = new Map(), out = [];
  for (const e of events) {
    if (!e.dedupe_key) { out.push(e); continue; }
    const prev = byKey.get(e.dedupe_key);
    if (!prev) { byKey.set(e.dedupe_key, e); continue; }
    const a = RANK[e.provenance], b = RANK[prev.provenance];
    const [win, lose] = a > b || (a === b && ms(e.ts) >= ms(prev.ts)) ? [e, prev] : [prev, e];
    byKey.set(e.dedupe_key, win.kind === 'agent_run' ? mergeAgent(win, lose) : win);
  }
  return out.concat([...byKey.values()]);
}

const SRC_ORDER = ['monitor_events', 'audit_jsonl', 'audit_jsonl_legacy', 'ucef_db', 'decision_telemetry', 'permission_log', 'hook_failures', 'transcript', 'subagent_transcript', 'atom_registry', 'adapter'];
function sortEvents(events) {
  return events.map((e, i) => [e, ms(e.ts), Number.isInteger(e.seq) ? e.seq : 0, SRC_ORDER.indexOf(e.source), i])
    .sort((x, y) => x[1] - y[1] || x[2] - y[2] || x[3] - y[3] || x[4] - y[4]).map(x => x[0]);
}

function phaseOfAgent(type, startMs, ctx) {
  const t = shortType(type);
  if (t === 'semantic-context-evaluator') return '1';
  if (t === 'task-decomposition-expert') return '2';
  if (t === 'completion-verification-agent' || t === 'constitutional-ai-agent') return '4';
  if (t === 'memory-coordinator') return ctx.first4 !== null && startMs > ctx.first4 ? '5.5' : '1.5';
  return '3';
}

/** Spec 5.5 last row: phase position from dispatch order, only for phases with no phase_gate enter/exit/skipped. */
function inferPhases(events, c) {
  const runs = events.filter(e => e.kind === 'agent_run' && e.agent_id);
  if (!runs.length) return [];
  const covered = new Set(events.filter(e => e.kind === 'phase_gate' && ['enter', 'exit', 'skipped'].includes(e.data.transition)).map(e => e.data.phase));
  const by = new Map();
  for (const e of runs) { const r = by.get(e.agent_id) || by.set(e.agent_id, {}).get(e.agent_id); r.type = e.data.agent_type; r[e.data.lifecycle] = e; }
  const starts = [...by.values()].filter(r => r.start).map(r => ({ r, t: ms(r.start.ts) }));
  const first = t => { const x = starts.filter(s => shortType(s.r.type) === t).map(s => s.t); return x.length ? Math.min(...x) : null; };
  const ctx = { first4: Math.min(...[first('completion-verification-agent'), first('constitutional-ai-agent')].filter(x => x !== null), Infinity) };
  if (ctx.first4 === Infinity) ctx.first4 = null;
  const phases = new Map();
  for (const r of by.values()) {
    const t0 = ms((r.start || r.stop).ts);
    const p = phaseOfAgent(r.type, t0, ctx);
    const rec = phases.get(p) || phases.set(p, { enter: Infinity, exit: 0, open: false }).get(p);
    rec.enter = Math.min(rec.enter, t0);
    if (r.stop) rec.exit = Math.max(rec.exit, ms(r.stop.ts)); else rec.open = true;
  }
  const out = [];
  for (const [p, rec] of phases) {
    if (covered.has(p)) continue;
    const mk = (tr, t) => makeEvent('adapter', `phase|${p}|${tr}`, { ts: t, session_id: c.sid, workspace_id: c.ws, provenance: 'inferred', kind: 'phase_gate', data: { phase: p, transition: tr } });
    out.push(mk('enter', rec.enter));
    if (!rec.open && rec.exit) out.push(mk('exit', rec.exit));
  }
  return out.filter(Boolean);
}

/** Rule 7: never keep an inferred enter/exit/skipped phase event once an emitted one exists for that phase (even a later one). */
function dropInferredPhase(events) {
  const pos = new Set(['enter', 'exit', 'skipped']);
  const emitted = new Set(events.filter(e => e.kind === 'phase_gate' && e.provenance === 'emitted' && pos.has(e.data.transition)).map(e => e.data.phase));
  return events.filter(e => !(e.kind === 'phase_gate' && e.provenance === 'inferred' && pos.has(e.data.transition) && emitted.has(e.data.phase)));
}

function finalizeEvents(raw, c = { sid: null, ws: null }) {
  const evs = dedupe(dropInferredPhase(raw));
  return sortEvents(evs.concat(inferPhases(evs, c)));
}

// ---------- summary: the four panes ----------
const VERDICTS = ['allow', 'ok', 'block', 'warn', 'bypass', 'guidance', 'not_done'];
function mergeSources(events) {
  const map = new Map(), counters = { malformed: 0, rejected: 0 };
  for (const e of events) {
    if (e.kind !== 'session_meta' || !Array.isArray(e.data.sources)) continue;
    for (const s of e.data.sources) if (isObj(s) && typeof s.source === 'string') map.set(s.source, s);
  }
  return [...map.values()];
}

function summarize(events, { now = Date.now(), sources = null, counters = {} } = {}) {
  const evs = events;
  const p1 = { counts: Object.fromEntries(VERDICTS.map(v => [v, 0])), total: 0, rows: [] };
  for (const e of evs) {
    if (e.kind !== 'hook_verdict') continue;
    const v = e.data.verdict;
    if (Object.hasOwn(p1.counts, v)) p1.counts[v]++;
    p1.total++;
    if (v !== 'allow' && v !== 'ok') p1.rows.push(e);
  }
  const agents = new Map();
  for (const e of evs) {
    if (e.kind !== 'agent_run' || !e.agent_id) continue;
    const a = agents.get(e.agent_id) || agents.set(e.agent_id, { agent_id: e.agent_id, start: null, stop: null }).get(e.agent_id);
    a[e.data.lifecycle] = e;
  }
  const p2 = [...agents.values()].map(a => {
    const x = a.stop || a.start, d = x.data, sd = a.start ? a.start.data : {};
    const startedAt = (a.start && a.start.ts) || d.started_at || x.ts;
    const known = t => (t && t !== 'unknown' ? t : null);
    return {
      agent_id: a.agent_id, type: d.agent_type, tier: known(d.model_tier) || known(sd.model_tier) || 'unknown', model_id: d.model_id || sd.model_id || null, status: a.stop ? d.status : 'running',
      duration_ms: a.stop ? (d.duration_ms ?? null) : Math.max(0, now - ms(startedAt)), live: !a.stop, atom_id: x.atom_id || (a.start && a.start.atom_id) || null,
      usage: d.usage || null, cost: d.cost || null, prov: x.provenance, started_at: startedAt, background: d.background, description: d.description || null,
    };
  }).sort((a, b) => ms(a.started_at) - ms(b.started_at));

  const phases = Object.fromEntries(PHASES.map(p => [p, { state: 'pending', prov: null }]));
  const gates = [];
  for (const e of evs) {
    if (e.kind !== 'phase_gate') continue;
    const d = e.data, ph = phases[d.phase];
    if (!ph) continue;
    const apply = st => { ph.state = st; ph.prov = e.provenance; };
    if (d.transition === 'skipped') apply('skipped');
    else if (d.transition === 'exit') apply('done');
    else if (d.transition === 'enter' && ph.state !== 'done' && ph.state !== 'skipped') apply('active');
    else if (d.transition === 'gate_result') { if (ph.state === 'pending') apply('seen'); gates.push(e); }
  }
  const reached = PHASES.filter(p => phases[p].state !== 'pending');
  const p3 = { phases, gates, position: reached.length ? reached[reached.length - 1] : null };

  const decisions = evs.filter(e => e.kind === 'decision');
  const tiers = { deterministic: 0, jev: 0, llm: 0 };
  for (const d of decisions) if (Object.hasOwn(tiers, d.data.tier)) tiers[d.data.tier]++;
  const totals = { runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheTotal: 0, usd: 0, priced: 0, unpriced: 0, versions: new Set(), bases: new Set() };
  const addCost = c => {
    if (isObj(c) && num(c.usd) !== null && (c.basis === 'estimated' || c.basis === 'reported')) { totals.usd += c.usd; totals.priced++; totals.bases.add(c.basis); if (c.price_table_version) totals.versions.add(c.price_table_version); return true; }
    return false;
  };
  for (const a of p2) {
    if (a.live) continue;
    totals.runs++;
    const u = a.usage || {};
    totals.input += u.input_tokens || 0; totals.output += u.output_tokens || 0;
    totals.cacheRead += u.cache_read_input_tokens || 0; totals.cacheWrite += u.cache_creation_input_tokens || 0; totals.cacheTotal += u.cache_tokens || 0;
    if (!addCost(a.cost)) totals.unpriced++;
  }
  // Rule 5: decision and judge usage is reported on its own lines and never added into the agent-run totals.
  const side = () => ({ n: 0, input: 0, output: 0, usd: 0, priced: 0, versions: new Set() });
  const decUse = side(), judgeUse = side();
  const addSide = (acc, u, c) => {
    acc.n++;
    if (isObj(u)) { acc.input += u.input_tokens || 0; acc.output += u.output_tokens || 0; }
    if (isObj(c) && num(c.usd) !== null && (c.basis === 'estimated' || c.basis === 'reported')) { acc.usd += c.usd; acc.priced++; if (c.price_table_version) acc.versions.add(c.price_table_version); }
  };
  for (const d of decisions) if (d.data.usage || d.data.cost) addSide(decUse, d.data.usage, d.data.cost);
  for (const e of evs) if (e.kind === 'hook_verdict' && isObj(e.data.judge) && (e.data.judge.usage || e.data.judge.cost)) addSide(judgeUse, e.data.judge.usage, e.data.judge.cost);

  const meta = evs.filter(e => e.kind === 'session_meta' && e.data.lifecycle === 'start').pop();
  const end = evs.filter(e => e.kind === 'session_meta' && e.data.lifecycle === 'end').pop();
  const health = sources || mergeSources(evs);
  return {
    events: evs, p1, p2, p3, p4: { decisions, tiers, totals, decisionUse: decUse, judgeUse }, health: { sources: health, counters },
    meta: meta ? { model_id: meta.data.model_id || null, tier: meta.data.model_tier || 'unknown', version: meta.data.claude_version || null, branch: meta.data.git_branch || null, project: meta.data.project_ref || null } : null,
    ended: end ? { success: end.data.success ?? null, duration_ms: end.data.duration_ms ?? null } : null,
  };
}

// ---------- S3: SQLite, read-only, never written ----------
// Spec 1 and 6.2 (rev 1.1): open file:<path>?mode=ro with PRAGMA query_only. immutable=1 is a LABELED fallback ("snapshot")
// because it ignores a live WAL and can return stale pages. Observed with this Node: mode=ro on a WAL-mode DB that has
// no -wal/-shm beside it CREATES both files, which is a write next to the UCEF DB. That case therefore reads a snapshot.
const dbUri = (file, mode = 'ro') => `${pathToFileURL(path.resolve(file)).href}?mode=ro${mode === 'snapshot' ? '&immutable=1' : ''}`;
function pickReadMode(file) {
  let wal = false, fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const b = Buffer.alloc(20);
    fs.readSync(fd, b, 0, 20, 0);
    wal = b[18] === 2 && b[19] === 2; // file-format versions 2/2 = WAL journal mode
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return wal && !isFile(`${file}-wal`) && !isFile(`${file}-shm`) ? 'snapshot' : 'ro';
}
let sqliteMod; // undefined = not probed, null = unavailable
function loadSqlite() {
  if (sqliteMod !== undefined) return sqliteMod;
  sqliteMod = null;
  if (parseInt(process.versions.node, 10) < 22) return sqliteMod;
  const ew = process.emitWarning;
  let tmp;
  try {
    process.emitWarning = () => {}; // node:sqlite may print an ExperimentalWarning that would garble the TUI
    const { DatabaseSync } = require('node:sqlite');
    // Probe on a private scratch DB that read-only is really enforced; if it is not, S3 stays off.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'puffr-ucef-'));
    const f = path.join(tmp, 'p.db');
    const w = new DatabaseSync(f); w.exec('CREATE TABLE t(x)'); w.close();
    let blocked = 0;
    for (const mode of ['ro', 'snapshot']) { // both connection forms must reject writes
      const r = new DatabaseSync(dbUri(f, mode), { readOnly: true });
      try { r.exec('CREATE TABLE u(y)'); } catch { blocked++; }
      r.close();
    }
    if (blocked === 2) sqliteMod = { DatabaseSync };
  } catch { sqliteMod = null; } finally {
    process.emitWarning = ew;
    if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  return sqliteMod;
}

/** mode=ro (or the labeled snapshot form); the engine rejects writes on both. Result carries read_mode: ro | snapshot. */
function readDb(file, sid, sqlite) {
  let mode = pickReadMode(file);
  for (;;) {
    try { return { ...readDbWith(file, sid, sqlite, mode), read_mode: mode }; } catch (e) {
      if (mode === 'snapshot') throw e;
      mode = 'snapshot'; // mode=ro failed (for example a read-only directory): labeled fallback
    }
  }
}

function readDbWith(file, sid, sqlite, mode) {
  const res = { alembicEmpty: null, rows: [], end: null };
  const db = new sqlite.DatabaseSync(dbUri(file, mode), { readOnly: true });
  try {
    try { db.exec('PRAGMA query_only = ON'); } catch {}
    try { res.alembicEmpty = db.prepare('SELECT COUNT(*) AS n FROM alembic_version').get().n === 0; } catch { res.alembicEmpty = true; }
    try {
      const r = db.prepare("SELECT timestamp, payload FROM monitoring_events WHERE session_id = ? AND event_type = 'session_end' ORDER BY id DESC LIMIT 1").get(sid);
      if (r) { let p = {}; try { p = JSON.parse(r.payload); } catch {} res.end = { ts: String(r.timestamp).replace(' ', 'T') + 'Z', duration_ms: nn(p.duration_ms), success: typeof p.success === 'boolean' ? p.success : null }; }
    } catch {}
    try { res.rows = db.prepare('SELECT * FROM decision_events WHERE session_id = ? ORDER BY id LIMIT 500').all(sid); } catch {}
  } finally { try { db.close(); } catch {} }
  return res;
}

function dbDecisionEvents(rows, c) {
  const out = [];
  for (const r of rows) {
    const pc = rcode(r.decision_class || r.point_id || r.question_id), pth = r.path_taken;
    if (!pc) continue;
    const provider = typeof r.provider === 'string' ? R.token(r.provider).slice(0, 40) : null;
    const conf = num(r.returned_confidence), fl = num(r.floor_in_effect), val = r.returned_value;
    const data = {
      tier: tierFromProvider(provider, pth), decision_class: pc, provider, path: ['fast_path_accept', 'fallback_llm', 'deny', 'defer'].includes(pth) ? pth : null,
      value: (typeof val === 'string' && VALUE_TOKEN.test(val)) || typeof val === 'number' || typeof val === 'boolean' ? val : null,
      confidence: conf !== null && conf >= 0 && conf <= 1 ? conf : null, latency_ms: nn(r.latency_ms),
    };
    if (fl !== null && fl >= 0 && fl <= 1) data.floor = fl;
    const mid = modelId(r.model_id); if (mid) data.model_id = mid;
    const e = makeEvent('ucef_db', `dec|${r.id}`, { ts: String(r.created_at || '').replace(' ', 'T').replace(/Z?$/, 'Z'), session_id: c.sid, workspace_id: c.ws, provenance: 'derived', kind: 'decision', data });
    if (e) out.push(e);
  }
  return out;
}

// ---------- discovery ----------
function checkRoot(root) {
  if (typeof root !== 'string' || !root || root.includes('\0')) throw new UcefError('bad_root', 'UCEF data directory is not set.');
  let real;
  try { real = fs.realpathSync(path.resolve(root)); } catch { throw new UcefError('no_root', 'UCEF data directory does not exist.'); }
  if (!isDir(real)) throw new UcefError('no_root', 'UCEF data directory is not a directory.');
  return real;
}

/** --ucef-data-dir, then UCEF_DATA_ROOT, then `.claude/data` found walking up from cwd. */
function detectRoot({ flag = null, env = process.env, cwd = process.cwd() } = {}) {
  if (flag) return { root: flag, how: 'flag' };
  if (env.UCEF_DATA_ROOT) return { root: env.UCEF_DATA_ROOT, how: 'env' };
  let d = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const c = path.join(d, '.claude', 'data');
    if (isDir(path.join(c, 'workspaces')) || isDir(path.join(c, 'decision-telemetry'))) return { root: c, how: 'detected' };
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

function validSessionId(sid) { return typeof sid === 'string' && ID_RE.test(sid) && !sid.includes('__'); }

class Monitor {
  constructor({ root, redact = true, projectRoots, sqlite, now = Date.now } = {}) {
    this.root = checkRoot(root);
    this.redact = redact !== false;
    this.projectRoots = projectRoots || lib.roots();
    this.sqliteOpt = sqlite; // undefined: probe lazily; null: force "unavailable" (tests)
    this.now = now;
    this.cache = new Map();
    this.perm = new Tail(() => ({ rows: [], malformed: 0 }));
    this.authored = new Tail(sharedBySid);
    this.proposals = new Tail(sharedBySid);
    this.failures = new Map();
    this.failOpen = new Map();
    this.s4 = { key: '', hit: false };
  }

  sessions() {
    const out = [], wsDir = path.join(this.root, 'workspaces');
    for (const ws of ls(wsDir)) {
      if (!ID_RE.test(ws)) continue;
      const sdir = path.join(wsDir, ws, 'sessions');
      for (const sid of ls(sdir)) {
        if (!validSessionId(sid)) continue;
        const dir = path.join(sdir, sid);
        let mt = 0, any = false;
        for (const f of ['orchestration-audit.jsonl', 'monitor-events.jsonl', '.atom-registry.json']) {
          const st = lstatOrNull(path.join(dir, f));
          if (st && st.isFile()) { any = true; mt = Math.max(mt, st.mtimeMs); }
        }
        if (any) out.push({ ws, sid, mtime: mt, dir });
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  state(sess) {
    let st = this.cache.get(sess.sid);
    if (st) { this.cache.delete(sess.sid); } else {
      st = { monitor: new Tail(() => ({ events: [], accepted: 0, rejected: 0, malformed: 0 })), audit: new Tail(auditInit), reg: { key: '', map: new Map() },
        main: new Tail(() => txInit({ sub: false, keepText: false })), subs: new Map(), tx: null, txAt: 0 };
    }
    st.sess = sess;
    this.cache.set(sess.sid, st);
    while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value); // LRU
    return st;
  }

  findTranscript(sid) {
    for (const r of this.projectRoots) {
      for (const d of ls(r)) {
        const f = path.join(r, d, `${sid}.jsonl`);
        if (isFile(f)) return { file: f, sdir: path.join(r, d, sid, 'subagents') };
      }
    }
    return null;
  }

  s4Degraded() {
    const f = path.join(this.root, 'ucef', 'logs', 'session-start-failures.log'), st = lstatOrNull(f);
    if (!st || !st.isFile()) return false;
    const key = `${st.mtimeMs}:${st.size}`;
    if (key === this.s4.key) return this.s4.hit;
    let hit = false, fd;
    try {
      fd = fs.openSync(f, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const len = Math.min(st.size, 65536), b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, st.size - len);
      hit = b.includes('UCEF DEGRADED-DB'); // the lines hold absolute paths: only the marker is looked for, nothing is kept
    } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
    this.s4 = { key, hit };
    return hit;
  }

  /** Newest session first. Returns the contract-shaped model for one session (`sid` or the newest). */
  snapshot(sid = null) {
    const list = this.sessions(), now = this.now();
    const idx = sid ? list.findIndex(s => s.sid === sid) : (list.length ? 0 : -1);
    const brief = list.map(s => ({ ws: s.ws, sid: s.sid, mtime: s.mtime, live: now - s.mtime < LIVE_MS }));
    if (idx < 0) {
      const model = summarize([], { now, sources: [], counters: { malformed: 0, rejected: 0 } });
      return { ...model, sessions: brief, index: -1, current: null, noSession: true, redact: this.redact };
    }
    const sess = list[idx], c = { sid: sess.sid, ws: sess.ws, redact: this.redact, atomOf: () => null, fallbackTs: new Date(sess.mtime).toISOString() };
    const st = this.state(sess);
    const raw = [], srcState = {}, counters = { malformed: 0, rejected: 0 };
    resetSeq();

    // S13 monitor-events.jsonl
    const mfile = path.join(sess.dir, 'monitor-events.jsonl');
    const mres = st.monitor.pump(mfile, (b, s) => {
      const r = acceptLine(b);
      if (r.ok) { s.accepted++; s.events.push(r.event); } else if (r.reason === 'version') s.rejected++; else s.malformed++;
    });
    raw.push(...st.monitor.state.events);
    counters.malformed += st.monitor.state.malformed; counters.rejected += st.monitor.state.rejected;
    srcState.monitor_events = mres === 'missing' ? { state: 'missing', reason_code: 'not_emitted' }
      : mres === 'unreadable' ? { state: 'unreadable', reason_code: 'open_failed' }
        : st.monitor.state.accepted === 0 && st.monitor.state.rejected > 0 ? { state: 'schema_mismatch', reason_code: 'schema_version_not_1' } : { state: 'ok', reason_code: null };

    // S8 .atom-registry.json (agent id -> semantic atom id)
    const rfile = path.join(sess.dir, '.atom-registry.json'), rst = lstatOrNull(rfile);
    if (rst && rst.isFile()) {
      const key = `${rst.mtimeMs}:${rst.size}`;
      if (key !== st.reg.key) {
        const map = new Map();
        const j = lib.readJson(rfile, null);
        for (const a of isObj(j) && Array.isArray(j.assignments) ? j.assignments : []) {
          if (isObj(a) && typeof a.claimed_by === 'string' && AGENT_RE.test(a.claimed_by) && typeof a.atom_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(a.atom_id)) map.set(a.claimed_by, a.atom_id);
        }
        st.reg = { key, map };
      }
      srcState.atom_registry = { state: 'ok', reason_code: null };
    } else srcState.atom_registry = { state: 'missing', reason_code: 'registry_absent' };

    // S10 / S11 transcripts
    const tx = st.tx && st.tx.file && isFile(st.tx.file) ? st.tx : (st.tx = this.findTranscript(sess.sid));
    let mainAtoms = new Map();
    if (tx) {
      st.main.pump(tx.file, onTx);
      mainAtoms = st.main.state.atoms;
    }

    // One atom resolution for every source: the UCEF_ATOM first line of the dispatch prompt, then the S8 registry.
    c.hints = new Map();
    c.atomOf = aid => c.hints.get(aid) || st.reg.map.get(aid) || null;

    if (tx) {
      counters.malformed += st.main.state.malformed;
      raw.push(...mainEvents(st.main.state, c));
      const subDirFiles = ls(tx.sdir).filter(f => /^agent-[A-Za-z0-9]{1,64}\.jsonl$/.test(f));
      for (const f of subDirFiles) {
        const aid = f.slice(6, -6);
        let sub = st.subs.get(aid);
        const metaFile = path.join(tx.sdir, `agent-${aid}.meta.json`), mst = lstatOrNull(metaFile);
        if (!sub) { sub = { meta: null, key: '', tail: null }; st.subs.set(aid, sub); }
        if (mst && mst.isFile()) {
          const key = `${mst.mtimeMs}:${mst.size}`;
          if (key !== sub.key) { sub.key = key; const m = lib.readJson(metaFile, null); sub.meta = isObj(m) ? m : null; }
        }
        const ref = sub.meta && mainAtoms.get(sub.meta.toolUseId);
        if (ref && ref.atom) c.hints.set(aid, ref.atom);
        const keepText = !!sub.meta && /constitutional-ai-agent$/.test(String(sub.meta.agentType || ''));
        if (!sub.tail || sub.tail.state.keepText !== keepText) sub.tail = new Tail(() => txInit({ sub: true, keepText }));
        sub.tail.pump(path.join(tx.sdir, f), onTx);
        counters.malformed += sub.tail.state.malformed;
        const s = sub.tail.state;
        s.atomsFromMain = mainAtoms;
        raw.push(...subEvents(aid, sub.meta, s, c));
      }
      srcState.transcript = { state: 'ok', reason_code: null };
      srcState.subagent_transcript = { state: subDirFiles.length ? 'ok' : 'missing', reason_code: subDirFiles.length ? null : 'no_subagent_transcripts' };
    } else {
      srcState.transcript = { state: 'missing', reason_code: 'transcript_not_found' };
      srcState.subagent_transcript = { state: 'missing', reason_code: 'transcript_not_found' };
    }

    // S1 orchestration-audit.jsonl (after the transcripts: only a start delegation, a transcript or an emitted
    // agent_run may create an agent row; named stops and outcomes of any other agent id are dropped, rule 2)
    const ares = st.audit.pump(path.join(sess.dir, 'orchestration-audit.jsonl'), onAudit);
    counters.malformed += st.audit.state.malformed;
    c.creators = new Set(raw.filter(e => e.kind === 'agent_run' && e.agent_id).map(e => e.agent_id));
    raw.push(...auditEvents(st.audit.state, c));
    srcState.audit_jsonl = ares === 'missing' ? { state: 'missing', reason_code: 'audit_absent' } : ares === 'unreadable' ? { state: 'unreadable', reason_code: 'open_failed' } : { state: 'ok', reason_code: null };

    // S5 decision-telemetry (authored + proposals only; captures/refusals are never opened)
    const dtDir = path.join(this.root, 'decision-telemetry');
    const ares5 = this.authored.pump(path.join(dtDir, 'authored.jsonl'), onSidRows);
    const pres5 = this.proposals.pump(path.join(dtDir, 'proposals.jsonl'), onSidRows);
    for (const o of this.authored.state.bySid.get(sess.sid) || []) { const e = authoredEvent(o, c); if (e) raw.push(e); }
    (this.proposals.state.bySid.get(sess.sid) || []).forEach((o, i) => { const e = proposalEvent(o, c, i); if (e) raw.push(e); });
    srcState.decision_telemetry = ares5 === 'missing' && pres5 === 'missing' ? { state: 'missing', reason_code: 'decision_log_absent' }
      : { state: 'ok', reason_code: pres5 === 'missing' ? 'proposals_log_absent' : null };

    // S7 hook-failures.jsonl (workspace scoped; message/traceback dropped)
    let ft = this.failures.get(sess.ws);
    if (!ft) this.failures.set(sess.ws, ft = new Tail(sharedBySid));
    const fres = ft.pump(path.join(this.root, 'workspaces', sess.ws, 'hook-failures.jsonl'), onSidRows);
    raw.push(...hookFailureEvents(ft.state.bySid.get(sess.sid) || [], c));
    srcState.hook_failures = fres === 'missing' ? { state: 'missing', reason_code: 'failures_log_absent' } : { state: 'ok', reason_code: null };
    // fail-open-counts.jsonl rows are counters (rule 6): aggregated into the health entry, never verdict rows.
    let fo = this.failOpen.get(sess.ws);
    if (!fo) this.failOpen.set(sess.ws, fo = new Tail(() => ({ rows: [], malformed: 0 })));
    const fores = fo.pump(path.join(this.root, 'workspaces', sess.ws, 'fail-open-counts.jsonl'), (b, s) => {
      const o = parseJson(b);
      if (!o) { s.malformed++; return; }
      const t = iso(o.timestamp);
      if (t && s.rows.length < 50000) s.rows.push(ms(t));
    });

    // S6 permission-request.log: INFO lines only, attributed to the session by time window
    const pres = this.perm.pump(path.join(this.root, 'permission-request.log'), onPerm);
    srcState.permission_log = pres === 'missing' ? { state: 'missing', reason_code: 'permission_log_absent' } : { state: 'ok', reason_code: null };

    // The session's time span (from everything that is not time-attributed) bounds S6.
    const stamps = raw.map(e => ms(e.ts)).filter(Boolean);
    if (stamps.length) {
      const lo = Math.min(...stamps) - 5000, hi = Math.max(...stamps) + 5000;
      // ASSUMPTION: counter rows carry no session id, so they are attributed to the session by the same time window as S6.
      const counted = fores === 'missing' ? 0 : fo.state.rows.filter(t => t >= lo && t <= hi).length;
      if (counted > 0) srcState.hook_failures = { state: 'ok', reason_code: 'fail_open_counters', count: counted };
      this.perm.state.rows.forEach((r, i) => {
        const t = ms(r.ts);
        if (t < lo || t > hi) return;
        const data = { hook_event: 'PermissionRequest', hook_name: 'permission-request', hook_type: 'command', model_tier: 'none', verdict: 'warn', reason_code: rcode(`deny_capability_unavailable:${String(r.reason).replace(/[^A-Za-z0-9_.-]/g, '_')}`), fail_open: true };
        const e = makeEvent('permission_log', `perm|${r.ts}|${i}`, { ts: r.ts, session_id: sess.sid, workspace_id: sess.ws, provenance: 'derived', kind: 'hook_verdict', data });
        if (e) raw.push(e);
      });
    }

    // S3 ucef_data.db (best effort) and the degraded-db signals (spec section 1)
    const dbFile = path.join(this.root, 'ucef', 'ucef_data.db');
    let signals = st.main.state.dbDegraded || this.s4Degraded() || isFile(`${dbFile}.migrate.lock`);
    let dbRead = 'ok';
    if (!isFile(dbFile)) { dbRead = 'missing'; } else {
      const sqlite = this.sqliteOpt === undefined ? loadSqlite() : this.sqliteOpt;
      if (!sqlite) dbRead = 'unavailable';
      else {
        try {
          const dbst = lstatOrNull(dbFile), key = `${dbst.mtimeMs}:${dbst.size}:${sess.sid}`;
          if (!st.db || st.db.key !== key || now - st.db.at > 30000) st.db = { key, at: now, res: readDb(dbFile, sess.sid, sqlite) };
          const r = st.db.res;
          if (r.alembicEmpty) signals = true;
          if (r.end) { const e = makeEvent('ucef_db', 'end', { ts: r.end.ts, session_id: sess.sid, workspace_id: sess.ws, provenance: 'derived', kind: 'session_meta', data: { lifecycle: 'end', duration_ms: r.end.duration_ms, success: r.end.success } }); if (e) raw.push(e); }
          raw.push(...dbDecisionEvents(r.rows, c));
        } catch { dbRead = 'unreadable'; }
      }
    }
    srcState.ucef_db = signals ? { state: 'degraded', reason_code: 'migration_failed' }
      : dbRead === 'missing' ? { state: 'missing', reason_code: 'db_absent' }
        : dbRead === 'unavailable' ? { state: 'unreadable', reason_code: 'node_sqlite_unavailable' }
          : dbRead === 'unreadable' ? { state: 'unreadable', reason_code: 'open_failed' } : { state: 'ok', reason_code: null };
    if (st.db && st.db.res && dbRead === 'ok') srcState.ucef_db.read_mode = st.db.res.read_mode; // ro | snapshot (rule 8)

    const events = finalizeEvents(raw, c);
    const last = {};
    for (const e of events) last[e.source] = e.ts;
    const sources = Object.entries(srcState).map(([source, v]) => ({ source, state: v.state, reason_code: v.reason_code, last_event_ts: last[source] || null,
      ...(v.count !== undefined ? { count: v.count } : {}), ...(v.read_mode ? { read_mode: v.read_mode } : {}) }));
    const model = summarize(events, { now, sources, counters });
    model.db = { state: srcState.ucef_db.state, read: dbRead };
    return { ...model, sessions: brief, index: idx, current: { ws: sess.ws, sid: sess.sid, live: now - sess.mtime < LIVE_MS }, noSession: false, redact: this.redact };
  }
}

module.exports = {
  Monitor, UcefError, acceptLine, summarize, finalizeEvents, dedupe, detectRoot, validSessionId, estimateCost, priceVersion,
  Tail, onAudit, auditInit, auditEvents, onTx, PHASES, MAX_LINE_BYTES, loadSqlite,
  canonicalKey, hookIdFromCommand, dropInferredPhase, pickReadMode,
};
