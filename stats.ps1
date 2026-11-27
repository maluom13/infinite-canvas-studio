$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'maluom13/infinite-canvas-studio'
$api = "https://api.github.com/repos/$repo/releases"

Write-Host ''
Write-Host '灵境画布 · 使用情况统计' -ForegroundColor White
Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray

try {
    $releases = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'lingjing-stats' } -TimeoutSec 30
} catch {
    Write-Host "  读取失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  换网络（手机热点）再试，或打开这个地址看：' -ForegroundColor Gray
    Write-Host "  https://github.com/$repo/releases" -ForegroundColor Gray
    exit 1
}

$totalInstall = 0
$totalUpdate = 0
$rows = @()

foreach ($rel in $releases) {
    foreach ($a in $rel.assets) {
        $n = $a.name
        if ($n -like 'lingjing-canvas-install-*.zip') { $kind = '全新安装' }
        elseif ($n -like 'lingjing-canvas-update-*.zip') { $kind = '更新' }
        else { continue }
        $rows += [pscustomobject]@{
            Version   = $rel.tag_name
            Kind      = $kind
            Downloads = $a.download_count
        }
        if ($kind -eq '全新安装') { $totalInstall += $a.download_count } else { $totalUpdate += $a.download_count }
    }
}

if ($rows.Count -eq 0) {
    Write-Host '  还没有发布带统计的安装包。' -ForegroundColor Yellow
    exit 0
}

foreach ($r in ($rows | Sort-Object Version -Descending)) {
    Write-Host ("  {0,-10} {1,-8} {2,5} 次" -f $r.Version, $r.Kind, $r.Downloads) -ForegroundColor White
}

Write-Host '------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host "  全新安装合计：$totalInstall 次" -ForegroundColor White
Write-Host "  更新下载合计：$totalUpdate 次" -ForegroundColor White
Write-Host ''
Write-Host '  说明：这是 GitHub 官方统计的下载次数，只有真实从 Release 下载才算。' -ForegroundColor Gray
Write-Host '  镜像站、仓库页面浏览不计数；数据是公开的，任何人都能核对。' -ForegroundColor Gray
Write-Host '  网页版：https://github.com/maluom13/infinite-canvas-studio/releases' -ForegroundColor Gray

# 本机活跃记录（只在本机，不联网）
try {
    $local = Invoke-RestMethod -Uri 'http://127.0.0.1:3010/usage/local' -TimeoutSec 5
    if ($local.enabled) {
        Write-Host ''
        Write-Host '本机活跃记录（只有这台机器，不代表所有人）' -ForegroundColor DarkGray
        Write-Host ("  活跃天数：{0}   启动次数：{1}" -f $local.activeDays, $local.launches) -ForegroundColor Gray
        Write-Host ("  上报：{0}" -f $local.note) -ForegroundColor Gray
    }
} catch { }

Write-Host ''
