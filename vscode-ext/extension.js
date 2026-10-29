// Puffr Status — minimal VS Code status bar item showing Claude Code context
// usage for the open workspace, read from puffr's existing `puffr-context --json`.
//
// This extension does no computation of its own: it shells out to
// `puffr-context --project <workspace path> --json` on a timer and renders
// the numbers puffr already produces. See ../README.md for what puffr-context
// reads (Claude Code session transcripts under ~/.claude/projects/).
'use strict';
const vscode = require('vscode');
const { execFile } = require('child_process');
const dashboard = require('./dashboard');
const { PuffrSidebarViewProvider } = require('./sidebar-view');
const { env, puffrBin } = require('./panel-path')('env');

let statusBarItem;
let contextTimer;
let costTimer;
let lastPayload = null;
let lastCost = null; // { usd, sessions } for today, scoped to this workspace
let lastCostError = null;

function config() {
  return vscode.workspace.getConfiguration('puffr');
}

function activeWorkspaceFilter() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  // puffr-context's --project matches a substring of the transcript directory
  // name (itself derived from the session's cwd), after lowercasing and
  // replacing '/' and '_' with '-'. Passing the full folder path is more
  // precise than a bare folder name and needs no pre-encoding on our side —
  // puffr-context does that normalization internally.
  return folders[0].uri.fsPath;
}

function runPuffrContext(filterPath) {
  return new Promise((resolve, reject) => {
    const bin = puffrBin('puffr-context', config().get('puffrContextPath'));
    execFile(bin, ['--project', filterPath, '--json'], { timeout: 10000, maxBuffer: 10 * 1024 * 1024, env: env() }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject({ kind: 'missing-binary' });
        return reject({ kind: 'no-session', detail: (stderr || err.message || '').trim() });
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject({ kind: 'parse-error', detail: e.message });
      }
    });
  });
}

function runPuffrBurn(filterPath) {
  return new Promise((resolve, reject) => {
    const bin = puffrBin('puffr-burn', config().get('puffrBurnPath'));
    execFile(bin, ['--days', '1', '--project', filterPath, '--json'], { timeout: 15000, maxBuffer: 10 * 1024 * 1024, env: env() }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') return reject({ kind: 'missing-binary' });
        return reject({ kind: 'no-data' });
      }
      try {
        const payload = JSON.parse(stdout);
        const a = payload.A || {};
        resolve({ usd: a.usd || 0, sessions: a.sessions || 0 });
      } catch (e) {
        reject({ kind: 'parse-error', detail: e.message });
      }
    });
  });
}

function iconFor(pct) {
  if (pct >= 0.8) return '🐡 $(flame)';
  if (pct >= 0.6) return '🐡 $(warning)';
  return '🐡';
}

function renderTooltip(payload) {
  const lines = [];
  lines.push(`🐡 **${payload.title || '(untitled session)'}**`);
  lines.push(`${payload.model || 'unknown model'} · ${payload.cwd || ''}`);
  lines.push('');
  const ctx = payload.context || {};
  const pct = Math.round((ctx.pct || 0) * 100);
  lines.push(`Context: ${pct}% (${Math.round((ctx.current || 0) / 1000)}k / ${Math.round((ctx.window || 0) / 1000)}k tokens)`);
  if (lastCost != null) {
    lines.push(`Today, this project: $${lastCost.usd.toFixed(2)} ≈ API list price (${lastCost.sessions} session${lastCost.sessions === 1 ? '' : 's'})`);
  }
  if (Array.isArray(ctx.composition)) {
    const top = [...ctx.composition].sort((a, b) => (b.tok || 0) - (a.tok || 0)).slice(0, 5);
    for (const c of top) {
      lines.push(`  ${c.cat}: ≈${Math.round((c.tok || 0) / 1000)}k`);
    }
  }
  const md = new vscode.MarkdownString(lines.join('\n\n'));
  md.isTrusted = false;
  return md;
}

function costSuffix() {
  if (!config().get('showCost', true)) return '';
  if (lastCost != null) return ` · $${lastCost.usd.toFixed(2)}`;
  return '';
}

async function refreshContext() {
  const filter = activeWorkspaceFilter();
  if (!filter) {
    statusBarItem.hide();
    return;
  }
  try {
    const payload = await runPuffrContext(filter);
    lastPayload = payload;
    const pct = Math.round(((payload.context && payload.context.pct) || 0) * 100);
    statusBarItem.text = `${iconFor((payload.context && payload.context.pct) || 0)} ${pct}%${costSuffix()}`;
    statusBarItem.tooltip = renderTooltip(payload);
    statusBarItem.command = 'puffr.openDashboard';
    statusBarItem.backgroundColor = pct >= 80
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    statusBarItem.show();
  } catch (e) {
    lastPayload = null;
    if (e.kind === 'missing-binary') {
      statusBarItem.text = '🐡 $(circle-slash)';
      statusBarItem.tooltip = 'puffr-context not found on PATH. Install puffr to enable this status item.';
    } else {
      statusBarItem.text = `🐡 —${costSuffix()}`;
      statusBarItem.tooltip = 'No Claude Code session found yet for this workspace.';
    }
    statusBarItem.command = undefined;
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
  }
}

async function refreshCost() {
  if (!config().get('showCost', true)) return;
  const filter = activeWorkspaceFilter();
  if (!filter) return;
  try {
    lastCost = await runPuffrBurn(filter);
    lastCostError = null;
  } catch (e) {
    lastCost = null;
    lastCostError = e.kind || 'error';
  }
  // Re-render the bar with whatever context data we last had, so cost
  // shows up without waiting for the next context poll.
  if (lastPayload) {
    const pct = Math.round(((lastPayload.context && lastPayload.context.pct) || 0) * 100);
    statusBarItem.text = `${iconFor((lastPayload.context && lastPayload.context.pct) || 0)} ${pct}%${costSuffix()}`;
  }
}

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBarItem);

  const sidebarProvider = new PuffrSidebarViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('puffrSidebarView', sidebarProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('puffr.refresh', () => { refreshContext(); refreshCost(); }),
    vscode.commands.registerCommand('puffr.openDashboard', () => dashboard.createOrShowDashboard(context)),
    vscode.commands.registerCommand('puffr.showDetail', () => {
      if (!lastPayload) {
        vscode.window.showInformationMessage('Puffr: no session data yet.');
        return;
      }
      const pct = Math.round(((lastPayload.context && lastPayload.context.pct) || 0) * 100);
      const costMsg = lastCost != null ? ` · $${lastCost.usd.toFixed(2)} today (this project)` : '';
      vscode.window.showInformationMessage(
        `${lastPayload.title || 'session'} — ${pct}% context used${costMsg}`,
        { modal: false }
      );
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('puffr')) restartTimers();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { refreshContext(); refreshCost(); })
  );

  restartTimers();
  refreshContext();
  refreshCost();
}

function restartTimers() {
  if (contextTimer) clearInterval(contextTimer);
  if (costTimer) clearInterval(costTimer);
  const ctxSeconds = Math.max(5, config().get('pollIntervalSeconds', 20));
  const costSeconds = Math.max(15, config().get('costPollIntervalSeconds', 60));
  contextTimer = setInterval(refreshContext, ctxSeconds * 1000);
  if (config().get('showCost', true)) {
    costTimer = setInterval(refreshCost, costSeconds * 1000);
  }
}

function deactivate() {
  if (contextTimer) clearInterval(contextTimer);
  if (costTimer) clearInterval(costTimer);
}

module.exports = { activate, deactivate };
