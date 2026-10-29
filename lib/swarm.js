'use strict';
// puffr swarm: how many sessions and subagents ran at once, what each lane spent, who messaged whom.
// Streams transcripts from one or more roots (one per machine), counts every assistant message id once,
// and reads no model, no network. Shared by bin/puffr-swarm. Builtins only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const F = require('./puffr.js');
const RP = require('./report-page.js');

const BUCKET = 15 * 60e3;
const MAX_LINE = 64 << 20;        // longer lines are tool-output dumps; they never carry what we need
const MAX_PATTERN = 200;
const KINDS = ['typed', 'prompted', 'general', 'other'];
const KIND_LABEL = { typed: 'Orchestrated, by agent type', prompted: 'Orchestrated, by prompt', general: 'General-purpose', other: 'Other typed agents' };

class UsageError extends Error {}

// --- time ---
// YYYY-MM-DD, "YYYY-MM-DD HH[:MM]" or YYYY-MM-DDTHH[:MM] in local time; a trailing Z or +-HH:MM makes it absolute.
// A bare day is the whole day: its start for --since, the next midnight for --until.
const WHEN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
function parseWhen(s, { end = false } = {}) {
  const m = WHEN.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]], hasTime = m[4] != null, h = hasTime ? +m[4] : 0, mi = m[5] == null ? 0 : +m[5];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || (m[6] && !hasTime)) return null;
  let ms;
  if (m[6]) {
    const z = m[6].toUpperCase(), off = z === 'Z' ? 0 : (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.slice(-2));
    if (Math.abs(off) > 14 * 60) return null;
    const u = new Date(Date.UTC(y, mo - 1, d, h, mi));
    if (u.getUTCMonth() !== mo - 1 || u.getUTCDate() !== d) return null;
    ms = u.getTime() - off * 60e3;
  } else {
    const dt = new Date(y, mo - 1, d, h, mi);
    if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;   // 2026-02-31 is not a day
    ms = !hasTime && end ? new Date(y, mo - 1, d + 1).getTime() : dt.getTime();
  }
  return Number.isFinite(ms) ? ms : null;
}

// --- config ---
const rx = (src, what) => {
  if (typeof src !== 'string' || !src || src.length > MAX_PATTERN) throw new UsageError(`${what}: expected a pattern of 1 to ${MAX_PATTERN} characters`);
  try { return new RegExp(src, 'i'); } catch (e) { throw new UsageError(`${what}: invalid pattern (${String(e.message).replace(/^Invalid regular expression: /, '')})`); }
};
const KEYS = ['roots', 'lanes', 'renames', 'otherLane', 'phases', 'orchestrated', 'bills', 'exclude', 'minUsd'];
const str = (v, what, max = 80) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new UsageError(`${what}: expected text of 1 to ${max} characters`); return F.clean(v).trim(); };
const usdNum = (v, what) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new UsageError(`${what}: expected a dollar amount, got ${JSON.stringify(v)}`); return n; };

/** Validate a parsed config object (and the flags merged into it) into the shape the scan and analysis use. */
function normalizeConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError('config: expected a JSON object');
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) throw new UsageError(`config: unknown key "${k}" (allowed: ${KEYS.join(', ')})`);
  const list = (v, what) => { if (v == null) return []; if (!Array.isArray(v)) throw new UsageError(`config: ${what} must be a list`); return v; };
  const cfg = { roots: [], lanes: [], renames: [], phases: [], bills: [], exclude: [] };
  for (const r of list(raw.roots, 'roots')) {
    if (typeof r === 'string') cfg.roots.push({ path: r, label: null });
    else if (r && typeof r.path === 'string') cfg.roots.push({ path: r.path, label: r.label == null ? null : str(r.label, 'roots[].label', 24) });
    else throw new UsageError('config: each root is a path or {"label", "path"}');
  }
  for (const l of list(raw.lanes, 'lanes')) {
    if (!l || typeof l !== 'object') throw new UsageError('config: each lane is {"name", "match", "role"?}');
    cfg.lanes.push({ name: str(l.name, 'lanes[].name', 40), re: rx(l.match, `lanes[${l.name}].match`), role: l.role == null ? '' : str(l.role, 'lanes[].role', 120) });
  }
  for (const r of list(raw.renames, 'renames')) {
    if (!r || typeof r !== 'object') throw new UsageError('config: each rename is {"match", "to"}');
    cfg.renames.push({ re: rx(r.match, 'renames[].match'), to: str(r.to, 'renames[].to', 80) });
  }
  cfg.otherLane = raw.otherLane == null ? '(other)' : str(raw.otherLane, 'otherLane', 40);
  for (const p of list(raw.phases, 'phases')) {
    if (!p || typeof p !== 'object') throw new UsageError('config: each phase is {"name", "from", "to"}');
    const from = parseWhen(p.from), to = parseWhen(p.to, { end: true });
    if (from == null || to == null || to <= from) throw new UsageError(`config: phase "${p.name}" needs from < to as YYYY-MM-DD, "YYYY-MM-DD HH:MM", or ISO with Z`);
    cfg.phases.push({ name: str(p.name, 'phases[].name', 40), from, to });
  }
  const o = raw.orchestrated || {};
  cfg.orchestrated = { agent: rx(o.agentPattern == null ? '^ucef-' : o.agentPattern, 'orchestrated.agentPattern'),
    prompt: rx(o.promptPattern == null ? '^\\s*UCEF_ATOM:' : o.promptPattern, 'orchestrated.promptPattern') };
  for (const b of list(raw.bills, 'bills')) {
    if (!b || typeof b !== 'object') throw new UsageError('config: each bill is {"usd", "month"?, "account"?}');
    if (b.month != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(b.month))) throw new UsageError('config: bills[].month is YYYY-MM');
    cfg.bills.push({ usd: usdNum(b.usd, 'bills[].usd'), month: b.month == null ? null : String(b.month), account: b.account == null ? null : str(b.account, 'bills[].account', 80) });
  }
  cfg.exclude = list(raw.exclude, 'exclude').map(x => str(String(x), 'exclude[]', 64));
  cfg.minUsd = raw.minUsd == null ? 1 : usdNum(raw.minUsd, 'minUsd');
  overlapCheck(cfg.phases);
  return cfg;
}
function overlapCheck(phases) {
  const s = phases.slice().sort((a, b) => a.from - b.from);
  for (let i = 1; i < s.length; i++) if (s[i].from < s[i - 1].to) throw new UsageError(`phases "${s[i - 1].name}" and "${s[i].name}" overlap`);
}

