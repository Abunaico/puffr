// Terminal rendering of the puffr panel, for a Warp (or any terminal) split
// pane. Same panel/core.js data as the VS Code and browser panels.
// Keys: r refresh · g regenerate Haiku insights · u UCEF view · q quit.
// UCEF view (read-only monitor of a UCEF data directory): --ucef starts in it, u toggles;
// [ ] step through past sessions (replay), l returns to live. See --help.
'use strict';
const core = require('./core');

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const project = flag('--project') || null;
const every = Math.max(10, parseInt(flag('--every') || '20', 10));
const once = args.includes('--once');

const USAGE = `puffr-dash: live terminal panel for a split pane.
Usage: puffr-dash [--project <substr>] [--every <seconds>] [--once]
                  [--ucef] [--ucef-data-dir <dir>] [--ucef-session <id>] [--ucef-no-redact]

  --ucef               start in the UCEF view (read-only monitor: hooks and verdicts, agents and
                       model tier, phase and gates, Jev decisions and cost). Press u to toggle.
  --ucef-data-dir <d>  UCEF data directory (the one holding workspaces/). Default: $UCEF_DATA_ROOT,
                       else .claude/data found above the current directory.
  --ucef-session <id>  start on a past session (replay) instead of the newest (live).
  --ucef-no-redact     do not scrub secret-shaped text; terminal controls are still stripped.
  --once               draw one frame and exit (exit 0 ok, 1 nothing to show, 2 bad usage).
Keys: r refresh, g regenerate insights, u UCEF view, [ ] older/newer UCEF session, l live, q quit.`;
if (args.includes('--help') || args.includes('-h')) { process.stdout.write(`${USAGE}\n`); process.exit(0); }

const wantUcef = args.includes('--ucef');
const ucefOpts = { dataDir: flag('--ucef-data-dir'), session: flag('--ucef-session'), redact: !args.includes('--ucef-no-redact') };
for (const [n, v] of [['--ucef-data-dir', ucefOpts.dataDir], ['--ucef-session', ucefOpts.session]]) {
  if (args.includes(n) && (!v || v.startsWith('--'))) { process.stderr.write(`puffr-dash: ${n} needs a value (see --help)\n`); process.exit(2); }
}
if (ucefOpts.session && !require('./ucef').validSessionId(ucefOpts.session)) { process.stderr.write('puffr-dash: --ucef-session is not a valid session id\n'); process.exit(2); }
let view = wantUcef ? 'ucef' : 'main';
let ucefPane = null;
const ucef = () => ucefPane || (ucefPane = new (require('./ucef-tui').UcefPane)({ ...ucefOpts, color: !!process.stdout.isTTY && !process.env.NO_COLOR }));
// With --once on a pipe, skip cursor and clear sequences (the default interactive output is unchanged).
const tty = seq => (!once || process.stdout.isTTY ? seq : '');

const C = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const dim = s => C('2', s), bold = s => C('1', s), cyan = s => C('36', s), yellow = s => C('33', s), red = s => C('31', s);
const width = () => Math.max(40, (process.stdout.columns || 80) - 2);
const fit = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const pad = (s, n) => fit(s, n).padEnd(n);
const lpad = (s, n) => fit(s, n).padStart(n);
const usd = core.fmtUsd;

function wrap(text, n, indent) {
  const words = String(text || '').split(/\s+/), lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > n) { lines.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines.map(l => indent + l).join('\n');
}

function section(title) {
  return '\n' + bold(title) + ' ' + dim('─'.repeat(Math.max(0, width() - title.length - 1)));
}

