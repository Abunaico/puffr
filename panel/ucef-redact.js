// Redaction for the UCEF view. Normative source: docs/ucef-monitor/spec.md section 7
// and docs/ucef-monitor/redaction-vectors.json. Pipeline order is fixed:
// scrub -> strip controls -> truncate. Builtins only.
'use strict';
const crypto = require('crypto');

// Order matters (spec section 7). Key-prefix classes are anchored with \b because an
// unanchored `sk-` matched inside `task-decomposition-expert` during contract testing.
const SCRUBBERS = [
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, () => '[REDACTED:private_key]'],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, () => '[REDACTED:jwt]'],
  ['api_key', /\bsk-[A-Za-z0-9_-]{16,}/g, () => '[REDACTED:api_key]'],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, () => '[REDACTED:github_token]'],
  ['aws_key_id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => '[REDACTED:aws_key_id]'],
  ['bearer', /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g, () => 'Bearer [REDACTED:bearer]'],
  ['url_userinfo', /(:\/\/)[^/\s:@[\]]+:[^/\s@[\]]+@/g, (_m, p1) => `${p1}[REDACTED:url_userinfo]@`],
  ['env_assignment',
    /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*)(\s*[=:]\s*)(?!\[REDACTED)[^\s'"]{6,}/gi,
    (_m, p1, p2) => `${p1}${p2}[REDACTED:env_assignment]`],
];
const CLASS_ORDER = SCRUBBERS.map(s => s[0]);

/** Replace secret-shaped substrings. Returns { text, counts: { class: n } }. */
function scrub(text) {
  const counts = {};
  let out = String(text == null ? '' : text);
  for (const [name, rx, repl] of SCRUBBERS) {
    out = out.replace(rx, (...a) => { counts[name] = (counts[name] || 0) + 1; return repl(...a); });
  }
  return { text: out, counts };
}

/** tab/newline/CR -> space; drop every other C0 and C1 control (DEL included). */
function stripControls(text) {
  let out = '';
  for (const ch of String(text)) {
    const o = ch.codePointAt(0);
    if (ch === '\t' || ch === '\n' || ch === '\r') out += ' ';
    else if (o < 32 || (o >= 127 && o <= 159)) continue;
    else out += ch;
  }
  return out;
}

// Render-time extras beyond the normative pipeline: bidirectional overrides and
// line/paragraph separators can re-order or spoof what a terminal draws.
const SPOOF = new RegExp("[\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\u200b-\\u200f\\ufeff]", "g");

function truncate(text, limit) {
  const cps = Array.from(text);
  if (cps.length <= limit) return { text, truncated: false };
  let cut = cps.slice(0, limit).join('');
  const i = cut.lastIndexOf('[');
  if (i !== -1 && !cut.slice(i).includes(']')) cut = cut.slice(0, i); // never inside a [REDACTED:...] token
  return { text: cut, truncated: true };
}

const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** scrub -> strip controls -> truncate. sha256 is of the scrubbed, untruncated text. */
function finalize(raw, limit) {
  const s = scrub(raw);
  const stripped = stripControls(s.text);
  const t = truncate(stripped, limit);
  return { text: t.text, counts: s.counts, truncated: t.truncated, sha256: sha256(stripped) };
}

/**
 * The one entry point for any string that reaches a terminal. Default is the full
 * pipeline; `redact: false` still strips terminal controls (never optional) but skips
 * scrub and the field-limit truncation.
 */
function safe(raw, limit, { redact = true } = {}) {
  if (raw == null) return '';
  const s = String(raw);
  if (!redact) return stripControls(s).replace(SPOOF, '').slice(0, 4000);
  return finalize(s, limit).text.replace(SPOOF, '');
}

/** Redaction object for an event, from per-field finalize results. */
function redactionRecord(parts) {
  const classes = new Set();
  const truncated = [];
  let n = 0, sawText = false;
  for (const [field, r] of Object.entries(parts)) {
    if (!r) continue;
    sawText = true;
    for (const [c, k] of Object.entries(r.counts)) { classes.add(c); n += k; }
    if (r.truncated) truncated.push(field);
  }
  if (!sawText) return undefined;
  const level = n ? 'scrubbed' : truncated.length ? 'truncated' : 'metadata_only';
  return { policy: 'v1', level, secrets_scrubbed: n, scrub_classes: CLASS_ORDER.filter(c => classes.has(c)), truncated_fields: truncated };
}

/** Reduce an untrusted identifier to the contract token alphabet, 64 chars at most. */
const token = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_.:+/-]/g, '_').slice(0, 64);

module.exports = { SCRUBBERS, CLASS_ORDER, scrub, stripControls, truncate, finalize, safe, redactionRecord, sha256, token };
