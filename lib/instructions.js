'use strict';
// What your always-on instructions cost, per file. Reads session transcripts and counts only
// what the model actually received: attachments carrying a `rendered` payload (CLAUDE.md and
// rules files, memory, hook output injected as context, skill/agent/MCP listings). Hook runs
// that never reach the model (PreToolUse, most PostToolUse) are not counted.
//
// A block that enters the context is re-read on every later request in that session, until a
// compaction clears it, so its cost is size × requests carried at that model's cache-read price,
// plus one cache write when it arrives. Tokens are ≈ chars / 4. Builtins only, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./puffr');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const ROOT = path.join(CONFIG_DIR, 'projects');
const HOME = os.homedir();
const tilde = p => String(p || '').replace(HOME, '~');
const tok = s => Math.round(String(s || '').length / 4);
const renderedText = o => (Array.isArray(o.rendered) ? o.rendered.map(r => (r && r.content) || '').join('') : '');

// One context block → { key, kind, label, tokens }. null when it isn't an instruction source.
function blocksOf(o) {
  const a = o.attachment || {};
  if (!Array.isArray(o.rendered) || !o.rendered.length) return [];
  switch (a.type) {
    case 'instructions':
      return (a.files || []).map(f => ({ key: `file:${f.path}`, kind: (f.type || 'file').toLowerCase(), label: tilde(f.path), tokens: tok(f.content) }));
    case 'nested_memory':
      return [{ key: `file:${a.path}`, kind: 'nested', label: tilde(a.path), tokens: tok(renderedText(o)) }];
    case 'hook_success':
    case 'hook_additional_context': {
      const cmd = String(a.command || '').replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/?/g, '').trim();
      const script = cmd ? path.basename(cmd.split(/\s+/).pop()) : '';
      const label = `${a.hookEvent || 'hook'} hook${script ? ` · ${script}` : ''}`;
      return [{ key: `hook:${label}`, kind: 'hook', label, tokens: tok(renderedText(o)) }];
    }
    case 'skill_listing':
      return [{ key: 'listing:skills', kind: 'listing', label: `skill listing${a.skillCount ? ` (${a.skillCount} skills)` : ''}`, tokens: tok(renderedText(o)) }];
    case 'agent_listing_delta':
      return [{ key: 'listing:agents', kind: 'listing', label: 'agent listing', tokens: tok(renderedText(o)) }];
    case 'mcp_instructions_delta':
      return [{ key: 'listing:mcp', kind: 'listing', label: 'MCP server instructions', tokens: tok(renderedText(o)) }];
    default:
      return [];
  }
}

function transcripts({ days, project }) {
  const since = Date.now() - days * 864e5, out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT); } catch { return out; }
  const want = project ? project.toLowerCase().replace(/[/_.]/g, '-') : null;
  for (const d of dirs) {
    if (want && !d.toLowerCase().includes(want)) continue;
    const walk = (dir, depth) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 2) walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch {}
        }
      }
    };
    walk(path.join(ROOT, d), 0);
  }
  return out;
}

function eachLine(fp, fn) {
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let carry = Buffer.alloc(0), n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const chunk = Buffer.concat([carry, buf.subarray(0, n)]);
      let start = 0;
      for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, start)) {
        if (i > start) fn(chunk.toString('utf8', start, i));
        start = i + 1;
      }
      carry = Buffer.from(chunk.subarray(start));
    }
    if (carry.length) fn(carry.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function analyze({ days = 30, project = null } = {}) {
  const rows = new Map();
  let requests = 0, sessions = 0, carriedUsd = 0;
  for (const fp of transcripts({ days, project })) {
    let active = [], sawAny = false;
    const seenMsg = new Set();
    const touched = new Set();
    eachLine(fp, line => {
      if (line.indexOf('"rendered"') < 0 && line.indexOf('"usage"') < 0 && line.indexOf('compact_boundary') < 0) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o.type === 'system' && o.subtype === 'compact_boundary') { active = []; return; }
      if (o.type === 'attachment') {
        for (const b of blocksOf(o)) {
          if (!b.tokens) continue;
          let r = rows.get(b.key);
          if (!r) rows.set(b.key, r = { key: b.key, kind: b.kind, label: b.label, tokens: 0, injections: 0, sessions: 0, carried: 0, usd: 0 });
          r.tokens = Math.max(r.tokens, b.tokens);
          r.injections++;
          if (!touched.has(b.key)) { touched.add(b.key); r.sessions++; }
          active.push({ row: r, tokens: b.tokens, fresh: true });
        }
        return;
      }
      const msg = o.message;
      if (o.type !== 'assistant' || !msg || !msg.usage || !msg.id || seenMsg.has(msg.id)) return;
      seenMsg.add(msg.id);
      requests++; sawAny = true;
      const p = F.price(String(msg.model || ''));
      if (!p) return;
      for (const b of active) {
        const usd = (b.tokens * p.r + (b.fresh ? b.tokens * (p.i * 1.25 - p.r) : 0)) / 1e6;
        b.fresh = false;
        b.row.carried++;
        b.row.usd += usd;
        carriedUsd += usd;
      }
    });
    if (sawAny) sessions++;
  }
  const scale = 30 / days;
  const list = [...rows.values()]
    .map(r => ({ ...r, usd: +r.usd.toFixed(4), monthlyUsd: +(r.usd * scale).toFixed(2) }))
    .sort((a, b) => b.usd - a.usd);
  return { days, project, sessions, requests, totalUsd: +carriedUsd.toFixed(2), monthlyUsd: +(carriedUsd * scale).toFixed(2), rows: list };
}

// One concrete suggestion per kind of source.
function adviceFor(r) {
  if (r.kind === 'hook') return r.injections > r.sessions * 2
    ? 'Runs on every prompt and stays in context. Inject only when it changes something, or shorten it.'
    : 'Trim what this hook injects, or move it to a skill that loads on demand.';
  if (r.kind === 'listing') return r.key === 'listing:skills'
    ? 'Every enabled skill is described up front. Disable plugins a project doesn\'t use, or set skillOverrides to name-only.'
    : 'Disable servers or agents a project doesn\'t use (project settings).';
  return r.tokens > 2000
    ? 'Keep this file a short map; move detail into skills or path-scoped rules (paths: frontmatter) that load only when needed.'
    : 'Small, but loaded every session: check it still earns its place.';
}

module.exports = { analyze, adviceFor };
