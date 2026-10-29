'use strict';
// puffr core: incremental transcript indexer, session metadata, projects, prices.
// Shared by puffr-sessions and puffr-burn. Builtins only, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = os.homedir();
const DIR = path.join(HOME, '.puffr');
const FILES = {
  cache: path.join(DIR, 'sessions-cache.json'),
  meta: path.join(DIR, 'sessions-meta.json'),
  projects: path.join(DIR, 'projects.json'),
  config: path.join(DIR, 'config'),
  spend: path.join(DIR, 'spend.json'),
  prices: path.join(DIR, 'prices.json'),
  reportPrompt: path.join(DIR, 'report-prompt.md'),
  reportRules: path.join(DIR, 'report-rules.json'),
  archive: path.join(DIR, 'archive'),
};
// Bump when the per-file state shape changes: old caches re-index from zero.
const CACHE_V = 8;
const HEAD_BYTES = 4096;
const SNIPPET_CAP = 100;
const READS_CAP = 40;
const MEM_CAP = 30;
// A manual compaction followed by this much quiet was done before a break.
const AWAY_SECS = 900;
const EARLY_COMPACT = 200000;

const clean = v => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f\u0080-\u009f]/g, '');
const n0 = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const TZ_MS = new Date().getTimezoneOffset() * 60000;
const dayOf = ts => { const t = Date.parse(ts); return Number.isFinite(t) ? new Date(t - TZ_MS).toISOString().slice(0, 10) : null; };
// Usage buckets are local hours, "YYYY-MM-DDTHH": they sort as strings and slice(0, 10) is the day.
const hourOf = ts => { const t = Date.parse(ts); return Number.isFinite(t) ? new Date(t - TZ_MS).toISOString().slice(0, 13) : null; };

