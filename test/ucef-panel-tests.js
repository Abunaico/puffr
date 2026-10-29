#!/usr/bin/env node
// puffr UCEF panel tests (run by test/run-tests.sh, or alone: node test/ucef-panel-tests.js).
// Offline and read-only against everything except its own temp dir. No dependencies.
//   - contract fixtures and redaction vectors from docs/ucef-monitor (byte-identical copy)
//   - every adapter, run on a synthetic UCEF tree, with its output checked against the v1 schema
//   - secret/escape leakage, live-tail semantics, read-only SQLite, CLI exit codes
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const U = require(path.join(ROOT, 'panel/ucef'));
const V = require(path.join(ROOT, 'panel/ucef-view'));
const R = require(path.join(ROOT, 'panel/ucef-redact'));
const { UcefPane } = require(path.join(ROOT, 'panel/ucef-tui'));
const lib = require(path.join(ROOT, 'lib/puffr'));
const PKG = require(path.join(ROOT, 'package.json'));
const CONTRACT = path.join(ROOT, 'docs/ucef-monitor');
const FIX = path.join(CONTRACT, 'fixtures');
const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7);

let pass = 0, fail = 0;
const ok = n => { pass++; console.log(`  ✔ ${n}`); };
const bad = (n, why) => { fail++; console.log(`  ✘ ${n}${why ? ` (${why})` : ''}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why));
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
const group = (title, fn) => {
  console.log(`— ${title} —`);
  try { fn(); } catch (e) { bad(`${title}: threw ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'puffr-ucef-test-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
const mk = (...p) => { const d = path.join(TMP, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };
const jl = rows => `${rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`;
const readLines = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// Secret-shaped strings are assembled at run time so none exists contiguously in the repo.
const SK = ['sk-', 'FAKE0123456789', 'abcdefghij'].join('');
const GH = ['ghp_', 'FAKEFAKEFAKEFAKEFAKEFAKE1234'].join('');
const CANARY = ['BIZ', 'CANARY', '7731'].join('-');

// ---------- a small JSON Schema (2020-12 subset) checker for the closed-world event schema ----------
const SCHEMA = JSON.parse(fs.readFileSync(path.join(CONTRACT, 'ucef-monitor-event.v1.schema.json'), 'utf8'));
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isType = (t, v) => (t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : t === 'object' ? isObj(v) : t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === t);
function validate(sch, v, errs, at) {
  if (sch === true || sch === undefined) return;
  if (sch.$ref) return validate(sch.$ref.replace('#/', '').split('/').reduce((o, k) => o[k], SCHEMA), v, errs, at);
  if (sch.const !== undefined && v !== sch.const) errs.push(`${at}: const ${JSON.stringify(sch.const)}`);
  if (sch.enum && !sch.enum.includes(v)) errs.push(`${at}: enum, got ${JSON.stringify(v)}`);
  if (sch.type && ![].concat(sch.type).some(t => isType(t, v))) { errs.push(`${at}: type ${JSON.stringify(sch.type)}`); return; }
  if (typeof v === 'string') {
    if (sch.pattern && !new RegExp(sch.pattern).test(v)) errs.push(`${at}: pattern ${sch.pattern.slice(0, 40)}`);
    if (sch.maxLength !== undefined && [...v].length > sch.maxLength) errs.push(`${at}: maxLength`);
  }
  if (typeof v === 'number') {
    if (sch.minimum !== undefined && v < sch.minimum) errs.push(`${at}: minimum`);
    if (sch.maximum !== undefined && v > sch.maximum) errs.push(`${at}: maximum`);
  }
  if (Array.isArray(v) && sch.items) v.forEach((x, i) => validate(sch.items, x, errs, `${at}[${i}]`));
  if (isObj(v)) {
    for (const r of sch.required || []) if (!Object.prototype.hasOwnProperty.call(v, r)) errs.push(`${at}: missing ${r}`);
    for (const [k, x] of Object.entries(v)) {
      if (sch.properties && sch.properties[k] !== undefined) validate(sch.properties[k], x, errs, `${at}.${k}`);
      else if (sch.additionalProperties === false) errs.push(`${at}: unknown key ${k}`);
      else if (isObj(sch.additionalProperties)) validate(sch.additionalProperties, x, errs, `${at}.${k}`);
      if (sch.propertyNames && sch.propertyNames.pattern && !new RegExp(sch.propertyNames.pattern).test(k)) errs.push(`${at}: key name ${k}`);
    }
    if (sch.maxProperties !== undefined && Object.keys(v).length > sch.maxProperties) errs.push(`${at}: maxProperties`);
  }
  for (const s of sch.allOf || []) validate(s, v, errs, at);
  if (sch.anyOf && !sch.anyOf.some(s => { const e = []; validate(s, v, e, at); return !e.length; })) errs.push(`${at}: anyOf`);
  if (sch.oneOf && sch.oneOf.filter(s => { const e = []; validate(s, v, e, at); return !e.length; }).length !== 1) errs.push(`${at}: oneOf`);
  if (sch.if) {
    const e = [];
    validate(sch.if, v, e, at);
    if (!e.length && sch.then) validate(sch.then, v, errs, at);
    else if (e.length && sch.else) validate(sch.else, v, errs, at);
  }
}
const schemaErrors = ev => { const e = []; validate(SCHEMA, ev, e, 'event'); return e; };
const render = (m, o = {}) => V.render(m, { width: 120, ...o });
const loadFixture = name => {
  const lines = readLines(path.join(FIX, name)), events = [], rej = [], bads = [];
  lines.forEach((l, i) => { const r = U.acceptLine(l); if (r.ok) events.push(r.event); else { bads.push(i + 1); rej.push(r.reason); } });
  return { lines, events, rejectedLines: bads, reasons: rej };
};

// ================= 1. contract copy is intact =================
group('ucef contract', () => {
  const sums = fs.readFileSync(path.join(CONTRACT, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean);
  const mismatched = sums.filter(l => { const [h, f] = l.split(/\s+/); return sha(path.join(CONTRACT, f)) !== h; });
  eq('contract files match SHA256SUMS', mismatched, []);
  check('schema validator accepts all normal fixture lines', loadFixture('normal-session.jsonl').events.every(e => !schemaErrors(e).length));
  const probe = JSON.parse(JSON.stringify(loadFixture('normal-session.jsonl').events[1]));
  probe.data.surprise = 1;
  check('schema validator rejects an unknown key (negative control)', schemaErrors(probe).length > 0);
  probe.data = { ...probe.data };
  delete probe.data.surprise;
  probe.data.verdict = 'ok'; // ok on a UserPromptSubmit hook violates the conditional rule
  check('schema validator enforces conditional rules (negative control)', schemaErrors(probe).length > 0);
});

// ================= 2. redaction vectors =================
group('ucef redaction vectors', () => {
  const vec = JSON.parse(fs.readFileSync(path.join(CONTRACT, 'redaction-vectors.json'), 'utf8'));
  for (const v of vec.vectors) {
    const f = R.finalize(v.input_parts.join(''), 240);
    const classes = Object.keys(f.counts).sort();
    check(`vector ${v.name}`, f.text === v.expected && JSON.stringify(classes) === JSON.stringify([...v.classes].sort()), `got ${JSON.stringify(f.text)} ${classes}`);
  }
  eq('truncation never cuts inside a [REDACTED:...] token', R.finalize(`${'x'.repeat(10)} ${SK}`, 20).text, 'xxxxxxxxxx ');
  eq('reason hash is of the scrubbed text', R.finalize(`k ${SK}`, 240).sha256, crypto.createHash('sha256').update('k [REDACTED:api_key]').digest('hex'));
  eq('safe() drops bidi and line-separator spoofing', R.safe('a‮b c', 50), 'abc');
  check('--ucef-no-redact path still strips terminal controls', R.safe(`x${ESC}]777;p${BEL}y`, 50, { redact: false }) === 'x]777;py');
  check('--ucef-no-redact path leaves secrets alone (explicit opt-out)', R.safe(`k ${SK}`, 50, { redact: false }).includes('sk-'));
});

// ================= 3. fixtures: accept/reject and the four panes =================
group('ucef fixtures', () => {
  const expectations = JSON.parse(fs.readFileSync(path.join(FIX, 'expectations.json'), 'utf8'));
  for (const [name, want] of Object.entries(expectations)) {
    if (want.kind === 'raw') { eq(`${name}: raw line count`, readLines(path.join(FIX, name)).length, want.lines); continue; } // raw S1 lines, not events
    const f = loadFixture(name);
    eq(`${name}: line count`, f.lines.length, want.lines);
    eq(`${name}: rejected lines match expectations.json`, f.rejectedLines, want.invalid_lines);
  }
  const unk = loadFixture('unknown-schema-version.jsonl');
  eq('unknown versions "2", integer 1 and "2"+unknown key are all rejected as version', unk.reasons, ['version', 'version', 'version']);
  eq('rejecting a line does not stop reading (line 1 still accepted)', unk.events.length, 1);
  check('a 4001-byte line is malformed, not accepted', U.acceptLine(Buffer.alloc(4001, 0x20)).reason === 'malformed');
  check('invalid UTF-8 is malformed', U.acceptLine(Buffer.from([0x7b, 0xff, 0x7d])).reason === 'malformed');
  check('missing schema_version is a version reject', U.acceptLine('{"event_id":"x"}').reason === 'version');

  // normal session: all four panes
  const n = loadFixture('normal-session.jsonl');
  const m = U.summarize(U.finalizeEvents(n.events), { now: Date.parse('2026-02-03T14:08:00Z'), counters: { malformed: 0, rejected: 0 } });
  m.sessions = [{ sid: 's' }]; m.index = 0; m.current = { ws: 'demo-workspace_feat-monitor-contract', sid: n.events[0].session_id, live: false };
  const raw = n.events.filter(e => e.kind === 'hook_verdict').reduce((a, e) => { a[e.data.verdict] = (a[e.data.verdict] || 0) + 1; return a; }, {});
  const text = render(m);
  const pane = name => { const i = text.indexOf(name); return i < 0 ? '' : text.slice(i).split(/\n\n(?=[A-Z])/)[0]; };
  // P1
  for (const v of ['allow', 'ok', 'block', 'warn', 'bypass', 'guidance', 'not_done']) eq(`P1 count ${v} equals a raw tally of the fixture`, m.p1.counts[v], raw[v] || 0);
  check('P1 renders verdict counts and non-allow rows', /allow 2 .* block 4 .* not_done 1/.test(pane('Hooks + verdicts')) && pane('Hooks + verdicts').includes('rm_rf_root'));
  check('P1 marks the inferred prompt-hook verdict', /not_done .*infer/.test(pane('Hooks + verdicts')));
  // P2
  eq('P2 shows six agents', m.p2.length, 6);
  eq('P2 model tiers', m.p2.map(a => a.tier), ['sonnet', 'haiku', 'opus', 'sonnet', 'opus', 'opus']);
  check('P2 status failed and atom ids are rendered', /constitutional-ai-agent\s+opus\s+failed/.test(pane('Agents')) && pane('Agents').includes('atom_1'));
  // P3
  eq('P3 phase states', Object.fromEntries(Object.entries(m.p3.phases).map(([p, v]) => [p, v.state])), { 1: 'done', 1.5: 'done', 2: 'done', 3: 'done', 4: 'done', 5: 'done', 5.5: 'skipped', 6: 'done' });
  eq('P3 gate kinds', [...new Set(m.p3.gates.map(e => e.data.gate))].sort(), ['completion', 'constitutional', 'field_stability']);
  check('P3 shows the threshold carried by the event, not a hardcoded one', /completion\s+fail\s+0\.90\s+thr 0\.92/.test(pane('Phase + gates')) && /field_stability\s+pass\s+0\.82\s+thr 0\.70/.test(pane('Phase + gates')));
  // P4
  eq('P4 decision tiers', m.p4.tiers, { deterministic: 2, jev: 1, llm: 1 });
  check('P4 renders confidence and latency', /jev\s+mode_enum_conservative\s+convergent\s+0\.97\s+41ms/.test(pane('Jev decisions')));
  check('P4 total is finished subagent runs only, labelled estimated with the price table version', /≈\$2\.94 estimated/.test(pane('Jev decisions')) && pane('Jev decisions').includes('synthetic-v1'), pane('Jev decisions').split('\n').filter(l => /cost/.test(l)).join(' / '));
  check('P4 decision and judge usage are separate lines, not added into the total', /decisions 1 with usage[^\n]*in 1\.2k[^\n]*out 80[^\n]*≈\$0\.00/.test(pane('Jev decisions')) && /judges 1 with usage[^\n]*in 900[^\n]*out 2\.1k[^\n]*≈\$0\.29/.test(pane('Jev decisions')));
  check('P4 total excludes decision and judge cost (2.9387)', Math.abs(m.p4.totals.usd - 2.9387) < 1e-9, String(m.p4.totals.usd));
  eq('P4 token sums over deduped agent runs', [m.p4.totals.input, m.p4.totals.output], [3470, 65100]);
  eq('every fixture event of every file passes the schema checker', ['normal-session', 'degraded-db', 'secret-bearing', 'dedupe-cases'].flatMap(f => loadFixture(`${f}.jsonl`).events.flatMap(e => schemaErrors(e))), []);
  eq('every keyed fixture line carries the canonical dedupe_key (<=128 chars)', ['normal-session', 'degraded-db', 'secret-bearing', 'dedupe-cases'].flatMap(f => loadFixture(`${f}.jsonl`).events.filter(e => U.canonicalKey(e) !== null).filter(e => e.dedupe_key !== U.canonicalKey(e) || e.dedupe_key.length > 128).map(e => `${f}:${e.dedupe_key}`)), []);
  eq('normal-session collapses to as many rows as lines (expectations.json collapsed_rows)', U.dedupe(loadFixture('normal-session.jsonl').events).length, expectations['normal-session.jsonl'].collapsed_rows);

  // v1.1 dedupe cases a, b, c, e, g (fixtures/dedupe-cases.jsonl)
  const dc = loadFixture('dedupe-cases.jsonl');
  for (const [cs, want] of Object.entries(expectations['dedupe-cases.jsonl'].cases)) {
    const evs = dc.events.filter(e => e.ext && e.ext.case === cs), rows = U.dedupe(U.dropInferredPhase(evs));
    eq(`case ${cs}: ${evs.length} lines collapse to ${want.rows} rows`, rows.length, want.rows);
    eq(`case ${cs}: the real pipeline (finalizeEvents) reaches the same row count`, U.finalizeEvents(evs).length, want.rows);
    if (want.winner_provenance) check(`case ${cs}: the winner is ${want.winner_provenance}`, rows.every(r => r.provenance === want.winner_provenance));
    for (const [ph, st] of Object.entries(want.phase_status || {})) eq(`case ${cs}: phase ${ph} renders ${st}`, U.summarize(U.finalizeEvents(evs), {}).p3.phases[ph].state, st);
  }

  // v1.1 case d: raw S1 lines. Only a start delegation (or a transcript / emitted event) creates an agent row.
  const rawLines = readLines(path.join(FIX, 'raw', 's1-orphan-agents.jsonl'));
  const as = U.auditInit();
  rawLines.forEach(l => U.onAudit(Buffer.from(l), as));
  const orphanRows = U.summarize(U.finalizeEvents(U.auditEvents(as, { sid: 's', ws: 'w', atomOf: () => null, creators: new Set() })), {}).p2;
  eq('case d: orphan outcome / named stop / placeholder stop create no row; the started agent is filled by its outcome', Object.fromEntries(orphanRows.map(a => [a.agent_id, a.status])), expectations['raw/s1-orphan-agents.jsonl'].agent_rows);
  const withTranscript = U.summarize(U.finalizeEvents(U.auditEvents(as, { sid: 's', ws: 'w', atomOf: () => null, creators: new Set(['a7000000000000004']) })), {}).p2;
  eq('case d: a transcript for that agent id DOES let the named stop fill its row', withTranscript.map(a => a.agent_id).sort(), ['a7000000000000001', 'a7000000000000004']);

  // hook_id from the attachment command (spec 4.4), never from hookName
  for (const [cmd, want] of [['uv run --script /plugin/hooks/user-prompt-submit.py', 'user-prompt-submit'], ['${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.sh', 'on-stop'], ['echo hi', 'echo'],
    ["bash -c '/opt/My Hooks/Guard.Sh' --flag", 'guard'], ['"/a b/c d/push-guard.js"', 'push-guard'], ['', null], [undefined, null], ['   ', null], ['/x/.hidden', 'hidden'], ['/x/file.verylongext', 'file-verylongext']]) {
    eq(`hook_id from command ${JSON.stringify(cmd)}`, U.hookIdFromCommand(cmd), want);
  }

  // degraded db
  const d = loadFixture('degraded-db.jsonl');
  const dm = U.summarize(U.finalizeEvents(d.events), { now: Date.parse('2026-02-04T09:32:00Z') });
  dm.sessions = [{ sid: 's' }]; dm.index = 0; dm.current = { ws: 'w', sid: d.events[0].session_id, live: false };
  const dt = render(dm);
  check('degraded-db: health names ucef_db degraded with its reason and the snapshot read mode', /ucef_db degraded\(migration_failed, snapshot\)/.test(dt), dt.split('\n').filter(l => /ucef_db/.test(l)).join(' / '));
  check('degraded-db: fail-open counters appear as a health aggregate, not as rows', /hook_failures\(fail_open_counters, n=\d+\)/.test(dt));
  check('degraded-db: a pane whose sources are missing says "no data source", not zeros', /Jev decisions \+ cost[^\n]*\n[^\n]*no data source/.test(dt));
  check('degraded-db: cost is "unknown" when the usage is an audit total with no model', /cost unknown/.test(dt));
  check('degraded-db: the other panes keep working', /Agents 1 runs/.test(dt) && /completion\s+fail/.test(dt));

  // secret bearing
  const s = loadFixture('secret-bearing.jsonl');
  const sm = U.summarize(U.finalizeEvents(s.events), {});
  sm.sessions = [{ sid: 's' }]; sm.index = 0; sm.current = { ws: 'w', sid: s.events[0].session_id, live: false };
  const st = render(sm);
  check('secret-bearing: placeholders are shown', st.includes('[REDACTED:api_key]') && st.includes('[REDACTED:url_userinfo]'));
  check('secret-bearing: no escape or BEL reaches the output', !st.includes(ESC) && !st.includes(BEL));
  check('secret-bearing: output holds no secret-shaped substring', R.SCRUBBERS.every(([, rx]) => { rx.lastIndex = 0; const hit = rx.test(st.replace(/\[REDACTED:[a-z_]+\]/g, '')); rx.lastIndex = 0; return !hit; }));
  // consumers must scrub again at render time, even if a producer failed to
  const raw2 = JSON.parse(JSON.stringify(s.events[1]));
  raw2.data.reason_text = `leaked ${SK} and ${GH}`;
  const rm = U.summarize([raw2], {});
  rm.sessions = [{ sid: 's' }]; rm.index = 0; rm.current = { ws: 'w', sid: 'abcdefgh1', live: false };
  const rt = render(rm);
  check('render-time re-scrub removes secrets a producer left in reason_text', !rt.includes(SK) && !rt.includes(GH) && rt.includes('[REDACTED:'));
  const rt2 = render(rm, { redact: false });
  check('redaction off is announced on screen', rt2.includes('REDACTION OFF'));
  // style cannot be injected through event data
  const colored = render(sm, { style: V.ANSI });
  check('only puffr style sequences appear with colour on', !colored.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').includes(ESC));
});

// ================= 4. adapters on a synthetic UCEF tree =================
const SID = '95401a50-d7b1-4598-a740-2ffcc1385e29', WS = 'demo-ws_feat-x', OTHER_SID = '11111111-2222-3333-4444-555555555555';
const A = 'a0b1c2d3e4f506172', B = 'a1b2c3d4e5f607182', C = 'a2c3d4e5f6071829a', D = 'a3d4e5f60718293ab';
const T0 = Date.parse('2026-10-25T05:30:00.000Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const SECRET_CWD = '/Users/someone/very-private-client-project';

function buildTree(base, { sqlite = false, markDegradedInLog = true } = {}) {
  const data = path.join(base, 'data'), proj = path.join(base, 'projects', '-tmp-demo');
  const sdir = path.join(data, 'workspaces', WS, 'sessions', SID);
  fs.mkdirSync(path.join(data, 'ucef'), { recursive: true });
  const audit = (type, ts, extra = {}, rest = {}) => ({ schema_version: '1.0.0', timestamp: new Date(T0 + ts * 1000).toISOString().replace('Z', '+00:00'), event_type: type, session_id: SID, workspace_id: WS, phase: null, model_id: null, ...rest, extra });
  put(path.join(sdir, 'orchestration-audit.jsonl'), jl([
    audit('agent_delegation', 5, { agent_id: A }, { agent_invoked: 'ucef-core:meta:semantic-context-evaluator' }),
    audit('agent_delegation', 20, { lifecycle: 'stop', agent_id: A }, { agent_invoked: 'ucef-core:meta:semantic-context-evaluator', input_tokens: 99999, output_tokens: 88888, cache_tokens: 7777777, duration_ms: 15000 }),
    audit('agent_delegation', 21, { lifecycle: 'stop', agent_id: A }, { agent_invoked: 'stop' }),
    audit('agent_delegation', 21, { lifecycle: 'stop', agent_id: A }, { agent_invoked: 'stop' }),
    audit('agent_delegation', 30, { agent_id: B }, { agent_invoked: 'general-purpose' }),
    audit('agent_delegation', 60, { lifecycle: 'stop', agent_id: B }, { agent_invoked: 'general-purpose', input_tokens: 10, output_tokens: 20, cache_tokens: 30, duration_ms: 30000 }),
    audit('atom_outcome', 61, { agent_id: B }, { atom_id: B, atom_outcome: 'succeeded', quality_gate_result: { gate: 'error_detection', passed: true } }),
    audit('tool_use', 31, { agent_id: B, tool_name: 'Bash' }), audit('tool_use', 32, { agent_id: B, tool_name: 'Read' }),
    audit('completion_gate', 70, { agent_id: C }, { atom_id: 'cva_1', quality_gate_result: { gate: 'completion', source: 'verifier', score: 0.9, threshold: 0.92, passed: false, status: 'fail', reason: 'Below Threshold!' } }),
    audit('hook_step_report', 71, {}, { hook: 'subagent-stop', step: 'gate_counters', atom_id: null, violations: ['cva_cycles:unkeyed'], details: { cva_cycles: 0 } }),
    audit('session_quality_grade', 72), audit('grading_signal', 72),
    '{this is not json',
  ]));
  put(path.join(sdir, '.atom-registry.json'), JSON.stringify({ assignments: [{ atom_id: 'atom_9', agent_type: 'general-purpose', task_complexity: 0.5, claimed_by: B }, { atom_id: 'atom_registry_A', agent_type: 'x', task_complexity: 0.1, claimed_by: A }] }));
  put(path.join(data, 'workspaces', WS, 'hook-failures.jsonl'), jl([
    { timestamp: at(40), hook: 'subagent-stop', step: 'conversation_lifecycle', exception_type: 'Exception', message: `closure incomplete for ${CANARY} ${SECRET_CWD}`, traceback: `File ${SECRET_CWD}/x.py`, session_id: SID },
    { timestamp: at(41), hook: 'pre-tool-use', step: 'x', message: 'other session', session_id: OTHER_SID },
  ]));
  put(path.join(data, 'decision-telemetry', 'authored.jsonl'), jl([
    { authored_provenance: 'inferred', authored_status: 'option', authored_value: 'convergent', point_id: 'stability_mode_selection', question_id: 'stability_mode', question_digest: 'b'.repeat(64), recorded_at: at(2), session_id: SID, supplied_status: 'none', supplied_value: null },
    { authored_provenance: 'defaulted', authored_status: 'default', authored_value: 'analytical_technical', point_id: 'register_mode_selection', question_id: 'register_mode', question_digest: 'c'.repeat(64), recorded_at: at(3), session_id: SID },
    { authored_provenance: 'inferred', authored_value: 'free text with spaces is never carried', point_id: 'free_text_point', question_id: 'q', recorded_at: at(4), session_id: SID },
    { authored_provenance: 'inferred', authored_value: 'other', point_id: 'other_session_point', recorded_at: at(5), session_id: OTHER_SID },
  ]));
  put(path.join(data, 'workspaces', WS, 'fail-open-counts.jsonl'), jl([10, 11, 12, -7200].map(sec => ({ timestamp: at(sec), hook_name: 'subagent-stop', step_name: 'x', error_message: `counter ${CANARY} ${SECRET_CWD}` }))));
  put(path.join(data, 'decision-telemetry', 'captures.jsonl'), jl([{ session_id: SID, state: { note: CANARY } }]));
  put(path.join(data, 'permission-request.log'), [
    `2026-10-25T05:29:00Z\n{\n  "tool_name": "Write",\n  "tool_input": { "content": "${CANARY} business content" }\n}\n\n`,
    `INFO ${at(-3600).replace(/\.\d+Z$/, 'Z')} deny_capability=unavailable reason=missing_dep:old\n`,
    `2026-10-25T05:30:12Z\n{\n  "tool_input": { "content": "${CANARY} more business content ${SK}" }\n}\n\n`,
    `INFO ${at(12).replace(/\.\d+Z$/, 'Z')} deny_capability=unavailable reason=missing_dep:shfmt\n`,
    `INFO ${at(13).replace(/\.\d+Z$/, 'Z')} defer_reason=needs_human\n`, '\n',
  ].join(''));
  if (markDegradedInLog) put(path.join(data, 'ucef', 'logs', 'session-start-failures.log'), `2026-10-25T05:00:00-07:00 UCEF DEGRADED-DB: ${SECRET_CWD}/db failed: table conversations already exists\n`);

  // transcripts (S10 main, S11 subagents)
  const tx = (o, s) => ({ timestamp: at(s), sessionId: SID, version: '2.1.306', gitBranch: 'feat/x', cwd: SECRET_CWD, ...o });
  const promptText = `[hook:haiku-done-judge] Decide whether the work is complete. Reference ${CANARY}.`;
  const feedback = `Stop hook feedback:\n[${promptText}]: Tests are missing. export OPENAI_API_KEY=${SK} then rerun.`;
  const msg = (id, model, out, stop, extra = {}) => ({ id, model, stop_reason: stop, usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, ...extra });
  put(path.join(proj, `${SID}.jsonl`), jl([
    tx({ type: 'assistant', message: { ...msg('msg_main', 'claude-opus-5-5', 50, 'tool_use'), content: [{ type: 'tool_use', id: 'toolu_A1', name: 'Agent', input: { prompt: 'UCEF_ATOM: atom_id=atom_7 task_complexity=0.61\nDo the thing.' } }] } }, 3),
    tx({ type: 'assistant', message: { ...msg('msg_main2', 'claude-opus-5-5', 20, 'tool_use'), content: [{ type: 'tool_use', id: 'toolu_F1', name: 'mcp__plugin_ucef-core_ucef-orchestration__field_stability_measure', input: { phase: 'post_phase_1' } }] } }, 4),
    tx({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_F1', content: [{ type: 'text', text: '{"aggregate_score":0.95,"passed":true,"stability_mode":"convergent","effective_thresholds":{"field_stability_floor":0.9}}' }] }] } }, 5),
    tx({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'UserPromptSubmit', hookName: 'UserPromptSubmit', exitCode: 0, durationMs: 61, command: `${SECRET_CWD}/hooks/user-prompt-submit.py`, toolUseID: 'hk_ups1', stdout: `ctx ${CANARY} ${ESC}]777;notify;pwn${BEL} <!-- UCEF_HOOK_DATA: {"hook": "user-prompt-submit", "step": "routing_enforcement", "result": "BYPASSED", "bypass_reason": "short_prompt"} -->`, stderr: '' } }, 6),
    tx({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'UserPromptSubmit', hookName: 'UserPromptSubmit', exitCode: 0, durationMs: 58, command: `uv run --script ${SECRET_CWD}/hooks/routing.py`, toolUseID: 'hk_ups2', stdout: '<!-- UCEF_HOOK_DATA: {"result": "GUIDANCE_PROVIDED", "processing_mode": "x"} -->' } }, 7),
    // two DISTINCT command hooks that share hookName 'PreToolUse:Bash' on one toolUseID (expect 2 rows), a repeat of the first (collapses), and one with no command (no event)
    tx({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'PreToolUse', hookName: 'PreToolUse:Bash', toolUseID: 'toolu_hk1', exitCode: 0, durationMs: 9, stdout: `secret ${SK}`, command: `${SECRET_CWD}/hooks/guard.sh` } }, 8),
    tx({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'PreToolUse', hookName: 'PreToolUse:Bash', toolUseID: 'toolu_hk1', exitCode: 0, durationMs: 11, stdout: '', command: `${SECRET_CWD}/hooks/audit.sh` } }, 8),
    tx({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'PreToolUse', hookName: 'PreToolUse:Bash', toolUseID: 'toolu_hk1', exitCode: 0, durationMs: 10, stdout: '', command: `${SECRET_CWD}/hooks/guard.sh` } }, 8),
    tx({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'PreToolUse', hookName: 'PreToolUse:Bash', toolUseID: 'toolu_hk1', exitCode: 0, durationMs: 12, stdout: '' } }, 8),
    tx({ type: 'attachment', attachment: { type: 'hook_non_blocking_error', hookEvent: 'PostToolUse', hookName: 'PostToolUse:Write', toolUseID: 'toolu_hk2', command: `${SECRET_CWD}/hooks/fmt.sh`, exitCode: 1, durationMs: 14, stderr: `boom ${CANARY}` } }, 9),
    tx({ type: 'attachment', attachment: { type: 'hook_system_message', hookEvent: 'SessionStart', hookName: 'SessionStart', content: `[session-start] step database_migration failed: table exists at ${SECRET_CWD}` } }, 10),
    tx({ type: 'system', subtype: 'stop_hook_summary', hookCount: 2, toolUseID: 'toolu_stop1', hookInfos: [{ command: `${SECRET_CWD}/on-stop.sh`, durationMs: 400 }, { command: promptText, promptText }], hookErrors: [], preventedContinuation: false, stopReason: '' }, 80),
    tx({ type: 'user', isMeta: true, message: { role: 'user', content: feedback } }, 81),
    tx({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1, toolUseID: 'toolu_stop2', hookInfos: [{ command: promptText, promptText }], hookErrors: [], preventedContinuation: false, stopReason: '' }, 120),
    tx({ permissionDecision: { decision: 'accept', source: 'user' }, type: 'permission-mode' }, 11),
    tx({ permissionDecision: { decision: 'deny', source: 'user' }, type: 'permission-mode' }, 12),
  ]));
  const sub = path.join(proj, SID, 'subagents');
  const al = (id, model, out, stop, s, content = [{ type: 'text', text: 'ok' }]) => ({ timestamp: at(s), type: 'assistant', message: { ...msg(id, model, out, stop), content } });
  put(path.join(sub, `agent-${A}.jsonl`), jl([
    al('msg_1', 'claude-sonnet-5-5', 5, null, 6, [{ type: 'tool_use', id: 'toolu_s1', name: 'Read', input: {} }]),
    al('msg_1', 'claude-sonnet-5-5', 5, null, 7, [{ type: 'text', text: 'a' }]),
    al('msg_1', 'claude-sonnet-5-5', 40, 'tool_use', 8, [{ type: 'tool_use', id: 'toolu_s2', name: 'Grep', input: {} }]),
    al('msg_2', 'claude-sonnet-5-5', 100, 'end_turn', 20),
  ]));
  put(path.join(sub, `agent-${A}.meta.json`), JSON.stringify({ agentType: 'ucef-core:meta:semantic-context-evaluator', description: `Phase 1 for ${SK} in ${CANARY}${ESC}[31m red`, toolUseId: 'toolu_A1', spawnDepth: 1, requestShape: 'background', finished: true }));
  put(path.join(sub, `agent-${B}.jsonl`), jl([al('msg_b1', 'claude-haiku-4-5', 30, 'tool_use', 31)]));
  put(path.join(sub, `agent-${B}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'still working', toolUseId: 'toolu_B', spawnDepth: 1, requestShape: 'foreground', finished: true }));
  put(path.join(sub, `agent-${D}.jsonl`), jl([al('msg_d1', 'claude-haiku-4-5', 12, 'tool_use', 100)]));
  put(path.join(sub, `agent-${D}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'still working', toolUseId: 'toolu_D', spawnDepth: 1, requestShape: 'foreground', finished: false }));
  put(path.join(sub, `agent-${C}.jsonl`), jl([al('msg_c1', 'claude-opus-5-5', 70, 'end_turn', 90, [{ type: 'text', text: 'Verdict:\n```yaml\ncompliance_score: 0.858\nstatus: rejected\n```\n' }])]));
  put(path.join(sub, `agent-${C}.meta.json`), JSON.stringify({ agentType: 'ucef-core:meta:constitutional-ai-agent', description: 'Phase 4.2', toolUseId: 'toolu_C', spawnDepth: 1, requestShape: 'background', finished: true }));

  if (sqlite) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(data, 'ucef', 'ucef_data.db'));
    db.exec('CREATE TABLE alembic_version(version_num TEXT); CREATE TABLE monitoring_events(id INTEGER PRIMARY KEY, timestamp TEXT, session_id TEXT, event_type TEXT, payload TEXT, workspace_id TEXT);');
    const ins = db.prepare('INSERT INTO monitoring_events(timestamp, session_id, event_type, payload, workspace_id) VALUES (?,?,?,?,?)');
    ins.run('2026-10-25 05:40:00.000000', SID, 'session_end', JSON.stringify({ duration_ms: 600000, success: true }), WS);
    for (let i = 0; i < 5; i++) ins.run(`2026-10-25 05:3${i}:00.000000`, SID, 'agent_delegation', JSON.stringify({ agent_id: 'a9999999999999999', task_type: 'stop' }), WS); // placeholder re-fires
    db.close();
  }
  return { data, proj: path.join(base, 'projects'), sdir };
}

