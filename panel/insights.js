// Haiku-written workflow insights for the puffr panels. Haiku sees a compact
// summary built from puffr-burn --json (7 days) and puffr-sessions --json, never
// transcripts. Gated by model.haiku=on, cached in ~/.puffr/insights.json for an
// hour, and counted in puffr's existing spend.json haiku tally.
'use strict';
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const puffr = require('../lib/puffr');
const { env, puffrBin } = require('./env');

const CACHE_FILE = require('path').join(puffr.DIR, 'insights.json');
const TTL_MS = 60 * 60 * 1000;
let inflight = null;

function runJson(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 60000, maxBuffer: 50 * 1024 * 1024, env: env() }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

function readCache() {
  return puffr.readJson(CACHE_FILE, null);
}

function top(obj, key, n) {
  return Object.entries(obj || {})
    .sort((a, b) => ((b[1] && b[1][key]) || 0) - ((a[1] && a[1][key]) || 0))
    .slice(0, n);
}

function buildSummary(burn, sessions) {
  const A = burn.A || {};
  return {
    period: `${A.from} to ${A.to} (${A.days} days)`,
    total_usd: Number((A.usd || 0).toFixed(2)),
    sessions: A.sessions,
    requests: A.reqs,
    models: top(A.models, 'usd', 6).map(([m, v]) => ({ model: m, usd: Number((v.usd || 0).toFixed(2)) })),
    projects: top(A.projects, 'usd', 8).map(([p, v]) => ({
      project: p, usd: Number((v.usd || 0).toFixed(2)), sessions: v.sessions,
      opus_exec_turns: v.opusExec, exec_turns: v.exec, cache_restore_usd: Number((v.restoreUsd || 0).toFixed(2)),
    })),
    rule_insights: (burn.insights || []).map(i => ({
      title: i.title, monthly_saving_usd: Math.round(i.save || 0), detail: i.detail, action: i.action,
    })),
    practices: burn.practices || null,
    recent_sessions: (Array.isArray(sessions) ? sessions : []).slice(0, 15).map(s => ({
      project: s.projectName, messages: s.messages, usd: s.cost, title: String(s.title || '').slice(0, 80),
    })),
  };
}

// Keep this short: a longer list of constraints made Haiku deliberate past the
// timeout on real data, while this version answers in about 20s.
const SYSTEM = 'You review Claude Code usage summaries. Output JSON only.';
const INSTRUCTIONS = 'Write 3 to 5 workflow tips as a JSON array of {title, pattern, action} from this Claude Code '
  + 'usage summary. Name the projects each tip applies to and quote numbers only from the summary.\n\n';

function askHaiku(prompt) {
  return new Promise(resolve => {
    const bin = process.env.PUFFR_CLAUDE || 'claude';
    const child = spawn(bin, ['-p', '--model', 'haiku', '--no-session-persistence', '--tools', '',
      '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--output-format', 'json',
      '--system-prompt', SYSTEM], { cwd: os.tmpdir(), env: { ...env(), PUFFR_AUTONAME_CHILD: '1' } });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 150000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true, out });
      resolve({ ok: false, error: timedOut ? 'Haiku timed out after 150s' : `claude exited ${code}: ${err.trim().slice(0, 200)}` });
    });
    child.stdin.end(prompt);
  });
}

const str = (v, max) => puffr.clean(typeof v === 'string' ? v : '').trim().slice(0, max);

function parseItems(stdout) {
  const outer = JSON.parse(stdout);
  const text = String(outer.result || '');
  const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  const items = (Array.isArray(arr) ? arr : []).slice(0, 5)
    .map(i => ({ title: str(i && i.title, 80), pattern: str(i && i.pattern, 400), action: str(i && i.action, 300) }))
    .filter(i => i.title && i.action);
  return { items, usd: Number(outer.total_cost_usd) };
}

function recordSpend(usd) {
  const sp = puffr.readJson(puffr.FILES.spend, {}) || {};
  const h = sp.haiku || { usd: 0, calls: 0 };
  sp.haiku = { usd: h.usd + (Number.isFinite(usd) ? usd : 0), calls: h.calls + 1 };
  puffr.writePrivate(puffr.FILES.spend, JSON.stringify(sp, null, 1) + '\n');
}

async function generate(bins) {
  const [burn, sessions] = await Promise.all([
    runJson(puffrBin('puffr-burn', bins.burn), ['--days', '7', '--json']),
    runJson(puffrBin('puffr-sessions', bins.sessions), ['--json']).catch(() => []),
  ]);
  const r = await askHaiku(INSTRUCTIONS + JSON.stringify(buildSummary(burn, sessions)));
  if (!r.ok) return { ...(readCache() || {}), status: 'failed', error: r.error };
  let parsed;
  try { parsed = parseItems(r.out); } catch (e) { return { ...(readCache() || {}), status: 'failed', error: `unparseable reply: ${e.message}` }; }
  recordSpend(parsed.usd);
  const result = { generatedAt: new Date().toISOString(), items: parsed.items, usd: parsed.usd };
  puffr.writePrivate(CACHE_FILE, JSON.stringify(result, null, 1) + '\n');
  return { status: 'fresh', ...result };
}

// Returns cached insights when fresh; regenerates when stale or forced.
// When regeneration is already running, callers share that one Haiku call.
async function getInsights({ bins = {}, force = false, allowGenerate = true } = {}) {
  const cached = readCache();
  if (puffr.readConfig()['model.haiku'] !== 'on') return { status: 'haiku-off', ...(cached || {}) };
  const age = cached && cached.generatedAt ? Date.now() - Date.parse(cached.generatedAt) : Infinity;
  if (!force && age < TTL_MS) return { status: 'cached', ...cached };
  if (!allowGenerate) return { status: cached ? 'stale' : 'none', ...(cached || {}) };
  if (!inflight) inflight = generate(bins).finally(() => { inflight = null; });
  return inflight;
}

module.exports = { getInsights };