function readConfigFile(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { throw new UsageError(`cannot read config ${file}: ${e.code || e.message}`); }
  try { return JSON.parse(txt); } catch (e) { throw new UsageError(`config ${file} is not valid JSON (${e.message})`); }
}

// --- roots ---
const expand = p => path.resolve(p.replace(/^~(?=\/|\\|$)/, F.HOME));
function labelFor(real) {
  let home = F.HOME;
  try { home = fs.realpathSync(home); } catch {}
  if (real === home || real.startsWith(home + path.sep)) return 'this machine';
  const segs = real.split(path.sep).filter(Boolean);
  while (segs.length && (segs[segs.length - 1] === 'projects' || segs[segs.length - 1].startsWith('.'))) segs.pop();
  return F.clean(segs[segs.length - 1] || 'other').slice(0, 24);
}
/** [{path, label}] → existing directories, deduped by real path, each with a unique label. */
function resolveRoots(specs) {
  const out = [], seen = new Set(), labels = new Set();
  for (const s of specs) {
    const p = expand(s.path);
    let real;
    try { real = fs.realpathSync(p); if (!fs.statSync(real).isDirectory()) throw new Error('not a directory'); } catch { throw new UsageError(`transcript root not found: ${s.path}`); }
    if (seen.has(real)) continue;
    seen.add(real);
    let label = s.label || labelFor(real), n = 2;
    while (labels.has(label)) label = `${s.label || labelFor(real)} ${n++}`;
    labels.add(label);
    out.push({ path: real, label });
  }
  return out;
}

// --- lanes ---
function laneResolver(cfg) {
  return (title, id) => {
    let t = title;
    for (const r of cfg.renames) {
      const m = r.re.exec(t);
      if (m) { t = r.to.replace(/\$(\d)/g, (_, n) => m[n] || ''); break; }
    }
    for (const l of cfg.lanes) if (l.re.test(t) || (id && l.re.test(id))) return l.name;
    return cfg.lanes.length ? cfg.otherLane : t;
  };
}

// --- streaming scan ---
function eachLine(fp, buf, cb) {
  let fd;
  try { fd = fs.openSync(fp, 'r'); } catch { return; }
  let carry = Buffer.alloc(0), pos = 0, n;
  try {
    while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
      pos += n;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let s = 0;
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, s)) {
        if (i - s < MAX_LINE) cb(chunk.toString('utf8', s, i));
        s = i + 1;
      }
      carry = chunk.length > s ? Buffer.from(chunk.subarray(s)) : Buffer.alloc(0);
      if (carry.length > MAX_LINE) carry = Buffer.alloc(0);
    }
    if (carry.length) cb(carry.toString('utf8'));
  } finally { try { fs.closeSync(fd); } catch {} }
}

const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n') : '';
const WRAPPED = /^\s*<(task-notification|system-reminder|local-command|command-name|cross-session)/;
const INJECTED = /Another Claude session sent a message|This session is being continued/;
const XSESSION = /<cross-session-message[^>]*from-name="([^"]+)"[^>]*>([\s\S]*?)(<\/cross-session-message>|$)/;
const ACK = /^(got it|thanks|thank you|ack|ok|noted|understood|roger|will do|on it|done\.?$)/i;
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
// Descriptions are shown in reports people share: drop anything shaped like a key, token, or password.
const scrub = s => String(s || '').replace(/\b(sk|pk|rk|key|tok|xox[a-z])[-_][A-Za-z0-9_-]{12,}\b/gi, '[key]')
  .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]').replace(/password\s*[:=]\s*\S+/gi, 'password: [redacted]').replace(/\s+/g, ' ').trim();

/** One pass over one transcript, keeping only what falls in the window. */
function scanFile(fp, kind, W, buf, orchPrompt) {
  const reqs = new Map(), msgs = [], prompts = [];
  let title = null, ai = null, org = '', promptHit = false, needFirst = kind === 'sub';
  eachLine(fp, buf, l => {
    if (!l) return;
    const isQ = l.includes('"queue-operation"'), hasUsage = !isQ && l.includes('"usage"');
    const isMeta = l.includes('"custom-title"') || l.includes('"ai-title"') || l.includes('"credential_org"');
    const wantUser = l.includes('"type":"user"') && (kind === 'main' ? !l.includes('"tool_result"') : needFirst);
    if (!hasUsage && !isQ && !isMeta && !wantUser) return;
    let e; try { e = JSON.parse(l); } catch { return; }
    if (!e || typeof e !== 'object') return;
    const t = Date.parse(e.timestamp);
    if (e.type === 'custom-title' && typeof e.customTitle === 'string') { title = e.customTitle; return; }
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string') { ai = e.aiTitle; return; }
    if (e.type === 'attachment') { if (e.attachment && e.attachment.type === 'credential_org' && typeof e.attachment.organizationUuid === 'string') org = F.clean(e.attachment.organizationUuid); return; }
    const inWin = t >= W.sinceMs && t < W.untilMs;
    if (e.type === 'queue-operation') {
      if (kind !== 'main' || e.operation !== 'enqueue' || typeof e.content !== 'string' || !inWin) return;
      const m = XSESSION.exec(e.content.slice(0, 20000));
      if (m) {
        const text = m[2].replace(/\s+/g, ' ').trim();
        msgs.push({ t, from: F.clean(m[1]).slice(0, 80), ack: text.length < 80 || ACK.test(text), key: `${t}|${m[1]}|${md5(text)}` });
      }
      return;
    }
    if (e.type === 'user' && e.message) {
      const txt = textOf(e.message.content);
      if (kind === 'sub') { if (needFirst && txt) { promptHit = orchPrompt.test(txt.slice(0, 2000)); needFirst = false; } return; }
      const c = e.message.content;
      const typed = typeof c === 'string' || (Array.isArray(c) && c.some(p => p && p.type === 'text') && !c.some(p => p && p.type === 'tool_result'));
      if (inWin && typed && txt && !e.isSidechain && !e.isMeta && !e.isCompactSummary && !WRAPPED.test(txt) && !INJECTED.test(txt)) {
        prompts.push({ t, uuid: typeof e.uuid === 'string' ? e.uuid : null });
      }
      return;
    }
    if (e.type !== 'assistant' || !e.message || !inWin) return;
    const m = e.message;
    // A streamed response repeats its id on several lines; the last one carries the final usage.
    if (hasUsage && m.usage && m.id && m.model && m.model !== '<synthetic>') reqs.set(m.id, { t, m: F.clean(m.model), u: F.usageRec(m.usage), org });
  });
  return { reqs, msgs, prompts, title, ai, promptHit };
}

