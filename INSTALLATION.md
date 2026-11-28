# 安装与使用

## 复制给 AI 的安装指令

这套工具**自带豆包通道，装完就能出图出视频**，不需要任何第三方软件。下面这条指令整块复制发给任意能执行命令的 AI（Claude Code、Codex、WorkBuddy 等），它会自己判断该用 `bootstrap.ps1` 还是 `update.ps1`。

> **没有可用的 AI、或 AI 登录不上**：跳过这段，看下面的「不借助 AI，手动安装（三步）」，效果一样。

```text
请帮我装好「灵境画布」（GitHub: maluom13/infinite-canvas-studio，一套 AI 内容生产与自动发布工作台）。

【动手前先做三件事，不要跳过】
1. 读仓库 https://github.com/maluom13/infinite-canvas-studio 的 INSTALLATION.md。
2. 问我要装到哪个非系统盘（并告诉我那个盘的剩余空间）、当前 Windows 用户名。
3. 确认本机是否已经装过它（看目标目录里有没有 VERSION 文件，或问运行中的服务 http://127.0.0.1:3010/muse/version）。
未经我同意：不要默认占 C 盘、不要删除任何已有数据、不要停止与我无关的程序、不要发起消耗额度或影响账号的测试。

【安装：按是否已装过，选其中一条】
- 没装过：运行仓库里的 bootstrap.ps1（可用 -Destination 指定目录，例如 -Destination 'D:\LingJingCanvas'）。
  它会自动下载最新版、装依赖、构建、建快捷方式并启动。默认装到非系统盘（有 D 盘就 D:\LingJingCanvas）。
- 已装过：用 update.ps1 更新。它会保留 canvas.config.json 和数据目录，不要重装、不要清空数据。
结束时它会按「通过 / 未通过 / 未测试」逐项输出，请原样贴给我，不要自己概括成"全部成功"。

【出图出视频：用自带的豆包通道，不需要任何第三方软件】
1. 确认安装输出的「豆包通道」是【通过】。
2. 从桌面「无限画布」进入（打开的是 localhost:3010，这就是本程序）。
3. 在画布顶部把生成通道切到「豆包」，由我本人登录豆包（扫码或输密码），登录后即可出图出视频。
4. 豆包的限制要如实告诉我：图片带水印、视频固定 10 秒 720p、不支持参考图、人机验证要我自己点。
5. 如果豆包通道没准备好（缺 Python 或 playwright 装不上），先告诉我缺什么、经我同意后再加 -InstallPython
   重跑一次，或者把安装脚本的原始报错整段贴给我。

【不要做的事】
- 不要下载、安装或使用任何叫 MuseCanvas 的第三方软件，也不要读它的仓库、文档或安装包。
  它不是本程序的一部分，本程序也不依赖它。它自带的画布是 localhost:3000，会引导购买别家的账号，
  与本程序无关——不要打开它，只认 localhost:3010。
- 不要去找第三方镜像、破解包、破解账号。
- 账号登录（豆包、视频号、快手、抖音）一律由我本人完成：打开窗口让我自己扫码或输密码，
  不要代我操作，不要读取、导出或保存我的密码、Cookie、令牌。
- 真实出图、真实发视频会花额度、会影响账号，必须经我明确同意后再做；装完只做"能打开、能连上"的检查。
- 最后逐项报告：通过什么、未通过什么、未测试什么。不要因为页面能打开或显示"已连接"就说装好了。
```

**只想要画布、暂时不要出图能力时**，装完主程序即可：画布能打开、能编辑、能整理，点生成会提示没有可用模型。等豆包登录后重启画布即可，不用重装。

**关于 MuseCanvas**：它是另一个第三方软件，不是本程序的组成部分，本程序不依赖它也能用豆包通道出图出视频。它自带的画布（`localhost:3000`）会引导购买别家的账号，与本程序无关——**不要装、不要打开、不要从本程序的文档或指令跳转过去**。本程序只用桌面「无限画布」打开的 `localhost:3010`。

---

## 这是什么

