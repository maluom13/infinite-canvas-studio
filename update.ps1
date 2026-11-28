param(
    [string]$Destination = '',
    [string]$Version = 'v0.21.2',
    [string]$FromZip = '',
    [switch]$Force,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [通过] $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "  [注意] $text" -ForegroundColor Yellow }
function Write-Bad($text) { Write-Host "  [失败] $text" -ForegroundColor Red }

Write-Host ''
Write-Host "无限画布 · 一键更新到 $Version" -ForegroundColor White
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host '这个脚本只做一件事：把程序文件换成新版。' -ForegroundColor DarkGray
Write-Host '不会动你的配置（canvas.config.json）和数据目录，作品和登录态都保留。' -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 1. 找到程序目录
# ---------------------------------------------------------------------------
Write-Step '确认程序目录'

if (-not $Destination) {
    # 优先问正在运行的服务：它自己知道程序在哪，比让人去找目录可靠
    $ports = @(3010)
    $cfgPath = Join-Path $PSScriptRoot 'canvas.config.json'
    if (Test-Path -LiteralPath $cfgPath) {
        try {
            $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
            if ($cfg.webPort) { $ports = @([int]$cfg.webPort) + $ports | Select-Object -Unique }
        } catch { }
    }
    foreach ($port in $ports) {
        try {
            $probe = Invoke-RestMethod -Uri "http://127.0.0.1:$port/muse/version" -TimeoutSec 5
            if ($probe.projectRoot -and (Test-Path -LiteralPath (Join-Path $probe.projectRoot 'VERSION'))) {
                $Destination = $probe.projectRoot
                Write-Ok "从运行中的服务读到程序目录：$Destination"
                break
            }
        } catch { }
    }
}
if (-not $Destination) {
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'VERSION')) { $Destination = $PSScriptRoot }
}
if (-not $Destination) {
    Write-Bad '找不到程序目录。请把本脚本放到程序目录里运行，或用 -Destination 指定。'
    exit 1
}
$Destination = [System.IO.Path]::GetFullPath($Destination)

if (-not (Test-Path -LiteralPath (Join-Path $Destination 'VERSION'))) {
    Write-Bad "$Destination 不像是程序目录（里面没有 VERSION 文件）。"
    exit 1
}
Write-Ok "程序目录：$Destination"

$current = (Get-Content -LiteralPath (Join-Path $Destination 'VERSION') -Raw).Trim()
Write-Host "  当前版本：$current    目标版本：$Version" -ForegroundColor Gray

if ($current -eq $Version -and -not $Force) {
    Write-Host ''
    Write-Ok "已经是 $Version，不需要更新。"
    Write-Host '  如果确实要重装同一版本，加 -Force 再运行。' -ForegroundColor Gray
    exit 0
}

# ---------------------------------------------------------------------------
# 2. 下载
# ---------------------------------------------------------------------------
Write-Step '下载新版文件'

$repo = 'maluom13/infinite-canvas-studio'
# 更新包单独放在 Release 里，GitHub 会统计下载次数（和全新安装分开）。
# 镜像站只用于网络不通时兜底，不计入统计。
$asset = "lingjing-canvas-update-$Version.zip"
$releaseUrl = "https://github.com/$repo/releases/download/$Version/$asset"
$urls = @(
    $releaseUrl,
    "https://ghfast.top/$releaseUrl",
    "https://gh-proxy.com/$releaseUrl",
    "https://ghproxy.net/$releaseUrl",
    "https://github.com/$repo/archive/refs/tags/$Version.zip"
)

$work = Join-Path $env:TEMP ("canvas-update-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$zip = Join-Path $work 'release.zip'
$downloaded = $false

if ($FromZip) {
    # 已经用 U 盘/聊天工具把 ZIP 传过来了，直接用，不联网
    if (-not (Test-Path -LiteralPath $FromZip)) {
        Write-Bad "指定的 ZIP 不存在：$FromZip"
        exit 1
    }
    Copy-Item -LiteralPath $FromZip -Destination $zip -Force
    Write-Ok "使用本地 ZIP：$FromZip"
    $downloaded = $true
}

foreach ($url in $urls) {
    if ($downloaded) { break }
    $hostName = ([Uri]$url).Host
    Write-Host "  尝试 $hostName ..." -NoNewline -ForegroundColor Gray
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 120 -UseBasicParsing
        if ((Test-Path -LiteralPath $zip) -and ((Get-Item -LiteralPath $zip).Length -gt 200000)) {
            Write-Host ' 成功' -ForegroundColor Green
            $downloaded = $true
        } else {
            Write-Host ' 文件太小，换下一个' -ForegroundColor Yellow
        }
    } catch {
        Write-Host ' 不通' -ForegroundColor DarkGray
    }
}