function render(d) {
  const W = width(), out = [];
  const A = d.burn && d.burn.A;
  out.push(`${bold('🐡 puffr')}  ${A ? `${bold(usd(A.usd))} today · ${A.sessions} sessions · ${A.reqs} requests` : dim('no burn data')}`);
  out.push(dim(`refreshes every ${every}s · r refresh · g regenerate insights · u UCEF view · q quit`));

  const ctx = d.context && d.context.context;
  out.push(section(project ? `Project: ${project}` : 'Most recent session'));
  if (ctx) {
    const pct = Math.round((ctx.pct || 0) * 100);
    const barW = Math.max(10, Math.min(40, W - 30));
    const filled = Math.round((pct / 100) * barW);
    const bar = (pct >= 80 ? red : pct >= 60 ? yellow : cyan)('█'.repeat(filled)) + dim('░'.repeat(barW - filled));
    out.push(fit(`${d.context.title || '(untitled)'} · ${d.context.model || ''}`, W));
    out.push(`${bar} ${pct}%  ${dim(`${Math.round((ctx.current || 0) / 1000)}k / ${Math.round((ctx.window || 0) / 1000)}k`)}`);
  } else out.push(dim('No active session found.'));

  const ai = d.ai || {};
  out.push(section('Patterns (Haiku)'));
  if (ai.status === 'haiku-off') out.push(dim('Off. puffr-config set model.haiku on'));
  else if (Array.isArray(ai.items) && ai.items.length) {
    for (const i of ai.items) {
      out.push(`${cyan('●')} ${bold(fit(i.title, W - 2))}`);
      if (i.pattern) out.push(dim(wrap(i.pattern, W - 4, '  ')));
      out.push(wrap('→ ' + i.action, W - 4, '  '));
    }
    out.push(dim(`written by Haiku${ai.status === 'generating' ? ' · refreshing in background' : ''} · suggestions, not measurements`));
  } else if (ai.status === 'generating') out.push(dim('Haiku is reading your patterns… (about a minute)'));
  else if (ai.status === 'failed') out.push(red(`Haiku failed: ${ai.error || 'unknown'}`) + dim('  press g to retry'));
  else out.push(dim('none yet'));

  const rules = (d.ruleInsights || []).slice(0, 4);
  out.push(section('Biggest levers (measured, 7d → /mo)'));
  if (rules.length) for (const r of rules) out.push(`${lpad('≈' + usd(r.save), 10)}  ${fit(r.title, W - 12)}`);
  else out.push(dim('none'));

  out.push(section('Cost by project (today)'));
  const projects = A ? Object.entries(A.projects || {}).sort((a, b) => b[1].usd - a[1].usd).slice(0, 8) : [];
  for (const [name, p] of projects) out.push(`${lpad(usd(p.usd), 10)}  ${pad(name, W - 22)} ${dim(lpad(p.sessions + ' sess', 8))}`);
  if (!projects.length) out.push(dim('none'));

  out.push(section('Recent sessions'));
  for (const s of (d.sessions || []).slice(0, 10)) {
    const age = core.relTime(s.mtime);
    out.push(`${lpad(age, 4)}  ${pad(s.projectName || '', 18)} ${lpad(usd(s.cost), 8)}  ${dim(fit(s.title || s.summary || '', Math.max(10, W - 36)))}`);
  }

  if (d.errors && d.errors.length) out.push('\n' + red(fit('errors: ' + d.errors.join('; '), W)));
  return out.join('\n');
}

let busy = false;
let lastOk = true;
async function draw(regen = false) {
  if (busy) return;
  busy = true;
  try {
    if (view === 'ucef') {
      const r = ucef().render(width());
      lastOk = r.ok;
      process.stdout.write(tty('\x1b[2J\x1b[H') + r.text + '\n');
      return;
    }
    if (regen) process.stdout.write('\x1b[2J\x1b[H🐡 regenerating Haiku insights (about a minute)…\n');
    const d = await core.gatherData({ projectFilter: project, regenInsights: regen });
    process.stdout.write(tty('\x1b[2J\x1b[H') + render(d) + '\n');
  } catch (e) {
    process.stdout.write(red(`puffr-dash error: ${e.message}`) + '\n');
  } finally { busy = false; }
}

process.stdout.write(tty('\x1b[?25l'));
const restore = () => { process.stdout.write(tty('\x1b[?25h\n')); process.exit(0); };
process.on('SIGINT', restore);
process.stdout.on('resize', () => draw());
if (process.stdin.isTTY && !once) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', k => {
    const key = k.toString();
    if (key === 'q' || key === '\u0003') restore();
    if (key === 'r') draw();
    if (key === 'g' && view === 'main') draw(true);
    if (key === 'u') { view = view === 'ucef' ? 'main' : 'ucef'; draw(); }
    else if (view === 'ucef' && ucef().key(key)) draw();
  });
}
draw().then(() => {
  if (!once) return;
  process.stdout.write(tty('\x1b[?25h'), () => process.exit(view === 'ucef' && !lastOk ? 1 : 0));
});
if (!once) setInterval(() => draw(), every * 1000);