function listTranscripts(roots, sinceMs) {
  const files = [];
  const add = (fp, rootIdx, sid, kind, dir) => {
    let st; try { st = fs.statSync(fp); } catch { return; }
    if (st.isFile() && st.mtimeMs >= sinceMs) files.push({ fp, size: st.size, rootIdx, sid, kind, dir });
  };
  roots.forEach((root, ri) => {
    let projects = []; try { projects = fs.readdirSync(root.path); } catch { return; }
    for (const d of projects) {
      const dir = path.join(root.path, d);
      let ents; try { ents = fs.readdirSync(dir); } catch { continue; }
      for (const f of ents) {
        if (f.endsWith('.jsonl')) { add(path.join(dir, f), ri, f.slice(0, -6), 'main', dir); continue; }
        const sdir = path.join(dir, f, 'subagents');
        let sf; try { sf = fs.readdirSync(sdir); } catch { continue; }
        for (const x of sf) if (x.endsWith('.jsonl')) add(path.join(sdir, x), ri, f, 'sub', dir);
      }
    }
  });
  // Largest first: when a rewound or forked copy repeats message ids, the fullest copy keeps them.
  return files.sort((a, b) => b.size - a.size || a.rootIdx - b.rootIdx || (a.fp < b.fp ? -1 : 1));
}

/** Scan every transcript that can hold the window; count each message id once across all files and roots. */
function scan(cfg, roots, W, { onProgress } = {}) {
  const list = listTranscripts(roots, W.sinceMs);
  const buf = Buffer.alloc(8 << 20);
  const seenId = new Set(), seenUuid = new Set(), seenMsg = new Set();
  const S = { files: [], info: new Map(), msgs: [], dedupe: { messages: 0, usd: 0, files: 0, byRoot: roots.map(() => ({ messages: 0, usd: 0 })), crossMessages: 0 },
    scanned: { files: list.length, bytes: list.reduce((a, f) => a + f.size, 0) }, unpriced: new Set() };
  const phaseOf = t => cfg.phases.findIndex(p => t >= p.from && t < p.to);
  list.forEach((f, i) => {
    if (onProgress) onProgress(i, list.length);
    const R = scanFile(f.fp, f.kind, W, buf, cfg.orchestrated.prompt);
    const rec = { sid: f.sid, kind: f.kind, rootIdx: f.rootIdx, usd: 0, reqs: 0, tok: 0, first: null, last: null, buckets: {}, orgUsd: {}, phaseUsd: cfg.phases.map(() => 0),
      models: {}, prompts: [], promptHit: R.promptHit, agentType: 'unknown', desc: '' };
    let lost = false;
    for (const [id, r] of R.reqs) {
      const cost = F.costOf(r.m, r.u);
      if (seenId.has(id)) {
        S.dedupe.messages++; S.dedupe.usd += cost; S.dedupe.byRoot[f.rootIdx].messages++; S.dedupe.byRoot[f.rootIdx].usd += cost; lost = true;
        continue;
      }
      seenId.add(id);
      if (!F.price(r.m)) S.unpriced.add(r.m);
      rec.usd += cost; rec.reqs++; rec.tok += r.u[0] + r.u[1] + r.u[2] + r.u[3] + r.u[4];
      if (rec.first == null || r.t < rec.first) rec.first = r.t;
      if (rec.last == null || r.t > rec.last) rec.last = r.t;
      rec.models[r.m] = (rec.models[r.m] || 0) + cost;
      const b = Math.floor(r.t / BUCKET) * BUCKET;
      rec.buckets[b] = (rec.buckets[b] || 0) + cost;
      rec.orgUsd[r.org] = (rec.orgUsd[r.org] || 0) + cost;
      const pi = phaseOf(r.t); if (pi >= 0) rec.phaseUsd[pi] += cost;
    }
    if (lost) S.dedupe.files++;
    for (const p of R.prompts) { if (p.uuid) { if (seenUuid.has(p.uuid)) continue; seenUuid.add(p.uuid); } rec.prompts.push(p.t); }
    for (const m of R.msgs) {
      if (seenMsg.has(m.key)) { S.dedupe.crossMessages++; continue; }
      seenMsg.add(m.key); S.msgs.push({ t: m.t, from: m.from, ack: m.ack, toSid: f.sid });
    }
    if (f.kind === 'sub') {
      const meta = F.readJson(f.fp.replace(/\.jsonl$/, '.meta.json'), {}) || {};
      rec.agentType = F.clean(meta.agentType) || 'unknown';
      rec.desc = scrub(F.clean(meta.description)).slice(0, 80);
    } else {
      const inf = S.info.get(f.sid) || { title: null, ai: null, dir: f.dir };
      if (R.title) inf.title = R.title;
      if (R.ai && !inf.ai) inf.ai = R.ai;
      S.info.set(f.sid, inf);
    }
    if (f.kind === 'sub' && !S.info.has(f.sid)) S.info.set(f.sid, { title: null, ai: null, dir: f.dir });
    if (rec.reqs) S.files.push(rec);
  });
  if (onProgress) onProgress(list.length, list.length);
  return S;
}

// --- analysis ---
const bk = t => Math.floor(t / BUCKET) * BUCKET;
function window_(sinceMs, untilMs) {
  const bk0 = bk(sinceMs), nb = (bk(untilMs - 1) - bk0) / BUCKET + 1;
  return { sinceMs, untilMs, bk0, nb, hours: (untilMs - sinceMs) / 3600e3 };
}
function readTitleFile(dir, sid) {
  const j = F.readJson(path.join(dir, sid, 'custom-title.json'), null);
  return j && typeof j.customTitle === 'string' ? j.customTitle : null;
}
const overlapH = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / 3600e3;

