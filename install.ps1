param(
    [string]$Destination = '',
    [string]$DataDirectory = '',
    [switch]$SkipDeps,
    [switch]$NoShortcut,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = $PSScriptRoot

# ---------------------------------------------------------------------------
# 结果记录：最后按「通过 / 未通过 / 未测试」分别报告，不笼统说成功
# ---------------------------------------------------------------------------
$results = New-Object System.Collections.ArrayList
function Add-Result($status, $name, $detail) {
    [void]$results.Add([pscustomobject]@{ Status = $status; Name = $name; Detail = $detail })
    $mark = switch ($status) { 'pass' { '[通过]' } 'fail' { '[未通过]' } 'warn' { '[注意]' } default { '[未测试]' } }
    Write-Host "$mark $name" -ForegroundColor $(switch ($status) { 'pass' { 'Green' } 'fail' { 'Red' } 'warn' { 'Yellow' } default { 'Gray' } })
    if ($detail) { Write-Host "       $detail" -ForegroundColor DarkGray }
}
function Write-Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }

Write-Host ''
Write-Host '无限画布 · 本机安装' -ForegroundColor White
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host '安装过程不会删除任何已有数据，不会停止与它无关的程序，' -ForegroundColor DarkGray
Write-Host '也不会代你登录任何账号。' -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 1. 程序目录
# ---------------------------------------------------------------------------
Write-Step '确认安装位置'

if (-not $Destination) { $Destination = $source }
$Destination = [System.IO.Path]::GetFullPath($Destination)
$installingInPlace = ($Destination.TrimEnd('\') -eq $source.TrimEnd('\'))

$driveLetter = (Split-Path -Qualifier $Destination).TrimEnd(':')
try {
    $freeGB = [math]::Round((Get-PSDrive -Name $driveLetter -ErrorAction Stop).Free / 1GB, 1)
} catch { $freeGB = $null }

if ($driveLetter -ieq 'C') {
    Add-Result 'warn' '安装位置在 C 盘' "素材和模型会很快占满系统盘。建议换到其他磁盘，例如 -Destination 'D:\InfiniteCanvas'"
} elseif ($null -ne $freeGB -and $freeGB -lt 5) {
    Add-Result 'warn' '磁盘空间偏小' "$driveLetter 盘剩余 $freeGB GB，建议至少 5 GB"
} else {
    Add-Result 'pass' '安装位置' "$Destination$(if ($null -ne $freeGB) { "（剩余 $freeGB GB）" })"
}

if (-not $installingInPlace) {
    Write-Host "    正在复制程序文件到 $Destination ..." -ForegroundColor DarkGray
    New-Item -ItemType Directory -Force $Destination | Out-Null
    $excludeDirs = @('node_modules', '.git', '__pycache__')
    $excludeFiles = @('canvas.config.json', '*.log', '*.bak-*')
    $robocopyArgs = @($source, $Destination, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    if ($excludeDirs.Count) { $robocopyArgs += '/XD'; $robocopyArgs += $excludeDirs }
    if ($excludeFiles.Count) { $robocopyArgs += '/XF'; $robocopyArgs += $excludeFiles }
    & robocopy.exe @robocopyArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { Add-Result 'fail' '复制程序文件' "robocopy 返回 $LASTEXITCODE，请检查目标目录权限" }
    else { Add-Result 'pass' '复制程序文件' '' }
}

# ---------------------------------------------------------------------------
# 2. Node.js
# ---------------------------------------------------------------------------
Write-Step '检查 Node.js'

$node = $null
# 优先系统安装的 Node（路径稳定），最后才用 PATH 里的（可能是某个工具自带的运行时）
$nodeCandidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
)
$node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $node) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $node = $nodeCommand.Source }
}

if (-not $node) {
    Add-Result 'fail' 'Node.js' '未安装。请先安装 Node.js 18 或更高版本：https://nodejs.org/ ，装完重新运行本脚本'
    Write-Host ''
    Write-Host '安装已停止。装好 Node.js 后再运行一次即可，不需要删除任何文件。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '结果汇总' -ForegroundColor White
    $results | ForEach-Object { Write-Host ("  {0,-6} {1} {2}" -f $_.Status, $_.Name, $_.Detail) -ForegroundColor DarkGray }
    exit 1
}

$nodeVersion = (& $node -v) -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 18) {
    Add-Result 'fail' 'Node.js 版本过低' "当前 $nodeVersion，需要 18 或更高。请升级后重新运行"
    exit 1
}
Add-Result 'pass' 'Node.js' "v$nodeVersion（$node）"

$npm = Join-Path (Split-Path $node -Parent) 'npm.cmd'
if (-not (Test-Path -LiteralPath $npm)) { $npm = 'npm.cmd' }

