// In the repo the panel code sits beside vscode-ext/; an installed extension
// carries its own copy inside its folder (see bin/puffr-install). Load whichever
// exists.
'use strict';
const fs = require('fs');
const path = require('path');

const base = fs.existsSync(path.join(__dirname, 'panel', 'core.js'))
  ? path.join(__dirname, 'panel')
  : path.join(__dirname, '..', 'panel');

module.exports = name => require(path.join(base, name));