function analyze(S, cfg, roots, W, { meta = {}, bill = null, anon = false } = {}) {
  const resolve = laneResolver(cfg);
  const sess = new Map();
  for (const f of S.files) {
    const x = sess.get(f.sid) || sess.set(f.sid, { id: f.sid, usd: 0, files: [] }).get(f.sid);
    x.usd += f.usd; x.files.push(f);
  }
  const all = { usd: 0, byRoot: roots.map(() => 0) };
  let smallUsd = 0, small = 0, excludedUsd = 0, excluded = 0;
  const kept = [];
  for (const x of sess.values()) {
    all.usd += x.usd; x.files.forEach(f => { all.byRoot[f.rootIdx] += f.usd; });
    if (cfg.exclude.some(p => x.id.startsWith(p))) { excluded++; excludedUsd += x.usd; continue; }
    if (x.usd < cfg.minUsd) { small++; smallUsd += x.usd; continue; }
    kept.push(x);
  }
  const keptIds = new Set(kept.map(x => x.id));
  // lanes
  const lanes = new Map();
  const laneOf = name => lanes.get(name) || lanes.set(name, { name, role: (cfg.lanes.find(l => l.name === name) || {}).role || '', sessions: 0, main: 0, sub: 0, reqs: 0, prompts: 0,
    subs: 0, kinds: { typed: 0, prompted: 0, general: 0, other: 0 }, first: null, last: null, buckets: new Set(), sent: 0, received: 0, acks: 0 }).get(name);
  const idx = t => (bk(t) - W.bk0) / BUCKET;
  const subs = [], promptTimes = [], byRoot = roots.map(r => ({ label: r.label, usd: 0, reqs: 0, sessions: new Set(), subagents: 0, allUsd: 0, dedupedMessages: 0, dedupedUsd: 0 }));
  roots.forEach((r, i) => { byRoot[i].allUsd = all.byRoot[i]; byRoot[i].dedupedMessages = S.dedupe.byRoot[i].messages; byRoot[i].dedupedUsd = S.dedupe.byRoot[i].usd; });
  let usd = 0, reqs = 0, tokens = 0;
  const phaseUsd = cfg.phases.map(() => 0);
  for (const x of kept) {
    const inf = S.info.get(x.id) || { dir: null };
    const title = F.clean((meta[x.id] || {}).name || inf.title || (inf.dir && readTitleFile(inf.dir, x.id)) || inf.ai || '').trim().slice(0, 80) || x.id.slice(0, 8);
    x.lane = resolve(title, x.id); x.title = title;
    const L = laneOf(x.lane); L.sessions++;
    for (const f of x.files) {
      usd += f.usd; reqs += f.reqs; tokens += f.tok;
      const R = byRoot[f.rootIdx]; R.usd += f.usd; R.reqs += f.reqs; R.sessions.add(x.id);
      f.phaseUsd.forEach((v, i) => { phaseUsd[i] += v; });
      if (f.first != null) { L.first = L.first == null ? f.first : Math.min(L.first, f.first); L.last = L.last == null ? f.last : Math.max(L.last, f.last); }
      if (f.kind === 'main') {
        L.main += f.usd; L.reqs += f.reqs; L.prompts += f.prompts.length;
        for (const b of Object.keys(f.buckets)) L.buckets.add(idx(+b));
        for (const t of f.prompts) promptTimes.push(t);
      } else {
        const kind = cfg.orchestrated.agent.test(f.agentType) ? 'typed' : f.promptHit ? 'prompted' : f.agentType === 'general-purpose' ? 'general' : 'other';
        const model = Object.entries(f.models).sort((a, b) => b[1] - a[1])[0];
        subs.push({ sid: x.id, lane: x.lane, type: f.agentType, kind, desc: f.desc, start: f.first, end: f.last, usd: f.usd, reqs: f.reqs, model: model ? model[0] : '?', root: f.rootIdx });
        L.sub += f.usd; L.subs++; L.kinds[kind]++; R.subagents++;
      }
    }
  }
  // A lane is active in a bucket when its main thread made requests or one of its subagents was running.
  for (const s of subs) for (let b = bk(s.start); b <= bk(s.end); b += BUCKET) laneOf(s.lane).buckets.add(idx(b));
  const laneCount = new Array(W.nb).fill(0), subCount = new Array(W.nb).fill(0);
  for (const L of lanes.values()) for (const i of L.buckets) if (i >= 0 && i < W.nb) laneCount[i]++;
  for (const s of subs) for (let b = bk(s.start); b <= bk(s.end); b += BUCKET) { const i = idx(b); if (i >= 0 && i < W.nb) subCount[i]++; }
  const conc = laneCount.map((l, i) => ({ t: W.bk0 + i * BUCKET, lanes: l, subs: subCount[i] }));
  const peakOf = (from, to) => conc.reduce((best, c) => (c.t >= from && c.t < to && c.lanes + c.subs > (best ? best.lanes + best.subs : 0) ? c : best), null);
  const activeOf = (from, to) => { const a = conc.filter(c => c.t >= from && c.t < to && c.lanes + c.subs > 0); return a.length ? a.reduce((s, c) => s + c.lanes + c.subs, 0) / a.length : 0; };
  const laneHours = [...lanes.values()].reduce((a, L) => a + L.buckets.size * BUCKET / 3600e3, 0);
  const subHoursOf = (from, to) => subs.reduce((a, s) => a + overlapH(s.start, Math.max(s.end, s.start + 60e3), from, to), 0);
  const peak = peakOf(-Infinity, Infinity);
  // messages
  const msgs = S.msgs.filter(m => keptIds.has(m.toSid));
  const sess2lane = new Map(kept.map(x => [x.id, x.lane]));
  const senders = new Map();
  let acks = 0, same = 0;
  for (const m of msgs) {
    const from = resolve(m.from, null), to = sess2lane.get(m.toSid);
    const a = senders.get(from) || senders.set(from, { name: from, sent: 0, acks: 0, received: 0 }).get(from);
    a.sent++; if (m.ack) { a.acks++; acks++; }
    const b = senders.get(to) || senders.set(to, { name: to, sent: 0, acks: 0, received: 0 }).get(to);
    b.received++; if (from === to) same++;
  }
  // phases
  const phases = cfg.phases.map((p, i) => {
    const from = Math.max(p.from, W.sinceMs), to = Math.min(p.to, W.untilMs);
    const inP = t => t >= p.from && t < p.to;
    const pk = peakOf(p.from, p.to), pSubs = subs.filter(s => inP(s.start));
    const laneBuckets = conc.filter(c => c.t >= p.from && c.t < p.to).reduce((a, c) => a + c.lanes, 0);
    const lanesSeen = new Set();
    for (const L of lanes.values()) for (const j of L.buckets) if (inP(W.bk0 + j * BUCKET)) lanesSeen.add(L.name);
    const pt = promptTimes.filter(inP);
    const lh = laneBuckets * BUCKET / 3600e3, sh = subHoursOf(p.from, p.to);
    return { name: p.name, from: p.from, to: p.to, hours: Math.max(0, to - from) / 3600e3, usd: phaseUsd[i], lanes: lanesSeen.size, subagents: pSubs.length,
      orchestrated: pSubs.filter(s => s.kind === 'typed' || s.kind === 'prompted').length, peak: pk && pk.lanes + pk.subs ? { n: pk.lanes + pk.subs, lanes: pk.lanes, subs: pk.subs, at: pk.t } : null,
      avgActive: activeOf(p.from, p.to), laneHours: lh, subHours: sh, claudeHours: lh + sh, prompts: pt.length, promptHours: new Set(pt.map(t => Math.floor(t / 3600e3))).size };
  });
  // accounts: a request's own org, else its session's main-thread org, else the profile record
  const ACC = F.accounts();
  const label = org => F.accountLabel(ACC.byOrg[org] || (org ? { email: `org ${org.slice(0, 8)}`, plan: '?', orgName: '' } : null));
  const accounts = {};
  for (const x of sess.values()) {
    const dom = {}; x.files.forEach(f => { if (f.kind === 'main') for (const [o, v] of Object.entries(f.orgUsd)) if (o) dom[o] = (dom[o] || 0) + v; });
    const fallback = (Object.entries(dom).sort((a, b) => b[1] - a[1])[0] || [])[0] || ACC.bySession[x.id] || '';
    for (const f of x.files) for (const [o, v] of Object.entries(f.orgUsd)) { const n = label(o || fallback); accounts[n] = (accounts[n] || 0) + v; }
  }
  const orchSubs = subs.filter(s => s.kind === 'typed' || s.kind === 'prompted');
  const hours = W.hours;
  const A = {
    window: { since: W.sinceMs, until: W.untilMs, hours, bucketMinutes: BUCKET / 60e3 },
    totals: { usd, reqs, tokens, sessions: kept.length, lanes: lanes.size, subagents: subs.length, messages: msgs.length, ackOnly: acks, sameLane: same,
      prompts: promptTimes.length, promptHours: new Set(promptTimes.map(t => Math.floor(t / 3600e3))).size,
      laneHours, subagentHours: subHoursOf(-Infinity, Infinity), avgParallelism: 0, avgActiveParallelism: activeOf(-Infinity, Infinity),
      peak: peak && peak.lanes + peak.subs ? { n: peak.lanes + peak.subs, lanes: peak.lanes, subs: peak.subs, at: peak.t } : null,
      allUsd: all.usd, smallSessions: small, smallUsd, excludedSessions: excluded, excludedUsd },
    orchestrated: { subagents: orchSubs.length, share: subs.length ? orchSubs.length / subs.length : 0, usd: orchSubs.reduce((a, s) => a + s.usd, 0),
      byKind: Object.fromEntries(KINDS.map(k => [k, subs.filter(s => s.kind === k).length])),
      agentPattern: cfg.orchestrated.agent.source, promptPattern: cfg.orchestrated.prompt.source },
    lanes: [...lanes.values()].sort((a, b) => b.main + b.sub - a.main - a.sub).map(L => ({ name: L.name, role: L.role, sessions: L.sessions, main: L.main, sub: L.sub, usd: L.main + L.sub,
      reqs: L.reqs, prompts: L.prompts, subagents: L.subs, kinds: L.kinds, activeHours: L.buckets.size * BUCKET / 3600e3, first: L.first, last: L.last })),
    phases, conc,
    messages: { total: msgs.length, ackOnly: acks, sameLane: same, senders: [...senders.values()].sort((a, b) => b.sent - a.sent || b.received - a.received) },
    topSubagents: subs.slice().sort((a, b) => b.usd - a.usd).slice(0, 10).map(s => ({ lane: s.lane, type: s.type, kind: s.kind, desc: s.desc, usd: s.usd, reqs: s.reqs,
      minutes: Math.max(1, Math.round((s.end - s.start) / 60e3)), model: s.model, machine: roots[s.root].label })),
    machines: byRoot.map(r => ({ label: r.label, usd: r.usd, reqs: r.reqs, sessions: r.sessions.size, subagents: r.subagents, allUsd: r.allUsd, dedupedMessages: r.dedupedMessages, dedupedUsd: r.dedupedUsd })),
    dedupe: { messages: S.dedupe.messages, usd: S.dedupe.usd, files: S.dedupe.files, crossSessionMessages: S.dedupe.crossMessages },
    accounts, unpriced: [...S.unpriced], scanned: S.scanned, sources: roots.map(r => r.label),
  };
  A.totals.avgParallelism = hours ? (A.totals.laneHours + A.totals.subagentHours) / hours : 0;
  A.reconcile = reconcile(A, cfg, bill, W);
  if (anon) anonymize(A);
  return A;
}

