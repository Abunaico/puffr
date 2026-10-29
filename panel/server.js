#!/usr/bin/env node
// Standalone local puffr panel — no VS Code dependency at all. Reads the same
// ~/.claude/projects/*.jsonl transcripts and puffr-* --json commands as the
// terminal HUD and the VS Code extension; just a different renderer for
// people who want a browser tab instead of either of those.
//
// Usage: node server.js [--port 4850] [--project <substr>]
'use strict';
const http = require('http');
const { URL } = require('url');
const core = require('./core');

function parseArgs(argv) {
  const out = { port: 4850, project: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = parseInt(argv[++i], 10) || out.port;
    if (argv[i] === '--project') out.project = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  const projectFilter = url.searchParams.get('project') || args.project;

  if (url.searchParams.get('regen') === '1') {
    await core.gatherData({ projectFilter, regenInsights: true }).catch(() => {});
    url.searchParams.delete('regen');
    res.writeHead(303, { Location: url.pathname + url.search });
    return res.end();
  }

  try {
    const data = await core.gatherData({ projectFilter });
    const sectionTitle = projectFilter ? `Project: ${projectFilter}` : 'Most recently active session';
    const html = core.render(data, { mode: 'http', refreshSeconds: 20, sectionTitle });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`puffr panel error: ${e.message}\n\nIs puffr on PATH? Try: which puffr-burn`);
  }
});

server.listen(args.port, '127.0.0.1', () => {
  console.log(`🐡 puffr panel running at http://localhost:${args.port}`);
  console.log(`   Switch project: http://localhost:${args.port}/?project=<substring>`);
  console.log('   Ctrl+C to stop.');
});
