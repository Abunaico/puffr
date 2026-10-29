// Terminal rendering of the four UCEF panes. Pure: model in, string out.
// Every string that came from an event is untrusted: it goes through R.safe() (scrub again,
// strip controls, truncate) BEFORE any styling is added, so event data can never inject escapes.
'use strict';
const R = require('./ucef-redact');

const ID = s => s;
const PLAIN = { bold: ID, dim: ID, red: ID, yellow: ID, cyan: ID, green: ID };
const ANSI = {
  bold: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`, cyan: s => `\x1b[36m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`,
};
const USABLE = new Set(['ok', 'degraded']);
const PHASES = ['1', '1.5', '2', '3', '4', '5', '5.5', '6'];
const MARK = { done: '✔', active: '▶', skipped: '-', seen: '•', pending: '·' };

const fit = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' '); return n <= 0 ? '' : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s; };
const pad = (s, n) => fit(s, n).padEnd(n);
const lpad = (s, n) => fit(s, n).padStart(n);
const k = n => { n = Number(n) || 0; return n < 1000 ? String(Math.round(n)) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`; };
const usd = n => `$${(Number(n) || 0).toFixed(2)}`;
function dur(msv) {
  if (msv === null || msv === undefined || !Number.isFinite(msv)) return '—';
  if (msv < 1000) return `${Math.round(msv)}ms`;
  const s = msv / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}
function clock(ts) {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toTimeString().slice(0, 8) : '--:--:--';
}
const shortType = t => String(t || '').split(':').pop();
const PROV = { emitted: 'emit', derived: 'deriv', inferred: 'infer' };

function render(m, { width = 100, style = PLAIN, redact = m.redact !== false, hint = true } = {}) {
  const W = Math.max(60, width), out = [];
  const T = style;
  const S = (v, n) => fit(R.safe(v, 240, { redact }), n);
  const section = (title, note) => {
    const head = `${title}${note ? ` ${note}` : ''}`;
    return `\n${T.bold(title)}${note ? ` ${T.dim(S(note, W - title.length - 4))}` : ''} ${T.dim('─'.repeat(Math.max(0, W - head.length - 2)))}`;
  };
  const verdictColor = v => (v === 'block' ? T.red : v === 'warn' || v === 'not_done' ? T.yellow : v === 'guidance' ? T.cyan : v === 'allow' || v === 'ok' ? T.green : T.dim);
  const provCell = p => (p === 'inferred' ? T.yellow(pad(PROV[p], 5)) : T.dim(pad(PROV[p] || '', 5)));
  const src = {};
  for (const s of m.health.sources || []) src[s.source] = s;
  const usable = names => names.some(n => src[n] && USABLE.has(src[n].state));
  const known = (m.health.sources || []).length > 0;
  const noData = names => {
    const missing = names.filter(n => src[n] && !USABLE.has(src[n].state)).map(n => `${n} ${src[n].state}`);
    return T.dim(`no data source${missing.length ? ` (${S(missing.slice(0, 3).join(', '), W - 30)})` : ''}`);
  };

  // ---- header ----
  const cur = m.current;
  const total = (m.sessions || []).length;
  let mode = '';
  if (cur) mode = m.index === 0 ? (cur.live ? T.green('live') : T.dim('newest, idle')) : T.yellow('replay');
  out.push(`${T.bold('🐡 puffr · UCEF')}  ${cur ? `${S(cur.sid.slice(0, 8), 8)} ${T.dim(`[${m.index + 1}/${total}]`)} ${mode}` : T.dim('no session')}`);
  if (m.meta) {
    const parts = [m.meta.version && `claude ${m.meta.version}`, m.meta.model_id && `${m.meta.tier} (${m.meta.model_id})`, m.meta.branch, m.meta.project].filter(Boolean);
    if (parts.length) out.push(T.dim(S(parts.join(' · '), W)));
  }
  if (cur) out.push(T.dim(S(`workspace ${cur.ws}`, W)));
  if (redact === false) out.push(T.red('REDACTION OFF: secrets are not scrubbed; terminal controls are still stripped'));
  if (hint) out.push(T.dim('u main view · [ ] older/newer session · l live · r refresh · q quit'));

  if (m.noSession) {
    out.push(`\n${T.dim('No UCEF session found. Expected <data dir>/workspaces/<workspace>/sessions/<session>/.')}`);
    out.push(T.dim('Point at the data with --ucef-data-dir <dir> or UCEF_DATA_ROOT (the directory that holds workspaces/).'));
    return out.join('\n');
  }

  // ---- health line ----
  const rank = ['monitor_events', 'audit_jsonl', 'transcript', 'subagent_transcript', 'atom_registry', 'ucef_db', 'decision_telemetry', 'permission_log', 'hook_failures'];
  const ordered = [...(m.health.sources || [])].sort((a, b) => (rank.indexOf(a.source) + 1 || 99) - (rank.indexOf(b.source) + 1 || 99));
  const fine = ordered.filter(s => s.state === 'ok');
  const note = s => {
    const bits = [s.reason_code && s.reason_code !== 'node_sqlite_unavailable' ? S(s.reason_code, 40) : null, typeof s.count === 'number' ? `n=${s.count}` : null, s.read_mode === 'snapshot' ? 'snapshot' : null].filter(Boolean);
    return bits.length ? `(${bits.join(', ')})` : '';
  };
  const items = ordered.filter(s => !fine.includes(s)).map(s => {
    const word = s.reason_code === 'node_sqlite_unavailable' ? 'unavailable' : s.state;
    const why = note(s);
    const color = s.state === 'degraded' ? T.yellow : T.red;
    return { plain: `${s.source} ${word}${why}`, styled: `${s.source} ${color(word)}${T.dim(why)}` };
  });
  if (fine.length) out.push(`${T.bold('sources ok')} ${T.green(S(fine.map(s => `${s.source}${note(s)}`).join(', '), W - 12))}`);
  let line = [], len = 0;
  const flush = () => { if (line.length) out.push(line.join(T.dim(' \u00b7 '))); line = []; len = 0; };
  if (items.length) out.push(T.bold('sources not ok'));
  for (const it of items) { if (len && len + it.plain.length + 3 > W - 2) flush(); line.push(it.styled); len += it.plain.length + 3; }
  flush();
  const c = m.health.counters || {};
  if (c.rejected || c.malformed) out.push(T.yellow(`skipped lines: ${c.rejected || 0} unsupported schema_version, ${c.malformed || 0} malformed (counted, reading continues)`));

  // ---- P1 hooks + verdicts ----
  out.push(section('Hooks + verdicts', `${m.p1.total} events`));
  const hookSrc = ['monitor_events', 'transcript', 'hook_failures', 'permission_log', 'audit_jsonl'];
  if (!m.p1.total) out.push(known && !usable(hookSrc) ? noData(hookSrc) : T.dim('no hook events recorded'));
  else {
    out.push(['allow', 'ok', 'block', 'warn', 'bypass', 'guidance', 'not_done'].map(v => `${verdictColor(v)(v)} ${T.bold(String(m.p1.counts[v]))}`).join(T.dim(' · ')));
    const rows = m.p1.rows.slice(-8), wide = W >= 110;
    if (m.p1.rows.length > rows.length) out.push(T.dim(`  ${m.p1.rows.length - rows.length} earlier non-allow rows not shown`));
    for (const e of rows) {
      const d = e.data, kind = d.hook_type === 'command' ? 'command' : `${d.hook_type}/${d.model_tier}`;
      const reason = d.reason_code || d.reason_text || '';
      const lat = d.latency_ms === undefined || d.latency_ms === null ? '' : dur(d.latency_ms);
      const head = `${T.dim(clock(e.ts))} ${verdictColor(d.verdict)(pad(S(d.verdict, 8), 8))} `;
      const rw = W - 72;
      if (wide) out.push(`${head}${pad(S(d.hook_name, 28), 28)} ${pad(S(kind, 11), 11)} ${lpad(lat, 6)} ${provCell(e.provenance)} ${S(reason, rw)}`);
      else out.push(`${head}${pad(S(d.hook_name, Math.max(14, W - 28)), Math.max(14, W - 28))} ${provCell(e.provenance)}`);
      if (reason && (!wide || S(reason, 4000).length > rw)) out.push(T.dim(`         ${S(reason, W - 10)}`));
    }
  }

  // ---- P2 agents ----
  out.push(section('Agents', `${m.p2.length} runs`));
  const agentSrc = ['audit_jsonl', 'subagent_transcript', 'monitor_events'];
  if (!m.p2.length) out.push(known && !usable(agentSrc) ? noData(agentSrc) : T.dim('no agent runs recorded'));
  else {
    const tw = Math.max(18, Math.min(30, W - 62));
    out.push(T.dim(`${pad('agent', tw)} ${pad('tier', 7)} ${pad('status', 9)} ${lpad('time', 7)}  ${pad('atom', 12)} ${lpad('in/out', 11)}  prov`));
    const rows = m.p2.slice(-12);
    if (m.p2.length > rows.length) out.push(T.dim(`  ${m.p2.length - rows.length} earlier runs not shown`));
    for (const a of rows) {
      const stc = a.status === 'failed' ? T.red : a.status === 'succeeded' ? T.green : a.status === 'running' ? T.cyan : T.yellow;
      const tok = a.usage ? `${k(a.usage.input_tokens || 0)}/${k(a.usage.output_tokens || 0)}` : '—';
      out.push(`${pad(S(shortType(a.type), tw), tw)} ${pad(S(a.tier, 7), 7)} ${stc(pad(S(a.status, 9), 9))} ${lpad(`${a.live ? '~' : ''}${dur(a.duration_ms)}`, 7)}  ${pad(S(a.atom_id || '—', 12), 12)} ${lpad(tok, 11)}  ${provCell(a.prov)}`);
    }
  }

  // ---- P3 phase + gates ----
  out.push(section('Phase + gates', m.p3.position ? `at phase ${m.p3.position}` : ''));
  const phaseSrc = ['audit_jsonl', 'monitor_events', 'transcript', 'subagent_transcript'];
  const anyPhase = m.p3.position !== null;
  if (!anyPhase && known && !usable(phaseSrc)) out.push(noData(phaseSrc));
  else {
    out.push(PHASES.map(p => {
      const ph = m.p3.phases[p], mk = MARK[ph.state] || MARK.pending;
      const col = ph.state === 'done' ? T.green : ph.state === 'active' ? T.cyan : ph.state === 'skipped' ? T.yellow : T.dim;
      return `${p} ${col(mk)}${ph.prov === 'inferred' ? T.yellow('~') : ''}`;
    }).join('  '));
    out.push(T.dim('✔ done  ▶ active  - skipped  • gate seen  · not reached  ~ inferred'));
    const gates = m.p3.gates.slice(-8);
    for (const e of gates) {
      const d = e.data, stc = d.status === 'pass' ? T.green : d.status === 'fail' ? T.red : T.yellow;
      const score = typeof d.score === 'number' ? d.score.toFixed(2) : 'n/a';
      const thr = typeof d.threshold === 'number' ? `thr ${d.threshold.toFixed(2)}` : 'thr n/a';
      const extra = [d.stability_mode, d.checkpoint].filter(Boolean).join(' ');
      out.push(`${T.dim(clock(e.ts))} ${pad(S(d.gate, 15), 15)} ${stc(pad(S(d.status, 5), 5))} ${lpad(score, 5)}  ${pad(thr, 10)} ${pad(S(e.atom_id || '', 10), 10)} ${provCell(e.provenance)} ${T.dim(S(extra, Math.max(0, W - 66)))}`);
    }
    if (!m.p3.gates.some(e => e.data.gate === 'field_stability')) out.push(T.dim('field_stability: no data'));
    if (!m.p3.gates.some(e => e.data.gate === 'constitutional')) out.push(T.dim('constitutional: no data'));
  }

  // ---- P4 decisions + cost ----
  out.push(section('Jev decisions + cost'));
  const decSrc = ['decision_telemetry', 'monitor_events']; // ucef_db decision_events has no writer: only a readable (ok) DB counts as a source
  const dec = m.p4.decisions;
  if (!dec.length) out.push(known && !usable(decSrc) && !(src.ucef_db && src.ucef_db.state === 'ok') ? noData([...decSrc, 'ucef_db']) : T.dim('no decisions recorded'));
  else {
    const t = m.p4.tiers;
    out.push(`${T.dim('tiers')} deterministic ${T.bold(String(t.deterministic))} · jev ${T.bold(String(t.jev))} · llm ${T.bold(String(t.llm))}`);
    out.push(T.dim(`${pad('tier', 13)} ${pad('decision', Math.max(16, W - 62))} ${pad('value', 20)} ${lpad('conf', 5)} ${lpad('latency', 8)}`));
    for (const e of dec.slice(-8)) {
      const d = e.data;
      out.push(`${pad(S(d.tier, 13), 13)} ${pad(S(d.decision_class, Math.max(16, W - 62)), Math.max(16, W - 62))} ${pad(S(d.value === null || d.value === undefined ? '—' : d.value, 20), 20)} ${lpad(typeof d.confidence === 'number' ? d.confidence.toFixed(2) : '—', 5)} ${lpad(dur(d.latency_ms), 8)}`);
    }
    if (dec.length > 8) out.push(T.dim(`  ${dec.length - 8} earlier decisions not shown`));
  }
  const tot = m.p4.totals;
  if (tot.runs) {
    out.push(`${T.dim('agent runs')} ${tot.runs} finished · in ${k(tot.input)} · out ${k(tot.output)} · cache read ${k(tot.cacheRead)} · cache write ${k(tot.cacheWrite)}${tot.cacheTotal ? ` · cache total ${k(tot.cacheTotal)}` : ''} ${T.dim('(finished subagent runs only; main session not counted)')}`);
  }
  if (tot.priced) {
    const basis = [...tot.bases].join('+') || 'estimated', ver = [...tot.versions].slice(0, 2).join(', ') || 'unversioned';
    out.push(`${T.dim('cost')} ${T.bold(`≈${usd(tot.usd)}`)} ${basis} ${T.dim(`· price table ${S(ver, 40)}${tot.unpriced ? ` · ${tot.unpriced} runs unpriced` : ''}`)}`);
  } else out.push(`${T.dim('cost')} unknown ${T.dim(tot.runs ? '(no price for the models used, or usage not recorded)' : '(no finished agent runs)')}`);
  // Never added into the totals above: the same tokens may already sit in an agent run or outside any subagent.
  for (const [label, u] of [['decisions', m.p4.decisionUse], ['judges', m.p4.judgeUse]]) {
    if (!u || !u.n) continue;
    out.push(`${T.dim(label)} ${u.n} with usage · in ${k(u.input)} · out ${k(u.output)}${u.priced ? ` · ≈${usd(u.usd)} ${[...u.versions].slice(0, 1).join('') ? `(${S([...u.versions][0], 30)})` : ''}` : ''} ${T.dim('(separate, not in the totals)')}`);
  }

  if (m.ended) out.push(`\n${T.dim(`session ended${m.ended.success === null ? '' : m.ended.success ? ' ok' : ' with failure'}${m.ended.duration_ms ? ` after ${dur(m.ended.duration_ms)}` : ''}`)}`);
  return out.join('\n');
}

module.exports = { render, PLAIN, ANSI, fit, dur };