# ---------------------------------------------------------------------------
# 3. 浏览器
# ---------------------------------------------------------------------------
Write-Step '检查浏览器'

$browser = $null
$browserCandidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
)
$browser = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if ($browser) { Add-Result 'pass' '浏览器' (Split-Path $browser -Leaf) }
else { Add-Result 'fail' '浏览器' '未找到 Chrome 或 Edge。画布需要其中一个，请先安装' }

# ---------------------------------------------------------------------------
# 4. MuseCanvas（第三方，只检测不安装）
# ---------------------------------------------------------------------------
Write-Step '检查 MuseCanvas（第三方软件，不由本脚本安装）'

$museInstall = $null
foreach ($p in @(
    'D:\CodexOutputs\MuseCanvasData\install.json',
    (Join-Path $env:LOCALAPPDATA 'MuseCanvasData\install.json'),
    (Join-Path $env:ProgramData 'MuseCanvasData\install.json')
)) {
    if (Test-Path -LiteralPath $p) { $museInstall = $p; break }
}
# 装在别的盘时靠端口判断（不做全盘搜索，避免在别人机器上扫几分钟）
$museRunning = $false
if (-not $museInstall) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18610/healthz' -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $museRunning = $true }
    } catch { }
}

if ($museInstall) {
    Add-Result 'pass' 'MuseCanvas' $museInstall
} elseif ($museRunning) {
    Add-Result 'warn' 'MuseCanvas 在运行但找不到配置' "服务有响应，但读不到 install.json。请在 canvas.config.json 里把 museInstall 指向 MuseCanvasData\install.json"
} else {
    Add-Result 'warn' 'MuseCanvas 未安装' '画布能打开和编辑，但出不了图。请先自行安装 MuseCanvas 并登录自己的 Muse 账号'
}

# ---------------------------------------------------------------------------
# 5. 安装依赖
# ---------------------------------------------------------------------------
if (-not $SkipDeps) {
    Write-Step '安装依赖（首次需要几分钟，请勿关闭窗口）'

    Push-Location (Join-Path $Destination 'web')
    try {
        Write-Host '    web ...' -ForegroundColor DarkGray
        & $npm install --no-audit --no-fund 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Add-Result 'pass' '前端依赖' '' }
        else { Add-Result 'fail' '前端依赖' "npm install 返回 $LASTEXITCODE，可在 $Destination\web 手动执行 npm install 查看详细报错" }
    } finally { Pop-Location }

    Push-Location (Join-Path $Destination 'canvas-agent')
    try {
        Write-Host '    canvas-agent ...' -ForegroundColor DarkGray
        & $npm install --no-audit --no-fund 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Add-Result 'pass' 'Agent 依赖' '' }
        else { Add-Result 'fail' 'Agent 依赖' "npm install 返回 $LASTEXITCODE" }

        Write-Host '    构建 Agent ...' -ForegroundColor DarkGray
        & $npm run build 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $Destination 'canvas-agent\dist\index.js'))) { Add-Result 'pass' 'Agent 构建' '' }
        else { Add-Result 'fail' 'Agent 构建' '未生成 canvas-agent\dist\index.js，可在该目录手动执行 npm run build 查看报错' }
    } finally { Pop-Location }
} else {
    Add-Result 'warn' '依赖安装' '已按参数跳过，启动前请确认两处 node_modules 与 canvas-agent\dist 存在'
}

# ---------------------------------------------------------------------------
# 6. 配置
# ---------------------------------------------------------------------------
Write-Step '生成配置'

