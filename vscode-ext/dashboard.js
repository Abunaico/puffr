// Puffr Dashboard — a webview panel inside the official Claude Code VS Code
// extension's window, for people who never see puffr's terminal HUD/fleet
// view. Thin VS Code wrapper around ../panel/core.js, which does the actual
// data gathering and rendering (shared with the standalone server).
'use strict';
const vscode = require('vscode');
const core = require('./panel-path')('core');

let panel = null;

function config() {
  return vscode.workspace.getConfiguration('puffr');
}

function currentBins() {
  const cfg = config();
  return {
    burn: cfg.get('puffrBurnPath', 'puffr-burn'),
    accounts: cfg.get('puffrAccountsPath', 'puffr-accounts'),
    sessions: cfg.get('puffrSessionsPath', 'puffr-sessions'),
    context: cfg.get('puffrContextPath', 'puffr-context'),
  };
}

function currentProjectFilter() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : null;
}

async function createOrShowDashboard(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    await refreshPanel();
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'puffrDashboard',
    '🐡 Puffr',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.onDidDispose(() => { panel = null; });
  panel.webview.onDidReceiveMessage(msg => {
    if (msg && msg.type === 'refresh') refreshPanel();
    if (msg && msg.type === 'regen') refreshPanel({ regen: true });
  });
  context.subscriptions.push(panel);
  await refreshPanel();
}

async function refreshPanel({ regen = false } = {}) {
  if (!panel) return;
  if (!regen) panel.webview.html = '<body style="font-family:sans-serif;padding:16px;">Loading…</body>';
  const data = await core.gatherData({ bins: currentBins(), projectFilter: currentProjectFilter(), regenInsights: regen });
  if (panel) panel.webview.html = core.render(data, { mode: 'vscode', sectionTitle: 'This workspace', themeName: config().get('theme', 'puffr') });
}

module.exports = { createOrShowDashboard, refreshPanel: () => refreshPanel() };
