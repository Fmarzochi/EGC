$ErrorActionPreference = "Stop"

# The directory the person ran the installer FROM. Captured here, before any
# Set-Location moves to the package root, because the project .mcp.json merge
# near the end must target their project, not the package.
$InvokedFromDir = (Get-Location).Path

$RootDir       = Split-Path -Parent $PSScriptRoot
$BootstrapDb   = Join-Path (Join-Path $RootDir "scripts") "bootstrap-state-db.js"
$EgcInstall    = Join-Path (Join-Path $RootDir "scripts") "install-apply.js"
$GuardianBin   = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $RootDir "mcp") "servers") "egc-guardian") "build") "index.js"
$MemoryBin     = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $RootDir "mcp") "servers") "egc-memory") "build") "index.js"

# npm strips the root package-lock.json from published tarballs, so a globally
# installed package has no root lockfile (npm already resolved its deps during
# `npm install -g`). The sub-package lockfiles travel via package.json "files",
# so run a pinned `npm ci` wherever a lockfile is present and skip entirely
# otherwise -- mirrors install.sh's install_deps exactly, including the lack
# of an npm install fallback (a global install has already resolved deps).
function Test-DirectoryWritable {
    param([string]$Directory)
    $probe = Join-Path $Directory ([System.IO.Path]::GetRandomFileName())
    try {
        [System.IO.File]::WriteAllText($probe, "")
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

function Install-Deps {
    if (-not (Test-Path "package-lock.json")) {
        return
    }
    $here = (Get-Location).Path
    if (Test-DirectoryWritable $here) {
        npm ci --silent
        if ($LASTEXITCODE -ne 0) {
            $rc = $LASTEXITCODE
            [Console]::Error.WriteLine("Error: npm ci failed in $here (exit $rc). Re-run with network access, or fix the directory ownership and try again.")
            exit $rc
        }
        return
    }
    # A read-only directory is a global npm prefix owned by another account
    # (an elevated `npm install -g`, then `egc install` from a normal
    # terminal). npm ci cannot write node_modules here, and with --silent its
    # failure used to end the install without a message. The published
    # package root already carries every dependency the MCP servers declare,
    # one level up, so confirm that and carry on. Mirrors install.sh.
    node (Join-Path (Join-Path $RootDir "scripts") "check-mcp-deps.js") $here
    if ($LASTEXITCODE -eq 0) {
        Write-Output "  dependencies provided by the package root ($here is read-only)"
        return
    }
    [Console]::Error.WriteLine("Error: $here is not writable and its dependencies are not available from the package root. Re-run 'npm install -g @egchq/egc' as the user that owns the npm prefix, or fix the prefix ownership (see docs/installation.md, Permissions).")
    exit 1
}

# Forward --help directly to the Node installer
if ($args -contains '--help') {
    node $EgcInstall @args
    exit $LASTEXITCODE
}

Write-Host "EGC install"

# Node.js version check. Keep this floor in lockstep with package.json
# "engines" and scripts/preinstall.js, which both require Node 20; a lower
# gate here would let 18/19 reach the better-sqlite3 build and the
# TypeScript build steps below.
try {
    # The last line node prints is its version, even when a wrapper prints
    # something before it.
    $nodeVersionText = "$(node --version | Select-Object -Last 1)".Trim()
    $nodeVersion = $nodeVersionText.TrimStart('v').Split('.')[0]
    if ([int]$nodeVersion -lt 20) {
        Write-Error "Node.js >= 20 is required (found: $nodeVersionText)"
        exit 1
    }
    Write-Host "  node $nodeVersionText"
} catch {
    Write-Error "Node.js not found. Install from https://nodejs.org"
    exit 1
}

$DryRun = $args -contains '--dry-run'

# The prompt library (agents, skills, commands, rules) is opt-in: the bare
# install sets up the engine and asks about the library only at an
# interactive console, default no. --prompt-library adds it without asking;
# --no-prompt-library skips the question (CI, provisioning).
$PromptLibrary = $null
if (($args -contains '--prompt-library') -and ($args -contains '--no-prompt-library')) {
    Write-Host "Error: --prompt-library and --no-prompt-library cannot be combined" -ForegroundColor Red
    exit 1
}
if ($args -contains '--prompt-library') { $PromptLibrary = $true }
if ($args -contains '--no-prompt-library') { $PromptLibrary = $false }

# Optional dependency hints (non-blocking)
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "  Optional dependency not found: uv"
    Write-Host "    Required only for Jira and omega-memory MCP servers."
    Write-Host "    Core EGC installation is unaffected. Install: https://docs.astral.sh/uv/"
}

if (-not $DryRun) {
    # Root dependencies
    Write-Host "  installing root dependencies..."
    Set-Location -Path $RootDir
    Install-Deps

    # Point the "egc" command at this checkout, so the "egc doctor" the
    # message at the end of this script tells the user to run (and anything
    # else they type afterward) targets the code that was just installed
    # rather than a stale prior global install left on PATH from an earlier
    # npm publish.
    #
    # Do not infer "npm install" from the currently active npm prefix: a
    # package installed with --prefix (or under a version manager that was
    # switched later) legitimately lives outside `npm root -g` (#1464).
    # The installed package layout itself is stable across prefixes.
    $ScopeDir = Split-Path -Parent $RootDir
    $NodeModulesDir = Split-Path -Parent $ScopeDir
    $IsNpmInstall = (
        -not (Test-Path (Join-Path $RootDir ".git")) -and
        (Split-Path -Leaf $RootDir) -eq "egc" -and
        (Split-Path -Leaf $ScopeDir) -eq "@egchq" -and
        (Split-Path -Leaf $NodeModulesDir) -eq "node_modules"
    )
    if ($IsNpmInstall) {
        Write-Host "  egc command already provided by this npm install"
    } else {
        Write-Host "  linking the egc command to this checkout..."
        # PowerShell does not treat a non-zero exit code from a native command as
        # a terminating error, so a try/catch here would never fire: check
        # $LASTEXITCODE explicitly instead, matching the "||" pattern install.sh
        # uses for the same fallback (cubic review, PR #1096).
        npm link --silent 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  note: npm link failed (no permission to the global npm prefix?). Run 'npm link' manually, or use 'node scripts\egc.js <command>' from this checkout." -ForegroundColor Yellow
        }
    }

    # The native sqlite3 binary is a prebuilt download; when it cannot load
    # here, EGC runs on its portable engine (full-text search degrades to
    # substring matching), so this is a note rather than a warning.
    node (Join-Path (Join-Path $RootDir "scripts") "check-native-sqlite.js") 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  note: native sqlite3 unavailable on this machine; EGC uses its portable engine (search falls back to substring matching)."
    }

    # egc-guardian
    Write-Host "  building egc-guardian..."
    $GuardianDir = Join-Path (Join-Path (Join-Path $RootDir "mcp") "servers") "egc-guardian"
    if (-not (Test-Path $GuardianDir)) {
        Write-Error "Not found: $GuardianDir"
        exit 1
    }
    Set-Location -Path $GuardianDir
    Install-Deps
    # The published package ships build/ but not src/, so only (re)build from
    # a git checkout where the TypeScript sources are present.
    if (Test-Path "src") {
        npm run build
    }

    # egc-memory
    Write-Host "  building egc-memory..."
    $MemoryDir = Join-Path (Join-Path (Join-Path $RootDir "mcp") "servers") "egc-memory"
    if (-not (Test-Path $MemoryDir)) {
        Write-Error "Not found: $MemoryDir"
        exit 1
    }
    Set-Location -Path $MemoryDir
    Install-Deps
    # Published package ships build/ but not src/; only build from a checkout.
    if (Test-Path "src") {
        npm run build
    }

    # Initialize database
    Write-Host "  initializing database..."
    Set-Location -Path $RootDir
    node $BootstrapDb
    Write-Host "  bootstrapping cognitive protocol..."
    node (Join-Path $RootDir (Join-Path "scripts" "bootstrap-cognitive.js"))

    # README promises memory "never gets committed to git" unconditionally,
    # but only `egc init` configured the filter that keeps that promise --
    # this quick-start script (the README's own documented command) never
    # did (2026-08-01 audit finding). Best-effort: must not fail the install.
    node "$RootDir/scripts/lib/apply-commit-privacy.js"
    if ($LASTEXITCODE -ne 0) { Write-Host "  note: commit-privacy filter setup failed (non-fatal)" }

    # Write harness config
    Set-Location -Path $RootDir
    $mcpConfig = @{
        mcpServers = @{
            "egc-guardian" = @{ command = "node"; args = @($GuardianBin) }
            "egc-memory"   = @{ command = "node"; args = @($MemoryBin)   }
        }
    } | ConvertTo-Json -Depth 4
    if (Test-DirectoryWritable $RootDir) {
        $mcpConfig | Set-Content -Path (Join-Path $RootDir ".mcp.egc.json") -Encoding UTF8
        Write-Host "  harness config written to .mcp.egc.json"
    } else {
        Write-Host "  note: $RootDir is read-only; skipping the .mcp.egc.json convenience copy"
    }
}