function leakScan(name, text, extra = []) {
  const forbidden = [CANARY, SK, GH, SECRET_CWD, 'CLAUDE_PLUGIN_ROOT', 'Decide whether the work is complete', os.tmpdir(), TMP, ...extra];
  const hit = forbidden.filter(f => f && text.includes(f));
  check(`${name}: no secret, business content, prompt text or absolute path in the output`, !hit.length, `found ${hit.map(h => h.slice(0, 20)).join(', ')}`);
  check(`${name}: no terminal escape or BEL in plain output`, !text.includes(ESC) && !text.includes(BEL));
}

group('ucef adapters (synthetic tree)', () => {
  const t = buildTree(mk('tree1'), { sqlite: false });
  const mon = new U.Monitor({ root: t.data, projectRoots: [t.proj], sqlite: null, now: () => T0 + 130000 });
  const before = { audit: sha(path.join(t.sdir, 'orchestration-audit.jsonl')) };
  const m = mon.snapshot(SID);
  const ev = m.events;
  const evOf = (kind, f = () => true) => ev.filter(e => e.kind === kind && f(e));
  const dec0 = ev.filter(e => e.kind === 'decision');
  check('session found, live, indexed', m.current && m.current.sid === SID && m.index === 0 && m.sessions.length === 1);
  eq('every event the adapters produced is schema-valid', ev.flatMap(e => schemaErrors(e).map(x => `${e.kind}/${e.source}: ${x}`)), []);

  // S1 / S8 / S11 agents
  const agent = id => m.p2.find(a => a.agent_id === id);
  eq('agents: four distinct runs after audit + transcript dedupe', m.p2.length, 4);
  eq('agent A atom: UCEF_ATOM first line beats the registry', agent(A).atom_id, 'atom_7');
  eq('agent B atom: from the registry via claimed_by', agent(B).atom_id, 'atom_9');
  eq('agent A tier and status', [agent(A).tier, agent(A).status], ['sonnet', 'succeeded']);
  eq('agent B: audit status wins on later ts, model tier is filled from the transcript', [agent(B).status, agent(B).tier, agent(B).usage.basis], ['succeeded', 'haiku', 'per_message_deduped']);
  eq('agent D is still running (meta.finished false), tier from its own messages, shown as live', [agent(D).status, agent(D).tier, agent(D).live], ['running', 'haiku', true]);
  const aU = agent(A).usage;
  eq('agent A usage is deduped by message.id (largest output per id, then summed), not the audit total', [aU.basis, aU.input_tokens, aU.output_tokens, aU.cache_read_input_tokens, aU.cache_creation_input_tokens], ['per_message_deduped', 20, 140, 2000, 400]);
  eq('agent A cost: puffr price table, labelled estimated with a version', agent(A).cost, { usd: Math.round(lib.costOf('claude-sonnet-5-5', [20, 2000, 400, 0, 140]) * 1e6) / 1e6, basis: 'estimated', price_table_version: `puffr-${PKG.version}` });
  check('"stop" placeholder rows are ignored (no duplicate agent runs)', evOf('agent_run', e => e.agent_id === A).length === 2);
  eq('agent tool calls: counted from distinct tool_use ids', evOf('agent_run', e => e.agent_id === A && e.data.lifecycle === 'stop')[0].data.tool_calls, 2);
  eq('atom_outcome is a status fill only: it produces no error_detection gate (rule 3)', evOf('phase_gate', e => e.data.gate === 'error_detection').length, 0);
  eq('agent B atom id (hex id on its atom_outcome) still resolves through the registry', agent(B).atom_id, 'atom_9');
  const con = evOf('phase_gate', e => e.data.gate === 'constitutional')[0];
  eq('constitutional verdict from the final YAML block is labelled inferred, with no invented threshold', [con.provenance, con.data.status, con.data.score, con.data.threshold], ['inferred', 'fail', 0.858, undefined]);
  const cg = evOf('phase_gate', e => e.data.gate === 'completion')[0];
  eq('completion gate carries its own threshold and a sanitised reason code', [cg.data.status, cg.data.score, cg.data.threshold, cg.data.reason_code, cg.atom_id], ['fail', 0.9, 0.92, 'below_threshold_', 'cva_1']);
  const fs1 = evOf('phase_gate', e => e.data.gate === 'field_stability');
  eq('field_stability_measure tool result becomes a gate (inferred)', fs1.length === 1 && [fs1[0].data.phase, fs1[0].data.status, fs1[0].data.threshold, fs1[0].provenance], ['1', 'pass', 0.9, 'inferred']);
  check('phase position is inferred from dispatch order and marked inferred', evOf('phase_gate', e => e.source === 'adapter' && e.data.phase === '1').length === 2 && m.p3.phases['1'].prov === 'inferred' && m.p3.phases['4'].state !== 'pending');

  // S12 / S10 hook verdicts
  eq('S12: BYPASSED and GUIDANCE_PROVIDED become verdicts', [m.p1.counts.bypass, m.p1.counts.guidance], [1, 1]);
  const bypass = evOf('hook_verdict', e => e.data.verdict === 'bypass')[0];
  eq('S12 bypass reason_code and latency come from the attachment', [bypass.data.reason_code, bypass.data.latency_ms, bypass.data.hook_name], ['short_prompt', 61, 'user-prompt-submit']);
  const nd = evOf('hook_verdict', e => e.data.verdict === 'not_done')[0];
  eq('prompt hook: Stop feedback gives not_done, inferred, named by its [hook:] marker', [nd.data.hook_name, nd.provenance, nd.data.hook_type, nd.data.model_tier], ['haiku-done-judge', 'inferred', 'prompt', 'unknown']);
  check('prompt hook reason is scrubbed before truncation and hashed over the scrubbed text', nd.data.reason_text.includes('[REDACTED:') && !nd.data.reason_text.includes('sk-') && /^[0-9a-f]{64}$/.test(nd.data.reason_sha256) && nd.redaction && nd.redaction.secrets_scrubbed >= 1);
  check('prompt hook without feedback is ok by absence (inferred)', evOf('hook_verdict', e => e.data.hook_type === 'prompt' && e.data.verdict === 'ok').length === 1);
  const pre = evOf('hook_verdict', e => e.data.tool_use_id === 'toolu_hk1');
  eq('two distinct command hooks sharing hookName PreToolUse:Bash on one toolUseID are 2 rows (hook_id from command, not hookName)', pre.map(e => e.data.hook_name).sort(), ['audit', 'guard']);
  eq('the same hook repeated on that toolUseID collapses, and a hook_success with no command makes no event', [pre.length, pre.every(e => e.data.verdict === 'allow'), pre.map(e => e.dedupe_key).sort()], [2, true, ['hv|PreToolUse|toolu_hk1|audit', 'hv|PreToolUse|toolu_hk1|guard']]);
  check('hookName is never used as a hook name or key', !ev.some(e => e.kind === 'hook_verdict' && /PreToolUse:Bash|PostToolUse:Write/.test(`${e.data.hook_name} ${e.dedupe_key}`)));
  const fmt = evOf('hook_verdict', e => e.data.hook_name === 'fmt')[0];
  eq('non-blocking error is a fail-open warn keyed by its command', [fmt.data.verdict, fmt.data.fail_open, fmt.dedupe_key], ['warn', true, 'hv|PostToolUse|toolu_hk2|fmt']);
  eq('events with no tool_use_id are keyed n<seq> and never collide', [ev.filter(e => e.kind === 'hook_verdict' && !e.data.tool_use_id).every(e => e.dedupe_key.includes(`|n${e.seq}|`)), new Set(ev.filter(e => e.kind === 'hook_verdict' && !e.data.tool_use_id).map(e => e.seq)).size === ev.filter(e => e.kind === 'hook_verdict' && !e.data.tool_use_id).length], [true, true]);
  eq('every adapter event carries the canonical dedupe_key (same function as contract_tool.py canonical_key)', ev.filter(e => U.canonicalKey(e) !== null && e.dedupe_key !== U.canonicalKey(e)).map(e => e.dedupe_key), []);
  eq('every keyed adapter event has a key', ev.filter(e => ['hook_verdict', 'agent_run', 'phase_gate', 'decision'].includes(e.kind) && !e.dedupe_key).length, 0);
  eq('decision keys use the digest when present, else t<digits>', dec0.map(d => d.dedupe_key.split('|').slice(0, 3).join('|') + '|' + (d.data.state_digest ? d.dedupe_key.split('|')[3] === d.data.state_digest.slice(0, 16) : /^t\d+$/.test(d.dedupe_key.split('|')[3]))), ['dc|stability_mode_selection|stability_mode|true', 'dc|register_mode_selection|register_mode|true', 'dc|free_text_point|q|true']);
  eq('permissionDecision: accept maps to allow; other decisions are not mapped (C-4)', evOf('hook_verdict', e => e.data.hook_name === 'permission-request' && e.source === 'transcript').length, 1);
  eq('fail-open-counts.jsonl is a health aggregate (count in the session window), never per-row verdicts', [m.health.sources.find(x => x.source === 'hook_failures').reason_code, m.health.sources.find(x => x.source === 'hook_failures').count], ['fail_open_counters', 3]);
  const hf = evOf('hook_verdict', e => e.source === 'hook_failures');
  eq('S7: only this session\'s failure, as a fail-open warn without message or traceback', [hf.length, hf[0].data.verdict, hf[0].data.fail_open, JSON.stringify(hf[0]).includes('closure')], [1, 'warn', true, false]);
  const perm = evOf('hook_verdict', e => e.source === 'permission_log');
  eq('S6: only the INFO deny_capability line inside the session window; payload blocks and defer lines are never read', [perm.length, perm[0] && perm[0].data.reason_code], [1, 'deny_capability_unavailable:missing_dep_shfmt']);
  check('S1 hook_step_report with violations is a warn with a lower-cased reason code', evOf('hook_verdict', e => e.source === 'audit_jsonl')[0].data.reason_code === 'cva_cycles:unkeyed');

  // S5 decisions
  const dec = evOf('decision');
  eq('S5: authored rows for this session only; free text is never carried as a value', [dec.length, dec.map(d => d.data.value)], [3, ['convergent', 'analytical_technical', null]]);
  eq('S5: tier derivation (defaulted is deterministic, inferred/supplied is llm)', dec.map(d => d.data.tier), ['llm', 'deterministic', 'llm']);

  // health
  const src = Object.fromEntries(m.health.sources.map(s => [s.source, s]));
  eq('health: monitor_events missing, audit and transcript ok', [src.monitor_events.state, src.audit_jsonl.state, src.transcript.state, src.atom_registry.state], ['missing', 'ok', 'ok', 'ok']);
  eq('health: ucef_db degraded from the S4 log and the transcript system message with no DB file at all', [src.ucef_db.state, src.ucef_db.reason_code, m.db.read], ['degraded', 'migration_failed', 'missing']);
  eq('health: decision_telemetry ok, proposals log absent noted', [src.decision_telemetry.state, src.decision_telemetry.reason_code], ['ok', 'proposals_log_absent']);
  eq('malformed audit line is counted, not fatal', m.health.counters.malformed, 1);

  // rendering and leakage
  const text = render(m);
  leakScan('adapters', text);
  const colored = render(m, { style: V.ANSI });
  leakScan('adapters (colour on, minus style codes)', colored.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), ''));
  check('description with a secret and a CSI sequence is scrubbed and stripped', ev.filter(e => e.agent_id === A && e.data.description).every(e => e.data.description.includes('[REDACTED:api_key]') && !e.data.description.includes(ESC)));
  eq('the audit file was not modified by reading it', sha(path.join(t.sdir, 'orchestration-audit.jsonl')), before.audit);

  // idempotence and incremental reads
  const again = mon.snapshot(SID);
  eq('a second snapshot is identical (idempotent event ids, no double counting)', [again.events.length, again.p1.total, again.p2.length], [m.events.length, m.p1.total, m.p2.length]);

  // live tail: torn write, completion, then truncation
  const af = path.join(t.sdir, 'orchestration-audit.jsonl');
  const line = JSON.stringify({ schema_version: '1.0.0', timestamp: at(100).replace('Z', '+00:00'), event_type: 'agent_delegation', session_id: SID, extra: { agent_id: C }, agent_invoked: 'ucef-core:meta:constitutional-ai-agent' });
  fs.appendFileSync(af, line.slice(0, 40));
  mon.snapshot(SID);
  const torn = mon.audit; // not used: state is per session
  const stateOf = () => mon.cache.get(SID).audit.state;
  eq('live tail: a final line without a newline is not consumed', stateOf().starts.filter(s => s.aid === C).length, 0);
  fs.appendFileSync(af, `${line.slice(40)}\n`);
  mon.snapshot(SID);
  eq('live tail: the completed line is consumed on the next poll', stateOf().starts.filter(s => s.aid === C).length, 1);
  const n1 = stateOf().n;
  fs.writeFileSync(af, jl([JSON.parse(line)]));
  mon.snapshot(SID);
  check('live tail: truncation rewinds and re-reads', stateOf().n < n1 && stateOf().starts.length === 1);
  void torn;
});

