# 安装与使用

## 复制给 AI 的安装指令

把下面这段整块复制，发给任意能执行命令的 AI（Claude Code、Codex、WorkBuddy 等）：

```text
请把我这台 Windows 电脑装好 https://github.com/maluom13/infinite-canvas-studio 这个项目。

先做三件事再动手：读仓库里的 INSTALLATION.md、确认要装到哪个磁盘目录、确认当前登录的 Windows 用户名。
未经我同意不要默认占用 C 盘、不要删除任何已有数据、不要停止与我无关的程序、不要发起消耗额度的模型或生成测试。

按 INSTALLATION.md 的步骤执行：检查 Node.js、安装依赖、构建 canvas-agent、启动服务。
MuseCanvas 是第三方软件，如果本机没有，请停下来告诉我怎么装，不要替我下载或安装别人的软件。
Muse、豆包、视频号、快手、抖音的账号登录必须由我本人完成，不要代我操作，也不要读取或保存我的密码、Cookie。

装完后逐项报告：通过什么、没通过什么、没测试什么。不要因为页面能打开就说全部成功；
真实出图、真实发布属于要花额度或对账号有影响的操作，必须等我确认后再做。
```

---

## 这是什么

基于 [infinite-canvas](https://github.com/basketikun/infinite-canvas)（MIT）修改的本地工作台：在画布上做图、做视频、合成成片，再自动发布到视频号 / 快手 / 抖音。

**生成能力来自 MuseCanvas**（第三方软件，不在本仓库内）。本仓库只包含画布、Agent 和发布链路。没有 MuseCanvas 时，画布能打开、能编辑，但出不了图。

## 前置条件

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10/11 x64 |
| 磁盘 | 程序 + 数据 ≥ 5 GB，另需素材空间 |
| Node.js | ≥ 18（`node -v` 能输出版本号） |
| 浏览器 | Chrome 或 Edge |
| MuseCanvas | 出图 / 出视频需要。第三方软件，请自行从官方渠道安装并登录 |
| Python | 仅「自动发布」「豆包」「深度视频」需要；缺少时相关功能会报错，其余功能不受影响 |

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

### 第三步：安装依赖

两处都要装，前端和 Agent 是独立的。

```powershell
Set-Location web
npm install
Set-Location ..

Set-Location canvas-agent
npm install
npm run build
Set-Location ..
```

`canvas-agent` 必须执行 `npm run build`，否则 `dist` 不存在，启动脚本会报错。

### 第四步（可选）：自定义路径与端口

默认全部自动探测，不配也能跑。需要改端口或程序位置时：

```powershell
Copy-Item canvas.config.example.json canvas.config.json
notepad canvas.config.json
```

可配置项：数据目录、Node 路径、浏览器路径、画布浏览器配置目录、MuseCanvas 启动脚本、前端与 Agent 端口。

### 第五步：启动

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-InfiniteCanvas.ps1
```

成功后浏览器会打开画布，终端输出 `Infinite Canvas is running: http://127.0.0.1:3010`。

停止：

```powershell
powershell -ExecutionPolicy Bypass -File .\Stop-InfiniteCanvas.ps1
```

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
