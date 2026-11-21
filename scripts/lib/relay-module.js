'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RELAY_RELATIVE = ['mcp', 'servers', 'egc-memory', 'build', 'relay'];
const NOT_BUILT = 'The memory server is not built, so the mesh cannot run: in a checkout of EGC run `bash scripts/install.sh`, which builds the servers, or `npm run build` in mcp/servers/egc-memory.\n';

// The built relay modules: the ones of the EGC root this file runs from,
// else the ones the shared resolver finds for an install elsewhere; null
// when the memory server was not built.
function relayModule(name) {
  const relative = [...RELAY_RELATIVE, `${name}.js`];
  const local = path.join(__dirname, '..', '..', ...relative);
  if (fs.existsSync(local)) return local;
  try {
    const { resolveEGCRoot } = require('./resolve-egc-root');
    const candidate = path.join(resolveEGCRoot({ probe: relative.join('/') }), ...relative);
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function loadRelay(name) {
  const script = relayModule(name);
  return script ? require(script) : null;
}

module.exports = { RELAY_RELATIVE, NOT_BUILT, relayModule, loadRelay };