基于 [infinite-canvas](https://github.com/basketikun/infinite-canvas)（MIT）修改的本地工作台：在画布上做图、做视频、合成成片，再自动发布到视频号 / 快手 / 抖音。

**生成能力来自项目自带的豆包通道**：只需 Python + `playwright`（安装脚本自动准备，不额外下载浏览器），驱动你机器上已有的 Chrome 或 Edge。装完、登录豆包就能出图出视频，不需要任何第三方软件。

MuseCanvas 是**可选的第三方增强**，不是本程序的组成部分，也不是前置条件。它的画布会引导购买别家账号，本程序不依赖它、也不推荐使用。

## 前置条件

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10/11 x64 |
| 磁盘 | 程序 + 数据 ≥ 5 GB，另需素材空间 |
| Node.js | ≥ 18（`node -v` 能输出版本号） |
| 浏览器 | Chrome 或 Edge（豆包通道和画布打开都用它） |
| MuseCanvas | **可选，不需要装**。本程序用自带豆包通道出图出视频。若你自己已有 MuseCanvas 且想用 Muse 通道，可在配置里填它的安装位置；它的账号与邀请码请自行解决，本程序不提供、也不引导 |
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

## 不借助 AI，手动安装（三步）

**WorkBuddy / Claude Code / Codex 都不是必需的**。它们只是替你把命令敲一遍；安装本身是一个脚本，自己点两下就行。

1. **拿代码**：下载
   `https://github.com/maluom13/infinite-canvas-studio/archive/refs/heads/main.zip`
   解压到非系统盘，例如 `D:\InfiniteCanvas`。
   - 那台机器打不开 GitHub：在能上网的机器上下载 ZIP，用 U 盘或聊天工具传过去再解压，效果一样。
2. **确认 Node.js**：没装就去 `https://nodejs.org/` 装 LTS 版（18 以上）。装完最好重开一次终端。
3. **双击 `install.cmd`**（或右键 `install.ps1` → 使用 PowerShell 运行）。
   它会装依赖、构建、生成配置、建快捷方式、启动，结束时按「通过 / 未通过 / 未测试」逐项报告。

以后只从桌面 **「无限画布」** 进，生成通道选豆包并登录你的豆包账号即可。不需要装 MuseCanvas。

## 检查版本与更新

> ### 如果你是 v0.20.0，看到提示「最新版本 v1.0.0」——不要点更新
>
> 那个 `v1.0.0` 是**上游作者的重写版**（2026-11-24 发布），和本项目不是一个东西。上游自己的更新说明写着：
>
> > v1.0.0 不再兼容 v0.20.0 及更早版本的数据，网页版改用新的浏览器存储，**旧版内容不会自动带入**。
>
> 装上去的后果：目录结构、包管理、界面全部重写；**你的作品不会迁过去**；本项目的自动发布、豆包通道、布局优化也全部消失。
>
> 原因：v0.20.0 的「检查更新」查的是上游仓库，所以它永远只看得到上游的版本。这个 bug 在 `v0.20.1` 已修正。
> **正确的更新目标是本仓库的 `v0.20.1`**，方法见下方「更新步骤」。

程序不会自动更新（ZIP 下载的是快照）。所以每个版本都有明确编号，三个地方能看到**当前装的是哪一版**：

| 位置 | 怎么看 |
|---|---|
| 画布右上角的版本号 | 点开是「版本更新」弹窗；有新版本时变成绿色「有新版本」标签，里面给出下载入口与更新说明 |
| `http://127.0.0.1:3010/muse/version` | JSON 里的 `version` 字段 |
| 安装或启动时的终端输出 | 标题行、以及结尾「程序目录」后面括起来的版本号 |

最新版本号见仓库根目录的 [`VERSION`](VERSION)。

从 `v0.20.1` 起，检查更新只查本仓库（`maluom13/infinite-canvas-studio`），不会再出现上游 `v1.0.0` 的误报。

### 最快的方式：一条命令自动更新

在**要更新的那台机器**上打开 PowerShell（开始菜单右键 → 终端），粘贴这一整行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/maluom13/infinite-canvas-studio/main/update.ps1 -OutFile $env:TEMP\u.ps1; & $env:TEMP\u.ps1"
```

它会自动完成：**找到程序目录**（画布开着就问服务要位置；没开就自动扫盘找，不用你自己找）→ 多源下载 → 核对包内版本 → 停止服务 → 覆盖（保留 `canvas.config.json` 与数据目录）→ 启动。

> 用 `raw.githubusercontent.com` 而不是 jsDelivr：jsDelivr 对 `@main` 有最长 12 小时缓存，可能拿到旧脚本。要用 jsDelivr 请换成带版本号的地址，例如 `@v0.21.4`。

如果上面那条连不上，按顺序换：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://ghfast.top/https://raw.githubusercontent.com/maluom13/infinite-canvas-studio/main/update.ps1 -OutFile $env:TEMP\u.ps1; & $env:TEMP\u.ps1"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://cdn.jsdelivr.net/gh/maluom13/infinite-canvas-studio@v0.21.4/update.ps1 -OutFile $env:TEMP\u.ps1; & $env:TEMP\u.ps1"
```

**三条都不通**（那台机器基本连不上外网）：在能上网的电脑下载 ZIP，用 U 盘或聊天工具传过去，然后手动覆盖，步骤见下。

### 手动更新（连不上外网时）

**第 0 步：先确认「程序目录」在哪。** 不知道就打开 `http://127.0.0.1:3010/muse/version`，看 `projectRoot` 字段的值，那就是要覆盖的目录（例如 `D:/InfiniteCanvas`）。

1. 下载最新版：`https://github.com/maluom13/infinite-canvas-studio/archive/refs/heads/main.zip`
2. 解压到一个临时位置（例如 `D:\temp\v0201`）。解压出来会是一个带版本号的文件夹，**进去**才是程序文件
3. 把**里面的内容**复制到第 0 步查到的程序目录，覆盖同名文件
   - 注意：不要把整个 `infinite-canvas-studio-0.20.1` 文件夹直接拖进程序目录，那样会多出一层
   - **不要覆盖** `canvas.config.json` —— 你的路径与端口配置在里面
   - **不要覆盖**数据目录 —— 作品、登录态、发布记录都在那里
4. **停止再启动**：桌面「无限画布 - 停止」→「无限画布」

如果不想手动复制，用新版里的安装脚本做覆盖更省事（`-SkipDeps` 表示复用已有依赖，不再联网安装）：

```powershell
cd D:\temp\v0201\infinite-canvas-studio-0.20.1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Destination "D:\InfiniteCanvas" -SkipDeps -NoStart
```

**不要把它解压到一个新目录直接双击启动**：那等于装第二套程序，配置和数据都另起一份，看不到原来的作品。

用 `git clone` 拿的更简单：`git pull` 后停止再启动。

想装**指定版本**（回退到旧版、或给多台机器对齐同一版）时，把地址里的 `main` 换成标签：

```
https://github.com/maluom13/infinite-canvas-studio/archive/refs/tags/v0.20.0.zip   ← 第一版
https://github.com/maluom13/infinite-canvas-studio/archive/refs/tags/v0.20.1.zip   ← 第二版
```

错误提示、路径解析、渠道注册这类改动都属于**运行时逻辑，不重启不会生效**。

### 怎么确认真的更新成功了

打开 `/muse/version`，看两个字段：

| 看到什么 | 说明 |
|---|---|
| 404 | 旧代码（这个地址本身是新版才有的） |
| `bridge` 小于 3 | 旧代码，先更新 |
| `version` 不是新版号 | 文件没覆盖成功，或覆盖到了别的目录 |
| `startedAt` 早于你刚才重启的时间 | **服务没重启**，跑的还是旧的 |


## 两个画布别搞混（重要）

装了 MuseCanvas 之后，机器上会同时存在**两个长得像、其实不同的画布**：

| 地址 | 是谁的 | 说明 |
|---|---|---|
| `localhost:3000` | **MuseCanvas 自带的** | 第三方作者自己改的那份画布。点 MuseCanvas 的桌面快捷方式就会打开它 |
| `localhost:3010` | **本程序的** | 桌面「无限画布」快捷方式打开它，会自动带上 Agent 参数、直接可用 |

**只认 `localhost:3010`**，也就是桌面「无限画布」打开的那个。本程序的出图用自带的豆包通道，不需要装 MuseCanvas。

如果您机器上原本就装过 MuseCanvas，那么 `localhost:3000` 是它的画布，**不是本程序**，它的首页会引导购买别家的账号。安装脚本会把桌面上的 MuseCanvas 启动器移到程序目录的「不常用工具」里（移动不是删除，可移回），减少误点；浏览器书签和手输地址管不了，请自己留意。

两边画布数据互不相通（3010 → Agent `17381`，3000 → Agent `17371`）。如果误开了 3000，关掉标签页、回到「无限画布」即可。

## 使用统计怎么看

分两类，来源不同，别混在一起看：

**一、安装 / 更新次数（在线、可靠）**

发布包放在 GitHub Release 里，分成「全新安装」和「更新」两个文件。GitHub 官方会统计每个文件被下载了多少次——这是真实下载才算的数字，公开、永久、不能被随便刷。

在程序目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\stats.ps1
```

它会显示各版本的安装次数、更新次数，以及本机活跃记录。也可以直接打开网页看：

```
https://github.com/maluom13/infinite-canvas-studio/releases
```

注意：只有从 Release 下载才算数；走镜像站、或从仓库页面下载 ZIP，都不计入。所以这个数字是**下限**，实际人数只会更多。另外 GitHub 的计数有延迟，刚下载的几次可能要等一会儿才显示。

**二、本机活跃记录（离线、只有这台机器）**

每次打开画布会在本机数据目录写一条匿名记录：一个随机安装 ID、活跃天数、启动次数。**不联网、不上传、不含用户名或任何账号信息。**

想关掉：启动画布前设置环境变量 `CANVAS_USAGE_DISABLED=1`。

**必须说清的限制**：这个本地记录**看不到其他人的使用情况**。要在线汇总所有人的活跃设备数，必须有一个中心服务器接收上报。本项目默认没有上报任何数据，也不会假装能做到。如果你以后有自己的服务器，可以设置 `CANVAS_USAGE_ENDPOINT` 指向它，程序会把 `{installId, date}` 用 POST 发过去（失败静默，不影响使用）。在此之前，能可靠看到的只有上面的 GitHub 下载次数。

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
| Muse | 画布顶部 Muse 面板（可选） | 仅当你自己已装 MuseCanvas 且有账号时可用；账号问题请自行解决，本程序不引导也不代购 |
| 豆包 | 画布顶部豆包面板 | 独立浏览器与登录态，与 Muse 无关；人机验证需本人完成 |
| 视频号 / 快手 / 抖音 | 「自动发布」页面 | 各平台扫码一次，之后复用登录态 |
| Codex / Claude | Agent 设置页 | 用于 Agent 对话，不登录则只能用画布手工操作 |

**任何账号都不应该由他人代登录**，也不要把 Cookie、令牌、密码写进配置或提交到仓库。

## Muse 登录不上怎么排查

先打开这个地址，它会直接告诉你是哪一层断了：

```
http://127.0.0.1:3010/muse/diagnose
```

返回里 `steps` 每项都是 `ok: true/false`，对应关系如下：

| 断在这一层 | 说明 | 怎么处理 |
|---|---|---|
| Muse 通道 | **本机没装 MuseCanvas**（正常情况，不影响出图） | 出图请用豆包通道：画布顶部切换并登录即可。Muse 是可选功能，只有你自己已有 MuseCanvas 且想用时才需要，此时在 `canvas.config.json` 里填 `museInstall` |
| 账号池 | 连不上 → 服务没启动；HTTP 401/403 → 密钥不匹配 | 用同一套 MuseCanvas 启动；别混用两个安装目录的 `install.json` |
| 生成协议 | 账号池通了、协议没响应 | 在 MuseCanvas 页面确认六个服务都正常，必要时停止再启动 |
| 已有 Muse 账号 | 服务正常但账号数为 0，或全部不可用 | 点画布顶部 Muse → 添加账号，用**你自己的**账号登录 |

**为什么「点登录没反应 / 无法获取」几乎都是这一条**：画布自己不会登录 Muse，它只是把请求转给本机的 MuseCanvas，由 MuseCanvas 弹出登录窗口。本机没有 MuseCanvas，就等于没有登录入口——不是按钮坏了。

**两个软件解决不了的前提**，占「登录不了」的大多数：

1. **没有 Muse 账号 / 邀请码**（仅当你自己选择用可选的 Muse 通道时）。本程序默认用豆包通道，不需要 Muse 账号；如果豆包能正常出图，就不用管这一段。
2. **MuseCanvas 版本太旧**（同上，仅可选通道）。旧版有「登录后窗口不关、账号加不进来」的已知问题，0.23.3 已修。账号与邀请码请通过你自己的渠道解决，本程序不提供也不引导。

登录动作本身：画布顶部 **Muse → 添加账号** → 弹出 Muse 的登录窗口 → 本人扫码或输密码 → 完成后窗口自动关闭，账号出现在列表里。窗口没关就说明登录没完成，不要重复点。

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

所以豆包适合「先把流程跑通、先看效果」。如果你已经有 MuseCanvas 和账号、且需要角色一致性的成片，可以在配置里启用可选的 Muse 通道；没有就不用管，豆包通道能正常完成大部分出图出视频。

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
