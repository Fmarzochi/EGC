'use strict';

// jsfuzz collects coverage only from modules loaded through require(): its
// istanbul-lib-hook instruments CommonJS, not Node's ESM loader. The guardian
// is "type":"module", so loading build/validator.js via dynamic import() left
// the validator un-instrumented and the fuzzer ran blind (no coverage feedback,
// no guided path discovery). We bundle the validator to a CommonJS artifact
// (npm run build:target -> validator.cjs) and require it synchronously so the
// fuzzer actually explores validateCommand/validateWrite/isProtectedPath.
const { validateCommand, validateWrite, isProtectedPath } = require('./validator.cjs');

module.exports.fuzz = function (data) {
  const input = data.toString('utf-8');

  try { validateCommand(input); } catch (_) { /* fuzz: expected throw */ }
  try { validateWrite(input); } catch (_) { /* fuzz: expected throw */ }
  try { isProtectedPath(input); } catch (_) { /* fuzz: expected throw */ }

  try { validateCommand('\x00' + input); } catch (_) { /* fuzz: expected throw */ }
  try { validateWrite('../../../etc/passwd' + input); } catch (_) { /* fuzz: expected throw */ }
  try { validateCommand('cat ~/' + input); } catch (_) { /* fuzz: expected throw */ }
};