function reconcile(A, cfg, bill, W) {
  const items = [];
  if (bill != null) items.push({ label: 'bill', usd: bill, account: null, month: null });
  else {
    const months = new Set();
    for (let t = W.sinceMs; t < W.untilMs; t += 86400e3 * 7) { const d = new Date(t); months.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }
    const e = new Date(W.untilMs - 1); months.add(`${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}`);
    for (const b of cfg.bills) if (!b.month || months.has(b.month)) items.push({ label: b.month || 'bill', ...b });
  }
  if (!items.length) return null;
  const plain = items.filter(i => !i.account), rows = [];
  if (plain.length) rows.push({ label: plain.map(i => i.label).join(' + '), account: null, billed: plain.reduce((a, i) => a + i.usd, 0), explained: A.totals.allUsd, months: plain.map(i => i.month).filter(Boolean) });
  for (const i of items.filter(x => x.account)) {
    const words = i.account.toLowerCase().split(/\s+/).filter(Boolean);
    const explained = Object.entries(A.accounts).filter(([n]) => words.every(w => n.toLowerCase().includes(w))).reduce((a, [, v]) => a + v, 0);
    rows.push({ label: `${i.account}${i.month ? ` ${i.month}` : ''}`, account: i.account, billed: i.usd, explained, months: i.month ? [i.month] : [] });
  }
  const cleanupDays = F.cleanupDays();
  for (const r of rows) {
    r.gap = r.billed - r.explained;
    r.pct = r.billed ? r.explained / r.billed : null;
    r.status = !r.billed ? 'none' : Math.abs(r.gap) <= 0.02 * r.billed ? 'match' : r.gap > 0 ? 'under' : 'over';
    const partial = r.months.some(m => { const [y, mo] = m.split('-').map(Number); return W.sinceMs > new Date(y, mo - 1, 1).getTime() || W.untilMs < new Date(y, mo, 1).getTime(); });
    r.reasons = [];
    if (r.status === 'under') {
      r.reasons.push(`Other machines or profiles: only ${A.sources.length} transcript root${A.sources.length === 1 ? ' was' : 's were'} read (${A.sources.join(', ')}). Add the rest with --root.`);
      r.reasons.push('claude.ai, Claude desktop and mobile, and API or console use never write Claude Code transcripts.');
      const horizon = Date.now() - cleanupDays * 86400e3;
      r.reasons.push(`Deleted sessions: Claude Code removes transcripts after cleanupPeriodDays (${cleanupDays} days here)${W.sinceMs < horizon ? '; this window starts before that horizon' : ''}.`);
      r.reasons.push(`Price-table drift: puffr prices every request at its built-in list prices${A.unpriced.length ? `; ${A.unpriced.join(', ')} ha${A.unpriced.length === 1 ? 's' : 've'} no price and count as $0` : ''}. Add or override prices in ~/.puffr/prices.json.`);
      r.reasons.push('Requests transcripts do not record, such as compaction summary calls.');
    } else if (r.status === 'over') {
      r.reasons.push('The bill may cover a narrower period or account than this window, or be net of credits, a plan allowance, or discounts. Transcripts are priced at list.');
      r.reasons.push('Price-table drift in the other direction: a built-in price above the rate you were billed.');
    }
    if (partial) r.reasons.push('This window covers only part of the billed month, so the bill includes spend from outside it.');
  }
  return { rows };
}