# Delegate to Node installer only when install-relevant args are present
Set-Location -Path $RootDir
$hasInstallArgs = $false
foreach ($arg in $args) {
    if ($arg -match '^(--target|--profile|--modules|--config|--with|--without|--dry-run|--json)$') {
        $hasInstallArgs = $true; break
    }
    if (-not $arg.StartsWith('-')) {
        $hasInstallArgs = $true; break
    }
}
if ($hasInstallArgs) {
    node $EgcInstall @args
    $installExitCode = $LASTEXITCODE
    # A refused or failed targeted install ends the run here, the way the
    # bash installer stops under set -e, instead of carrying on to the
    # prompt-library step and the registration as if it had succeeded.
    if ($DryRun -or $installExitCode -ne 0) {
        exit $installExitCode
    }
}

# Prompt library: opt-in. The question is asked only at an interactive
# console and defaults to no; --prompt-library answers yes without asking
# and --no-prompt-library skips the question. A headless run (CI, redirected
# stdin) skips it with a note: a piped stdin used to reach Read-Host, come
# back $null instantly and make the whole block vanish without a word
# (Windows report in #1217), so the gate tests IsInputRedirected and the
# skip is announced.
$isInteractive = [Environment]::UserInteractive -and -not $env:CI -and -not [Console]::IsInputRedirected
$installLibrary = $false
$libraryFailed = $false
if (-not $DryRun) {
    if ($PromptLibrary -eq $true) {
        $installLibrary = $true
    } elseif ($PromptLibrary -eq $false) {
        Write-Host "  prompt library skipped (--no-prompt-library). Run 'egc install --prompt-library' to add it later."
    } elseif ($isInteractive) {
        $ans = Read-Host "`n  Install prompt library? (61 agents, 232 skills, 77 commands) [y/N]"
        # A null or empty answer is the default: no. Only an explicit y installs.
        $installLibrary = ($ans -eq 'Y' -or $ans -eq 'y')
    } else {
        Write-Host "  note: non-interactive session; skipping the prompt-library step. Run 'egc install --prompt-library' to add it."
    }
}
if ($installLibrary) {
    # One detection list for every tool, shared with the shell installer:
    # scripts/lib/install/prompt-library.js applies the full profile to each
    # detected home target and runs the remaining per-tool shell scripts.
    node (Join-Path $RootDir (Join-Path "scripts" "install-prompt-library.js"))
    # A tool that did not get the library is reported at the end and turns
    # the exit status non-zero, after the engine steps below have all run.
    if ($LASTEXITCODE -ne 0) { $libraryFailed = $true }
}
if (-not $DryRun) {
    # MCP auto-registration
    Write-Host "  registering MCP servers..."

    # One registration list for every entry point. This block used to be a
    # hand-written copy of scripts/lib/mcp-register.js and had drifted:
    # Continue.dev and Zed were never registered here, so installing through
    # PowerShell wired up fewer tools than `egc init` did on the same machine.

    # Run from the directory the person invoked the installer in, so a
    # project .mcp.json there is picked up; the script itself moved to the
    # package root long ago.
    # -LiteralPath: a real directory whose name contains [ ] * or ? is a
    # wildcard pattern to Push-Location otherwise, and the resulting error
    # would abort the installer before registration and everything after it.
    Push-Location -LiteralPath $InvokedFromDir
    try {
        & node (Join-Path $RootDir "scripts/lib/mcp-register-cli.js") $GuardianBin $MemoryBin
    } finally {
        Pop-Location
    }

    # Install git pre-commit hook in a clone (strips egc:state blocks before
    # commits), through the helper install.sh runs as well.
    # A native command's failure is no terminating error in PowerShell, so the
    # exit code is read here, the way install.sh stops on it under set -e.
    node (Join-Path $RootDir (Join-Path "scripts" (Join-Path "lib" "git-pre-commit-install.js")))
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  git pre-commit hook could not be installed (exit code $LASTEXITCODE); the install stops here." -ForegroundColor Red
        exit $LASTEXITCODE
    }

    # Token Crusher PATH-level binary shim (git, npm, gh, ...). Best-effort:
    # a failure here (permission, unsupported shell profile, ...) must never
    # abort an otherwise successful install.
    Write-Host ""
    Write-Host "  installing Token Crusher binary shim..."
    $CrusherShim = Join-Path (Join-Path $RootDir "scripts") "crusher-shim.js"
    try {
        node $CrusherShim install
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  note: crusher-shim install failed (non-fatal). Run 'node scripts\crusher-shim.js install' manually to retry." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  note: crusher-shim install failed (non-fatal). Run 'node scripts\crusher-shim.js install' manually to retry." -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "Installation complete."
    if (-not $hasInstallArgs) {
        # Same single decision point as install.sh: shouldAutoLaunch()
        # inside the wrapper decides whether to launch, and prints the
        # headless message itself when it declines.
        & node (Join-Path $RootDir "scripts/lib/dashboard-launch-cli.js") $RootDir
    }
    Write-Host "Re-check anytime with 'egc doctor'."
    if ($libraryFailed) {
        Write-Host "  prompt library: one or more detected tools did not get it (see the notes above)." -ForegroundColor Yellow
        exit 1
    }
}