// ================= 5. SQLite: read-only, immutable, no side files =================
group('ucef sqlite (S3)', () => {
  const sq = U.loadSqlite();
  if (!sq) { ok('node:sqlite not available on this Node: S3 is reported "unavailable" (skipped probes)'); }
  const t = buildTree(mk('tree2'), { sqlite: !!sq, markDegradedInLog: false });
  if (!sq) {
    // Without any degraded signal the db row says unavailable. No transcript degraded marker here either.
    put(path.join(t.data, 'ucef', 'ucef_data.db'), 'not a db');
  }
  const dbf = path.join(t.data, 'ucef', 'ucef_data.db');
  // strip the transcript's degraded marker for this scenario so only the DB decides
  const txf = path.join(t.proj, '-tmp-demo', `${SID}.jsonl`);
  fs.writeFileSync(txf, readLines(txf).filter(l => !l.includes('database_migration failed')).join('\n') + '\n');
  const dirBefore = fs.readdirSync(path.dirname(dbf)).sort();
  const hashBefore = sha(dbf), statBefore = fs.statSync(dbf);
  const mon = new U.Monitor({ root: t.data, projectRoots: [t.proj], now: () => T0 + 130000 });
  const m = mon.snapshot(SID);
  const dbs = m.health.sources.find(s => s.source === 'ucef_db');
  if (sq) {
    eq('empty alembic_version marks the DB degraded (best effort, still read)', [dbs.state, dbs.reason_code], ['degraded', 'migration_failed']);
    eq('session_end row is read from monitoring_events', m.ended, { success: true, duration_ms: 600000 });
    eq('a rollback-journal DB is read with mode=ro (not the snapshot form)', dbs.read_mode, 'ro');
    check('S3 agent_delegation placeholder rows (task_type "stop") never create an agent row', !m.p2.some(x => x.agent_id === 'a9999999999999999') && !m.events.some(e => e.agent_id === 'a9999999999999999'));

    // WAL databases: observed with this Node, mode=ro creates -wal and -shm when neither exists, so that case is read as a labeled snapshot.
    const { DatabaseSync } = require('node:sqlite');
    const dbCase = (name, { wal, hold = false, sqlite }) => {
      const root = mk(name, 'data'), dbp = path.join(root, 'ucef', 'ucef_data.db');
      put(path.join(root, 'workspaces', WS, 'sessions', SID, '.atom-registry.json'), '{"assignments":[]}');
      fs.mkdirSync(path.dirname(dbp), { recursive: true });
      const w = new DatabaseSync(dbp);
      w.exec(`${wal ? 'PRAGMA journal_mode=WAL;' : ''} CREATE TABLE alembic_version(version_num TEXT); INSERT INTO alembic_version VALUES ('x'); CREATE TABLE monitoring_events(id INTEGER PRIMARY KEY, timestamp TEXT, session_id TEXT, event_type TEXT, payload TEXT, workspace_id TEXT); INSERT INTO monitoring_events(timestamp, session_id, event_type, payload, workspace_id) VALUES ('2026-10-25 05:40:00.000000', '${SID}', 'session_end', '{"duration_ms": 1000, "success": true}', '${WS}');`);
      if (!hold) w.close();
      const files = () => fs.readdirSync(path.dirname(dbp)).sort(), before = files(), h = hold ? null : sha(dbp);
      const mm = new U.Monitor({ root, projectRoots: [], sqlite, now: () => T0 + 130000 }).snapshot(SID);
      const out = { src: mm.health.sources.find(x => x.source === 'ucef_db'), ended: mm.ended, created: files().filter(x => !before.includes(x)), same: h === null || sha(dbp) === h, pick: U.pickReadMode(dbp) };
      if (hold) w.close();
      return out;
    };
    const clean = dbCase('wal-clean', { wal: true });
    eq('WAL DB with no -wal/-shm: read as a labeled snapshot, health says so', [clean.src.state, clean.src.read_mode, clean.pick], ['ok', 'snapshot', 'snapshot']);
    eq('...and it still returns data, byte-identical file, no -wal/-shm created', [clean.ended, clean.same, clean.created], [{ success: true, duration_ms: 1000 }, true, []]);
    const live = dbCase('wal-live', { wal: true, hold: true });
    eq('WAL DB with a live writer (sidecars exist): mode=ro is used, nothing created', [live.src.read_mode, live.pick, live.created, live.ended], ['ro', 'ro', [], { success: true, duration_ms: 1000 }]);
    const failing = { DatabaseSync: class { constructor(uri, o) { if (!/immutable=1/.test(uri)) throw new Error('mode=ro refused'); return new DatabaseSync(uri, o); } } };
    const fb = dbCase('ro-fails', { wal: false, sqlite: failing });
    eq('when mode=ro fails, the immutable form is used and labeled snapshot', [fb.src.state, fb.src.read_mode, fb.ended], ['ok', 'snapshot', { success: true, duration_ms: 1000 }]);
    const probe = new DatabaseSync(`file:${encodeURI(path.join(TMP, 'wal-clean', 'data', 'ucef', 'ucef_data.db'))}?mode=ro`, { readOnly: true });
    let blocked = false; try { probe.exec('CREATE TABLE z(y)'); } catch { blocked = true; } probe.close();
    check('the engine rejects writes on the mode=ro connection form too', blocked);
  } else {
    eq('without node:sqlite the health line says unreadable/node_sqlite_unavailable', [dbs.state, dbs.reason_code], ['unreadable', 'node_sqlite_unavailable']);
  }
  eq('the DB file is byte-identical after reading', sha(dbf), hashBefore);
  eq('the DB file mtime is unchanged', fs.statSync(dbf).mtimeMs, statBefore.mtimeMs);
  eq('no sidecar files appeared next to the DB', fs.readdirSync(path.dirname(dbf)).filter(f => f !== 'wal.db' && !f.startsWith('wal.db-')).sort(), dirBefore);
  const text = render(new U.Monitor({ root: t.data, projectRoots: [t.proj], sqlite: null, now: () => T0 + 130000 }).snapshot(SID));
  check('sqlite forced off: health line says "unavailable"', /ucef_db unavailable/.test(text));
});

