param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = $PSScriptRoot

# ---------------------------------------------------------------------------
# 可选外部配置：与脚本同目录的 canvas.config.json
# 不写这个文件也能跑，下面每一项都有自动探测。
# ---------------------------------------------------------------------------
$configFile = Join-Path $root 'canvas.config.json'
$cfg = $null
if (Test-Path -LiteralPath $configFile) {
    $cfg = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
}

function Get-Cfg($name, $default) {
    if ($cfg -and $cfg.PSObject.Properties.Name -contains $name -and $cfg.$name) { return $cfg.$name }
    return $default
}

# ---------------------------------------------------------------------------
# 数据目录：优先配置，其次环境变量；老机器沿用原来的 D 盘位置，新机器落到本机用户目录
# ---------------------------------------------------------------------------
$state = Get-Cfg 'stateDir' $env:CANVAS_DATA_ROOT
if (-not $state) {
    $legacy = 'D:\CodexData\.codex\infinite-canvas'
    if (Test-Path -LiteralPath $legacy) { $state = $legacy }
    else { $state = Join-Path $env:LOCALAPPDATA 'InfiniteCanvas' }
}
$env:CANVAS_DATA_ROOT = $state

# Codex 的 home 与数据目录同级；老机器是 D:\CodexData\.codex，新机器放到数据目录下的 .codex
$codexHome = Get-Cfg 'codexHome' $env:CODEX_HOME
if (-not $codexHome) {
    $parent = Split-Path -Parent $state
    if ((Split-Path -Leaf $parent) -eq '.codex') { $codexHome = $parent }
    else { $codexHome = Join-Path $state '.codex' }
}
$env:CODEX_HOME = $codexHome

$tempDir = Get-Cfg 'tempDir' (Join-Path $state 'temp')
$env:TEMP = $tempDir
$env:TMP = $tempDir
$env:CANVAS_TEMP = $tempDir
$env:CANVAS_PROJECT_ROOT = $root
$env:CANVAS_AGENT_HOME = Join-Path $state 'agent'

# ---------------------------------------------------------------------------
# Codex：优先用配置，其次系统里找；找不到只影响 Agent 对话，画布仍可打开
# ---------------------------------------------------------------------------
$codexPath = Get-Cfg 'codexPath' ''
if (-not $codexPath) {
    $codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
    if ($codexCommand) { $codexPath = $codexCommand.Source }
    else {
        $codexPath = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | ForEach-Object {
            Join-Path $_.InstallLocation 'app\resources\codex.exe'
        } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
}
if ($codexPath) { $env:CANVAS_CODEX_EXECUTABLE = $codexPath }
else { Write-Warning 'Codex 未找到：画布能打开，但 Agent 对话不可用。' }

# ---------------------------------------------------------------------------
# Node：配置 > PATH > 常见安装位置
# ---------------------------------------------------------------------------
$node = Get-Cfg 'nodePath' ''
if (-not $node) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $node = $nodeCommand.Source }
}
if (-not $node) {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    $node = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $node) { throw '找不到 Node.js。请先安装 Node.js 18 以上版本，再重新运行。' }

$agentPort = Get-Cfg 'agentPort' 17381
$webPort = Get-Cfg 'webPort' 3010
$env:PORT = "$agentPort"

New-Item -ItemType Directory -Force $state, (Join-Path $state 'logs'), $env:CANVAS_AGENT_HOME, $tempDir | Out-Null

