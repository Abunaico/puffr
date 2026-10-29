// GUI-launched hosts (VS Code's extension host, LaunchAgents) don't get the
// login shell's PATH, so bare `puffr-burn` or `claude` can fail with ENOENT.
// Resolve puffr's own commands from this repo and widen PATH for node/claude.
'use strict';
const path = require('path');
const os = require('os');

const PUFFR_BIN = path.join(__dirname, '..', 'bin');
const EXTRA = [PUFFR_BIN, '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];

const env = () => ({ ...process.env, PATH: [...EXTRA, process.env.PATH || '/usr/bin:/bin'].join(':') });

// A configured value that is a bare puffr-* name resolves to this repo's bin/.
const puffrBin = (name, configured) =>
  !configured || configured === name ? path.join(PUFFR_BIN, name) : configured;

module.exports = { env, puffrBin, PUFFR_BIN };
