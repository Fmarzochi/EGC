$ErrorActionPreference = "Stop"

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

    # Claude Code (Windows path)
    $claudeConfig = Join-Path (Join-Path $env:APPDATA "Claude") "claude_desktop_config.json"
    if ((Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path (Split-Path $claudeConfig -Parent))) {
        Register-McpJson -Target $claudeConfig -Label "Claude Code"
    }

    # Claude Code - project .mcp.json (if present)
    $projectMcp = Join-Path $RootDir ".mcp.json"
    if (Test-Path $projectMcp) {
        Register-McpJson -Target $projectMcp -Label "Claude Code (project .mcp.json)"
    }

    # Cursor (Windows path)
    $cursorConfig = Join-Path (Join-Path $env:USERPROFILE ".cursor") "mcp.json"
    if ((Get-Command cursor -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE ".cursor"))) {
        Register-McpJson -Target $cursorConfig -Label "Cursor"
    }

    # Kiro
    $kiroConfig = Join-Path (Join-Path (Join-Path $env:USERPROFILE ".kiro") "settings") "mcp.json"
    if ((Get-Command kiro -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE ".kiro"))) {
        Register-McpJson -Target $kiroConfig -Label "Kiro"
    }

    # OpenCode
    $opencodeConfig = Join-Path (Join-Path $env:APPDATA "opencode") "config.json"
    if ((Get-Command opencode -ErrorAction SilentlyContinue) -or (Test-Path (Split-Path $opencodeConfig -Parent))) {
        Register-McpJson -Target $opencodeConfig -Label "OpenCode"
    }

    # AGY (Antigravity CLI)
    $agyDir    = Join-Path (Join-Path $env:USERPROFILE ".gemini") "antigravity-cli"
    $agyConfig = Join-Path $agyDir "mcp_config.json"
    if (Test-Path $agyDir) {
        Register-McpJson -Target $agyConfig -Label "Antigravity CLI"
    }

    # Gemini CLI (only when AGY is absent)
    $geminiConfigDir = Join-Path (Join-Path $env:USERPROFILE ".gemini") "config"
    $geminiConfig    = Join-Path $geminiConfigDir "mcp_config.json"
    if ((Test-Path $geminiConfigDir) -and -not (Test-Path $agyDir)) {
        Register-McpJson -Target $geminiConfig -Label "Gemini CLI"
    }

    # Codex CLI (TOML - delegated to Node)
    $codexToml = Join-Path (Join-Path $env:USERPROFILE ".codex") "config.toml"
    if ((Get-Command codex -ErrorAction SilentlyContinue) -or (Test-Path $codexToml)) {
        $tmpCodexJs = Join-Path $env:TEMP ("egc_codex_" + [System.Guid]::NewGuid().ToString("N") + ".js")
        Set-Content -Path $tmpCodexJs -Encoding UTF8 -Value @'
const fs=require("fs"),path=require("path");
const[,,t,g,m]=process.argv;
// Escape backslashes (Windows paths are the common case here) and double
// quotes so the path stays a valid TOML basic string; mirrors tomlEscape in
// scripts/install.sh and scripts/lib/mcp-register.js. Without this, a raw
// Windows path like C:\Users\x\... corrupts the TOML (\U... reads as an
// invalid/wrong Unicode escape).
const tomlEscape=(p)=>p.split("\\").join("\\\\").split('"').join('\\"');
const ge='\n[[mcp_servers]]\nname = "egc-guardian"\ncommand = "node"\nargs = ["'+tomlEscape(g)+'"]\n';
const me='\n[[mcp_servers]]\nname = "egc-memory"\ncommand = "node"\nargs = ["'+tomlEscape(m)+'"]\n';
let c=fs.existsSync(t)?fs.readFileSync(t,"utf8"):"";
let ch=false;
if(!c.includes("egc-guardian")){c+=ge;ch=true;}
if(!c.includes("egc-memory")){c+=me;ch=true;}
if(!ch)process.exit(0);
const d=path.dirname(t);if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true});
fs.writeFileSync(t,c);
'@
        try {
            node $tmpCodexJs $codexToml $GuardianBin $MemoryBin 2>$null
            if ($LASTEXITCODE -eq 0) { Write-Host "  v registered in Codex CLI ($codexToml)" }
        } catch {}
        Remove-Item $tmpCodexJs -ErrorAction SilentlyContinue
    }

    # Obsidian propagation (delegated to Node)
    $obsidianSources = @($agyConfig, $geminiConfig, $claudeConfig, $cursorConfig)
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
            @{ P = $claudeConfig;  L = "Claude Code" }
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

    Write-Host ""
    Write-Host "Installation complete."
    if (-not $hasInstallArgs) {
        Write-Host "Dashboard was not started automatically."
        Write-Host "Run 'egc dashboard' to start it, or run 'egc init' inside a project for project setup."
    }
    Write-Host "Run 'egc doctor' to verify."
}