if (-not $downloaded) {
    Write-Bad '所有下载源都失败。'
    Write-Host ''
    Write-Host '  这说明这台机器访问不了 GitHub 及其镜像。可以：' -ForegroundColor Gray
    Write-Host '   1) 换网络（手机热点）后重跑本脚本' -ForegroundColor Gray
    Write-Host '   2) 在能上网的电脑下载后，用 U 盘/微信把 ZIP 传过来：' -ForegroundColor Gray
    Write-Host "      https://github.com/$repo/archive/refs/tags/$Version.zip" -ForegroundColor Gray
    Write-Host '   3) 把 ZIP 放到任意目录，然后运行：' -ForegroundColor Gray
    Write-Host "      .\update.ps1 -Destination `"$Destination`" -FromZip `"<ZIP 路径>`"" -ForegroundColor Gray
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Ok ("已下载 {0:N1} MB" -f ((Get-Item -LiteralPath $zip).Length / 1MB))

# ---------------------------------------------------------------------------
# 3. 解压并核对版本
# ---------------------------------------------------------------------------
Write-Step '解压并核对版本'

$unpack = Join-Path $work 'unpack'
try {
    Expand-Archive -LiteralPath $zip -DestinationPath $unpack -Force
} catch {
    Write-Bad "解压失败：$($_.Exception.Message)"
    exit 1
}

$root = Get-ChildItem -LiteralPath $unpack -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'VERSION') } | Select-Object -First 1
if (-not $root) {
    Write-Bad '解压出来的内容里没有 VERSION 文件，包可能不完整。'
    exit 1
}
$newVersion = (Get-Content -LiteralPath (Join-Path $root.FullName 'VERSION') -Raw).Trim()
if ($newVersion -ne $Version) {
    Write-Bad "包里是 $newVersion，不是要更新的 $Version，已中止。"
    exit 1
}
Write-Ok "包内版本核对一致：$newVersion"

# ---------------------------------------------------------------------------
# 4. 停止服务
# ---------------------------------------------------------------------------
Write-Step '停止正在运行的服务'

$stopScript = Join-Path $Destination 'Stop-InfiniteCanvas.ps1'
if (Test-Path -LiteralPath $stopScript) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    Write-Ok '已停止'
} else {
    Write-Warn2 '没找到停止脚本，跳过（覆盖后请手动重启）'
}

# ---------------------------------------------------------------------------
# 5. 覆盖程序文件
# ---------------------------------------------------------------------------
Write-Step '覆盖程序文件'

# /XF 保留配置；update.ps1 / update.cmd 可能正在被占用，跳过避免报错
$rcArgs = @(
    $root.FullName, $Destination,
    '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
    '/XF', 'canvas.config.json', 'update.ps1', 'update.cmd'
)
# 不用 Start-Process：机器上同时存在 HTTPS_PROXY 与 https_proxy 时，
# Start-Process 重建环境块会抛“字典中已添加关键字”，导致复制根本没执行。
& robocopy.exe @rcArgs | Out-Null
$rcCode = $LASTEXITCODE
if ($rcCode -lt 8) {
    Write-Ok "已覆盖（robocopy 退出码 $rcCode）"
} else {
    Write-Bad "覆盖时有文件失败（robocopy 退出码 $rcCode）"
    Write-Host '  常见原因：文件正被占用。重启电脑后再跑一次通常就好了。' -ForegroundColor Gray
}

$after = (Get-Content -LiteralPath (Join-Path $Destination 'VERSION') -Raw).Trim()
if ($after -eq $Version) {
    Write-Ok "程序目录的 VERSION 已是 $after"
} else {
    Write-Warn2 "程序目录的 VERSION 是 $after，与目标 $Version 不一致"
}

# ---------------------------------------------------------------------------
# 6. 启动
# ---------------------------------------------------------------------------
if (-not $NoStart) {
    Write-Step '启动'
    $startScript = Join-Path $Destination 'Start-InfiniteCanvas.ps1'
    if (Test-Path -LiteralPath $startScript) {
        try {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript -NoBrowser 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
        } catch {
            Write-Warn2 "自动启动失败：$($_.Exception.Message)。请点桌面「无限画布」启动。"
        }
    } else {
        Write-Warn2 '没找到启动脚本，请点桌面「无限画布」'
    }
}

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host "更新完成：$current → $Version" -ForegroundColor White
Write-Host '  验证：浏览器打开 http://127.0.0.1:3010/muse/version' -ForegroundColor Gray
Write-Host "  看 version 是不是 $Version" -ForegroundColor Gray
Write-Host '  你的配置和作品都没有动过。' -ForegroundColor Gray
Write-Host ''
