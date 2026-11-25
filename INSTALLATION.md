# 安装与使用

## 复制给 AI 的安装指令

这套工具**出图/出视频首选 MuseCanvas**（第三方软件，不在本仓库内）；装不上时用**豆包通道**兜底。下面这条指令把两件事合并成一次安装，整块复制发给任意能执行命令的 AI（Claude Code、Codex、WorkBuddy 等）：

```text
请在我这台 Windows 电脑上装好一整套 AI 内容生产工具（画布 + 出图能力）。一次装完，不要拆成两次问我。

【动手前先确认，不要跳过】
1. 读仓库 https://github.com/maluom13/infinite-canvas-studio 的 INSTALLATION.md。
2. 先告诉我三件事：装到哪个盘（含剩余空间）、当前登录的 Windows 用户名、本机是否已装过 MuseCanvas。
未经我同意：不要默认占用 C 盘、不要删除任何已有数据、不要停止与我无关的程序、不要发起消耗额度的生成测试。

【第一段：出图能力 MuseCanvas（第三方软件，先装它）】
1. 读 https://github.com/fangrui202575/muse-canvas-deploy 的 DEPLOY.md 和 manifest.json。
2. 按 manifest 里的版本、文件名、大小、SHA-256 下载官方 Release 包，用 Get-FileHash 核对；
   不一致就停下告诉我，不要换别的来源再试。
3. 解压后在该文件夹运行 Install.ps1，显式指定非系统盘和我的用户名：
   -Destination 'D:\MuseCanvas' -DataDirectory 'D:\MuseCanvasData' -ForUser '当前用户名'
   它的默认路径在 C 盘，这两个参数不能省。
4. 装完启动一次，确认画布、Agent、导出、授权、老接口、新接口六个服务都起来。

【第二段：主程序】
1. 把 https://github.com/maluom13/infinite-canvas-studio 的代码取到同一块磁盘（git clone 或下载 ZIP）。
2. 运行仓库里的 install.ps1（装在非系统盘就用 -Destination 指定，例如 -Destination 'D:\InfiniteCanvas'）。
   它会依次做：检查 Node 和浏览器 → 安装两处依赖 → 构建 Agent → 检测 MuseCanvas →
   准备豆包兜底通道（Python + playwright，不下载浏览器）→ 生成配置 → 建快捷方式 → 启动。
3. 结束时它会按「通过 / 未通过 / 未测试」输出，请原样贴给我，不要自己概括成"全部成功"。

【如果 MuseCanvas 装不上（下载不到、校验不一致、安装报错，或没有可用的 Muse 账号）】
不要反复重试，也不要去找第三方镜像或破解包。直接告诉我卡在哪一步，然后：
确认第二段输出的「豆包通道」是【通过】，把画布顶部生成通道切到豆包，我登录后就能出图。
同时明确告诉我豆包的限制：图片带水印、视频固定 10 秒 720p、不支持参考图、人机验证要我自己点。
如果豆包通道也没准备好（缺 Python 或 playwright 装不上），先告诉我缺什么、要我同意后再加 -InstallPython
重跑一次 install.ps1（它会用 winget 装 Python），或者把 install.ps1 的原始报错整段贴给我。

【全程硬约束】
- 账号登录（Muse、豆包、视频号、快手、抖音）必须由我本人完成：打开窗口让我自己扫码或输密码，
  不要代我操作，不要读取、导出或保存我的密码、Cookie、令牌。
- 不要替我接受任何第三方许可协议。MuseCanvas 的安装包和授权只能来自它自己的官方渠道。
- 真实出图、真实发视频会花额度、会影响账号，必须等我明确同意后再做；装完只做"能打开、能连上"的检查。
- 最后逐项报告：通过什么、未通过什么、未测试什么。不要因为页面能打开或显示"已连接"就说成功。
```

**只想要画布、暂时不要出图能力时**，可以跳过第一段：画布能打开、能编辑、能整理，点生成会提示没有可用模型。等 MuseCanvas 装好或豆包通道登录后，重启画布即可，不用重装。