function readJson(fp, d) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return d; } }
// Private: everything under ~/.puffr holds titles, prompts, or paths from 0600 transcripts.
function writePrivate(fp, body) {
  fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DIR, 0o700); } catch {}
  const tmp = `${fp}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, fp);
}

// ~/.claude/projects plus $CLAUDE_CONFIG_DIR/projects, deduped by real path
// (aimux profiles usually symlink one shared projects dir).
function roots() {
  const out = [], seen = new Set();
  const cands = [path.join(HOME, '.claude', 'projects')];
  if (process.env.CLAUDE_CONFIG_DIR) cands.push(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
  for (const c of cands) {
    let r; try { r = fs.realpathSync(c); } catch { continue; }
    if (!seen.has(r)) { seen.add(r); out.push(c); }
  }
  return out;
}

// --- per-line accumulator ---
function emptyState() {
  return {
    summary: '', count: 0, slug: null, customTitle: null, aiTitle: null, first: null, last: null, cwd: null,
    days: {}, prs: {}, reads: {}, mem: {}, editDirs: {}, org: null, lastOrg: null, lastCat: null,
    lastId: null, lastU: null, lastDay: null, lastModel: null,
    prevTs: null, prevModel: null, base: 0, tier: 300, compacts: 0, prevCompacts: 0, pend: null,
  };
}
// st.days is keyed by local hour (hourOf), despite the name.
// u: model → [input, cacheRead, write5m, write1h, output, requests]
// brk: reason → {n, t: model → [write5m, write1h]}
// comp: [auto, manual <200k, manual other, followed by work, followed by a break]
// o: org uuid ('' = not recorded) → model → same shape as u, for per-account spend
// k: work type → model → same shape as u (each response classed by the tools it called)
// cz: model → [tokens before, tokens after, count] per compaction, to estimate the summary call
const dayB = (st, d) => st.days[d] || (st.days[d] = { u: {}, brk: {}, comp: [0, 0, 0, 0, 0], exec: {}, expl: {}, edits: 0, commits: 0, prompts: 0, o: {}, k: {}, cz: {} });

const EXEC = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EXPLORE = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS']);
const COMMIT_RE = /\bgit\s+(?:-[Cc]\s+\S+\s+)*commit\b/;
const DOC_RE = /\.(md|mdx|markdown|txt|rst|adoc|org)$/i;
// Work type of a response: the highest-ranked tool it called.
const CAT_RANK = { compact: 8, code: 7, docs: 6, shell: 5, delegate: 4, explore: 3, tools: 2, talk: 1 };
function lineCat(content) {
  let best = 'talk';
  for (const c of Array.isArray(content) ? content : []) {
    if (!c || c.type !== 'tool_use') continue;
    const n = String(c.name || ''), fp = (c.input && (c.input.file_path || c.input.notebook_path)) || '';
    const cat = EDITS.has(n) ? (n !== 'NotebookEdit' && DOC_RE.test(fp) ? 'docs' : 'code')
      : n === 'Bash' ? 'shell' : n === 'Task' || n === 'Agent' ? 'delegate' : EXPLORE.has(n) ? 'explore' : 'tools';
    if (CAT_RANK[cat] > CAT_RANK[best]) best = cat;
  }
  return best;
}

function memAdd(st, p, content) {
  if (typeof p !== 'string' || typeof content !== 'string') return;
  if (st.mem[p] == null && Object.keys(st.mem).length >= MEM_CAP) return;
  st.mem[clean(p)] = Math.ceil(content.length / 4);
}

// One request seen for the first time: settle a pending compaction, detect a cache break.
function newRequest(st, ts, day, model, r) {
  const t = Date.parse(ts);
  if (st.pend) {
    const g = (t - Date.parse(st.pend.ts)) / 1000, pb = st.days[st.pend.day];
    if (pb && Number.isFinite(g)) pb.comp[g >= AWAY_SECS ? 4 : 3]++;
    st.pend = null;
  }
  const write = r[2] + r[3], ctx = r[0] + r[1] + write;
  let brk = null;
  // The first request's context is the fixed prefix: system prompt, tools, skills, CLAUDE.md, first prompt.
  if (!st.prevTs) st.base = ctx;
  if (write >= Math.max(10000, 0.3 * ctx)) {
    let reason = 'start';
    if (st.prevTs) {
      const gap = (t - Date.parse(st.prevTs)) / 1000;
      const ttl = st.tier === 3600 || r[3] > 0 ? 3600 : 300;
      if (Number.isFinite(gap) && gap > ttl) reason = 'idle';
      else if (st.compacts > st.prevCompacts) reason = 'compact';
      else if (st.prevModel && st.prevModel !== model) reason = 'model';
      else reason = 'prefix';
    }
    const x = dayB(st, day).brk[reason] || (dayB(st, day).brk[reason] = { n: 0, t: {} });
    x.n++;
    const tm = x.t[model] || (x.t[model] = [0, 0]);
    tm[0] += r[2]; tm[1] += r[3];
    brk = reason;
  }
  if (r[3] > 0) st.tier = 3600; else if (r[2] > 0) st.tier = 300;
  st.prevTs = ts; st.prevModel = model; st.prevCompacts = st.compacts;
  return brk;
}

// One response's usage block as [input, cache read, write 5m, write 1h, output]. When the 5m/1h split
// doesn't add up to the total written, the remainder is 5m.
function usageRec(u) {
  const cc = u.cache_creation || {};
  const write = n0(u.cache_creation_input_tokens);
  let w1h = n0(cc.ephemeral_1h_input_tokens), w5 = n0(cc.ephemeral_5m_input_tokens);
  if (w1h + w5 !== write) { w5 = write - w1h; if (w5 < 0) { w5 = 0; w1h = write; } }
  return [n0(u.input_tokens), n0(u.cache_read_input_tokens), w5, w1h, n0(u.output_tokens)];
}

function applyLine(line, st) {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (!e || typeof e !== 'object') return;
  if (e.timestamp) { st.last = e.timestamp; if (!st.first) st.first = e.timestamp; }
  if (!st.cwd && typeof e.cwd === 'string') st.cwd = e.cwd;
  if (typeof e.slug === 'string' && !st.slug) st.slug = e.slug;
  if (e.type === 'custom-title' && typeof e.customTitle === 'string') st.customTitle = e.customTitle;
  if (e.type === 'ai-title' && typeof e.aiTitle === 'string') st.aiTitle = e.aiTitle;
  if (e.type === 'user' || e.type === 'assistant') st.count++;
  if (e.type === 'pr-link' && typeof e.prUrl === 'string' && !st.prs[e.prUrl]) st.prs[clean(e.prUrl)] = dayOf(e.timestamp);

  if (!st.summary && e.type === 'user' && e.message) {
    const c = e.message.content;
    let t = typeof c === 'string' ? c
      : Array.isArray(c) ? (c.find(p => p && p.type === 'text') || {}).text || '' : '';
    // Slash commands and ! shell input are wrapped in tags; the summary should be
    // the first thing the user actually typed, so wait for a plain prompt.
    if (typeof t === 'string' && t && !/<bash-input>|<local-command-caveat>|<command-name>/.test(t.slice(0, 4096))) {
      t = t.slice(0, 4096).replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (t) st.summary = t.slice(0, SNIPPET_CAP);
    }
  }

  if (e.type === 'user' && e.message && !e.isMeta && !e.isCompactSummary && !e.isSidechain) {
    const c = e.message.content;
    const typed = typeof c === 'string' || (Array.isArray(c) && c.some(p => p && p.type === 'text') && !c.some(p => p && p.type === 'tool_result'));
    const day = typed && hourOf(e.timestamp);
    if (day) dayB(st, day).prompts++;
  }

  if (e.type === 'system' && e.subtype === 'compact_boundary') {
    const day = hourOf(e.timestamp); if (!day) return;
    const m = e.compactMetadata || {}, manual = m.trigger === 'manual';
    const b = dayB(st, day);
    b.comp[!manual ? 0 : n0(m.preTokens) && n0(m.preTokens) < EARLY_COMPACT ? 1 : 2]++;
    const cz = b.cz[st.lastModel || '?'] || (b.cz[st.lastModel || '?'] = [0, 0, 0]);
    cz[0] += n0(m.preTokens); cz[1] += n0(m.postTokens); cz[2]++;
    st.compacts++;
    if (manual) st.pend = { ts: e.timestamp, day };
    return;
  }

  if (e.type === 'attachment' && e.attachment) {
    const a = e.attachment;
    if (a.type === 'credential_org' && typeof a.organizationUuid === 'string') st.org = clean(a.organizationUuid);
    else if (a.type === 'instructions' && Array.isArray(a.files)) for (const f of a.files) memAdd(st, f && f.path, f && f.content);
    else if (a.type === 'nested_memory') memAdd(st, a.path, a.content && typeof a.content === 'object' ? a.content.content : a.content);
    return;
  }

  if (e.type !== 'assistant' || !e.message) return;
  const msg = e.message, model = clean(msg.model), day = hourOf(e.timestamp);
  if (!model || model === '<synthetic>' || !day) return;

  if (msg.id && msg.usage) {
    const rec = usageRec(msg.usage);
    const org = st.org || '', b = dayB(st, day);
    const nb = b.u[model] || (b.u[model] = [0, 0, 0, 0, 0, 0]);
    const bo = b.o[org] || (b.o[org] = {}), no = bo[model] || (bo[model] = [0, 0, 0, 0, 0, 0]);
    const kb = (c, d) => { const kk = d.k[c] || (d.k[c] = {}); return kk[model] || (kk[model] = [0, 0, 0, 0, 0, 0]); };
    let cat = lineCat(msg.content);
    if (msg.id === st.lastId) {
      // One streamed response is logged as several lines repeating its usage: replace, don't add.
      // Its work type can only rise as later lines reveal more tool calls.
      if (CAT_RANK[st.lastCat] > CAT_RANK[cat]) cat = st.lastCat;
      const lb = st.days[st.lastDay], ob = lb && lb.u[st.lastModel], oo = lb && lb.o[st.lastOrg] && lb.o[st.lastOrg][st.lastModel];
      const ok = lb && lb.k[st.lastCat] && lb.k[st.lastCat][st.lastModel], nk = kb(cat, b);
      if (st.lastU) for (let i = 0; i < 5; i++) { if (ob) ob[i] -= st.lastU[i]; if (oo) oo[i] -= st.lastU[i]; if (ok) ok[i] -= st.lastU[i]; }
      if (ok && ok !== nk) { ok[5]--; nk[5]++; }
      for (let i = 0; i < 5; i++) { nb[i] += rec[i]; no[i] += rec[i]; nk[i] += rec[i]; }
    } else {
      if (!e.isSidechain && newRequest(st, e.timestamp, day, model, rec) === 'compact') cat = 'compact';
      const nk = kb(cat, b);
      for (let i = 0; i < 5; i++) { nb[i] += rec[i]; no[i] += rec[i]; nk[i] += rec[i]; }
      nb[5]++; no[5]++; nk[5]++;
    }
    st.lastId = msg.id; st.lastU = rec; st.lastDay = day; st.lastModel = model; st.lastOrg = org; st.lastCat = cat;
  }

  if (!Array.isArray(msg.content)) return;
  for (const c of msg.content) {
    if (!c || c.type !== 'tool_use') continue;
    const name = String(c.name || ''), inp = c.input || {}, b = dayB(st, day);
    if (EXEC.has(name)) b.exec[model] = (b.exec[model] || 0) + 1;
    else if (EXPLORE.has(name)) b.expl[model] = (b.expl[model] || 0) + 1;
    if (EDITS.has(name)) {
      b.edits++;
      // Where edits land locates the repos a session worked in, even when it started above them.
      const d = typeof inp.file_path === 'string' && path.dirname(clean(inp.file_path));
      if (d && (st.editDirs[d] || Object.keys(st.editDirs).length < 20)) st.editDirs[d] = (st.editDirs[d] || 0) + 1;
    }
    if (name === 'Bash' && typeof inp.command === 'string' && COMMIT_RE.test(inp.command)) b.commits++;
    if (name === 'Read' && typeof inp.file_path === 'string') {
      const p = clean(inp.file_path);
      if (st.reads[p] || Object.keys(st.reads).length < READS_CAP) st.reads[p] = (st.reads[p] || 0) + 1;
    }
  }
}

// --- Codex (OpenAI) rollouts: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl ---
// Same state shape as Claude sessions so every report works on both. Usage comes
// from cumulative token_count totals; each increase is one model request, filed
// under the work type of the tool calls made since the previous one.
const CODEX_SHELL = /^(exec|exec_command|shell|local_shell|unified_exec|write_stdin|container\.exec)$/;
function codexCat(p) {
  const n = String(p.name || '');
  if (n === 'apply_patch') {
    const files = [...String(p.input || p.arguments || '').matchAll(/\*\*\* (?:Update|Add) File: ([^\n\\]+)/g)].map(m => m[1].trim());
    return files.length && files.every(f => DOC_RE.test(f)) ? 'docs' : 'code';
  }
  if (CODEX_SHELL.test(n)) return 'shell';
  if (/spawn|agent/i.test(n)) return 'delegate';
  if (/read|search|list|grep|view|find/i.test(n) || p.type === 'web_search_call') return 'explore';
  return 'tools';
}
const CTOT = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'];
function applyCodexLine(line, st) {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (!e || typeof e !== 'object') return;
  const p = e.payload || {}, ts = e.timestamp, day = hourOf(ts);
  if (ts) { st.last = ts; if (!st.first) st.first = ts; }
  if (typeof p.cwd === 'string' && !st.cwd) st.cwd = p.cwd;
  if (e.type === 'session_meta') {
    if (typeof p.id === 'string') st.codexId = clean(p.id);
    const sp = p.source && p.source.subagent && p.source.subagent.thread_spawn;
    if (sp && typeof sp.parent_thread_id === 'string') {
      st.parent = clean(sp.parent_thread_id);
      st.agentName = `codex:${clean(sp.agent_role || sp.agent_nickname || 'subagent')}`;
    }
    return;
  }
  if (e.type === 'turn_context') { if (typeof p.model === 'string') st.model = clean(p.model); return; }
  if (!day) return;
  if (e.type === 'compacted') { dayB(st, day).comp[0]++; st.compacts++; return; }
  if (e.type === 'response_item') {
    if (p.type === 'message') {
      st.count++;
      const t = Array.isArray(p.content) ? (p.content.find(c => c && typeof c.text === 'string') || {}).text : null;
      // Codex injects AGENTS.md and environment blocks as user messages; the title is the first real one.
      if (p.role === 'user' && !st.summary && t && !/^\s*(#|<)/.test(t)) st.summary = t.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CAP);
    } else if (/call$/.test(p.type || '')) {
      const cat = codexCat(p), b = dayB(st, day), model = st.model || 'codex';
      if (!st.pendCat || CAT_RANK[cat] > CAT_RANK[st.pendCat]) st.pendCat = cat;
      if (cat === 'shell' || cat === 'code' || cat === 'docs') b.exec[model] = (b.exec[model] || 0) + 1;
      else if (cat === 'explore') b.expl[model] = (b.expl[model] || 0) + 1;
      if (cat === 'code' || cat === 'docs') b.edits++;
      if (cat === 'shell' && COMMIT_RE.test(String(p.arguments || p.input || ''))) b.commits++;
    }
    return;
  }
  if (e.type !== 'event_msg') return;
  if (p.type === 'task_started') { dayB(st, day).prompts++; return; }
  if (p.type !== 'token_count' || !p.info || !p.info.total_token_usage) return;
  const t = p.info.total_token_usage, prev = st.ctot || [0, 0, 0, 0];
  const cur = CTOT.map(k => n0(t[k]));
  let d = cur.map((v, i) => v - prev[i]);
  if (d.some(v => v < 0)) d = cur;               // totals restarted (new process or compaction)
  st.ctot = cur;
  if (!d.some(v => v > 0)) return;              // repeated event, no new request
  const model = st.model || 'codex', rec = [Math.max(0, d[0] - d[1] - d[2]), d[1], d[2], 0, d[3]];
  const b = dayB(st, day), cat = st.pendCat || 'talk';
  st.pendCat = null;
  const add = o => { const x = o[model] || (o[model] = [0, 0, 0, 0, 0, 0]); for (let i = 0; i < 5; i++) x[i] += rec[i]; x[5]++; };
  add(b.u); add(b.o.codex || (b.o.codex = {})); add(b.k[cat] || (b.k[cat] = {}));
  if (!st.base) st.base = d[0];
}
const codexHome = () => process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(HOME, '.codex');
const CODEX_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// --- incremental file read ---
// Append-only transcripts resume at the last indexed byte, keyed by a head hash
// (dev:ino + first 4KB) so a replaced file re-indexes from zero.
function headHash(fd, stat) {
  const n = Math.min(HEAD_BYTES, stat.size);
  if (n === 0) return '';
  const buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, 0);
  return crypto.createHash('sha1').update(`${stat.dev}:${stat.ino}:`).update(buf).digest('hex');
}

function indexFile(fp, st8, prev, apply = applyLine) {
  let fd;
  try { fd = fs.openSync(fp, 'r'); } catch { return null; }
  try {
    const hh = headHash(fd, st8);
    const resume = prev && prev.headHash === hh && Number.isSafeInteger(prev.indexedBytes)
      && prev.indexedBytes > 0 && prev.indexedBytes <= st8.size;
    const st = resume ? { ...emptyState(), ...prev.state } : emptyState();
    let pos = resume ? prev.indexedBytes : 0;
    const buf = Buffer.alloc(1 << 20);
    let carry = Buffer.alloc(0); // raw bytes after the last newline, never decoded early
    let consumed = pos;
    while (pos < st8.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st8.size - pos), pos);
      if (n <= 0) break;
      const chunk = Buffer.concat([carry, buf.subarray(0, n)]);
      let start = 0;
      for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, start)) {
        if (i > start) apply(chunk.toString('utf8', start, i), st);
        start = i + 1;
      }
      carry = Buffer.from(chunk.subarray(start));
      pos += n;
      consumed = pos - carry.length; // raw byte arithmetic, immune to a split UTF-8 char
    }
    // A trailing no-newline line is shown but not persisted: indexedBytes excludes it,
    // so caching it would double-apply it on the next resume. Deep copy: applyLine
    // mutates nested buckets.
    let disp = st;
    if (carry.length) { disp = JSON.parse(JSON.stringify(st)); apply(carry.toString('utf8'), disp); }
    return { headHash: hh, indexedBytes: consumed, state: st, disp };
  } catch { return null; }
  finally { try { fs.closeSync(fd); } catch {} }
}

function indexCached(fp, cache, minSize, apply) {
  let st8;
  try { st8 = fs.statSync(fp); } catch { return null; }
  if (st8.size < minSize) { delete cache[fp]; return null; }
  const prev = cache[fp];
  // Untouched since last scan: free. Serve the display state so counts never
  // flicker between an indexing run and a fast-path run.
  if (prev && prev.mtimeMs === st8.mtimeMs && prev.size === st8.size) return { st8, state: prev.disp || prev.state, agent: prev.agent };
  const idx = indexFile(fp, st8, prev, apply);
  if (!idx) return null;
  // Subagents record their type beside the transcript.
  const agent = minSize === 1 ? clean((readJson(fp.replace(/\.jsonl$/, '.meta.json'), {}) || {}).agentType) || 'unknown' : undefined;
  cache[fp] = { mtimeMs: st8.mtimeMs, size: st8.size, headHash: idx.headHash, indexedBytes: idx.indexedBytes, state: idx.state, disp: idx.disp, agent };
  return { st8, state: idx.disp, agent };
}

function loadCache(reindex) {
  if (reindex) return {};
  const c = readJson(FILES.cache, null);
  return c && c.v === CACHE_V && c.files ? c.files : {};
}

/** Every top-level session, with its subagent transcripts' states attached. */
function scan({ reindex = false, projFilter = null } = {}) {
  const cache = loadCache(reindex);
  const rs = roots();
  if (!rs.length) throw new Error(`no ${path.join(HOME, '.claude', 'projects')}`);
  const out = [];
  for (const root of rs) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      // Lossy fallback only: '_' and '-' both encode to '-'. The transcript's own
      // cwd is authoritative once indexed.
      const decoded = d.replace(/^-/, '/').replace(/-/g, '/');
      if (projFilter && !decoded.toLowerCase().replace(/\//g, '-').includes(projFilter.toLowerCase().replace(/[/_]/g, '-'))) continue;
      const dir = path.join(root, d);
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const fp = path.join(dir, f), id = f.slice(0, -6);
        const main = indexCached(fp, cache, 200);
        if (!main) continue;
        const subs = [], subAgents = [];
        const sdir = path.join(dir, id, 'subagents');
        let sf = [];
        try { sf = fs.readdirSync(sdir).filter(x => x.endsWith('.jsonl')); } catch {}
        for (const x of sf) { const r = indexCached(path.join(sdir, x), cache, 1); if (r) { subs.push(r.state); subAgents.push(r.agent || 'unknown'); } }
        out.push({ id, dirName: d, decoded, file: fp, mtime: main.st8.mtimeMs, size: main.st8.size, state: main.state, subs, subAgents, harness: 'claude' });
      }
    }
  }
  // Codex keeps sessions by date, not project; each carries its own cwd. Subagent
  // threads are separate rollouts that name their parent, so they attach to it.
  const cx = [];
  for (const [base, label] of [[path.join(codexHome(), 'sessions'), 'codex'], [path.join(codexHome(), 'archived_sessions'), 'codex/archived']]) {
    let files = [];
    try { files = fs.readdirSync(base, { recursive: true }).filter(f => /rollout-.*\.jsonl$/.test(f)); } catch {}
    for (const rel of files) {
      const fp = path.join(base, rel), r = indexCached(fp, cache, 200, applyCodexLine);
      if (!r || !r.state) continue;
      const id = r.state.codexId || (CODEX_ID.exec(rel) || [])[1] || rel;
      const dirName = path.join(label, path.dirname(rel)).replace(/\/\.$/, '');
      if (projFilter && !String(r.state.cwd || '').toLowerCase().includes(projFilter.toLowerCase())) continue;
      cx.push({ id, dirName, decoded: clean(r.state.cwd) || dirName, file: fp, mtime: r.st8.mtimeMs, size: r.st8.size, state: r.state, subs: [], subAgents: [], harness: 'codex' });
    }
  }
  // Codex keeps thread titles (its automatic name and any /rename) outside the rollout,
  // as appended { id, thread_name } records; the newest one for an id wins.
  const titles = new Map();
  try {
    for (const l of fs.readFileSync(path.join(codexHome(), 'session_index.jsonl'), 'utf8').split('\n')) {
      try { const r = JSON.parse(l); if (r && typeof r.id === 'string' && typeof r.thread_name === 'string') titles.set(r.id, clean(r.thread_name)); } catch {}
    }
  } catch {}
  for (const x of cx) if (titles.has(x.id)) x.title = titles.get(x.id);
  const byId = new Map(cx.map(x => [x.id, x]));
  for (const x of cx) {
    const parent = x.state.parent && byId.get(x.state.parent);
    if (parent && parent !== x) { parent.subs.push(x.state); parent.subAgents.push(x.state.agentName || 'codex:subagent'); }
    else out.push(x);
  }
  for (const k of Object.keys(cache)) if (!fs.existsSync(k)) delete cache[k];
  try { writePrivate(FILES.cache, JSON.stringify({ v: CACHE_V, files: cache })); } catch {}
  return out;
}

// --- session metadata (name, star, archived, project, label) ---
const loadMeta = () => readJson(FILES.meta, {}) || {};
const saveMeta = m => writePrivate(FILES.meta, JSON.stringify(m, null, 1) + '\n');

// --- projects: folders mapped in ~/.puffr/projects.json, else the git root's name;
// then `aliases` (case-insensitive) fold renamed or duplicate names into one ---
function loadProjects(withRules = true) {
  const p = readJson(FILES.projects, {}) || {};
  const map = [];
  for (const [name, paths] of Object.entries(p.projects || {})) {
    for (const x of [].concat(paths)) if (typeof x === 'string') map.push([path.resolve(x.replace(/^~(?=\/|$)/, HOME)), clean(name)]);
  }
  map.sort((a, b) => b[0].length - a[0].length);
  map.aliases = {};
  // Report customizations add aliases underneath; anything in projects.json wins.
  // A rename can leave a repeated segment ("Abunaico/Abunai" → "Abunaico/Abunaico"); fold it into one.
  const fold = n => clean(n).split('/').filter((x, i, a) => !i || x.toLowerCase() !== a[i - 1].toLowerCase()).join('/');
  if (withRules) for (const [from, to] of Object.entries(loadReportRules().project_aliases || {})) map.aliases[from.toLowerCase()] = fold(to);
  for (const [from, to] of Object.entries(p.aliases || {})) if (typeof to === 'string') map.aliases[from.toLowerCase()] = clean(to);
  return map;
}

// --- report customizations: plain-English rules in ~/.puffr/report-prompt.md, turned
// into a fixed set of edits by Haiku and applied in code. Haiku sees the rules and the
// names it may change (projects, tags; accounts only if the rules mention them), never
// transcripts. Its answer is checked against those names; the result is cached until
// the rules change. ---
const PROMPT_TEMPLATE = `<!--
puffr report customizations. Write rules in plain English below, one per line, e.g.
  abunai is the same as abunaico; show it as Abunaico
  hide the scratchpad project
  call the gmail account "Personal"