function anonymize(A) {
  const names = new Map(), nm = n => { if (!names.has(n)) names.set(n, `lane-${String(names.size + 1).padStart(2, '0')}`); return names.get(n); };
  A.lanes.forEach(L => { L.name = nm(L.name); L.role = ''; });
  A.messages.senders.forEach(s => { s.name = nm(s.name); });
  A.topSubagents.forEach(s => { s.lane = nm(s.lane); s.desc = ''; });
  A.accounts = Object.fromEntries(Object.values(A.accounts).map((v, i) => [`account-${i + 1}`, v]));
}

// --- number and time formats ---
const k = n => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
const usd = v => v == null ? '–' : v >= 1000 ? `$${Math.round(v).toLocaleString('en-US')}` : v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
const pct = x => `${Math.round(x * 100)}%`;
const h1 = n => n.toFixed(1);
const p2 = n => String(n).padStart(2, '0');
const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function fmtT(ms) {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
const fmtD = ms => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const titleOf = A => `${fmtD(A.window.since)} → ${fmtD(A.window.until)} (${Math.round(A.window.hours)} h)`;

function renderText(A, { color = false } = {}) {
  const C = (c, s) => color ? `\x1b[${c}m${s}\x1b[0m` : s;
  const dim = s => C('2', s), bold = s => C('1', s);
  const T = A.totals, o = [];
  const H = (title, cols, pad) => o.push(bold(title) + dim(' '.repeat(Math.max(1, pad - title.length)) + cols));
  o.push(`🐡 puffr swarm: ${titleOf(A)} · ${T.sessions} sessions · ${bold(usd(T.usd))} ${dim('≈ API list price')}`);
  const left = [T.smallSessions && `${T.smallSessions} under the minimum (${usd(T.smallUsd)})`, T.excludedSessions && `${T.excludedSessions} excluded (${usd(T.excludedUsd)})`].filter(Boolean);
  if (left.length) o.push(dim(`   left out of lanes and counts: ${left.join(' · ')}; the reconciliation and machine totals still include them`));
  o.push('');
  H('SWARM', '', 10);
  o.push(`  ${T.peak ? `peak ${bold(String(T.peak.n))} at ${fmtT(T.peak.at)} (${pl(T.peak.lanes, 'lane')} + ${pl(T.peak.subs, 'subagent')})` : 'no activity'} · average ${h1(T.avgParallelism)} over the window, ${h1(T.avgActiveParallelism)} while active`);
  o.push(`  ${h1(T.laneHours)} lane-hours · ${h1(T.subagentHours)} subagent-hours · ${T.lanes} lanes · ${T.subagents} subagents · ${T.messages} cross-session messages`);
  o.push(`  you typed ${T.prompts} prompts across ${T.promptHours} distinct hours`);
  o.push('');
  H('LANES', 'spend  main  subagents  reqs  prompts  subs  orch  active-h', 36);
  for (const L of A.lanes.slice(0, 20)) {
    o.push(`  ${L.name.slice(0, 30).padEnd(30)} ${usd(L.usd).padStart(8)} ${usd(L.main).padStart(8)} ${usd(L.sub).padStart(9)} ${k(L.reqs).padStart(6)} ${String(L.prompts).padStart(7)} ${String(L.subagents).padStart(5)} ${String(L.kinds.typed + L.kinds.prompted).padStart(5)} ${h1(L.activeHours).padStart(8)}`);
  }
  if (A.lanes.length > 20) o.push(dim(`  … ${A.lanes.length - 20} more lanes (--json has all)`));
  o.push('');
  if (A.phases.length) {
    H('PHASES', 'spend  subagents  orch  peak  avg  claude-h  prompts  prompt-h', 36);
    for (const p of A.phases) {
      o.push(`  ${p.name.slice(0, 30).padEnd(30)} ${usd(p.usd).padStart(8)} ${String(p.subagents).padStart(9)} ${String(p.orchestrated).padStart(5)} ${(p.peak ? String(p.peak.n) : '–').padStart(5)} ${h1(p.avgActive).padStart(5)} ${h1(p.claudeHours).padStart(9)} ${String(p.prompts).padStart(8)} ${String(p.promptHours).padStart(9)}`);
      o.push(dim(`    ${fmtD(p.from)} → ${fmtD(p.to)}${p.peak ? ` · peak at ${fmtT(p.peak.at)}` : ''} · ${pl(p.lanes, 'lane')} active`));
    }
    o.push('');
  }
  H('CROSS-SESSION MESSAGES', 'sent  received  ack-only', 36);
  o.push(`  ${bold(String(A.messages.total))} messages · ${A.messages.ackOnly} ack-only (${pct(A.messages.total ? A.messages.ackOnly / A.messages.total : 0)}) · ${A.messages.sameLane} within one lane`);
  for (const s of A.messages.senders.slice(0, 10)) o.push(`  ${s.name.slice(0, 30).padEnd(30)} ${String(s.sent).padStart(5)}  ${String(s.received).padStart(8)}  ${String(s.acks).padStart(8)}`);
  o.push('');
  const O = A.orchestrated;
  H('ORCHESTRATED SUBAGENTS', 'count  share', 36);
  o.push(`  ${O.subagents} of ${T.subagents} subagents (${pct(O.share)}) · ${usd(O.usd)}`);
  for (const kd of KINDS) o.push(dim(`    ${KIND_LABEL[kd].padEnd(30)} ${String(O.byKind[kd]).padStart(5)}`));
  o.push(dim(`    agent type /${O.agentPattern}/i · prompt /${O.promptPattern}/i (--orchestrated-agent, --orchestrated-prompt)`));
  o.push('');
  H('TOP SUBAGENTS', 'spend  min  reqs  agent / lane', 12);
  for (const s of A.topSubagents) o.push(`  ${usd(s.usd).padStart(8)} ${String(s.minutes).padStart(4)} ${k(s.reqs).padStart(5)}  ${s.type.slice(0, 34)} ${dim(`· ${s.lane.slice(0, 24)}${s.desc ? ` · ${s.desc.slice(0, 40)}` : ''}`)}`);
  o.push('');
  H('BY MACHINE', 'spend  sessions  subagents  deduped msgs  deduped $', 30);
  for (const m of A.machines) o.push(`  ${m.label.slice(0, 24).padEnd(24)} ${usd(m.usd).padStart(9)} ${String(m.sessions).padStart(8)} ${String(m.subagents).padStart(9)} ${String(m.dedupedMessages).padStart(13)} ${usd(m.dedupedUsd).padStart(10)}`);
  o.push(dim(`  Every assistant message id is counted once across ${A.sources.length} root${A.sources.length === 1 ? '' : 's'}: ${A.dedupe.messages} repeats removed (${usd(A.dedupe.usd)}) from ${A.dedupe.files} transcript${A.dedupe.files === 1 ? '' : 's'}${A.dedupe.crossSessionMessages ? `, plus ${pl(A.dedupe.crossSessionMessages, 'repeated cross-session message')}` : ''}.`));
  if (A.reconcile) {
    o.push('');
    H('RECONCILE AGAINST THE BILL', '', 30);
    for (const r of A.reconcile.rows) {
      o.push(`  ${r.label}: transcripts explain ${bold(usd(r.explained))} of ${bold(usd(r.billed))} (${r.pct == null ? '–' : pct(r.pct)})`);
      o.push(`  ${r.gap >= 0 ? 'unexplained' : 'over the bill by'} ${bold(usd(Math.abs(r.gap)))}`);
      for (const why of r.reasons) o.push(dim(`    · ${why}`));
    }
  }
  if (A.unpriced.length) o.push('', dim(`  unpriced models (tokens counted, $ not): ${A.unpriced.join(', ')}`));
  o.push('', dim('  A lane is active in a 15-minute bucket when its main thread made requests or one of its subagents was running. Local time.'));
  return o.join('\n');
}

// --- HTML ---
function chartSvg(A) {
  const e = RP.e, W = 960, H = 230, L = 40, R = 8, T = 22, B = 28, iw = W - L - R, ih = H - T - B;
  const group = Math.max(1, Math.ceil(A.conc.length / 480)), bars = [];
  for (let i = 0; i < A.conc.length; i += group) {
    const g = A.conc.slice(i, i + group);
    bars.push({ t: g[0].t, lanes: Math.max(...g.map(c => c.lanes)), subs: Math.max(...g.map(c => c.subs)) });
  }
  const max = Math.max(1, ...bars.map(b => b.lanes + b.subs)), bw = iw / Math.max(1, bars.length);
  const y = v => (T + ih * (1 - v / max)).toFixed(1), x = i => (L + i * bw).toFixed(1);
  const at = t => L + ((t - A.conc[0].t) / (A.conc.length * BUCKET)) * iw;
  const out = [`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sessions and subagents running at once, per ${15 * group} minutes">`];
  A.phases.forEach((p, i) => {
    const x0 = Math.max(L, at(p.from)), x1 = Math.min(W - R, at(p.to));
    if (x1 > x0) out.push(`<rect class="band${i % 2 ? ' alt' : ''}" x="${x0.toFixed(1)}" y="${T}" width="${(x1 - x0).toFixed(1)}" height="${ih}"/><text x="${(x0 + 3).toFixed(1)}" y="${T - 7}">${e(p.name.slice(0, 24))}</text>`);
  });
  for (const v of [0, Math.round(max / 2), max]) out.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 5}" y="${(+y(v) + 3).toFixed(1)}" text-anchor="end">${v}</text>`);
  bars.forEach((b, i) => {
    const tip = `${fmtT(b.t)}: ${pl(b.lanes, 'lane')} + ${pl(b.subs, 'subagent')}`;
    out.push(`<g><title>${e(tip)}</title><rect class="lane" x="${x(i)}" y="${y(b.lanes)}" width="${Math.max(0.6, bw - 0.4).toFixed(1)}" height="${(ih * b.lanes / max).toFixed(1)}"/>`
      + `<rect class="sub" x="${x(i)}" y="${y(b.lanes + b.subs)}" width="${Math.max(0.6, bw - 0.4).toFixed(1)}" height="${(ih * b.subs / max).toFixed(1)}"/></g>`);
  });
  const step = Math.max(1, Math.ceil(bars.length / 8));
  for (let i = 0; i < bars.length; i += step) out.push(`<text class="ax" x="${x(i)}" y="${H - 9}">${e(fmtT(bars[i].t).slice(4))}</text>`);
  if (A.totals.peak) { const px = at(A.totals.peak.at) + bw / 2; out.push(`<line class="peak" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${T}" y2="${T + ih}"/>`); }
  out.push('</svg>');
  return out.join('');
}

