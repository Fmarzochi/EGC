$ErrorActionPreference = "Stop"

$RootDir       = $PSScriptRoot
$BootstrapDb   = Join-Path $RootDir "scripts" "bootstrap-state-db.js"
$EgcInstall    = Join-Path $RootDir "scripts" "install-apply.js"
$GuardianBin   = Join-Path $RootDir "mcp" "servers" "egc-guardian" "build" "index.js"
$MemoryBin     = Join-Path $RootDir "mcp" "servers" "egc-memory"   "build" "index.js"

# Forward --help directly to the Node installer
if ($args -contains '--help') {
    node $EgcInstall @args
    exit $LASTEXITCODE
}

Write-Host "EGC install"

# Node.js version check
try {
    $nodeVersion = node -e "process.stdout.write(process.versions.node.split('.')[0])"
    if ([int]$nodeVersion -lt 18) {
        Write-Error "Node.js >= 18 is required (found: $(node --version))"
        exit 1
    }
    Write-Host "  node $(node --version)"
} catch {
    Write-Error "Node.js not found. Install from https://nodejs.org"
    exit 1
}

$DryRun = $args -contains '--dry-run'

if (-not $DryRun) {
    # Root dependencies
    Write-Host "  installing root dependencies..."
    Set-Location -Path $RootDir
    npm install --silent

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
    $GuardianDir = Join-Path $RootDir "mcp" "servers" "egc-guardian"
    if (-Not (Test-Path $GuardianDir)) {
        Write-Error "Not found: $GuardianDir"
        exit 1
    }
    Set-Location -Path $GuardianDir
    npm install --silent
    npm run build

    # egc-memory
    Write-Host "  building egc-memory..."
    $MemoryDir = Join-Path $RootDir "mcp" "servers" "egc-memory"
    if (-Not (Test-Path $MemoryDir)) {
        Write-Error "Not found: $MemoryDir"
        exit 1
    }
    Set-Location -Path $MemoryDir
    npm install --silent
    npm run build

    # Initialize database
    Write-Host "  initializing database..."
    Set-Location -Path $RootDir
    node $BootstrapDb

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
            try { $obj = Get-Content $Target -Raw | ConvertFrom-Json -AsHashtable } catch {}
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
    $claudeConfig = Join-Path $env:APPDATA "Claude" "claude_desktop_config.json"
    if ((Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path (Split-Path $claudeConfig -Parent))) {
        Register-McpJson -Target $claudeConfig -Label "Claude Code"
    }

    # Cursor (Windows path)
    $cursorConfig = Join-Path $env:USERPROFILE ".cursor" "mcp.json"
    if ((Get-Command cursor -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE ".cursor"))) {
        Register-McpJson -Target $cursorConfig -Label "Cursor"
    }

    # Kiro
    $kiroConfig = Join-Path $env:USERPROFILE ".kiro" "settings" "mcp.json"
    if ((Get-Command kiro -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE ".kiro"))) {
        Register-McpJson -Target $kiroConfig -Label "Kiro"
    }

    # OpenCode
    $opencodeConfig = Join-Path $env:APPDATA "opencode" "config.json"
    if ((Get-Command opencode -ErrorAction SilentlyContinue) -or (Test-Path (Split-Path $opencodeConfig -Parent))) {
        Register-McpJson -Target $opencodeConfig -Label "OpenCode"
    }

    Write-Host ""
    Write-Host "Installation complete."
    Write-Host "Run 'egc doctor' to verify."
}
