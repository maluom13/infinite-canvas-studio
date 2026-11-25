$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = $PSScriptRoot

$configFile = Join-Path $root 'canvas.config.json'
$cfg = $null
if (Test-Path -LiteralPath $configFile) {
    $cfg = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
}

$state = $env:CANVAS_DATA_ROOT
if (-not $state -and $cfg -and $cfg.PSObject.Properties.Name -contains 'stateDir' -and $cfg.stateDir) { $state = $cfg.stateDir }
if (-not $state) {
    $legacy = 'D:\CodexData\.codex\infinite-canvas'
    if (Test-Path -LiteralPath $legacy) { $state = $legacy }
    else { $state = Join-Path $env:LOCALAPPDATA 'InfiniteCanvas' }
}

foreach ($name in @('web', 'agent')) {
    $file = Join-Path $state "$name.pid"
    if (Test-Path -LiteralPath $file) {
        $processId = [int](Get-Content -LiteralPath $file)
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
        # 只结束本程序目录下的进程，避免 PID 被系统复用时误杀别的程序
        if ($process -and $process.CommandLine -and $process.CommandLine.Contains($root)) {
            # Agent 由 node 托管，需要连同子进程一起结束
            & taskkill.exe /PID $processId /T /F | Out-Null
        }
        Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue
    }
}