// ================= 5b. one hook execution seen by two sources is one row =================
group('ucef cross-source dedupe', () => {
  const base = mk('tree7'), data = path.join(base, 'data'), proj = path.join(base, 'projects', '-tmp-x');
  const dedupeLines = readLines(path.join(FIX, 'dedupe-cases.jsonl')).map(l => JSON.parse(l));
  const emitted = dedupeLines.find(e => e.ext && e.ext.case === 'a' && e.provenance === 'emitted');
  put(path.join(data, 'workspaces', WS, 'sessions', SID, 'monitor-events.jsonl'), jl([emitted]));
  const tx = (o, s) => ({ timestamp: at(s), sessionId: SID, ...o });
  put(path.join(proj, `${SID}.jsonl`), jl([
    tx({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'PreToolUse', hookName: 'PreToolUse:Bash', toolUseID: 'toolu_v11a', exitCode: 0, durationMs: 7, command: '/plugin/hooks/pre-tool-use.py' } }, 1),
    tx({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'PreToolUse', hookName: 'PreToolUse:Bash', toolUseID: 'toolu_v11a', exitCode: 0, durationMs: 8, command: '/plugin/hooks/push-guard.sh' } }, 2),
  ]));
  const m = new U.Monitor({ root: data, projectRoots: [path.join(base, 'projects')], sqlite: null }).snapshot(SID);
  const rows = m.events.filter(e => e.kind === 'hook_verdict' && e.data.tool_use_id === 'toolu_v11a');
  eq('emitted pre-tool-use + its transcript attachment are ONE row; the other hook on the same toolUseID is a second', rows.map(r => [r.data.hook_name, r.provenance, r.data.verdict]).sort(), [['pre-tool-use/command_guardrails', 'emitted', 'block'], ['push-guard', 'derived', 'allow']]);
  eq('the emitted event keeps its own dedupe_key', rows.find(r => r.provenance === 'emitted').dedupe_key, 'hv|PreToolUse|toolu_v11a|pre-tool-use');
  eq('P1 counts reflect the collapse (1 block, 1 allow)', [m.p1.counts.block, m.p1.counts.allow], [1, 1]);
});

