# 本机安装与使用

- 项目：D:\CodexOutputs\infinite-canvas
- 版本：网页 v0.20.0，Canvas Agent 0.6.0。
- 下载来源：https://github.com/basketikun/infinite-canvas 的 main 源码压缩包。Git 下载受本机代理重写影响，使用 GitHub codeload 完成安装；此目录不是 Git checkout。
- 启动：双击 D:\CodexOutputs\InfiniteCanvas-Start.lnk。
- 停止本次服务：双击 D:\CodexOutputs\InfiniteCanvas-Stop.lnk。
- 网页：http://127.0.0.1:3010
- Agent：http://127.0.0.1:17381
- 状态、浏览器画布数据和日志：D:\CodexData\.codex\infinite-canvas
- Bun 与 npm 缓存：D:\CodexData\.codex\cache

启动快捷方式会后台启动服务，并打开使用独立 D 盘浏览器配置的 Chrome，自动连接 Agent。请使用此入口保持同一份画布数据。未设置开机自启。

普通网页链接现在也会自动取得本安装的 Codex 连接信息并连接 17381；无需手填 Token。已经打开的页面刷新即可生效。已在全新浏览器和刷新场景验证连接及会话 ready。使用其他浏览器会有独立的画布本地数据，日常仍建议使用 D 盘启动入口。

Codex 插件 infinite-canvas@infinite-canvas-local 已安装并启用；MCP 使用本地编译版本，并与启动器共用 D 盘状态目录。在 Codex 新建聊天后输入：“打开 D 盘本地 Infinite Canvas，读取当前画布。”当前已打开的聊天可能需要重新加载才能取得新插件工具。

Muse 图片、视频接口已接入。刷新当前画布，顶部点击 Muse 即可查看账号、登录 Muse 或重新登录。已有有效账号会在首次接入时自动配置图片和视频模型，无需填写 API 地址或 Key。登录窗口由本机 Muse 服务打开，密码与验证码由用户本人输入，登录完成后自动载入模型。

此接入复用 D:\CodexOutputs\MuseCanvas 中的 Muse 账号服务及 D:\CodexOutputs\MuseCanvasData 中的账号数据，仍受该服务的账号状态和软件授权约束。账号登录状态是共享的，作品数据仍在新版画布的独立浏览器配置中。启动入口会检查 Muse 服务，未运行时调用现有启动器的 NoBrowser 模式。停止新版画布不会停止共享 Muse 服务。

新画布的本地转发层在服务端读取现有安装密钥，浏览器只保存占位值 local-session，不保存或展示该密钥。服务端限制同源请求并仅转发登录、模型、生成与媒体接口。当前配置使用 Vite 本地服务（也支持 Vite preview），单独发布静态 dist 不包含这一服务能力。

验证：6 项本地接口测试通过（27 条断言）；独立浏览器验证实际账号和模型、模拟登录成功/失败、刷新后持久化、模拟文生图/参考图编辑/视频任务与媒体返回通过；没有页面 JavaScript 异常。实际用户画布的 MCP 已读到 Muse 图片和视频模型。没有发起真实图片或视频生成，没有消耗生成额度；真实 Muse 登录仍需用户本人操作。

## 验证结果

- 网页 HTTP 200，浏览器页面无 JavaScript 异常。
- 网页显示 Codex 已连接；Agent health 显示 hasCanvas=true、会话 ready。
- Codex 模型列表读取成功。
- MCP 完成握手，列出 34 个工具，canvas_get_state 成功读到当前画布。
- 原 MuseCanvas 的 3000/17371 端口服务继续运行。
- 检查了项目 TODO；本次为本机安装，没有完成或删除原项目待办。

## 插件检查记录

来源：用户指定的 basketikun/infinite-canvas 仓库。
版本：插件 0.1.0。
检查范围：7 个文本配置/说明文件，以及图标资源路径；阅读两份 SKILL.md、MCP 命令、插件和 marketplace 清单。
权限：在本机启动 Canvas Agent，通过 localhost 读取和操作画布；使用已有 Codex 登录；安装时从 GitHub/npm 获取源码与依赖。
结论：中等权限范围，符合本次本地安装和 Codex 接入请求；未在插件说明中发现无关数据上传指令。
本地适配：MCP 改用已安装的 Node 与本地 Agent；open-canvas 技能优先使用 D 盘启动器；Agent 新增 CANVAS_AGENT_HOME 环境变量以隔离状态目录。
此记录是安装配置检查，不代表对全部第三方依赖的安全审计。
