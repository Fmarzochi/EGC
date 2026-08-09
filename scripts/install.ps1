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
function Install-Deps {
    if (Test-Path "package-lock.json") {
        npm ci --silent
    }
}

# Two paths can name the same directory in several ways: different separators
# (C:/repo vs C:\repo, routine when the installer is launched from Git Bash),
# a trailing slash, or a symlink/junction anywhere along the path, including a
# parent component. Comparing anything less than the fully resolved physical
# path risks treating the package's own directory as somebody's project and
# rewriting its bundled .mcp.json. .NET's ResolveLinkTarget is unavailable in
# Windows PowerShell 5.1, so each component is resolved in turn (with a small
# depth cap for chained links), which works on every supported version.
function Resolve-PhysicalDirectory {
    param([string]$Path)

    # Returns $null when the path cannot be fully resolved. Callers must
    # treat that as "unknown", never as "different": a partial answer here
    # is what would let the installer mistake its own directory for a user
    # project and rewrite the bundled .mcp.json.
    try {
        $full = [System.IO.Path]::GetFullPath($Path)
    } catch {
        return $null
    }

    # Components are consumed from a queue rather than a fixed list: when one
    # of them turns out to be a link, the target's own components are pushed
    # back onto the front of the queue, so links nested inside a link target
    # get resolved on the same pass. The step budget only bounds pathological
    # cycles; it is never reached by a real directory tree.
    $pending = New-Object 'System.Collections.Generic.Queue[string]'
    $resolved = [System.IO.Path]::GetPathRoot($full)
    foreach ($segment in ($full.Substring($resolved.Length).Trim('\', '/') -split '[\\/]+')) {
        if ($segment) { $pending.Enqueue($segment) }
    }

    $steps = 0
    while ($pending.Count -gt 0) {
        $steps++
        # Only a cyclic link chain gets here; a real tree never does. The
        # path stays unresolved rather than half-resolved.
        if ($steps -gt 512) { return $null }

        $segment = $pending.Dequeue()
        if ($segment -eq '.') { continue }
        if ($segment -eq '..') {
            $resolved = [System.IO.Path]::GetFullPath((Join-Path $resolved '..'))
            continue
        }

        $candidate = Join-Path $resolved $segment
        $item = $null
        try {
            $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
        } catch {
            $item = $null
        }

        $target = $null
        if ($item -and $item.PSObject.Properties['Target'] -and $item.Target) {
            $target = @($item.Target)[0]
        }
        if (-not $target) {
            $resolved = $candidate
            continue
        }

        $remaining = @($pending.ToArray())
        $pending.Clear()
        if ([System.IO.Path]::IsPathRooted($target)) {
            $targetRoot = [System.IO.Path]::GetPathRoot($target)
            $targetTail = $target.Substring($targetRoot.Length)
            $resolved = $targetRoot
        } else {
            # A relative target is relative to the link's own directory, which
            # is exactly where $resolved already points.
            $targetTail = $target
        }
        foreach ($piece in ($targetTail.Trim('\', '/') -split '[\\/]+')) {
            if ($piece) { $pending.Enqueue($piece) }
        }
        foreach ($piece in $remaining) { $pending.Enqueue($piece) }
    }

    return [System.IO.Path]::GetFullPath($resolved).TrimEnd('\', '/')
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
    $nodeVersion = node -e "process.stdout.write(process.versions.node.split('.')[0])"
    if ([int]$nodeVersion -lt 20) {
        Write-Error "Node.js >= 20 is required (found: $(node --version))"
        exit 1
    }
    Write-Host "  node $(node --version)"
} catch {
    Write-Error "Node.js not found. Install from https://nodejs.org"
    exit 1
}

$DryRun = $args -contains '--dry-run'

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
    # npm publish. Skipped when this tree IS the global npm install
    # (`egc install` right after `npm install -g @egchq/egc`): the egc
    # command on PATH already points here, so there is nothing stale to
    # outrank, and without permission to the global prefix the link can only
    # fail and print a note about a checkout the person does not have
    # (#1218 Linux report). Best-effort: some environments lack permission
    # to the global npm prefix, and that must not abort the rest of the
    # install.
    $GlobalNpmRoot = (& npm root -g 2>$null)
    $IsGlobalNpmInstall = $false
    if ($GlobalNpmRoot) {
        $GlobalPkgDir = Join-Path (Join-Path $GlobalNpmRoot "@egchq") "egc"
        if (Test-Path $GlobalPkgDir) {
            $IsGlobalNpmInstall = ((Resolve-Path $GlobalPkgDir).Path -eq (Resolve-Path $RootDir).Path)
        }
    }
    if ($IsGlobalNpmInstall) {
        Write-Host "  egc command already provided by the global npm install"
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

    # Verify native modules (better-sqlite3 requires Build Tools on Windows)
    $nativeOk = $true
    try {
        node -e "require('better-sqlite3')" 2>$null
    } catch {
        $nativeOk = $false
    }
    if (-not $nativeOk) {
        Write-Host ""
        Write-Host "  WARNING: better-sqlite3 native module unavailable." -ForegroundColor Yellow
        Write-Host "    SQLite CLI features (egc status, egc sessions) will be disabled." -ForegroundColor Yellow
        Write-Host "    Core memory features via egc-memory MCP server are unaffected." -ForegroundColor Yellow
        Write-Host "    To enable full SQLite, install Visual Studio Build Tools:" -ForegroundColor Yellow
        Write-Host "    https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Yellow
        Write-Host ""
    }

    # egc-guardian
    Write-Host "  building egc-guardian..."
    $GuardianDir = Join-Path (Join-Path (Join-Path $RootDir "mcp") "servers") "egc-guardian"
    if (-Not (Test-Path $GuardianDir)) {
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
    if (-Not (Test-Path $MemoryDir)) {
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
    $mcpConfig | Set-Content -Path (Join-Path $RootDir ".mcp.egc.json") -Encoding UTF8
    Write-Host "  harness config written to .mcp.egc.json"
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
    if ($DryRun) {
        exit $installExitCode
    }
}

# Interactive ecosystem install (skipped in headless/CI)
$isInteractive = [Environment]::UserInteractive -and -not $env:CI -and -not [Console]::IsInputRedirected
if ($isInteractive -and -not $DryRun) {
    $ans = Read-Host "`n  Install prompt library? (61 agents, 230 skills, 77 commands) [Y/n]"
    if ([string]::IsNullOrEmpty($ans) -or $ans -eq 'Y' -or $ans -eq 'y') {
        if ((Get-Command gemini -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE ".gemini"))) {
            Write-Host "  installing to Gemini / AGY..."
            node $EgcInstall --target egc --profile full
        }
        if ((Get-Command codex -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE ".codex"))) {
            Write-Host "  installing to Codex..."
            node $EgcInstall --target codex --profile full
        }
        if ((Get-Command opencode -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE ".opencode"))) {
            Write-Host "  installing to OpenCode..."
            node $EgcInstall --target opencode --profile full
        }
        if ((Get-Command kiro -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE ".kiro"))) {
            if (Get-Command bash -ErrorAction SilentlyContinue) {
                Write-Host "  installing to Kiro..."
                bash (Join-Path $RootDir (Join-Path ".kiro" "install.sh")) ~
            } else {
                Write-Host "  note: Kiro detected but bash not available - run manually: bash .kiro/install.sh ~" -ForegroundColor Yellow
            }
        }
        if ((Get-Command trae -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE ".trae")) -or (Test-Path (Join-Path $env:USERPROFILE ".trae-cn"))) {
            if (Get-Command bash -ErrorAction SilentlyContinue) {
                Write-Host "  installing to Trae..."
                bash (Join-Path $RootDir (Join-Path ".trae" "install.sh")) ~
            } else {
                Write-Host "  note: Trae detected but bash not available - run manually: bash .trae/install.sh ~" -ForegroundColor Yellow
            }
        }
        if ((Get-Command codebuddy -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE ".codebuddy"))) {
            if (Get-Command bash -ErrorAction SilentlyContinue) {
                Write-Host "  installing to CodeBuddy..."
                bash (Join-Path $RootDir (Join-Path ".codebuddy" "install.sh")) ~
            } else {
                Write-Host "  note: CodeBuddy detected but bash not available - run manually: bash .codebuddy/install.sh ~" -ForegroundColor Yellow
            }
        }
    }
} elseif (-not $DryRun) {
    # A piped or redirected stdin used to reach the Read-Host above and come
    # back $null instantly, and `$null -eq ''` is false in PowerShell, so the
    # whole ecosystem block vanished without a word (Windows report in #1217:
    # install-state left at the previous version). Announce the skip instead.
    Write-Host "  note: non-interactive session; skipping the prompt-library step. Run 'egc install --target <tool> --profile full' to add it."
}

if (-not $DryRun) {
    # MCP auto-registration
    Write-Host "  registering MCP servers..."

    function Register-McpJson {
        param([string]$Target, [string]$Label)
        $dir = Split-Path $Target -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $obj = @{ mcpServers = @{} }
        if (Test-Path $Target) {
            try {
                $obj = Get-Content $Target -Raw | ConvertFrom-Json -AsHashtable
            } catch {
                # Existing config is not valid JSON: leave it untouched and
                # skip, matching install.sh's Node helper exactly. Falling
                # through here would merge the new servers into a fresh empty
                # hashtable and overwrite the file, destroying whatever the
                # user already had in it.
                Write-Host "  - skipped $Label ($Target): existing config is not valid JSON" -ForegroundColor Yellow
                return
            }
        }
        if (-not $obj.mcpServers) { $obj.mcpServers = @{} }
        $changed = $false
        if (-not $obj.mcpServers.ContainsKey("egc-guardian")) {
            $obj.mcpServers["egc-guardian"] = @{ command = "node"; args = @($GuardianBin) }
            $changed = $true
        }
        if (-not $obj.mcpServers.ContainsKey("egc-memory")) {
            $obj.mcpServers["egc-memory"] = @{ command = "node"; args = @($MemoryBin) }
            $changed = $true
        }
        if ($changed) {
            $obj | ConvertTo-Json -Depth 6 | Set-Content -Path $Target -Encoding UTF8
            Write-Host "  v registered in $Label ($Target)"
        }
    }

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
}