// ================= 6. replay: pick a past session =================
group('ucef replay', () => {
  const base = mk('tree3'), data = path.join(base, 'data');
  const put1 = (sid, fixture, mtime) => {
    const f = put(path.join(data, 'workspaces', WS, 'sessions', sid, 'monitor-events.jsonl'), fs.readFileSync(path.join(FIX, fixture)));
    fs.utimesSync(f, mtime, mtime);
  };
  put1('aaaaaaaa-0000-0000-0000-000000000001', 'normal-session.jsonl', 1000);
  put1('bbbbbbbb-0000-0000-0000-000000000002', 'degraded-db.jsonl', 2000);
  fs.mkdirSync(path.join(data, 'workspaces', WS, 'sessions', 'bbbbbbbb-0000-0000-0000-000000000002__a1b2c3d4e5f607182'), { recursive: true });
  const mon = new U.Monitor({ root: data, projectRoots: [], sqlite: null, now: () => 3000 * 1000 });
  eq('sessions are newest first and per-agent state dirs are not sessions', mon.sessions().map(s => s.sid), ['bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001']);
  const live = mon.snapshot(null), past = mon.snapshot('aaaaaaaa-0000-0000-0000-000000000001');
  eq('default selection is the newest session (live follow)', [live.index, live.current.sid], [0, 'bbbbbbbb-0000-0000-0000-000000000002']);
  eq('a past session replays its own events', [past.index, past.events.length, past.p2.length], [1, 50, 6]);
  check('the header labels it replay with position', /\[2\/2\] replay/.test(render(past)));
  const pane = new UcefPane({ dataDir: data, redact: true });
  pane.monitor = new U.Monitor({ root: data, projectRoots: [], sqlite: null, now: () => 3000 * 1000 });
  pane.key('[');
  check('key [ steps to the older session', /\[2\/2\] replay/.test(pane.render(120).text));
  pane.key('l');
  check('key l returns to live', /\[1\/2\]/.test(pane.render(120).text));
  pane.key(']'); pane.key(']');
  check('key ] stays at the newest', /\[1\/2\]/.test(pane.render(120).text));
  eq('monitor-events.jsonl is S13: its schema_version rejects are counted and shown', (() => {
    const bad = path.join(data, 'workspaces', WS, 'sessions', 'cccccccc-0000-0000-0000-000000000003', 'monitor-events.jsonl');
    put(bad, fs.readFileSync(path.join(FIX, 'unknown-schema-version.jsonl')));
    const m = new U.Monitor({ root: data, projectRoots: [], sqlite: null }).snapshot('cccccccc-0000-0000-0000-000000000003');
    return [m.health.counters.rejected, m.events.length, /3 unsupported schema_version/.test(render(m))];
  })(), [3, 1, true]);
});

