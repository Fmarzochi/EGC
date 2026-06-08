'use strict';

let validateCommand;
let validateWrite;
let isProtectedPath;

const ready = import('../mcp/servers/egc-guardian/build/validator.js').then((mod) => {
  validateCommand = mod.validateCommand;
  validateWrite = mod.validateWrite;
  isProtectedPath = mod.isProtectedPath;
});

module.exports.fuzz = async function (data) {
  await ready;

  const input = data.toString('utf-8');

  try { validateCommand(input); } catch (_) { /* fuzz: expected throw */ }
  try { validateWrite(input); } catch (_) { /* fuzz: expected throw */ }
  try { isProtectedPath(input); } catch (_) { /* fuzz: expected throw */ }

  try { validateCommand('\x00' + input); } catch (_) { /* fuzz: expected throw */ }
  try { validateWrite('../../../etc/passwd' + input); } catch (_) { /* fuzz: expected throw */ }
  try { validateCommand('cat ~/' + input); } catch (_) { /* fuzz: expected throw */ }
};