function renderHtml(A) {
  const { e, row, table } = RP, T = A.totals;
  const $ = v => [e(usd(v)), v == null ? null : v], N = v => [String(v), v], K = v => [e(k(v)), v], Hh = v => [h1(v), v];
  const stat = (v, l, tip) => `<div title="${e(tip)}"><b>${e(v)}</b><span>${e(l)}</span></div>`;
  const box = (hero, label, text) => `<div class="ucef-box"><div class="hero"><b>${e(hero)}</b><span>${e(label)}</span></div><p class="vsum">${e(text)}</p></div>`;
  const parts = [];
  parts.push(`<div class="stats">${[
    stat(usd(T.usd), 'at API list prices', 'Every assistant message id counted once, priced at list. Main threads and subagents.'),
    stat(T.sessions, 'sessions', 'Sessions above the minimum spend, after exclusions.'),
    stat(T.lanes, 'lanes', 'Sessions grouped by the lane rules; with none, one lane per session title.'),
    stat(T.peak ? T.peak.n : 0, T.peak ? `peak at ${fmtT(T.peak.at)}` : 'peak', T.peak ? `${T.peak.lanes} lanes and ${T.peak.subs} subagents active in the busiest 15 minutes.` : 'No activity in the window.'),
    stat(h1(T.avgParallelism), 'avg parallel', `Lane-hours plus subagent-hours over the ${Math.round(A.window.hours)} hour window. While active: ${h1(T.avgActiveParallelism)}.`),
    stat(h1(T.laneHours), 'lane-hours', 'Each 15-minute bucket in which a lane was active counts a quarter hour per lane.'),
    stat(h1(T.subagentHours), 'subagent-hours', 'Each subagent from its first to its last request in the window, at least a minute.'),
    stat(T.subagents, 'subagents', `${pct(A.orchestrated.share)} orchestrated.`),
    stat(T.messages, 'cross-session msgs', `${T.ackOnly} of them are acks only.`),
    stat(T.promptHours, 'prompt-hours', `${T.prompts} prompts you typed, in ${T.promptHours} distinct clock hours.`),
  ].join('')}</div>`);
  const left = [T.smallSessions && `${pl(T.smallSessions, 'session')} under the minimum spend (${usd(T.smallUsd)})`, T.excludedSessions && `${T.excludedSessions} excluded (${usd(T.excludedUsd)})`].filter(Boolean);
  if (left.length) parts.push(`<p class="note">Left out of lanes and counts: ${e(left.join(', '))}. The machine split and the reconciliation still include them.</p>`);
  parts.push('<h2>Concurrency <small>lanes and subagents running, per 15 minutes</small></h2>', A.conc.length ? chartSvg(A) : '<p class="note">No activity in this window.</p>',
    '<p class="note chartkey"><span class="k lane"></span> lanes active <span class="k sub"></span> subagents running · a lane is active when its main thread made requests or one of its subagents was running · local time</p>');
  parts.push('<h2>Lanes</h2>', table(['Lane', 'Spend', 'Main', 'Subagents $', 'Requests', 'Prompts', 'Sessions', 'Subagents', 'Orchestrated', 'Active h'],
    A.lanes.map(L => row([`${e(L.name)}${L.role ? ` <small>${e(L.role)}</small>` : ''}`, $(L.usd), $(L.main), $(L.sub), K(L.reqs), N(L.prompts), N(L.sessions), N(L.subagents), N(L.kinds.typed + L.kinds.prompted), Hh(L.activeHours)]))));
  if (A.phases.length) {
    parts.push('<h2>Phases</h2>', table(['Phase', 'Span', 'Spend', 'Lanes', 'Subagents', 'Orchestrated', 'Peak', 'Avg active', 'Claude h', 'Prompts', 'Prompt-h'],
      A.phases.map(p => row([e(p.name), e(`${fmtD(p.from)} → ${fmtD(p.to)}`), $(p.usd), N(p.lanes), N(p.subagents), N(p.orchestrated),
        [p.peak ? `${p.peak.n} <small>${e(fmtT(p.peak.at))}</small>` : '–', p.peak ? p.peak.n : 0], Hh(p.avgActive), Hh(p.claudeHours), N(p.prompts), N(p.promptHours)]))),
    '<p class="note">Claude h is lane-hours plus subagent-hours inside the phase. Prompt-h counts the distinct clock hours in which you typed a prompt.</p>');
  }
  parts.push('<h2>Cross-session messages</h2>', box(String(A.messages.total), 'messages', `${A.messages.ackOnly} (${pct(A.messages.total ? A.messages.ackOnly / A.messages.total : 0)}) are acks only, and ${A.messages.sameLane} went between sessions of one lane.`),
    A.messages.senders.length ? table(['Lane', 'Sent', 'Received', 'Ack-only sent'], A.messages.senders.map(s => row([e(s.name), N(s.sent), N(s.received), N(s.acks)]))) : '');
  const O = A.orchestrated;
  parts.push('<h2>Orchestrated subagents</h2>', box(pct(O.share), 'of subagents', `${O.subagents} of ${T.subagents} subagents, ${usd(O.usd)}, matched by agent type /${O.agentPattern}/i or by a first prompt matching /${O.promptPattern}/i.`),
    table(['Kind', 'Subagents'], KINDS.map(kd => row([e(KIND_LABEL[kd]), N(O.byKind[kd])]))));
  parts.push('<h2>Top costly subagents</h2>', table(['Agent', 'Lane', 'Spend', 'Minutes', 'Requests', 'Model', 'Machine', 'Description'],
    A.topSubagents.map(s => row([e(s.type), e(s.lane), $(s.usd), N(s.minutes), K(s.reqs), e(s.model.replace(/^claude-/, '')), e(s.machine), e(s.desc)]))));
  parts.push('<h2>By machine</h2>', table(['Machine', 'Spend', 'Sessions', 'Subagents', 'Deduped messages', 'Deduped $'],
    A.machines.map(m => row([e(m.label), $(m.usd), N(m.sessions), N(m.subagents), N(m.dedupedMessages), $(m.dedupedUsd)]))),
    `<p class="note">Every assistant message id is counted once across ${A.sources.length} root${A.sources.length === 1 ? '' : 's'}; the fullest copy keeps it. ${A.dedupe.messages} repeated messages (${e(usd(A.dedupe.usd))}) were removed from ${A.dedupe.files} transcript${A.dedupe.files === 1 ? '' : 's'} (rewound or forked copies)${A.dedupe.crossSessionMessages ? `, plus ${pl(A.dedupe.crossSessionMessages, 'repeated cross-session message')}` : ''}.</p>`);
  if (A.reconcile) {
    parts.push('<h2>Reconcile against the bill</h2>');
    for (const r of A.reconcile.rows) {
      parts.push(box(r.pct == null ? '–' : pct(r.pct), `transcripts explain ${usd(r.explained)} of ${usd(r.billed)}`,
        `${r.label}: ${r.gap >= 0 ? `${usd(r.gap)} unexplained` : `transcripts exceed the bill by ${usd(-r.gap)}`}.`),
      r.reasons.length ? `<ul class="prac">${r.reasons.map(w => `<li class="warn"><b>${e(w)}</b></li>`).join('')}</ul>` : '');
    }
  }
  if (A.unpriced.length) parts.push(`<p class="note">Unpriced models (tokens counted, $ not): ${e(A.unpriced.join(', '))}.</p>`);
  return RP.page({ title: `swarm ${titleOf(A)}`, body: parts.join('\n') });
}

module.exports = { UsageError, parseWhen, normalizeConfig, readConfigFile, resolveRoots, scan, analyze, window_, renderText, renderHtml, laneResolver, titleOf, fmtD };
