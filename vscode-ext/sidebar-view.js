// Puffr sidebar view — a WebviewView docked in the Activity Bar, always
// visible without a command, unlike dashboard.js's on-demand editor-area
// panel. Same ../panel/core.js render core as the webview panel and the
// standalone server; this is just a different VS Code API for where the
// webview lives.
'use strict';
const vscode = require('vscode');
const core = require('./panel-path')('core');

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

class PuffrSidebarViewProvider {
  constructor() {
    this.view = null;
    this.timer = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = '<body style="font-family:sans-serif;padding:16px;">Loading…</body>';

    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg && msg.type === 'refresh') this.refresh();
      if (msg && msg.type === 'regen') this.refresh({ regen: true });
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.refresh();
      this.restartTimer();
    });

    webviewView.onDidDispose(() => {
      this.view = null;
      if (this.timer) clearInterval(this.timer);
    });

    this.refresh();
    this.restartTimer();
  }

  restartTimer() {
    if (this.timer) clearInterval(this.timer);
    if (!this.view || !this.view.visible) return;
    const seconds = Math.max(10, config().get('pollIntervalSeconds', 20));
    this.timer = setInterval(() => this.refresh(), seconds * 1000);
  }

  async refresh({ regen = false } = {}) {
    if (!this.view) return;
    try {
      const data = await core.gatherData({ bins: currentBins(), projectFilter: currentProjectFilter(), regenInsights: regen });
      if (this.view) {
        this.view.webview.html = core.render(data, { mode: 'vscode', sectionTitle: 'This workspace', themeName: config().get('theme', 'puffr') });
      }
    } catch (e) {
      if (this.view) {
        this.view.webview.html = `<body style="font-family:sans-serif;padding:16px;">puffr error: ${String(e.message || e)}</body>`;
      }
    }
  }
}

module.exports = { PuffrSidebarViewProvider };