Haiku turns them into project and tag renames, account labels, and hidden projects
the next time a report runs (needs: puffr-config set model.haiku on). Lines inside
these comment markers are ignored. This file ships empty.
-->
`;
function reportPromptText() {
  let t = '';
  try { t = fs.readFileSync(FILES.reportPrompt, 'utf8'); } catch { try { writePrivate(FILES.reportPrompt, PROMPT_TEMPLATE); } catch {} }
  return t.replace(/<!--[\s\S]*?-->/g, '').trim();
}
function addReportRule(line) {
  reportPromptText();
  fs.appendFileSync(FILES.reportPrompt, `${clean(line).trim()}\n`);
}
const loadReportRules = () => ((readJson(FILES.reportRules, {}) || {}).rules) || {};
function compileReportRules(names, { force = false } = {}) {
  const text = reportPromptText();
  if (!text) return { rules: {}, status: 'empty' };
  const hash = crypto.createHash('sha1').update(text).digest('hex');
  const cached = readJson(FILES.reportRules, null);
  if (cached && cached.hash === hash && !force) return { rules: cached.rules || {}, status: 'cached', lines: text.split('\n').length };
  if (readConfig()['model.haiku'] !== 'on') return { rules: (cached && cached.rules) || {}, status: 'haiku-off' };
  const lists = { projects: names.projects, tags: names.tags };
  if (/account|email|login|plan|personal|work/i.test(text)) lists.accounts = names.accounts;
  const prompt = 'Turn these report customization rules into JSON edits for a usage report.\n'
    + 'Allowed keys (all optional): "project_aliases": {"<existing project name>": "<display name>"}, '
    + '"tag_aliases": {"<existing tag>": "<display tag>"}, "account_labels": {"<existing account>": "<display label>"}, '
    + '"hide_projects": ["<existing project name>"].\n'
    + 'Keys and hidden names must be copied exactly from the lists below. Apply each rule to every name it covers, '
    + 'including nested names like "Parent/child" when the rule is about the parent. Ignore rules you cannot express. Reply with only the JSON object.\n\n'
    + Object.entries(lists).map(([k, v]) => `${k}:\n${v.map(x => `- ${x}`).join('\n')}`).join('\n\n')
    + `\n\nrules:\n${text}`;
  const bin = process.env.PUFFR_CLAUDE || (process.env.CLAUDE_CODE_EXECPATH && fs.existsSync(process.env.CLAUDE_CODE_EXECPATH) ? process.env.CLAUDE_CODE_EXECPATH : 'claude');
  const r = require('child_process').spawnSync(bin, ['-p', '--model', 'haiku', '--no-session-persistence', '--tools', '',
    '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--output-format', 'json',
    '--system-prompt', 'You convert report customization rules into JSON edits. Output JSON only.'],
  { input: prompt, encoding: 'utf8', timeout: 120000, cwd: os.tmpdir(), env: { ...process.env, PUFFR_AUTONAME_CHILD: '1' } });
  if (r.status !== 0) return { rules: (cached && cached.rules) || {}, status: 'failed' };
  let out, raw;
  try { out = JSON.parse(r.stdout); raw = JSON.parse(String(out.result).replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { return { rules: (cached && cached.rules) || {}, status: 'failed' }; }
  // Only names that exist, only the four edit kinds, short plain-text values.
  const pick = (map, known) => {
    const byLower = new Map((known || []).map(n => [n.toLowerCase(), n])), o = {};
    for (const [k, v] of Object.entries(map && typeof map === 'object' ? map : {})) {
      const key = byLower.get(String(k).toLowerCase());
      if (key && typeof v === 'string' && clean(v).trim()) o[key] = clean(v).trim().slice(0, 60);
    }
    return o;
  };
  const known = new Set((names.projects || []).map(n => n.toLowerCase()));
  const rules = { project_aliases: pick(raw.project_aliases, names.projects), tag_aliases: pick(raw.tag_aliases, names.tags),
    account_labels: pick(raw.account_labels, lists.accounts), hide_projects: (Array.isArray(raw.hide_projects) ? raw.hide_projects : [])
      .filter(n => typeof n === 'string' && known.has(n.toLowerCase())).map(n => names.projects.find(x => x.toLowerCase() === n.toLowerCase())) };
  for (const k of Object.keys(rules)) if (!Object.keys(rules[k]).length) delete rules[k];
  const usd = Number(out.total_cost_usd);
  writePrivate(FILES.reportRules, JSON.stringify({ hash, compiledAt: new Date().toISOString(), rules }, null, 1) + '\n');
  const sp = readJson(FILES.spend, {}) || {}, h = sp.haiku || { usd: 0, calls: 0 };
  sp.haiku = { usd: h.usd + (Number.isFinite(usd) ? usd : 0), calls: h.calls + 1 };
  writePrivate(FILES.spend, JSON.stringify(sp, null, 1) + '\n');
  return { rules, status: 'compiled', usd };
}
const rootMemo = new Map();
function gitRoot(dir) {
  if (rootMemo.has(dir)) return rootMemo.get(dir);
  let d = dir.replace(/\/\.(claude\/)?worktrees\/.*$/, ''), r = null;
  while (d && d !== '/' && d !== HOME) {
    if (fs.existsSync(path.join(d, '.git'))) { r = d; break; }
    d = path.dirname(d);
  }
  rootMemo.set(dir, r);
  return r;
}
// A project folder is a session's git root (or its cwd) or a mapped folder. One
// nested inside another is named Parent/child. Drive roots and home (depth < 3)
// are never parents. Aliases apply to the full name at every level.
function projectNamer(cwds, pmap) {
  const alias = n => (pmap.aliases || {})[n.toLowerCase()] || n;
  // On a case-insensitive disk one folder can arrive as Client and client; use the on-disk case.
  const canonMemo = new Map();
  const canon = d => {
    if (!canonMemo.has(d)) { let r = d; try { r = fs.realpathSync.native(d); } catch {} canonMemo.set(d, r); }
    return canonMemo.get(d);
  };
  const folderOf = cwd => canon(gitRoot(cwd) || cwd.replace(/\/\.(claude\/)?worktrees\/.*$/, ''));
  const mapped = new Map(pmap.map(([p, n]) => [canon(p), n]));
  const folders = new Set([...cwds.filter(Boolean).map(folderOf), ...mapped.keys()]);
  const memo = new Map();
  function nameOf(dir) {
    if (memo.has(dir)) return memo.get(dir);
    let parent = null;
    if (!mapped.has(dir)) for (let d = path.dirname(dir); d.split('/').length > 3; d = path.dirname(d)) if (folders.has(d)) { parent = d; break; }
    const n = alias(mapped.has(dir) ? mapped.get(dir) : parent ? `${nameOf(parent)}/${path.basename(dir)}` : path.basename(dir) || dir);
    memo.set(dir, n);
    return n;
  }
  return (cwd, assigned) => assigned ? alias(clean(assigned)) : cwd ? nameOf(folderOf(cwd)) : '?';
}

// --- prices: $/MTok [input, output, cache read]; cache writes are 1.25× (5m) / 2× (1h) input ---
// Anthropic first-party list prices. Unknown models fall back by family, marked estimated.
const PRICES = [
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25, true],
  [/fable|mythos/, 10, 50, 1, true],
  [/opus-5-5/, 4, 20, 0.2, true],
  [/opus-(5|4-[5-8])/, 5, 25, 0.5, true],
  [/sonnet-5-5/, 2, 10, 0.1, true],
  [/sonnet-5/, 2, 10, 0.2, true],
  [/sonnet-4-[5-6]/, 3, 15, 0.3, true],
  [/haiku-4-5/, 1, 5, 0.1, true],
  [/opus/, 5, 25, 0.5, false],
  [/sonnet/, 3, 15, 0.3, false],
  [/haiku/, 1, 5, 0.1, false],
];
// ~/.puffr/prices.json adds or overrides $/MTok per model (exact name or prefix), e.g. for
// Codex models: {"models": {"<model>": {"input": <$/MTok>, "cached": <$/MTok>, "output": <$/MTok>}}}.
// puffr ships no OpenAI prices: models without one count tokens and show as unpriced.
let userPrices;
function price(model) {
  if (userPrices === undefined) {
    const m = (readJson(FILES.prices, {}) || {}).models || {};
    userPrices = Object.entries(m).filter(([, v]) => v && Number.isFinite(+v.input) && Number.isFinite(+v.output)).sort((a, b) => b[0].length - a[0].length);
  }
  for (const [k, v] of userPrices) if (model === k || model.startsWith(k)) return { i: +v.input, o: +v.output, r: Number.isFinite(+v.cached) ? +v.cached : +v.input / 10, listed: false, user: true };
  for (const [re, i, o, r, listed] of PRICES) if (re.test(model)) return { i, o, r, listed };
  return null;
}
function costOf(model, u) {
  const p = price(model);
  if (!p) return 0;
  return (u[0] * p.i + u[1] * p.r + u[2] * p.i * 1.25 + u[3] * p.i * 2 + u[4] * p.o) / 1e6;
}
// What a cache rewrite cost beyond reading the same tokens from cache.
function rewriteCost(model, w5, w1h) {
  const p = price(model);
  return p ? (w5 * (p.i * 1.25 - p.r) + w1h * (p.i * 2 - p.r)) / 1e6 : 0;
}

// Main transcript and its subagents, one day bucket at a time.
function eachDay(rec, fn) {
  [rec.state, ...rec.subs].forEach((st, i) => {
    for (const [d, b] of Object.entries(st.days || {})) fn(d, b, i === 0, i === 0 ? null : (rec.subAgents || [])[i - 1] || 'unknown');
  });
}
function sessionCost(rec) {
  let usd = 0;
  eachDay(rec, (d, b) => { for (const [m, u] of Object.entries(b.u)) usd += costOf(m, u); });
  return usd;
}

// Claude Code deletes transcripts after cleanupPeriodDays (default 30).
function cleanupDays() {
  let days = 30;
  const dirs = [path.join(HOME, '.claude')];
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(process.env.CLAUDE_CONFIG_DIR);
  for (const d of dirs) { const v = n0((readJson(path.join(d, 'settings.json'), {}) || {}).cleanupPeriodDays); if (v) days = v; }
  return days;
}

// --- Claude Code logins: the default config, $CLAUDE_CONFIG_DIR, ~/.aimux/profiles/*,
// ~/.claude-profiles/*, and $PUFFR_PROFILE_DIRS (a profile dir or a dir of them) ---
function profiles() {
  const dirs = new Map();
  const add = (d, label) => { const r = path.resolve(d); if (!dirs.has(r) && fs.existsSync(path.join(r, '.claude.json'))) dirs.set(r, label); };
  const addParent = p => { try { for (const n of fs.readdirSync(p).sort()) add(path.join(p, n), n); } catch {} };
  add(HOME, 'default');
  if (process.env.CLAUDE_CONFIG_DIR) add(process.env.CLAUDE_CONFIG_DIR, path.basename(process.env.CLAUDE_CONFIG_DIR));
  addParent(path.join(HOME, '.aimux', 'profiles'));
  addParent(path.join(HOME, '.claude-profiles'));
  for (const p of (process.env.PUFFR_PROFILE_DIRS || '').split(':').filter(Boolean)) {
    if (fs.existsSync(path.join(p, '.claude.json'))) add(p, path.basename(p)); else addParent(p);
  }
  return [...dirs].map(([dir, label]) => ({ dir, label, cfg: readJson(path.join(dir, '.claude.json'), {}) || {} }));
}
// org uuid → account label, plus each profile's last session per project as a
// fallback for transcripts older than Claude Code's credential_org record.
function accounts() {
  const byOrg = {}, bySession = {};
  const PLAN = { claude_max: 'Max', claude_pro: 'Pro', claude_team: 'Team', claude_enterprise: 'Enterprise' };
  for (const { label, cfg } of profiles()) {
    const oa = cfg.oauthAccount || {}, org = clean(oa.organizationUuid);
    if (!org) continue;
    const tier = /max_(\d+x)/.exec(oa.organizationRateLimitTier || '');
    const plan = (PLAN[oa.organizationType] || clean(oa.organizationType).replace(/^claude_/, '') || '?') + (tier ? ` ${tier[1]}` : '');
    const name = clean(oa.organizationName);
    const a = byOrg[org] || (byOrg[org] = { org, email: clean(oa.emailAddress), plan, orgName: /'s Organization$/.test(name) ? '' : name, profiles: [] });
    a.profiles.push(clean(label));
    for (const p of Object.values(cfg.projects || {})) if (p && typeof p.lastSessionId === 'string') bySession[p.lastSessionId] = org;
  }
  return { byOrg, bySession };
}
const accountLabel = a => a ? `${a.email} (${a.plan}${a.orgName ? `, ${a.orgName}` : ''})` : 'unknown (before Claude Code recorded the account)';

// --- config: `key=value` lines; features are on unless `=off` ---
function readConfig() {
  const out = {};
  let txt = '';
  try { txt = fs.readFileSync(FILES.config, 'utf8'); } catch { return out; }
  for (const line of txt.split('\n')) {
    const m = /^\s*([a-z.]+)\s*=\s*([a-z]+)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

module.exports = {
  HOME, DIR, FILES, clean, n0, dayOf, hourOf, readJson, writePrivate, usageRec,
  roots, scan, loadMeta, saveMeta, loadProjects, projectNamer, price, costOf, rewriteCost, readConfig,
  eachDay, sessionCost, cleanupDays, profiles, accounts, accountLabel,
  gitRoot, PUFFR_ROOT: path.join(__dirname, '..'), codexHome,
  reportPromptText, addReportRule, loadReportRules, compileReportRules,
};
