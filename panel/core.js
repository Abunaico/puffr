// Shared, host-agnostic rendering core for puffr's HTML panels.
// No dependency on vscode or any particular runtime — used by both the
// VS Code extension's webview (vscode-ext/dashboard.js) and the standalone
// local web server (panel/server.js). Read-only: shells out to existing
// puffr-* --json commands and renders what they already compute.
'use strict';
const { execFile } = require('child_process');
const insights = require('./insights');
const { env, puffrBin } = require('./env');
const theme = require('./theme');
const path = require('path');
const lib = require('../lib/puffr');

// The instruction-cost scan reads every transcript in the window (seconds, not ms), so it runs
// as a child process at most every 10 minutes and its last result is kept on disk.
const INSTR_FILE = path.join(lib.DIR, 'instructions.json');
const INSTR_TTL_MS = 10 * 60 * 1000;
let instrInflight = null;
function getInstructions(bin) {
  const cached = lib.readJson(INSTR_FILE, null);
  const age = cached && cached.at ? Date.now() - Date.parse(cached.at) : Infinity;
  if (age < INSTR_TTL_MS) return { status: 'cached', ...cached };
  if (!instrInflight) {
    instrInflight = run(bin, ['--days', '7', '--json'])
      .then(r => lib.writePrivate(INSTR_FILE, JSON.stringify({ at: new Date().toISOString(), ...r }) + '\n'))
      .catch(() => {})
      .finally(() => { instrInflight = null; });
  }
  return { status: cached ? 'refreshing' : 'measuring', ...(cached || {}) };
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 20000, maxBuffer: 20 * 1024 * 1024, env: env() }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtUsd(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function relTime(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

// bins: { burn, accounts, sessions, context } binary names/paths (default: on PATH)
// projectFilter: substring passed to puffr-context --project (e.g. a workspace path).
//   If omitted, falls back to the most recently active project from puffr-sessions.
// regenInsights: true forces a fresh Haiku call and waits for it (Regenerate
// button). Otherwise a stale cache kicks off a background regeneration and this
// render shows the cached copy, so the 20s poll never blocks on Haiku.
async function gatherData({ bins = {}, projectFilter = null, regenInsights = false } = {}) {
  const puffrBurn = puffrBin('puffr-burn', bins.burn);
  const puffrAccounts = puffrBin('puffr-accounts', bins.accounts);
  const puffrSessions = puffrBin('puffr-sessions', bins.sessions);
  const puffrContext = puffrBin('puffr-context', bins.context);
  bins = { burn: puffrBurn, sessions: puffrSessions };

  const [burn, burnWeek, accounts, sessions, ai] = await Promise.allSettled([
    run(puffrBurn, ['--days', '1', '--json']),
    run(puffrBurn, ['--days', '7', '--json']),
    run(puffrAccounts, ['--json']),
    run(puffrSessions, ['--json']),
    insights.getInsights({ bins, force: regenInsights, allowGenerate: regenInsights }),
  ]);
  const aiValue = ai.status === 'fulfilled' ? ai.value : null;
  if (!regenInsights && aiValue && (aiValue.status === 'stale' || aiValue.status === 'none')) {
    insights.getInsights({ bins }).catch(() => {});
    aiValue.status = 'generating';
  }

  const sessionsList = sessions.status === 'fulfilled' ? sessions.value : null;
  let effectiveFilter = projectFilter;
  if (!effectiveFilter && Array.isArray(sessionsList) && sessionsList.length) {
    effectiveFilter = sessionsList[0].project; // most recently active
  }

  const settle = pr => pr.then(v => ({ status: 'fulfilled', value: v }), e => ({ status: 'rejected', reason: e }));
  const context = effectiveFilter
    ? await settle(run(puffrContext, ['--project', effectiveFilter, '--json']))
    : { status: 'rejected', reason: new Error('no project to show') };

  // Every open Claude session (puffr's --active rule: touched within the hour),
  // capped so a busy machine doesn't fan out dozens of lookups per refresh.
  const open = (Array.isArray(sessionsList) ? sessionsList : [])
    .filter(s => s.status !== 'idle' && (s.harness || 'claude') === 'claude').slice(0, 8);
  const openContexts = (await Promise.all(open.map(s =>
    run(puffrContext, [s.id, '--json']).then(v => ({ ...v, live: s.status === 'active', projectName: s.projectName, cost: s.cost }), () => null))))
    .filter(Boolean);
  if (projectFilter && context.status === 'fulfilled') {
    const ws = context.value, i = openContexts.findIndex(o => o.session === ws.session);
    const mine = { ...(i >= 0 ? openContexts.splice(i, 1)[0] : ws), workspace: true };
    openContexts.unshift(mine);
  }

  return {
    burn: burn.status === 'fulfilled' ? burn.value : null,
    ruleInsights: burnWeek.status === 'fulfilled' ? (burnWeek.value.insights || []) : null,
    monthlySpend: burnWeek.status === 'fulfilled' && burnWeek.value.A && burnWeek.value.A.days
      ? (burnWeek.value.A.usd / burnWeek.value.A.days) * 30 : null,
    ai: aiValue,
    accounts: accounts.status === 'fulfilled' ? accounts.value : null,
    sessions: sessionsList,
    context: context.status === 'fulfilled' ? context.value : null,
    openContexts,
    instructions: getInstructions(puffrBin('puffr-instructions', bins.instructions)),
    errors: [burn, burnWeek, accounts, sessions, context]
      .filter(r => r.status === 'rejected')
      .map(r => (r.reason && r.reason.message) || String(r.reason)),
  };
}

const k = n => { n = Number(n) || 0; return n < 1000 ? String(Math.round(n)) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`; };

function empty(text) {
  return `<p class="empty">${esc(text)}</p>`;
}

function renderKpis(A, data) {
  const tiles = [
    ['Spend today', A ? fmtUsd(A.usd) : '—', 'API list price, all projects'],
    ['Sessions', A ? A.sessions : '—', 'active today'],
    ['Requests', A ? Number(A.reqs).toLocaleString() : '—', 'model calls today'],
  ];
  const lever = Array.isArray(data.ruleInsights) && data.ruleInsights[0];
  if (lever) tiles.push(['Top lever', `≈${fmtUsd(lever.save)}/mo`, lever.title]);
  return `<div class="kpis">${tiles.map(([label, value, sub]) => `
    <div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div><div class="tile-sub">${esc(sub)}</div></div>`).join('')}
  </div>`;
}

function meterBlock(ctx) {
  const pct = Math.round((ctx.pct || 0) * 100);
  const ac = ctx.autocompactPct || 80;
  const state = pct >= ac ? 'critical' : pct >= ac - 20 ? 'warning' : 'ok';
  const badge = state === 'critical' ? `<span class="badge critical">🔥 near autocompact</span>`
    : state === 'warning' ? `<span class="badge warning">⚠ filling up</span>` : `<span class="badge ok">✓ room to work</span>`;
  const fill = state === 'ok' ? 'var(--meter)' : state === 'warning' ? 'var(--warn)' : 'var(--bad)';
  return `<div class="meter" title="${pct}% of ${k(ctx.window)} context window used; autocompact at ${ac}%">
      <div class="meter-fill" style="width:${Math.min(100, pct)}%;background:${fill}"></div>
      <div class="meter-mark" style="left:${ac}%"></div>
    </div>
    <div class="meter-row"><span><strong>${pct}%</strong> <span class="dim">${k(ctx.current)} / ${k(ctx.window)} tokens</span></span>${badge}</div>`;
}

function renderOpenSessions(list) {
  if (!Array.isArray(list) || !list.length) return card('Open sessions', empty('No Claude Code session active in the last hour.'));
  return card(`Open sessions · ${list.length}`, `<div class="open-grid">${list.map(o => {
    const ctx = o.context || {};
    const comp = Array.isArray(ctx.composition) ? [...ctx.composition].sort((a, b) => (b.tok || 0) - (a.tok || 0)).slice(0, 4) : [];
    const maxTok = Math.max(1, ...comp.map(c => c.tok || 0));
    const tag = o.workspace ? '<span class="chip here">this workspace</span>' : '';
    return `<div class="open-session${o.workspace ? ' mine' : ''}">
      <div class="ctx-title" title="${esc(o.cwd || '')}"><span class="dot ${o.live ? 'live' : ''}" aria-label="${o.live ? 'active' : 'recent'}"></span> ${esc(o.title || 'Untitled session')}</div>
      <div class="ctx-meta">${tag}<span class="chip">${esc(o.model || 'model?')}</span><span class="dim">${esc(o.projectName || o.cwd || '')}${Number.isFinite(o.cost) ? ` · ${fmtUsd(o.cost)}` : ''}</span></div>
      ${meterBlock(ctx)}
      ${comp.length ? `<details class="filling"><summary>What's filling it</summary><div class="bars">${comp.map(c => barRow(c.cat, (c.tok || 0) / maxTok, `≈${k(c.tok)}`, `${c.cat}: about ${k(c.tok)} tokens`)).join('')}</div></details>` : ''}
    </div>`;
  }).join('')}</div>`);
}

function barRow(label, frac, value, tip) {
  return `<div class="bar-row" title="${esc(tip)}">
    <div class="bar-label">${esc(label)}</div>
    <div class="bar-track"><div class="bar" style="width:${Math.max(1.5, frac * 100).toFixed(1)}%"></div></div>
    <div class="bar-value">${esc(value)}</div>
  </div>`;
}

// A lever's saving as a share of monthly spend (7-day spend scaled to 30 days,
// the same basis puffr-burn scales the savings to). Shares overlap like the
// savings do, so they don't sum to anything meaningful.
function pctBox(save, monthly) {
  if (!monthly || !(save > 0)) return '';
  const pct = (save / monthly) * 100;
  const shown = pct >= 10 ? Math.round(pct) : pct.toFixed(1);
  return `<span class="pct" title="≈${fmtUsd(save)} of ≈${fmtUsd(monthly)} monthly spend">${shown}% of spend</span>`;
}

function renderInsights(data) {
  const ai = data.ai || {};
  let aiHtml;
  if (ai.status === 'haiku-off') {
    aiHtml = empty('Haiku insights are off. Turn on with: puffr-config set model.haiku on');
  } else if (Array.isArray(ai.items) && ai.items.length) {
    const when = ai.generatedAt ? `${relTime(Date.parse(ai.generatedAt))} ago` : '';
    aiHtml = `<div class="insights">${ai.items.map(i => `
      <div class="insight">
        <div class="insight-title">${esc(i.title)}</div>
        ${i.pattern ? `<div class="insight-pattern">${esc(i.pattern)}</div>` : ''}
        <div class="insight-action"><span class="arrow">→</span>${esc(i.action)}</div>
      </div>`).join('')}</div>
      <div class="foot">Written by Haiku ${esc(when)}${ai.status === 'generating' ? ' · refreshing in background' : ''}${Number.isFinite(ai.usd) ? ` · ${fmtUsd(ai.usd)} per run` : ''} · suggestions, not measurements</div>`;
  } else if (ai.status === 'generating') {
    aiHtml = empty('Haiku is reading your usage patterns. They show up on a refresh in about a minute.');
  } else if (ai.status === 'failed') {
    aiHtml = empty(`Haiku call failed${ai.error ? `: ${ai.error}` : ''}. Try Regenerate.`);
  } else {
    aiHtml = empty('No Haiku insights yet.');
  }

  const rules = Array.isArray(data.ruleInsights) ? data.ruleInsights.slice(0, 5) : [];
  const rulesHtml = rules.length
    ? `<div class="levers">${rules.map(i => `
      <details class="lever">
        <summary><span class="lever-title">${esc(i.title)}</span><span class="pill">≈${fmtUsd(i.save)}/mo</span>${pctBox(i.save, data.monthlySpend)}</summary>
        <div class="insight-pattern">${esc(i.detail)}</div>
        <div class="insight-action"><span class="arrow">→</span>${esc(i.action)}</div>
      </details>`).join('')}</div>
      <div class="foot">Measured over the last 7 days, scaled to 30. % is the share of your monthly spend each lever would save. Savings overlap, so don't add them up.</div>`
    : empty('No measured levers for the last 7 days.');

  return card('Insights', `
    <div class="sub-head row"><span>Patterns · Haiku</span><button class="ghost" onclick="regen()">↻ Regenerate</button></div>
    ${aiHtml}
    <div class="sub-head">Biggest levers · measured</div>
    ${rulesHtml}`);
}

function renderInstructions(ins) {
  const title = 'Instructions · always-on cost';
  if (!ins || (!Array.isArray(ins.rows) && ins.status === 'measuring')) return card(title, empty('Measuring what your CLAUDE.md files, rules, hooks, and listings cost… shows up on a refresh.'));
  const rows = (ins.rows || []).slice(0, 6);
  if (!rows.length) return card(title, empty('No instruction sources found in the last 7 days.'));
  const max = Math.max(...rows.map(r => r.monthlyUsd || 0), 0.01);
  const short = r => r.kind === 'hook' || r.kind === 'listing' ? r.label : r.label.split('/').slice(-2).join('/');
  const lead = rows[0];
  return card(title, `
    <div class="instr-head"><span class="instr-total">≈${fmtUsd(ins.monthlyUsd)}/mo</span>
      <span class="dim">re-read on every request · ${esc(ins.sessions)} sessions, last 7 days${ins.status === 'refreshing' ? ' · refreshing' : ''}</span></div>
    <div class="bars">${rows.map(r => barRow(short(r), (r.monthlyUsd || 0) / max, `${fmtUsd(r.monthlyUsd)}/mo`,
      `${r.label}: ≈${k(r.tokens)} tokens, injected ${r.injections}×, carried through ${k(r.carried)} requests`)).join('')}</div>
    <div class="insight-action instr-move"><span class="arrow">→</span><strong>${esc(short(lead))}:</strong> ${esc(lead.advice || '')}</div>
    <div class="foot">Counts only what reached the model. Size × requests carried at cache-read price, ≈ chars/4 tokens, API list price. Full table: <code>puffr-instructions</code></div>`);
}

function renderProjects(A) {
  const entries = A ? Object.entries(A.projects || {}).sort((a, b) => (b[1].usd || 0) - (a[1].usd || 0)) : [];
  if (!entries.length) return card('Cost by project · today', empty('No spend yet today.'));
  const shown = entries.slice(0, 7);
  const rest = entries.slice(7);
  if (rest.length) shown.push([`Other (${rest.length})`, { usd: rest.reduce((s, [, p]) => s + (p.usd || 0), 0), sessions: rest.reduce((s, [, p]) => s + (p.sessions || 0), 0) }]);
  const max = Math.max(...shown.map(([, p]) => p.usd || 0), 0.01);
  return card('Cost by project · today', `<div class="bars">${shown.map(([name, p]) =>
    barRow(name, (p.usd || 0) / max, fmtUsd(p.usd), `${name}: ${fmtUsd(p.usd)} across ${p.sessions} session${p.sessions === 1 ? '' : 's'}`)).join('')}</div>`);
}

function renderSessions(sessions) {
  if (!Array.isArray(sessions) || !sessions.length) return card('Recent sessions', empty('No sessions found.'));
  return card('Recent sessions', `<div class="sessions">${sessions.slice(0, 12).map(s => {
    const live = s.status === 'active';
    return `<div class="session" title="${esc(s.resume || '')}">
      <span class="dot ${live ? 'live' : ''}" aria-label="${live ? 'active' : 'idle'}"></span>
      <div class="session-main">
        <div class="session-title">${esc(s.title || s.summary || '(untitled)')}</div>
        <div class="session-meta">${esc(s.projectName || '')} · ${esc(s.messages)} msgs · ${relTime(s.mtime)}${live ? ' · active' : ''}</div>
      </div>
      <div class="session-cost">${fmtUsd(s.cost)}</div>
    </div>`;
  }).join('')}</div>`);
}

function renderAccounts(accounts) {
  if (!Array.isArray(accounts) || !accounts.length) return card('Accounts', empty('No accounts found.'));
  return card('Accounts', `<div class="accounts">${accounts.map(a => `
    <div class="account ${a.active ? 'active' : ''}" title="${esc(a.org || '')}">
      <div class="account-email">${a.active ? '● ' : ''}${esc(a.email || a.profile)}</div>
      <div class="account-meta"><span class="chip">${esc(a.plan || '?')}</span>${esc(a.org || '')}</div>
    </div>`).join('')}</div>`);
}

function card(title, body) {
  return `<section class="card"><h2>${esc(title)}</h2>${body}</section>`;
}

// mode: 'vscode' (default) wires the buttons to acquireVsCodeApi() postMessage,
// matching the onDidReceiveMessage handlers in dashboard.js and sidebar-view.js.
// 'http' wires them to page loads and adds a meta auto-refresh, for the
// standalone server with no extension host to message.
function render(data, { mode = 'vscode', refreshSeconds = 20, sectionTitle = 'This workspace', themeName = 'puffr' } = {}) {
  const A = data.burn && data.burn.A ? data.burn.A : null;
  const refreshScript = mode === 'http'
    ? `function refresh() { location.reload(); }
       function regen() { const u = new URL(location.href); u.searchParams.set('regen', '1'); document.body.classList.add('busy'); location.href = u.toString(); }`
    : `const vscode = acquireVsCodeApi();
       function refresh() { document.body.classList.add('busy'); vscode.postMessage({ type: 'refresh' }); }
       function regen() { document.body.classList.add('busy'); vscode.postMessage({ type: 'regen' }); }`;
  const autoRefreshMeta = mode === 'http' ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : '';
  const updated = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${autoRefreshMeta}
<title>🐡 puffr</title>
<style>${theme.css(themeName)}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${theme.fishMarkup()}PUFFR <em>dash</em></h1>
    <div class="header-side"><span class="stamp">updated ${esc(updated)}</span><button onclick="refresh()">Refresh</button></div>
  </header>
  ${renderKpis(A, data)}
  ${renderOpenSessions(data.openContexts)}
  ${renderInsights(data)}
  <div class="grid-2">
    ${renderInstructions(data.instructions)}
    ${renderProjects(A)}
  </div>
  <div class="grid-2">
    ${renderSessions(data.sessions)}
    ${renderAccounts(data.accounts)}
  </div>
  ${data.errors && data.errors.length ? `<div class="errors">Some data failed to load: ${esc(data.errors.join('; '))}</div>` : ''}
</div>
<script>${refreshScript}</script>
</body>
</html>`;
}

module.exports = { gatherData, render, esc, fmtUsd, relTime };
