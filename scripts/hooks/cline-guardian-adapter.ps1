# Cline (VS Code extension) Guardian hook -- Windows.
#
# Confirmed against the real cline/cline source (hook-factory.ts
# findWindowsHook, fetched 2026-07-29): on win32, Cline only looks for
# `<HookName>.ps1` and runs it via PowerShell -- the extensionless
# `PreToolUse` file that Unix uses is ignored on Windows. Cline discovers
# this file by its exact filename, not by a require()'d module, so it
# cannot live next to its own dependencies the way cline-guardian-adapter.js
# does (installed at .clinerules/scripts/hooks/, alongside its own copied
# ./pre-bash-guardian-validate and ../lib/adapter-stdin-json dependencies).
# This wrapper pipes stdin through unchanged to that real implementation via
# `node`, and forwards its stdout and exit code.

$stdin = [Console]::In.ReadToEnd()
$hooksDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$clinerulesDir = Split-Path -Parent $hooksDir
$target = Join-Path $clinerulesDir 'scripts\hooks\cline-guardian-adapter.js'

$stdin | & node $target
exit $LASTEXITCODE