---

## 这是什么

基于 [infinite-canvas](https://github.com/basketikun/infinite-canvas)（MIT）修改的本地工作台：在画布上做图、做视频、合成成片，再自动发布到视频号 / 快手 / 抖音。

**生成能力来自 MuseCanvas**（第三方软件，不在本仓库内）。本仓库只包含画布、Agent 和发布链路。

**没有 MuseCanvas 时**，画布能打开、能编辑，也能用**豆包通道**出图/出视频——它由本项目自带，只需 Python + `playwright`（安装脚本会自动准备，不额外下载浏览器），驱动你机器上已有的 Chrome 或 Edge。

## 前置条件

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10/11 x64 |
| 磁盘 | 程序 + 数据 ≥ 5 GB，另需素材空间 |
| Node.js | ≥ 18（`node -v` 能输出版本号） |
| 浏览器 | Chrome 或 Edge（豆包通道和画布打开都用它） |
| MuseCanvas | 出图/出视频的首选，画质最好、支持参考图。第三方软件，需自行从官方渠道安装并登录 |
| Python | ≥ 3.10，仅豆包通道、自动发布、深度视频需要。安装脚本会自动建虚拟环境并装 `playwright`；没有 Python 时加 `-InstallPython` 自动装 |

## 安装

### 第一步：选目录

**不要装在 C 盘**，素材和模型会很快占满系统盘。示例用 `D:\InfiniteCanvas`，实际按可用磁盘替换。

```powershell
$root = 'D:\InfiniteCanvas'
New-Item -ItemType Directory -Force $root | Out-Null
Set-Location $root
```

### 第二步：获取代码

```powershell
git clone https://github.com/maluom13/infinite-canvas-studio.git .
```

没有 git 时，也可以在仓库页面点 `Code → Download ZIP`，解压到上一步的目录。

### 第三步：一键安装

双击 `install.cmd`，或在 PowerShell 里运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会依次完成：检查 Node.js 与浏览器 → 安装两处依赖并构建 Agent → 检测 MuseCanvas → 准备豆包兜底通道（Python 虚拟环境 + `playwright`，不下载浏览器）→ 生成 `canvas.config.json` → 创建桌面快捷方式 → 启动服务。首次需要几分钟，过程中不要关闭窗口。

常用参数：

| 目的 | 命令 |
|---|---|
| 装到别的目录（建议非 C 盘） | `.\install.ps1 -Destination 'E:\InfiniteCanvas'` |
| 指定数据目录 | `.\install.ps1 -DataDirectory 'E:\InfiniteCanvasData'` |
| 不创建桌面快捷方式 | `.\install.ps1 -NoShortcut` |
| 装完不自动启动 | `.\install.ps1 -NoStart` |
| 依赖已装好，只更新程序 | `.\install.ps1 -SkipDeps` |
| 本机没有 Python，自动装 Python 3.12 | `.\install.ps1 -InstallPython` |

结束时脚本会分别列出「通过 / 未通过 / 需要注意 / 未测试」，不会笼统地说装好了。

也可以手动分步执行（等价于脚本做的事）：

```powershell
Set-Location web;           npm install; Set-Location ..
Set-Location canvas-agent;  npm install; npm run build; Set-Location ..
```

`canvas-agent` 必须执行 `npm run build`，否则 `dist` 不存在，启动会报错。

### 第四步（可选）：自定义路径与端口

默认全部自动探测，不配也能跑。需要改端口或程序位置时：

```powershell
Copy-Item canvas.config.example.json canvas.config.json
notepad canvas.config.json
```

可配置项：数据目录、Node 路径、浏览器路径、画布浏览器配置目录、MuseCanvas 安装位置与启动脚本、豆包通道的 Python 路径、前端与 Agent 端口。

### 第五步：日常启动与停止

装好后桌面上会有两个快捷方式：「无限画布」和「无限画布 - 停止」，双击即可。

也可以在程序目录里运行：

```powershell
# 启动
powershell -ExecutionPolicy Bypass -File .\Start-InfiniteCanvas.ps1

# 停止
powershell -ExecutionPolicy Bypass -File .\Stop-InfiniteCanvas.ps1
```

启动成功后浏览器会打开画布，终端输出 `Infinite Canvas is running: http://127.0.0.1:3010`。

## 数据放在哪里

启动脚本按以下顺序决定：

1. `canvas.config.json` 里的 `stateDir`
2. 环境变量 `CANVAS_DATA_ROOT`
3. 如果 `D:\CodexData\.codex\infinite-canvas` 已存在（老机器），沿用它
4. 否则用 `%LOCALAPPDATA%\InfiniteCanvas`

该目录保存：账号登录态、任务记录、发布历史与日志、浏览器配置。**不要公开分享这个目录的内容。**

## 端口

| 用途 | 默认端口 |
|---|---|
| 画布前端 | 3010 |
| 画布 Agent | 17381 |
| MuseCanvas Web / Agent / 导出 / 授权 | 3000 / 17371 / 17372 / 17373 |
| MuseCanvas 池 / 协议 | 18610 / 18611 |

画布与 MuseCanvas 端口不冲突，可同时运行。端口被占用时改 `canvas.config.json`。

## 账号登录（必须本人操作）

| 账号 | 在哪登录 | 说明 |
|---|---|---|
| Muse | 画布顶部 Muse 面板 | 用自己账号；生成走这个 |
| 豆包 | 画布顶部豆包面板 | 独立浏览器与登录态，与 Muse 无关；人机验证需本人完成 |
| 视频号 / 快手 / 抖音 | 「自动发布」页面 | 各平台扫码一次，之后复用登录态 |
| Codex / Claude | Agent 设置页 | 用于 Agent 对话，不登录则只能用画布手工操作 |

**任何账号都不应该由他人代登录**，也不要把 Cookie、令牌、密码写进配置或提交到仓库。

## 没有 MuseCanvas 时：用豆包通道出图

MuseCanvas 装不上、或暂时没有 Muse 账号时，不用卡在这里，豆包通道能顶上：

1. 安装脚本已准备好 Python 虚拟环境与 `playwright`（`install.ps1` 输出里「豆包通道」显示【通过】）。
2. 打开画布，在顶部豆包面板点登录，弹出浏览器后自己扫码/输密码，遇到人机验证自己点一下。
3. 生成时把通道切到豆包，就能出图或出视频。登录态会保留，下次不用重复登录。

**它的边界，先看清楚再用：**

| 项目 | 豆包通道 | MuseCanvas |
|---|---|---|
| 参考图 / 角色一致性 | **不支持** | 支持 |
| 图片水印 | 有 | 无 |
| 视频 | 固定 10 秒 720p | 可长、可更高分辨率 |
| 商用 | 用户协议不允许 | 取决于你的 Muse 授权 |
| 成本 | 免费（网页额度） | 你的 Muse 账号额度 |

所以豆包适合「先把流程跑通、先看效果」，要做需要角色一致性的成片，还是得装 MuseCanvas。

## 已知限制

- **出图速度约 60 秒一张，且同一账号串行**。多登几个 Muse 账号可并行，速度接近线性提升。
- **发布使用浏览器自动化**，平台服务条款可能不允许，账号存在被限制的风险，建议用单独注册的账号。
- **豆包**：图片带水印，视频固定 10 秒 720p，不支持参考图；其用户协议不允许将生成内容用于商业用途。
- **Agent 对话**需要 Codex 或 Claude 的账号/额度，未登录时画布的手工操作不受影响。
- 视频号 / 快手的发布链路尚未在真实账号上完整验证，首次使用建议先拿一个不重要的作品试。

## 卸载

1. 运行 `Stop-InfiniteCanvas.ps1` 停止服务
2. 删除程序目录（如 `D:\InfiniteCanvas`）
3. 数据目录按需保留或删除（见上方「数据放在哪里」）

MuseCanvas 是独立安装的软件，需要单独卸载。
