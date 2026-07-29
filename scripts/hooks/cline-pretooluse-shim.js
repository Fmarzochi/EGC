#!/usr/bin/env node
/**
 * Installed verbatim as .clinerules/hooks/PreToolUse (Unix, executable).
 *
 * Cline discovers this file by its exact filename, not by a require()'d
 * module, so it cannot live next to its own dependencies the way every
 * other EGC translation adapter does -- cline-guardian-adapter.js (with its
 * `./pre-bash-guardian-validate` and `../lib/adapter-stdin-json` requires)
 * is instead installed at the normal .clinerules/scripts/hooks/ location,
 * alongside its own copied dependencies, and this shim just spawns it with
 * stdin/stdout/stderr passed through unchanged.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const target = path.join(__dirname, '..', 'scripts', 'hooks', 'cline-guardian-adapter.js');
const result = spawnSync(process.execPath, [target], { stdio: 'inherit' });

process.exitCode = typeof result.status === 'number' ? result.status : 0;