function Test-Endpoint($url) {
    try { return (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}

# ---------------------------------------------------------------------------
# MuseCanvas：别人的安装，路径可能在任意磁盘。找不到就跳过，不阻塞画布
# ---------------------------------------------------------------------------
$museLauncher = Get-Cfg 'museLauncher' ''
if (-not $museLauncher) {
    $museCandidates = @(
        'D:\CodexOutputs\MuseCanvas-Launcher.ps1',
        (Join-Path $env:LOCALAPPDATA 'MuseCanvas\scripts\Manage.ps1')
    )
    $museLauncher = $museCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not ((Test-Endpoint 'http://127.0.0.1:18610/healthz') -and (Test-Endpoint 'http://127.0.0.1:18611/health'))) {
    if ($museLauncher) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $museLauncher -NoBrowser
        if ($LASTEXITCODE -ne 0) { Write-Warning 'Muse 服务启动失败。画布仍会打开，可在画布顶部 Muse 面板查看状态。' }
    } else {
        Write-Warning '未找到 MuseCanvas，生成能力不可用。请先安装 MuseCanvas 并确认能登录。'
    }
}

# MuseCanvas 可能装在任意磁盘：把 install.json 位置传给前端进程，避免它去猜
$museInstall = Get-Cfg 'museInstall' ''
if (-not $museInstall -and $museLauncher) { $museInstall = Join-Path (Split-Path -Parent $museLauncher) 'MuseCanvasData\install.json' }
if ($museInstall -and (Test-Path -LiteralPath $museInstall)) { $env:MUSE_INSTALL_CONFIG = $museInstall }

# 豆包通道：安装脚本准备的 Python 在配置里，传给前端进程用
$doubaoPython = Get-Cfg 'doubaoPython' ''
if ($doubaoPython -and (Test-Path -LiteralPath $doubaoPython)) { $env:DOUBAO_PYTHON = $doubaoPython }

if (-not (Test-Endpoint "http://127.0.0.1:$agentPort/health")) {
    # 不重定向 stdout：Start-Process 的重定向句柄会随本脚本退出而关闭，导致 node 写日志时报错退出；改用 --debug 让日志落到文件
    $agent = Start-Process -FilePath $node -ArgumentList @("`"$root\canvas-agent\dist\index.js`"", '--debug') -WorkingDirectory $root -WindowStyle Hidden -PassThru
    $agent.Id | Set-Content (Join-Path $state 'agent.pid')
}
if (-not (Test-Endpoint "http://127.0.0.1:$webPort")) {
    $web = Start-Process -FilePath $node -ArgumentList @("`"$root\web\node_modules\vite\bin\vite.js`"", '--host', '127.0.0.1', '--port', "$webPort", '--strictPort') -WorkingDirectory (Join-Path $root 'web') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $state 'logs\web.log') -RedirectStandardError (Join-Path $state 'logs\web-error.log') -PassThru
    $web.Id | Set-Content (Join-Path $state 'web.pid')
}
for ($i = 0; $i -lt 60; $i++) {
    if ((Test-Endpoint "http://127.0.0.1:$agentPort/health") -and (Test-Endpoint "http://127.0.0.1:$webPort")) { break }
    Start-Sleep -Seconds 1
}
if (-not (Test-Endpoint "http://127.0.0.1:$webPort")) { throw "前端启动失败，请查看 $(Join-Path $state 'logs')" }
if (-not (Test-Endpoint "http://127.0.0.1:$agentPort/health")) { throw "画布 Agent 启动失败，请查看 $(Join-Path $state 'logs')" }

if (-not $NoBrowser) {
    $agentConfig = Get-Content (Join-Path $state 'agent\canvas-agent.json') -Raw | ConvertFrom-Json
    $url = "http://127.0.0.1:$webPort/canvas?mode=recent#agentUrl=" + [uri]::EscapeDataString($agentConfig.url) + '&agentToken=' + [uri]::EscapeDataString($agentConfig.token)

    $chrome = Get-Cfg 'chromePath' ''
    if (-not $chrome) {
        $chromeCandidates = @(
            (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
            (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
            (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
        )
        $chrome = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
    if (-not $chrome) { throw '找不到 Chrome 或 Edge，请先安装其中一个浏览器。' }

    # 画布专用浏览器配置：历史画布都存在这里，换掉会看起来像“画布全没了”
    $canvasProfile = Get-Cfg 'canvasProfile' ''
    if (-not $canvasProfile) {
        $knownProfile = 'D:\CodexOutputs\MuseCanvasData\browser-profiles\canvas'
        if (Test-Path -LiteralPath $knownProfile) { $canvasProfile = $knownProfile }
        else { $canvasProfile = Join-Path $state 'browser-profile' }
    }
    Start-Process -FilePath $chrome -ArgumentList @("--user-data-dir=`"$canvasProfile`"", '--no-first-run', '--no-default-browser-check', "`"$url`"")
}

Write-Output "Infinite Canvas is running: http://127.0.0.1:$webPort"