// ================= 7. input validation and the CLI =================
group('ucef paths and CLI', () => {
  for (const bad1 of ['../../etc/passwd', '..', 'a/b', '', 'x\u0000y', 'sid__agent', ' ']) check(`session id ${JSON.stringify(bad1)} is refused`, !U.validSessionId(bad1));
  check('a normal session id is accepted', U.validSessionId(SID));
  let threw = null; try { new U.Monitor({ root: path.join(TMP, 'does-not-exist') }); } catch (e) { threw = e; }
  check('a missing data directory raises a friendly error without the path', threw && threw.code === 'no_root' && !threw.message.includes(TMP));
  const symTarget = mk('symtarget'); put(path.join(symTarget, 'secret.jsonl'), 'x\n');
  const sdir = mk('tree4', 'data', 'workspaces', WS, 'sessions', SID);
  fs.symlinkSync(path.join(symTarget, 'secret.jsonl'), path.join(sdir, 'orchestration-audit.jsonl'));
  put(path.join(sdir, '.atom-registry.json'), '{"assignments":[]}');
  const m = new U.Monitor({ root: path.join(TMP, 'tree4', 'data'), projectRoots: [], sqlite: null }).snapshot(SID);
  eq('a symlinked audit file is not followed', m.health.sources.find(s => s.source === 'audit_jsonl').state, 'unreadable');

  // the real binary, sandboxed HOME
  const data = path.join(TMP, 'tree3', 'data');
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'bin/puffr-dash'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: path.join(TMP, 'home'), NO_COLOR: '1', ...env }, timeout: 30000 });
  fs.mkdirSync(path.join(TMP, 'home'), { recursive: true });
  let r = run(['--ucef', '--once', '--ucef-data-dir', data]);
  eq('puffr-dash --ucef --once exits 0', r.status, 0);
  const idx = ['Hooks + verdicts', 'Agents', 'Phase + gates', 'Jev decisions + cost'].map(h => r.stdout.indexOf(h));
  check('all four panes render, in order', idx.every(i => i >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]), String(idx));
  check('--once to a pipe emits no cursor or clear sequences', !r.stdout.includes(ESC));
  r = run(['--ucef', '--once'], { UCEF_DATA_ROOT: data });
  eq('UCEF_DATA_ROOT is honoured', r.status, 0);
  r = run(['--ucef', '--once', '--ucef-data-dir', path.join(TMP, 'nope')]);
  check('missing data dir: exit 1, friendly message, no path echoed', r.status === 1 && /does not exist/.test(r.stdout) && !r.stdout.includes(TMP), `${r.status}`);
  r = run(['--ucef', '--once', '--ucef-session', '../../etc']);
  check('invalid --ucef-session: exit 2 with a usage message', r.status === 2 && /not a valid session id/.test(r.stderr));
  r = run(['--ucef-data-dir']);
  check('--ucef-data-dir without a value: exit 2', r.status === 2 && /needs a value/.test(r.stderr));
  r = run(['--help']);
  check('--help documents the UCEF flags and exits 0', r.status === 0 && /--ucef-data-dir/.test(r.stdout) && /--ucef-no-redact/.test(r.stdout));
  r = run(['--ucef', '--once', '--ucef-data-dir', data, '--ucef-session', 'aaaaaaaa-0000-0000-0000-000000000001']);
  check('--ucef-session starts on a past session (replay)', r.status === 0 && /replay/.test(r.stdout));
  r = run(['--ucef', '--once', '--ucef-data-dir', path.join(TMP, 'tree3', 'empty')]);
  eq('an existing but empty path is the same friendly error', r.status, 1);
  // a data dir with no sessions
  const empty = mk('tree5', 'data'); mk('tree5', 'data', 'workspaces');
  r = run(['--ucef', '--once', '--ucef-data-dir', empty]);
  check('no sessions: says so and exits 1', r.status === 1 && /No UCEF session found/.test(r.stdout));
  // reading never changes the tree
  const snap = dir => fs.readdirSync(dir, { recursive: true }).sort().map(f => { const s = fs.statSync(path.join(dir, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).join('|');
  const s1 = snap(data); run(['--ucef', '--once', '--ucef-data-dir', data]);
  eq('the CLI leaves the data tree untouched (names, sizes, mtimes)', snap(data), s1);
});

console.log('');
console.log(`ucef panel: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
