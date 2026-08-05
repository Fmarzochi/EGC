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
    # npm publish. Best-effort: some environments lack permission to the
    # global npm prefix, and that must not abort the rest of the install.
    Write-Host "  linking the egc command to this checkout..."
    # PowerShell does not treat a non-zero exit code from a native command as
    # a terminating error, so a try/catch here would never fire: check
    # $LASTEXITCODE explicitly instead, matching the "||" pattern install.sh
    # uses for the same fallback (cubic review, PR #1096).
    npm link --silent 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  note: npm link failed (no permission to the global npm prefix?). Run 'npm link' manually, or use 'node scripts\egc.js <command>' from this checkout." -ForegroundColor Yellow
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
    node -e 'const rootDir = process.argv[1]; const { applyCommitPrivacyFilterCli } = require(rootDir + "/scripts/lib/memory-filters"); applyCommitPrivacyFilterCli({ projectDir: process.cwd(), scriptPath: rootDir + "/scripts/check-state-leak.js", log: m => console.log("  " + m) });' $RootDir
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
$isInteractive = [Environment]::UserInteractive -and -not $env:CI
if ($isInteractive -and -not $DryRun) {
    $ans = Read-Host "`n  Install prompt library? (62 agents, 228 skills, 74 commands) [Y/n]"
    if ($ans -eq '' -or $ans -eq 'Y' -or $ans -eq 'y') {
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


    # Claude Code - project .mcp.json: merge into an existing file in the
    # directory the installer was invoked from only. The package's own
    # bundled .mcp.json is not a user project, and creating a file in an
    # arbitrary cwd would litter. (Get-Location is useless here - the
    # script Set-Location'd to the package root long ago.)
    $projectMcp = Join-Path $InvokedFromDir ".mcp.json"
    if (Test-Path $projectMcp) {
        $invokedPhysical = Resolve-PhysicalDirectory $InvokedFromDir
        $rootPhysical = Resolve-PhysicalDirectory $RootDir
        if (-not $invokedPhysical -or -not $rootPhysical) {
            # Unresolvable means unknown, and an unknown directory is never
            # worth the risk of writing into the package's own config.
            Write-Host "  note: skipped project .mcp.json (could not resolve $InvokedFromDir to a physical path)"
        } elseif ($invokedPhysical -ne $rootPhysical) {
            Register-McpJson -Target $projectMcp -Label "Claude Code (project .mcp.json)"
        }
    }

    # One registration list for every entry point. This block used to be a
    # hand-written copy of scripts/lib/mcp-register.js and had drifted:
    # Continue.dev and Zed were never registered here, so installing through
    # PowerShell wired up fewer tools than `egc init` did on the same machine.
    # The paths below are still computed because the Obsidian propagation
    # further down reads them.
    $cursorConfig    = Join-Path (Join-Path $env:USERPROFILE ".cursor") "mcp.json"
    $kiroConfig      = Join-Path (Join-Path (Join-Path $env:USERPROFILE ".kiro") "settings") "mcp.json"
    $opencodeConfig  = Join-Path (Join-Path $env:APPDATA "opencode") "config.json"
    $agyDir          = Join-Path (Join-Path $env:USERPROFILE ".gemini") "antigravity-cli"
    $agyConfig       = Join-Path $agyDir "mcp_config.json"
    $geminiConfigDir = Join-Path (Join-Path $env:USERPROFILE ".gemini") "config"
    $geminiConfig    = Join-Path $geminiConfigDir "mcp_config.json"

    & node (Join-Path $RootDir "scripts/lib/mcp-register-cli.js") $GuardianBin $MemoryBin

    # Obsidian propagation (delegated to Node)
    # $claudeConfig (Claude Desktop's file) is gone from both lists: Claude
    # Code never read it, so it was a dead source and a dead target alike.
    # Propagating obsidian into Claude Code's real user scope needs the CLI
    # (claude mcp add-json) and is tracked as a follow-up.
    $obsidianSources = @($agyConfig, $geminiConfig, $cursorConfig)
    $findObsTmp = Join-Path $env:TEMP ("egc_obs_find_" + [System.Guid]::NewGuid().ToString("N") + ".js")
    Set-Content -Path $findObsTmp -Encoding UTF8 -Value @'
const fs=require("fs");
const srcs=process.argv.slice(2);
for(const s of srcs){try{const o=JSON.parse(fs.readFileSync(s,"utf8"));if(o.mcpServers&&o.mcpServers.obsidian){process.stdout.write(JSON.stringify(o.mcpServers.obsidian));process.exit(0);}}catch(_){}}
'@
    $existingSources = $obsidianSources | Where-Object { Test-Path $_ }
    $obsBlock = $null
    if ($existingSources) {
        try { $obsBlock = & node $findObsTmp @existingSources 2>$null } catch {}
    }
    Remove-Item $findObsTmp -ErrorAction SilentlyContinue

    if ($obsBlock) {
        $propObsTmp = Join-Path $env:TEMP ("egc_obs_prop_" + [System.Guid]::NewGuid().ToString("N") + ".js")
        Set-Content -Path $propObsTmp -Encoding UTF8 -Value @'
const fs=require("fs"),path=require("path");
const[,,t,b]=process.argv;
let obs;try{obs=JSON.parse(b);}catch(_){process.exit(0);}
let obj={mcpServers:{}};
if(fs.existsSync(t)){try{obj=JSON.parse(fs.readFileSync(t,"utf8"));}catch(_){process.exit(0);}}
if(!obj.mcpServers)obj.mcpServers={};
if(obj.mcpServers.obsidian)process.exit(0);
obj.mcpServers.obsidian=obs;
const d=path.dirname(t);if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true});
fs.writeFileSync(t,JSON.stringify(obj,null,2)+"\n");
'@
        $propagateTargets = @(
            @{ P = $agyConfig;     L = "Antigravity CLI" }
            @{ P = $geminiConfig;  L = "Gemini CLI" }
            @{ P = $cursorConfig;  L = "Cursor" }
            @{ P = $kiroConfig;    L = "Kiro" }
            @{ P = $opencodeConfig; L = "OpenCode" }
        )
        foreach ($pt in $propagateTargets) {
            try {
                node $propObsTmp $pt.P $obsBlock 2>$null
                if ($LASTEXITCODE -eq 0) { Write-Host "  v obsidian synced to $($pt.L)" }
            } catch {}
        }
        Remove-Item $propObsTmp -ErrorAction SilentlyContinue
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
    Write-Host "Run 'egc doctor' to verify."
}
