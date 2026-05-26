$ErrorActionPreference = "Stop"

$RootDir = $PSScriptRoot
$EgcScript  = Join-Path (Join-Path $RootDir "scripts") "egc.js"
$EgcInstall = Join-Path (Join-Path $RootDir "scripts") "install-apply.js"

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
    node $EgcScript init
}

# Delegate to Node installer (handles --target, --dry-run, --modules, --profile, etc.)
Set-Location -Path $RootDir
node $EgcInstall @args

if (-not $DryRun) {
    # Final validation
    node $EgcScript doctor

    Write-Host ""
    Write-Host "Installation complete."
    Write-Host ""
    Write-Host "To add EGC to your harness, merge .mcp.egc.json into your harness MCP config."
    Write-Host "Run 'egc --help' for available commands."
}