$configPath = Join-Path $Destination 'canvas.config.json'
if (Test-Path -LiteralPath $configPath) {
    # 已存在就不覆盖用户设置，只修掉失效的程序路径（比如换了 Node 安装位置）
    try {
        $existing = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $dirty = $false
        if (-not $existing.nodePath -or -not (Test-Path -LiteralPath $existing.nodePath)) { $existing.nodePath = $node; $dirty = $true }
        if ($browser -and (-not $existing.chromePath -or -not (Test-Path -LiteralPath $existing.chromePath))) { $existing.chromePath = $browser; $dirty = $true }
        $hasMuseField = $existing.PSObject.Properties.Name -contains 'museInstall'
        if ($museInstall -and ((-not $hasMuseField) -or -not $existing.museInstall -or -not (Test-Path -LiteralPath $existing.museInstall))) {
            $existing | Add-Member -NotePropertyName museInstall -NotePropertyValue $museInstall -Force
            $dirty = $true
        }
        if ($dirty) {
            [System.IO.File]::WriteAllText($configPath, ($existing | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
            Add-Result 'pass' '配置文件' '已存在，修正了失效的程序路径'
        } else {
            Add-Result 'pass' '配置文件' '已存在，保持不动'
        }
    } catch {
        Add-Result 'warn' '配置文件' "已存在但无法解析，保留原文件：$configPath"
    }
} else {
    $config = [ordered]@{
        stateDir      = $DataDirectory
        nodePath      = $node
        chromePath    = if ($browser) { $browser } else { '' }
        museInstall   = if ($museInstall) { $museInstall } else { '' }
        canvasProfile = ''
        museLauncher  = ''
        agentPort     = 17381
        webPort       = 3010
    }
    $json = $config | ConvertTo-Json
    [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Add-Result 'pass' '配置文件' $configPath
}

if ($DataDirectory) {
    New-Item -ItemType Directory -Force $DataDirectory | Out-Null
    Add-Result 'pass' '数据目录' $DataDirectory
} else {
    Add-Result 'pass' '数据目录' '默认位置（沿用已有目录，否则用 %LOCALAPPDATA%\InfiniteCanvas）'
}

# ---------------------------------------------------------------------------
# 7. 快捷方式
# ---------------------------------------------------------------------------
if (-not $NoShortcut) {
    Write-Step '创建桌面快捷方式'
    try {
        $desktop = [Environment]::GetFolderPath('Desktop')
        $shell = New-Object -ComObject WScript.Shell
        $startScript = Join-Path $Destination 'Start-InfiniteCanvas.ps1'
        $stopScript = Join-Path $Destination 'Stop-InfiniteCanvas.ps1'

        $lnk = $shell.CreateShortcut((Join-Path $desktop '无限画布.lnk'))
        $lnk.TargetPath = 'powershell.exe'
        $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
        $lnk.WorkingDirectory = $Destination
        $lnk.IconLocation = 'powershell.exe,0'
        $lnk.Save()

        $lnkStop = $shell.CreateShortcut((Join-Path $desktop '无限画布 - 停止.lnk'))
        $lnkStop.TargetPath = 'powershell.exe'
        $lnkStop.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$stopScript`""
        $lnkStop.WorkingDirectory = $Destination
        $lnkStop.IconLocation = 'powershell.exe,0'
        $lnkStop.Save()

        Add-Result 'pass' '桌面快捷方式' '「无限画布」与「无限画布 - 停止」'
    } catch {
        Add-Result 'warn' '桌面快捷方式' "创建失败：$($_.Exception.Message)。可直接运行 Start-InfiniteCanvas.ps1"
    }
}

# ---------------------------------------------------------------------------
# 8. 启动
# ---------------------------------------------------------------------------
if (-not $NoStart) {
    Write-Step '启动'
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Destination 'Start-InfiniteCanvas.ps1') | Out-Null
        Add-Result 'pass' '启动' '画布应已在浏览器中打开'
    } catch {
        Add-Result 'fail' '启动' $_.Exception.Message
    }
}

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host '安装结果' -ForegroundColor White
foreach ($group in @(@('pass', '通过'), @('fail', '未通过'), @('warn', '需要注意'), @('untested', '未测试'))) {
    $items = $results | Where-Object { $_.Status -eq $group[0] }
    if (-not $items) { continue }
    Write-Host ''
    Write-Host "  $($group[1])" -ForegroundColor $(switch ($group[0]) { 'pass' { 'Green' } 'fail' { 'Red' } 'warn' { 'Yellow' } default { 'Gray' } })
    foreach ($item in $items) { Write-Host "   - $($item.Name)：$($item.Detail)" -ForegroundColor Gray }
}

Write-Host ''
Write-Host '  未测试（这类操作会花额度或影响账号，需要你本人确认后使用）' -ForegroundColor Gray
Write-Host '   - 真实出图 / 出视频：需要 MuseCanvas 已装且登录自己的 Muse 账号' -ForegroundColor Gray
Write-Host '   - 真实发布：需要在「自动发布」页面逐个平台扫码登录' -ForegroundColor Gray
Write-Host '   - Agent 对话：需要登录 Codex 或 Claude 的账号' -ForegroundColor Gray

Write-Host ''
Write-Host "程序目录：$Destination" -ForegroundColor White
Write-Host '启动：桌面「无限画布」快捷方式，或运行 Start-InfiniteCanvas.ps1' -ForegroundColor White
Write-Host '停止：桌面「无限画布 - 停止」快捷方式，或运行 Stop-InfiniteCanvas.ps1' -ForegroundColor White
Write-Host ''

if ($results | Where-Object { $_.Status -eq 'fail' }) { exit 1 } else { exit 0 }
