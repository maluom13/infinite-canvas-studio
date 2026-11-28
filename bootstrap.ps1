param(
    [string]$Destination = '',
    [string]$FromZip = '',
    [switch]$NoInstall,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [通过] $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "  [注意] $text" -ForegroundColor Yellow }
function Write-Bad($text) { Write-Host "  [失败] $text" -ForegroundColor Red }

Write-Host ''
Write-Host '灵境画布 · 下载并安装' -ForegroundColor White
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host '只做两件事：把程序下载到本机，然后调用它自己的安装脚本。' -ForegroundColor DarkGray
Write-Host '不会装到 C 盘（除非系统只有 C 盘），不会删你已有的东西。' -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 1. 确定安装位置
# ---------------------------------------------------------------------------
Write-Step '确认安装位置'

if (-not $Destination) {
    if (Test-Path -LiteralPath 'D:\') { $Destination = 'D:\LingJingCanvas' }
    elseif (Test-Path -LiteralPath 'E:\') { $Destination = 'E:\LingJingCanvas' }
    else { $Destination = Join-Path $env:USERPROFILE 'LingJingCanvas' }
}
$Destination = [System.IO.Path]::GetFullPath($Destination)
Write-Host "  目录：$Destination" -ForegroundColor Gray
Write-Host '  想换盘或换名字：加 -Destination "D:\你的目录"' -ForegroundColor DarkGray

if ((Test-Path -LiteralPath (Join-Path $Destination 'VERSION')) -and -not $Force) {
    Write-Warn2 '这个目录里已经有一套程序了。'
    Write-Host '  要更新到新版，用 update.ps1（会保留配置和数据）' -ForegroundColor Gray
    Write-Host '  确实要覆盖重装，加 -Force' -ForegroundColor Gray
    exit 1
}

# ---------------------------------------------------------------------------
# 2. 下载
# ---------------------------------------------------------------------------
Write-Step '下载程序文件'

$repo = 'maluom13/infinite-canvas-studio'
# 安装包单独放在 Release 里，GitHub 会统计每个 asset 的下载次数。
# 这样「装了多少份」是官方数字、匿名可读、永久保留，也不可能被随便刷。
# 镜像站只用于网络不通时的兜底，不计入统计。
$releaseVersion = 'v0.21.2'
$asset = "lingjing-canvas-install-$releaseVersion.zip"
$releaseUrl = "https://github.com/$repo/releases/download/$releaseVersion/$asset"
$urls = @(
    $releaseUrl,
    "https://ghfast.top/$releaseUrl",
    "https://gh-proxy.com/$releaseUrl",
    "https://ghproxy.net/$releaseUrl",
    "https://github.com/$repo/archive/refs/tags/$releaseVersion.zip"
)

$work = Join-Path $env:TEMP ("canvas-setup-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$zip = Join-Path $work 'main.zip'
$downloaded = $false

if ($FromZip) {
    # 已经用 U 盘/微信把 ZIP 传过来了，直接用，不联网
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
        Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 180 -UseBasicParsing
        if ((Test-Path -LiteralPath $zip) -and ((Get-Item -LiteralPath $zip).Length -gt 500000)) {
            Write-Host ' 成功' -ForegroundColor Green
            $downloaded = $true
        } else {
            Write-Host ' 文件不完整，换下一个' -ForegroundColor Yellow
        }
    } catch {
        Write-Host ' 不通' -ForegroundColor DarkGray
    }
}

if (-not $downloaded) {
    Write-Bad '所有下载源都没成功。'
    Write-Host ''
    Write-Host '  三个办法：' -ForegroundColor Gray
    Write-Host '   1) 换网络（手机热点）后重跑' -ForegroundColor Gray
    Write-Host "   2) 在能上网的电脑下载：https://github.com/$repo/archive/refs/heads/main.zip" -ForegroundColor Gray
    Write-Host '      用 U 盘或微信传过来，解压后直接双击里面的 install.cmd' -ForegroundColor Gray
    Write-Host '   3) 把 ZIP 放到本机后运行：' -ForegroundColor Gray
    Write-Host '      .\bootstrap.ps1 -FromZip "<ZIP 路径>"' -ForegroundColor Gray
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Ok ("已下载 {0:N1} MB" -f ((Get-Item -LiteralPath $zip).Length / 1MB))

# ---------------------------------------------------------------------------
# 3. 解压
# ---------------------------------------------------------------------------
Write-Step '解压'

$unpack = Join-Path $work 'unpack'
try {
    Expand-Archive -LiteralPath $zip -DestinationPath $unpack -Force
} catch {
    Write-Bad "解压失败：$($_.Exception.Message)"
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

$root = Get-ChildItem -LiteralPath $unpack -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'VERSION') } | Select-Object -First 1
if (-not $root) {
    Write-Bad '解压出来的内容里没有 VERSION，下载的包不完整。'
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}
$version = (Get-Content -LiteralPath (Join-Path $root.FullName 'VERSION') -Raw).Trim()
Write-Ok "包内容完整，版本 $version"

if ($NoInstall) {
    Write-Step '只下载，不安装'
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    & robocopy.exe $root.FullName $Destination /E /NFL /NDL /NJH /NJS /NP | Out-Null
    Write-Ok "已放到 $Destination"
    Write-Host "  以后想装，进那个目录双击 install.cmd" -ForegroundColor Gray
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}

# ---------------------------------------------------------------------------
# 4. 交给安装脚本
# ---------------------------------------------------------------------------
Write-Step "安装到 $Destination"
Write-Host '  接下来会检查环境、装依赖、构建、建快捷方式，第一次需要几分钟。' -ForegroundColor Gray
Write-Host '  过程中不要关闭这个窗口。' -ForegroundColor Gray

$installer = Join-Path $root.FullName 'install.ps1'
if (-not (Test-Path -LiteralPath $installer)) {
    Write-Bad '包里没有 install.ps1，无法继续。'
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Destination $Destination
$installExit = $LASTEXITCODE

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
if ($installExit -eq 0) {
    Write-Host "完成：灵境画布 $version 已装到 $Destination" -ForegroundColor White
    Write-Host '  启动：桌面「无限画布」快捷方式，或运行 Start-InfiniteCanvas.ps1' -ForegroundColor Gray
} else {
    Write-Host "安装脚本返回了问题（退出码 $installExit），请看上面「未通过」的项。" -ForegroundColor Yellow
}
Write-Host ''
exit $installExit
