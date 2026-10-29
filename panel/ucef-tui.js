// Controller for the UCEF view inside panel/tui.js: owns the Monitor, the selected session
// (live follow or a pinned past session for replay) and the keys. Read-only, no side effects
// until render() is called. Errors are reported without paths or stack traces.
'use strict';
const ucef = require('./ucef');
const view = require('./ucef-view');

class UcefPane {
  /**
   * @param {{dataDir?: string|null, session?: string|null, redact?: boolean, env?: object, cwd?: string, color?: boolean}} o
   * dataDir: --ucef-data-dir; env.UCEF_DATA_ROOT is next; else `.claude/data` is looked for above cwd.
   */
  constructor({ dataDir = null, session = null, redact = true, env = process.env, cwd = process.cwd(), color = false } = {}) {
    this.found = ucef.detectRoot({ flag: dataDir, env, cwd });
    this.explicit = !!(dataDir || env.UCEF_DATA_ROOT);
    this.sel = session || null;
    this.redact = redact !== false;
    this.style = color ? view.ANSI : view.PLAIN;
    this.monitor = null;
    this.error = null;
    this.open();
  }

  open() {
    if (!this.found) { this.error = { code: 'no_data', message: 'No UCEF data directory found above the current directory (looked for .claude/data/workspaces).' }; return; }
    try { this.monitor = new ucef.Monitor({ root: this.found.root, redact: this.redact }); this.error = null; } catch (e) {
      this.monitor = null;
      this.error = { code: e instanceof ucef.UcefError ? e.code : 'open_failed', message: e instanceof ucef.UcefError ? e.message : 'UCEF data directory could not be opened.' };
    }
  }

  /** @returns {{text: string, ok: boolean}} ok is false when there is nothing to show. */
  render(width = 100) {
    if (!this.monitor) this.open(); // the directory may appear later; retry on every refresh
    if (!this.monitor) {
      return { ok: false, text: `${this.style.bold('🐡 puffr · UCEF')}\n\n${this.style.red(this.error.message)}\n${this.style.dim('Use --ucef-data-dir <dir>, or set UCEF_DATA_ROOT (the directory that holds workspaces/).')}` };
    }
    try {
      let m = this.monitor.snapshot(this.sel);
      if (m.noSession && this.sel) { this.sel = null; m = this.monitor.snapshot(null); } // the pinned session is gone
      return { ok: !m.noSession, text: view.render(m, { width, style: this.style, redact: this.redact }) };
    } catch (e) {
      return { ok: false, text: this.style.red(`UCEF view error (${(e && (e.code || e.name)) || 'unknown'}). Press r to retry.`) };
    }
  }

  /** Keys: [ older session (replay) · ] newer · l back to live. Returns true when the key was used. */
  key(k) {
    if (!this.monitor || (k !== '[' && k !== ']' && k !== 'l')) return false;
    const list = this.monitor.sessions();
    const cur = this.sel ? Math.max(0, list.findIndex(s => s.sid === this.sel)) : 0;
    if (k === '[') this.sel = (list[Math.min(list.length - 1, cur + 1)] || {}).sid || null;
    else if (k === ']') this.sel = cur <= 1 ? null : list[cur - 1].sid;
    else this.sel = null;
    return true;
  }
}

module.exports = { UcefPane };
