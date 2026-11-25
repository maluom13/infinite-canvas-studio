import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import { AGENT_PROMPT } from "../config.js";
import { createAgentLogWriter } from "../utils/agent-runtime.js";
import { logger } from "../utils/logger.js";
import { errorMessage } from "../utils/value.js";
import type { AgentEmit } from "./types.js";

/** WorkBuddy 内置 CodeBuddy CLI 的运行位置。 */
export type CodebuddyRuntime = { nodePath: string; cliPath: string };

/** WorkBuddy 账号与 CLI 的可用状态。 */
export type CodebuddyStatus = { installed: boolean; loggedIn: boolean; cliPath: string; version: string; account: string; error: string };

/** 一次 WorkBuddy 对话执行的参数。 */
export type CodebuddyRunOptions = { cwd?: string; model?: string; permissionMode?: string; messageText?: string; threadId?: string; resumeSessionId?: string; onSession?: (sessionId: string) => void; onAnswer?: (text: string) => void };

/** WorkBuddy 可选模型：CLI 的模型 ID 与中文展示名。 */
export type CodebuddyModel = { model: string; displayName: string };

const DEFAULT_THREAD_ID = "workbuddy:main";
const FALLBACK_MODEL = "deepseek-v4.1-flash";
const NODE_MIN_VERSION = "18.20.8";
const SERVE_PORT_BASE = 18620;
const CREDENTIAL_FILES = [".credentials.json", "credentials.json", "auth.json", "session.json", "config.json"];

let cachedRuntime: CodebuddyRuntime | null | undefined;
let cachedVersion: string | null = null;
let modelLoad: Promise<CodebuddyModel[]> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let currentChild: ChildProcess | null = null;

const execFileAsync = promisify(execFile);

/** 解析 WorkBuddy 内置 CodeBuddy CLI，找不到时返回 null。 */
export function resolveCodebuddyRuntime(force = false): CodebuddyRuntime | null {
    if (!force && cachedRuntime !== undefined) return cachedRuntime;
    cachedRuntime = detectRuntime();
    if (cachedRuntime) logger.info("CodeBuddy CLI detected", { cliPath: cachedRuntime.cliPath, nodePath: cachedRuntime.nodePath });
    else logger.warn("CodeBuddy CLI not found; WorkBuddy engine unavailable");
    return cachedRuntime;
}

/** 读取 WorkBuddy 引擎的安装、登录与账号状态。 */
export function readCodebuddyStatus(probe = false): CodebuddyStatus {
    const runtime = resolveCodebuddyRuntime();
    if (!runtime) return { installed: false, loggedIn: false, cliPath: "", version: "", account: "", error: "" };
    // 重新登录后凭据文件会刷新，之前的失败缓存立即失效，不必再等满 30 分钟
    if (authFailedAt && credentialUpdatedAt() > authFailedAt) authFailedAt = 0;
    const state = readAccountState();
    const status: CodebuddyStatus = { installed: true, loggedIn: state.loggedIn, cliPath: runtime.cliPath, version: runtimeVersion(runtime), account: state.account, error: state.error };
    // 30 分钟内刚因未登录失败过，直接按不可用处理，避免再让用户白跑一轮
    if (status.loggedIn && Date.now() - authFailedAt < 30 * 60 * 1000) {
        status.loggedIn = false;
        status.error = AUTH_FAILED_MESSAGE;
    }
    if (probe) {
        const result = probeLogin(runtime);
        status.loggedIn = result.loggedIn;
        status.error = result.error;
        if (result.account) status.account = result.account;
    }
    return status;
}

/** CLI 里模型 ID 对应的中文名，取自 WorkBuddy 模型设置页。 */
const MODEL_LABELS: Record<string, string> = {
    "fast-model": "快速",
    "balanced-model": "均衡",
    "deep-model": "极致",
    hy4std: "Hy4",
    "hy4flash-free": "Hy4 flash（免费）",
    hy4flash: "Hy4 flash",
    "deepseek-v4.1-flash": "DeepSeek-V4.1-Flash",
    "glm-5.3": "GLM-5.3",
    "glm-5.3-flash": "GLM-5.3-Flash",
    "glm-5.2": "GLM-5.2",
    "space-bunny": "Space-Bunny",
    "minimax-m3.1-flash": "MiniMax-M3.1-Flash",
    "kimi-k3.1-pro": "Kimi-K3.1-Pro",
    "kimi-k3-1": "Kimi-K3",
    "kimi-k2.8-preview": "Kimi-K2.8-Preview",
    "deepseek-v4-pro": "DeepSeek-V4-Pro",
    "step-5-preview": "Step-5-Preview",
    "mimo-v2.6-pro": "Xiaomi MiMo-V2.6-Pro",
};

let cachedModels: CodebuddyModel[] | null = null;

/** 读取 CLI 自带产品配置里的模型目录（id → 展示名），用于给 supported 清单补中文名。 */
function productModelNames(runtime: CodebuddyRuntime) {
    const file = path.join(path.dirname(runtime.cliPath), "..", "product.json");
    try {
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as { models?: Array<{ id?: string; name?: string; supportsToolCall?: boolean }> };
        const names = new Map<string, string>();
        for (const item of data.models || []) {
            const id = String(item.id || "").trim();
            if (!id) continue;
            // 只保留能调工具的对话模型，排除补全/图片/视频等专用模型
            if (item.supportsToolCall === false) continue;
            names.set(id, String(item.name || "").trim() || id);
        }
        return names;
    } catch (error) {
        logger.debug("Failed to read CodeBuddy product models", { error: errorMessage(error) });
        return new Map<string, string>();
    }
}

/** 读取 CLI 支持的模型列表：解析 --help 里的 supported 清单，进程内缓存。 */
export function listCodebuddyModels(): Promise<CodebuddyModel[]> {
    if (cachedModels) return Promise.resolve(cachedModels);
    if (!modelLoad) modelLoad = loadModels().finally(() => { modelLoad = null; });
    return modelLoad;
}

async function loadModels(): Promise<CodebuddyModel[]> {
    const runtime = resolveCodebuddyRuntime();
    if (!runtime) return (cachedModels = []);
    try {
        const { stdout } = await execFileAsync(runtime.nodePath, [runtime.cliPath, "--help"], { timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: buildEnv() });
        const supported = /Currently supported:\s*\(([^)]*)\)/.exec(stdout)?.[1] || "";
        const names = productModelNames(runtime);
        cachedModels = supported
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
            .map((model) => ({ model, displayName: MODEL_LABELS[model] || names.get(model) || model }));
        logger.info("CodeBuddy models loaded", { count: cachedModels.length });
    } catch (error) {
        logger.debug("Failed to read CodeBuddy model list", { error: errorMessage(error) });
        cachedModels = [];
    }
    return cachedModels;
}

/** 过滤掉 CLI 不认识的模型，避免整轮对话因 --model 无效直接失败。 */
function resolveModel(model?: string) {
    const value = String(model || "").trim();
    if (!value) return "";
    // 模型清单是异步加载的；未就绪时直接透传，让 CLI 自行判断
    if (!cachedModels?.length) return value;
    return cachedModels.some((item) => item.model === value) ? value : "";
}

/** 未指定模型时的兜底：CLI 的 default 可能指向已欠额的自定义模型，导致整轮 429。 */
function defaultModel() {
    if (!cachedModels?.length) return FALLBACK_MODEL;
    return cachedModels.some((item) => item.model === FALLBACK_MODEL) ? FALLBACK_MODEL : "";
}

/** 串行执行一次 WorkBuddy 对话，避免同一 CLI 会话被并发复用。 */
export async function runCodebuddyTurn(prompt: string, emit: AgentEmit, options: CodebuddyRunOptions = {}) {
    const task = queue.catch(() => undefined).then(() => runTurnNow(prompt, emit, options));
    queue = task;
    await task;
}

/** 一次性文本生成（标题/标签这类短任务）：不挂画布 MCP，直接把 CLI 的标准输出返回。 */
export function runCodebuddyText(prompt: string, timeoutMs = 120000): Promise<string> {
    const runtime = resolveCodebuddyRuntime();
    if (!runtime) return Promise.reject(new Error("未找到 WorkBuddy 内置的 CodeBuddy CLI"));
    // defaultModel() 返回空串表示账号里没有兜底模型，此时交给 CLI 用自身默认模型。
    const model = defaultModel();
    const args = [runtime.cliPath, "-p", "--output-format", "text", "--max-turns", "1", ...(model ? ["--model", model] : []), prompt];
    return new Promise((resolve, reject) => {
        const child = spawn(runtime.nodePath, args, { env: buildEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        // 中文跨 chunk 会被 toString 截断成乱码，导致文案 / JSON 解析失败。
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        const timer = setTimeout(() => {
            killQuietly(child);
            reject(new Error("文案生成超时，请稍后重试"));
        }, timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => {
            out += stdoutDecoder.write(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            err = (err + stderrDecoder.write(chunk)).slice(-4000);
        });
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            const text = out.trim();
            if (code === 0 && text) return resolve(text);
            if (/Authentication required|Please use \/login/i.test(err)) return reject(new Error(AUTH_FAILED_MESSAGE));
            if (quotaExhausted(err)) return reject(new Error(QUOTA_EXCEEDED_MESSAGE));
            reject(new Error(failureDetail(err) || `CodeBuddy CLI 退出码 ${code}`));
        });
    });
}

/** 中断正在执行的 WorkBuddy 对话。 */
export function interruptCodebuddyTurn() {
    if (!currentChild) return false;
    const child = currentChild;
    currentChild = null;
    try {
        child.kill();
    } catch (error) {
        logger.warn("Failed to interrupt CodeBuddy turn", { error });
        return false;
    }
    return true;
}

/** 打开 WorkBuddy 官方登录页（浏览器扫码），返回登录地址。 */
export async function openCodebuddyLogin() {
    const runtime = resolveCodebuddyRuntime();
    if (!runtime) throw new Error("未找到 WorkBuddy 内置的 CodeBuddy CLI，请确认 WorkBuddy 已安装并至少启动过一次。");
    const bridge = await ensureServeBridge(runtime);
    const payload = (await bridgeJson(bridge, "/api/v1/auth/account/login", { method: "POST", body: "{}" })) as { data?: { authUrl?: string; success?: boolean }; error?: { message?: string } };
    const url = String(payload?.data?.authUrl || "").trim();
    if (!url) throw new Error(payload?.error?.message || "CodeBuddy 没有返回登录地址，请稍后重试。");
    // 只返回登录地址，由前端打开唯一一个标签页，避免服务端和前端各弹一个浏览器窗口
    logger.info("Generated WorkBuddy login URL", { url: url.split("?")[0] });
    return url;
}

/** 执行一次对话并把 CLI 的 stream-json 输出转换为画布事件。 */
async function runTurnNow(prompt: string, emit: AgentEmit, options: CodebuddyRunOptions) {
    const fullPrompt = buildPrompt(prompt, options.messageText);
    if (!fullPrompt) return;
    const runtime = resolveCodebuddyRuntime();
    if (!runtime) {
        emit("agent_error", { message: "未找到 WorkBuddy 内置的 CodeBuddy CLI，请确认 WorkBuddy 已安装并至少启动过一次。" });
        return;
    }
    const threadId = options.threadId || DEFAULT_THREAD_ID;
    const turnId = `workbuddy-${Date.now()}`;
    const ctx: TurnContext = { emit, threadId, turnId, streamed: new Map(), completed: new Set(), toolNames: new Map(), started: false, onSession: options.onSession, onAnswer: options.onAnswer };
    const args = buildArgs(runtime, fullPrompt, options);
    logger.info("CodeBuddy turn started", { threadId, turnId, model: options.model || "default", promptLength: fullPrompt.length, cwd: options.cwd || process.cwd() });
    let child: ChildProcess;
    try {
        child = spawn(runtime.nodePath, args, { cwd: options.cwd || process.cwd(), env: buildEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
        emit("agent_error", { message: errorMessage(error) });
        return;
    }
    currentChild = child;
    emit("agent_event", { agent: "workbuddy", type: "turn.started", thread_id: threadId, turn_id: turnId });
    ctx.started = true;
    await new Promise<void>((resolve) => {
        let buffer = "";
        let stderrTail = "";
        const raw = createAgentLogWriter((text) => {
            if (/Authentication required|Please use \/login/i.test(text)) markAuthFailed(ctx);
            logger.debug("CodeBuddy stderr", { text: text.trim() });
        });
        // 中文等 UTF-8 多字节字符可能跨 chunk，用 decoder 保证不出现乱码。
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        child.stdout?.on("data", (chunk: Buffer) => {
            buffer += stdoutDecoder.write(chunk);
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            for (const line of lines) handleStreamLine(line, ctx);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            const text = stderrDecoder.write(chunk);
            // 分块到达时 "Authentication required" 可能被截断，留一段尾部合并判断
            stderrTail = (stderrTail + text).slice(-4000);
            // 额度耗尽时 CLI 会按 retry-after 睡一小时，直接掐掉并给出可操作提示
            if (quotaExhausted(text)) {
                ctx.quotaExceeded = true;
                killQuietly(child);
            }
            raw.write(text);
        });
        child.on("error", (error) => {
            raw.flush();
            emit("agent_error", { message: error.message });
        });
        child.on("close", (code) => {
            raw.flush();
            if (buffer.trim()) handleStreamLine(buffer, ctx);
            if (!ctx.finished) {
                if (/Authentication required|Please use \/login/i.test(stderrTail)) markAuthFailed(ctx);
                if (quotaExhausted(stderrTail)) ctx.quotaExceeded = true;
                const failed = code !== 0;
                const detail = ctx.authFailed || ctx.quotaExceeded ? "" : failureDetail(stderrTail);
                const message = ctx.authFailed ? AUTH_FAILED_MESSAGE : ctx.quotaExceeded ? QUOTA_EXCEEDED_MESSAGE : detail ? `WorkBuddy 执行失败（退出码 ${code}）：${detail}` : `CodeBuddy CLI 退出码 ${code}`;
                emit("agent_event", { agent: "workbuddy", type: "turn.completed", status: failed ? "failed" : "completed", error: failed ? { message } : undefined, thread_id: threadId, turn_id: turnId });
                emit("agent_done", { agent: "workbuddy", status: failed ? "failed" : "completed", code, thread_id: threadId, turn_id: turnId });
            }
            if (currentChild === child) currentChild = null;
            logger.info("CodeBuddy turn finished", { threadId, turnId, code });
            resolve();
        });
    });
}

/** 从 stderr 里挑一行最能说明问题的内容，避免把整段堆栈糊到聊天里。 */
function failureDetail(text: string) {
    const lines = text
        .replace(/\u001b\[[0-9;]*m/g, "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !/accessToken|refreshToken|Bearer\s/i.test(line));
    const hit = lines.find((line) => /error|failed|invalid|denied|unauthorized|expired|not found|cannot|无法|失败|未登录|超时/i.test(line));
    return (hit || lines[lines.length - 1] || "").slice(0, 300);
}

type TurnContext = { emit: AgentEmit; threadId: string; turnId: string; streamed: Map<number, string>; completed: Set<string>; toolNames: Map<string, string>; started: boolean; finished?: boolean; authFailed?: boolean; quotaExceeded?: boolean; sessionId?: string; onSession?: (sessionId: string) => void; onAnswer?: (text: string) => void };

/** CLI 未登录时的统一提示，避免把退出码糊给用户。 */
const AUTH_FAILED_MESSAGE = "WorkBuddy 登录态已失效，请点输入框上方的「重新登录 WorkBuddy」扫码后再试。";

/** 模型额度耗尽时的提示：CLI 会按 retry-after 长时间重试，直接换模型更快。 */
const QUOTA_EXCEEDED_MESSAGE = "所选模型额度已用尽（429），请在输入框上方换一个模型再试，例如 DeepSeek-V4.1-Flash。";

/** 判断错误输出是否属于额度耗尽/长间隔限流。 */
function quotaExhausted(text: string) {
    if (/quota_balance_exhausted|insufficient.?quota|额度.{0,8}(不足|用尽|耗尽)/i.test(text)) return true;
    // retry-after 大于 5 分钟说明不是瞬时抖动，等下去没有意义
    return /status=429[\s\S]{0,400}?retry-after=(\d{6,})ms/i.test(text);
}

/** 最近一次因未登录失败的时间：短时间内直接按未登录处理，避免反复撞墙。 */
let authFailedAt = 0;

/** 只提示一次未登录，避免同一轮刷屏。 */
function markAuthFailed(ctx: TurnContext) {
    if (ctx.authFailed) return;
    ctx.authFailed = true;
    authFailedAt = Date.now();
    ctx.emit("agent_error", { message: AUTH_FAILED_MESSAGE });
}

type StreamEvent = Record<string, unknown>;
type ContentBlock = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

/** 解析单行 stream-json 并广播为画布可识别的事件。 */
function handleStreamLine(line: string, ctx: TurnContext) {
    const text = line.trim();
    if (!text) return;
    let event: StreamEvent;
    try {
        event = JSON.parse(text) as StreamEvent;
    } catch {
        if (/Authentication required|Please use \/login/i.test(text)) markAuthFailed(ctx);
        ctx.emit("agent_event", { agent: "workbuddy", type: "raw", text });
        return;
    }
    const type = String(event.type || "");
    if (type === "stream_event") {
        handlePartial(event.event as StreamEvent | undefined, ctx);
        return;
    }
    if (type === "assistant") {
        handleAssistant(event, ctx);
        return;
    }
    if (type === "user") {
        handleToolResult(event, ctx);
        return;
    }
    if (type === "result") {
        handleResult(event, ctx);
        return;
    }
    if (type === "system" && String(event.subtype || "") === "init") {
        const sessionId = String(event.session_id || "");
        if (sessionId && ctx.sessionId !== sessionId) {
            ctx.sessionId = sessionId;
            ctx.onSession?.(sessionId);
        }
        logger.debug("CodeBuddy session initialized", { sessionId });
    }
}

/** 处理流式增量文本，避免与完整 assistant 消息重复渲染。 */
function handlePartial(event: StreamEvent | undefined, ctx: TurnContext) {
    if (!event || event.type !== "content_block_delta") return;
    const delta = event.delta as StreamEvent | undefined;
    if (!delta || delta.type !== "text_delta") return;
    const value = String(delta.text || "");
    if (!value) return;
    const index = Number(event.index || 0);
    ctx.streamed.set(index, (ctx.streamed.get(index) || "") + value);
    ctx.emit("agent_event", { agent: "workbuddy", type: "item.updated", thread_id: ctx.threadId, turn_id: ctx.turnId, item: { id: `${ctx.turnId}:text:${index}`, type: "agent_message", delta: value, text: ctx.streamed.get(index) } });
}

/** 处理完整 assistant 消息中的文本与工具调用块。 */
function handleAssistant(event: StreamEvent, ctx: TurnContext) {
    const message = event.message as StreamEvent | undefined;
    const blocks = Array.isArray(message?.content) ? (message?.content as ContentBlock[]) : [];
    blocks.forEach((block, index) => {
        if (block.type === "text") {
            const value = String(block.text || "");
            if (!value) return;
            // CLI 未登录时会把提示当普通文本吐出来，转成统一提示，别原样渲染
            if (/Authentication required|Please use \/login/i.test(value)) {
                markAuthFailed(ctx);
                return;
            }
            const streamed = ctx.streamed.get(index);
            if (streamed && streamed.length >= value.length) return;
            ctx.emit("agent_event", { agent: "workbuddy", type: "item.completed", thread_id: ctx.threadId, turn_id: ctx.turnId, item: { id: `${ctx.turnId}:text:${index}`, type: "agent_message", text: value } });
            return;
        }
        if (block.type === "tool_use") {
            const id = String(block.id || `${ctx.turnId}:tool:${index}`);
            const name = String(block.name || "tool");
            ctx.toolNames.set(id, name);
            ctx.emit("agent_event", { agent: "workbuddy", type: "item.started", thread_id: ctx.threadId, turn_id: ctx.turnId, item: { id, type: "dynamic_tool_call", server: toolServer(name), tool: toolLabel(name), status: "in_progress", arguments: block.input } });
            return;
        }
        if (block.type === "thinking") {
            ctx.emit("agent_event", { agent: "workbuddy", type: "item.completed", thread_id: ctx.threadId, turn_id: ctx.turnId, item: { id: `${ctx.turnId}:thinking:${index}`, type: "reasoning", text: String(block.text || "") } });
        }
    });
}

/** 把工具结果回填到对应工具调用项。 */
function handleToolResult(event: StreamEvent, ctx: TurnContext) {
    const message = event.message as StreamEvent | undefined;
    const blocks = Array.isArray(message?.content) ? (message?.content as ContentBlock[]) : [];
    blocks.forEach((block) => {
        if (block.type !== "tool_result") return;
        const id = String(block.tool_use_id || "");
        if (!id) return;
        const failed = Boolean(block.is_error);
        ctx.completed.add(id);
        ctx.emit("agent_event", { agent: "workbuddy", type: "item.completed", thread_id: ctx.threadId, turn_id: ctx.turnId, item: { id, type: "dynamic_tool_call", server: toolServer(ctx.toolNames.get(id) || ""), tool: toolLabel(ctx.toolNames.get(id) || ""), status: failed ? "failed" : "completed", result: summarizeToolContent(block.content) } });
    });
}

/** 处理本次对话的最终结果事件。 */
function handleResult(event: StreamEvent, ctx: TurnContext) {
    ctx.finished = true;
    const failed = String(event.subtype || "") !== "success" || Boolean(event.is_error);
    const usage = event.usage as StreamEvent | undefined;
    const resultText = String(event.result || "");
    const errorText = `${resultText} ${String(event.error || "")}`;
    const sessionId = String(event.session_id || "");
    if (sessionId && ctx.sessionId !== sessionId) {
        ctx.sessionId = sessionId;
        ctx.onSession?.(sessionId);
    }
    if (/Authentication required|Please use \/login/i.test(errorText)) markAuthFailed(ctx);
    if (quotaExhausted(errorText)) ctx.quotaExceeded = true;
    if (resultText && !ctx.streamed.size && !ctx.authFailed) {
        ctx.emit("agent_event", { agent: "workbuddy", type: "item.completed", thread_id: ctx.threadId, turn_id: ctx.turnId, item: { id: `${ctx.turnId}:text:final`, type: "agent_message", text: resultText } });
    }
    // 记录本轮回答，供历史会话回看
    if (!ctx.authFailed && !ctx.quotaExceeded) {
        const answer = resultText.trim() || [...ctx.streamed.values()].join("\n\n").trim();
        if (answer) ctx.onAnswer?.(answer);
    }
    const failureMessage = ctx.authFailed ? AUTH_FAILED_MESSAGE : ctx.quotaExceeded ? QUOTA_EXCEEDED_MESSAGE : String(event.error || event.subtype || "WorkBuddy 对话失败");
    ctx.emit("agent_event", { agent: "workbuddy", type: "turn.completed", status: failed ? "failed" : "completed", ...(failed ? { error: { message: failureMessage } } : {}), ...(usage ? { usage } : {}), thread_id: ctx.threadId, turn_id: ctx.turnId });
    ctx.emit("agent_done", { agent: "workbuddy", status: failed ? "failed" : "completed", ...(usage ? { usage } : {}), thread_id: ctx.threadId, turn_id: ctx.turnId });
}

/** 生成 CodeBuddy CLI 的启动参数。 */
function buildArgs(runtime: CodebuddyRuntime, prompt: string, options: CodebuddyRunOptions) {
    const args = [
        runtime.cliPath,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--allowedTools",
        "mcp__infinite-canvas__*",
        "--mcp-config",
        JSON.stringify(mcpConfig()),
        "--strict-mcp-config",
        "--permission-mode",
        permissionMode(options.permissionMode),
    ];
    const model = resolveModel(options.model) || defaultModel();
    if (model) args.push("--model", model);
    // 继续历史会话：CLI 会带上之前的上下文
    const resume = String(options.resumeSessionId || "").trim();
    if (resume) args.push("--resume", resume);
    args.push(prompt);
    return args;
}

/** 构造注入画布 MCP 与助手说明的完整提示词。 */
function buildPrompt(prompt: string, messageText?: string) {
    const text = prompt.trim();
    if (!text) return "";
    const prefix = messageText && messageText !== text ? `（网页展示的附件说明：${messageText}）\n\n` : "";
    return `${AGENT_PROMPT}\n\n${prefix}用户请求：${text}`;
}

/** 指向本地 canvas-agent 的 MCP 配置，复用同一套画布工具。 */
function mcpConfig() {
    const home = process.env.CANVAS_AGENT_HOME;
    const server: Record<string, unknown> = { command: process.execPath, args: [canvasAgentEntry(), "mcp"] };
    if (home) server.env = { CANVAS_AGENT_HOME: home };
    return { mcpServers: { "infinite-canvas": server } };
}

/** 计算 MCP 入口脚本路径，兼容编译产物目录。 */
function canvasAgentEntry() {
    return fileURLToPath(new URL("../index.js", import.meta.url));
}

/** 将网页的权限模式映射为 CLI 参数。非交互模式没有弹窗授权通道，统一放行；真正可用的工具仍由 --allowedTools 限定为画布 MCP。 */
function permissionMode(_mode?: string) {
    return "bypassPermissions";
}

/** 组装子进程环境：清掉代理变量，避免 CLI 拉配置失败后误判为「未登录」。 */
function buildEnv() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // 这个安装只带 lite-wb 产物；父进程没带开关时会走 headless 分支并报
    // "Cannot find module '../dist/codebuddy'"，所以这里显式指定
    const runtime = resolveCodebuddyRuntime();
    const liteBundle = runtime ? path.join(path.dirname(runtime.cliPath), "..", "dist", "codebuddy-lite-wb.mjs") : "";
    if (!env.CODEBUDDY_FORCE_LITE_WB_BUNDLE && liteBundle && isFile(liteBundle)) env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = "1";
    // 关键：CLI 跑在独立 home 里。桌面版会周期性把真实 profile 下的凭据重新加密，
    // 而它只扫自己的数据目录，碰不到这份独立副本，CLI 因此可以长期保持登录。
    const cliHome = cliHomeDir();
    syncCliCredential();
    env.USERPROFILE = cliHome;
    env.HOME = cliHome;
    env.LOCALAPPDATA = path.join(cliHome, "AppData", "Local");
    env.APPDATA = path.join(cliHome, "AppData", "Roaming");
    // 会话、模型缓存等仍用真实配置目录，避免脱离用户已有设置
    env.CODEBUDDY_CONFIG_DIR = env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), ".codebuddy");
    if (process.env.CANVAS_CODEBUDDY_KEEP_PROXY === "1") return env;
    for (const key of Object.keys(env)) {
        if (/^(https?|all|socks|socks5|no)_proxy$/i.test(key)) delete env[key];
    }
    env.NO_PROXY = "*";
    env.no_proxy = "*";
    return env;
}

type ServeBridge = { port: number; cookie: string; child: ChildProcess };
let serveBridge: Promise<ServeBridge> | null = null;

/** 懒启动 CodeBuddy 的本地 HTTP 服务：官方登录页由它下发。 */
function ensureServeBridge(runtime: CodebuddyRuntime) {
    if (!serveBridge) {
        serveBridge = startServeBridge(runtime).catch((error) => {
            serveBridge = null;
            throw error;
        });
    }
    return serveBridge;
}

async function startServeBridge(runtime: CodebuddyRuntime): Promise<ServeBridge> {
    for (let port = SERVE_PORT_BASE; port < SERVE_PORT_BASE + 5; port += 1) {
        if (await isPortBusy(port)) continue;
        const child = spawn(runtime.nodePath, [runtime.cliPath, "--serve", "--port", String(port), "--host", "127.0.0.1"], { env: buildEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const password = await waitForServePassword(child);
        if (!password) {
            killQuietly(child);
            continue;
        }
        const cookie = await fetchSessionCookie(port, password);
        if (!cookie) {
            killQuietly(child);
            continue;
        }
        child.on("exit", () => {
            serveBridge = null;
        });
        process.once("exit", () => killQuietly(child));
        logger.info("CodeBuddy serve bridge ready", { port });
        return { port, cookie, child };
    }
    throw new Error("无法启动 CodeBuddy 本地服务，请稍后重试。");
}

/** 从服务启动输出里抓访问密码；拿到后继续消费输出，避免子进程写满管道阻塞。 */
function waitForServePassword(child: ChildProcess) {
    return new Promise<string>((resolve) => {
        let buffer = "";
        let settled = false;
        const timer = setTimeout(() => finish(""), 25000);
        const finish = (value: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const decoder = new StringDecoder("utf8");
        child.stdout?.on("data", (chunk: Buffer) => {
            if (settled) return;
            buffer += decoder.write(chunk);
            if (buffer.length > 65536) buffer = buffer.slice(-8192);
            const match = /Password\s+([A-Za-z0-9_-]{8,})/.exec(buffer);
            if (match) finish(match[1]);
        });
        child.stderr?.on("data", (chunk: Buffer) => logger.debug("CodeBuddy serve stderr", { text: chunk.toString("utf8").trim() }));
        child.on("error", () => finish(""));
    });
}

/** 用启动密码换一个本地会话 cookie。 */
async function fetchSessionCookie(port: number, password: string) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/?password=${encodeURIComponent(password)}`, { redirect: "manual" });
        const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") || ""];
        for (const line of raw) {
            const match = /gateway_session=([^;]+)/.exec(line || "");
            if (match) return match[1];
        }
        return "";
    } catch (error) {
        logger.debug("Failed to fetch CodeBuddy session cookie", { error: errorMessage(error) });
        return "";
    }
}

/** 带会话 cookie 调用 CodeBuddy 本地接口。 */
async function bridgeJson(bridge: ServeBridge, path: string, init: RequestInit = {}) {
    const response = await fetch(`http://127.0.0.1:${bridge.port}${path}`, {
        ...init,
        headers: { "content-type": "application/json", cookie: `gateway_session=${bridge.cookie}`, ...(init.headers || {}) },
    });
    return (await response.json().catch(() => ({}))) as unknown;
}

function isPortBusy(port: number) {
    return new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        const done = (busy: boolean) => {
            socket.destroy();
            resolve(busy);
        };
        socket.setTimeout(600);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
        socket.connect(port, "127.0.0.1");
    });
}

function killQuietly(child: ChildProcess) {
    try {
        child.kill();
    } catch {
        // 忽略退出阶段的重复 kill
    }
}

/** 把 MCP 工具名转换为前端展示用的服务与工具标签。 */
function toolServer(name: string) {
    const match = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
    return match ? match[1] : "";
}

function toolLabel(name: string) {
    return name.replace(/^mcp__[^_]+(?:__)?/, "") || name;
}

/** 提取工具结果的简短文本，避免把大段内容塞进事件。 */
function summarizeToolContent(content: unknown) {
    if (typeof content === "string") return content.slice(0, 2000);
    if (Array.isArray(content)) {
        const text = content.map((item) => (item && typeof item === "object" ? String((item as ContentBlock).text || "") : "")).filter(Boolean).join("\n");
        return text.slice(0, 2000);
    }
    if (content && typeof content === "object") return JSON.stringify(content).slice(0, 2000);
    return "";
}

/** 探测 WorkBuddy 内置 CodeBuddy CLI 的实际路径。 */
function detectRuntime(): CodebuddyRuntime | null {
    const candidates = [...envCandidates(), ...installCandidates(), ...runningCandidates()];
    const cliPath = candidates.find((item) => item && isFile(item));
    if (!cliPath) return null;
    return { nodePath: process.execPath, cliPath };
}

/** 支持通过环境变量显式指定 CLI 路径。 */
function envCandidates() {
    return [process.env.CANVAS_CODEBUDDY_CLI || ""];
}

/** 按常见安装目录枚举 CLI 路径。 */
function installCandidates() {
    const roots = new Set<string>();
    const localPrograms = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : "";
    for (const base of [localPrograms, process.env.ProgramFiles || "", process.env["ProgramFiles(x86)"] || ""]) {
        if (base) roots.add(path.join(base, "WorkBuddy"));
    }
    return [...roots].map(cliUnderRoot).filter(Boolean);
}

/** 从正在运行的 WorkBuddy 进程或注册表推断安装目录。 */
function runningCandidates() {
    if (process.platform !== "win32") return [];
    const exe = powerShell("(Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)");
    const icon = powerShell("(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*WorkBuddy*' } | Select-Object -First 1 -ExpandProperty DisplayIcon)");
    return [exe ? cliUnderRoot(path.dirname(exe)) : "", icon ? cliUnderRoot(path.dirname(icon.replace(/,\d+$/, ""))) : ""].filter(Boolean);
}

/** 以 UTF-8 输出调用 PowerShell，避免中文安装路径乱码。 */
function powerShell(script: string) {
    try {
        return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], { encoding: "utf8", timeout: 8000, windowsHide: true }).trim();
    } catch (error) {
        logger.debug("PowerShell probe failed", { error: errorMessage(error) });
        return "";
    }
}

function cliUnderRoot(root: string) {
    return root ? path.join(root, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy") : "";
}

function isFile(file: string) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

/** 读取 CLI 版本号，读取失败时返回空串。 */
function runtimeVersion(runtime: CodebuddyRuntime) {
    if (cachedVersion !== null) return cachedVersion;
    try {
        cachedVersion = execFileSync(runtime.nodePath, [runtime.cliPath, "--version"], { encoding: "utf8", timeout: 60000, windowsHide: true, env: buildEnv() }).trim().split(/\r?\n/).pop() || "";
    } catch (error) {
        logger.debug("Failed to read CodeBuddy version", { error: errorMessage(error) });
        cachedVersion = "";
    }
    return cachedVersion;
}

/** 明文凭据备份放在 canvas-agent 自己的私有工作区，不写进桌面版目录。 */
function credentialBackupFile() {
    const home = process.env.CANVAS_AGENT_HOME || path.join(os.tmpdir(), "canvas-agent");
    return path.join(home, "workbuddy-credentials-plaintext.json");
}

/** CLI 的独立 home：桌面版 at-rest 加密只作用于真实 profile，不会碰这里。 */
function cliHomeDir() {
    const home = process.env.CANVAS_AGENT_HOME || path.join(os.tmpdir(), "canvas-agent");
    return path.join(home, "wb-cli-home");
}

/** CLI 实际读取的凭据文件（位于独立 home 内，路径与桌面版一致）。 */
function cliAuthFile() {
    return path.join(cliHomeDir(), "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info");
}

/** 是否是一份可直接使用的明文凭据。 */
function isPlaintextCredential(file: string) {
    if (!isFile(file)) return false;
    try {
        const raw = fs.readFileSync(file, "utf8");
        return !raw.includes("$wbEncrypted") && /"accessToken"\s*:\s*"eyJ/.test(raw);
    } catch {
        return false;
    }
}

/** 从凭据里取展示用账号名，取不到就退回 uid。 */
function credentialAccount(file: string) {
    try {
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as { account?: { nickname?: string; phoneNumber?: string; uid?: string } };
        return String(data.account?.nickname || data.account?.phoneNumber || data.account?.uid || "");
    } catch {
        return "";
    }
}

/** 共享凭据还是明文时留一份备份，作为独立 home 的凭据来源。 */
function syncCredentialBackup() {
    const target = sharedCredentialFiles().find((file) => isFile(file));
    if (!target) return;
    try {
        const raw = fs.readFileSync(target, "utf8");
        if (!/"accessToken"\s*:\s*"eyJ/.test(raw) || raw.includes("$wbEncrypted")) return;
        fs.mkdirSync(path.dirname(credentialBackupFile()), { recursive: true });
        fs.writeFileSync(credentialBackupFile(), raw, { mode: 0o600 });
    } catch (error) {
        logger.debug("WorkBuddy credential backup failed", { error: errorMessage(error) });
    }
}

/**
 * 把明文凭据铺进 CLI 独立 home。
 * 只补「缺失 / 被加密 / 共享凭据更新过」的情况，CLI 自己刷新出的新 token 不会被旧备份覆盖。
 */
function syncCliCredential() {
    syncCredentialBackup();
    const target = cliAuthFile();
    try {
        fs.mkdirSync(path.join(cliHomeDir(), "AppData", "Roaming"), { recursive: true });
        const sources = [...sharedCredentialFiles(), credentialBackupFile()].filter(isPlaintextCredential);
        if (!sources.length) return isPlaintextCredential(target);
        const newest = sources.reduce((left, right) => (fileMtime(right) > fileMtime(left) ? right : left));
        const needsCopy = !isPlaintextCredential(target) || fileMtime(newest) > fileMtime(target) + 1000;
        if (needsCopy) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(newest, target);
            fs.chmodSync(target, 0o600);
            logger.info("Synced WorkBuddy credentials into CLI home", { bytes: fileSize(target) });
        }
        syncCredentialMeta(path.dirname(target));
        return true;
    } catch (error) {
        logger.debug("WorkBuddy credential sync failed", { error: errorMessage(error) });
        return isPlaintextCredential(target);
    }
}

/** 凭据旁的 observation 元数据缺失时从共享目录补一份，CLI 用它判断账号身份。 */
function syncCredentialMeta(dir: string) {
    try {
        if (fs.readdirSync(dir).some((name) => name.endsWith(".observation.json"))) return;
        for (const source of sharedCredentialFiles()) {
            const sourceDir = path.dirname(source);
            const name = fs.readdirSync(sourceDir).find((item) => item.endsWith(".observation.json"));
            if (!name) continue;
            fs.copyFileSync(path.join(sourceDir, name), path.join(dir, name));
            return;
        }
    } catch (error) {
        logger.debug("WorkBuddy credential meta sync failed", { error: errorMessage(error) });
    }
}

/** 通过本地凭证文件推断登录状态，避免每次查询都消耗一次模型调用。 */
function readAccountState() {
    // CLI 实际读的是独立 home，以这里为准，状态才和真实可用性一致
    syncCliCredential();
    const isolated = cliAuthFile();
    if (isPlaintextCredential(isolated)) return { loggedIn: true, account: credentialAccount(isolated), error: "" };
    const blocked = credentialReadBlocked();
    if (blocked) return { loggedIn: false, account: "", error: "WorkBuddy 凭据已加密，当前 CLI 无法解密，请点「重新登录 WorkBuddy」重新扫码。" };
    // 独立 home 里没有可用凭据时，CLI 一定跑不通，不再用「文件存在」冒充已登录
    const home = process.env.CODEBUDDY_HOME || path.join(os.homedir(), ".codebuddy");
    for (const name of CREDENTIAL_FILES) {
        const file = path.join(home, name);
        if (!isFile(file)) continue;
        try {
            const raw = fs.readFileSync(file, "utf8");
            if (!/token|credential|session|access/i.test(raw)) continue;
            const data = JSON.parse(raw) as Record<string, unknown>;
            const account = [data.email, data.userName, data.nickname, data.userId].map((value) => (typeof value === "string" ? value : "")).find(Boolean) || "";
            return { loggedIn: true, account, error: "" };
        } catch {
            continue;
        }
    }
    return { loggedIn: false, account: "", error: "" };
}

/** 检测 at-rest 凭据解密失败登记：CLI 读不到加密凭据时会写在这里，且比凭据文件更新。 */
function credentialReadBlocked() {
    // 独立 home 里有明文凭据时，桌面版的加密失败登记与 CLI 无关
    if (isPlaintextCredential(cliAuthFile())) return false;
    const local = process.env.LOCALAPPDATA;
    if (!local) return false;
    const securityDir = path.join(local, "CodeBuddyExtension", "Data", "Public", "security");
    const registry = path.join(securityDir, "at-rest-failures-v1.json");
    try {
        const data = JSON.parse(fs.readFileSync(registry, "utf8")) as { entries?: Array<{ resourceId?: string; processRole?: string; category?: string; lastFailureAt?: number }> };
        const blocked = (data.entries || []).filter((entry) => entry.resourceId === "auth/workbuddy-desktop.info" && ["cbc", "sidecar"].includes(String(entry.processRole || "")) && ["missing-key", "invalid-key", "safe-storage", "unavailable"].includes(String(entry.category || "")));
        if (!blocked.length) return false;
        // 凭据已经是明文时，历史加密失败登记对 CLI 不再有影响
        const target = sharedCredentialFiles().find((file) => isFile(file));
        if (target && !fs.readFileSync(target, "utf8").includes("$wbEncrypted")) return false;
        // 登录成功后凭据文件会更新；登记早于凭据文件则视为已恢复
        const credentialTime = credentialUpdatedAt();
        return blocked.some((entry) => Number(entry.lastFailureAt || 0) > credentialTime);
    } catch {
        return false;
    }
}

/** 共享凭据文件最近一次更新时间：晚于失败登记时说明用户已重新登录。 */
function credentialUpdatedAt() {
    return Math.max(...sharedCredentialFiles().map((file) => fileMtime(file)), fileMtime(cliAuthFile()), 0);
}

function fileMtime(file: string) {
    try {
        return fs.statSync(file).mtimeMs;
    } catch {
        return 0;
    }
}

/** WorkBuddy 桌面版与 CLI 共用的凭据文件（登录一次两边都生效）。 */
function sharedCredentialFiles() {
    const local = process.env.LOCALAPPDATA;
    if (!local) return [];
    const dir = path.join(local, "CodeBuddyExtension", "Data", "Public", "auth");
    try {
        return fs
            .readdirSync(dir)
            .filter((name) => name.endsWith(".info"))
            .map((name) => path.join(dir, name));
    } catch {
        return [];
    }
}

function fileSize(file: string) {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
}

/** 真实探测一次极小请求，用于登录后的状态校验。探测失败不抛错，避免把底层调用栈糊到界面上。 */
function probeLogin(runtime: CodebuddyRuntime) {
    try {
        const output = execFileSync(runtime.nodePath, [runtime.cliPath, "-p", "--output-format", "text", "--max-turns", "1", "只回复 ok"], { encoding: "utf8", timeout: 120000, windowsHide: true, env: buildEnv() });
        if (/Authentication required/i.test(output)) return { loggedIn: false, error: "WorkBuddy 账号未登录" };
        return { loggedIn: true, error: "", account: "" };
    } catch (error) {
        const message = errorMessage(error);
        if (/Authentication required/i.test(message)) return { loggedIn: false, error: "WorkBuddy 账号未登录" };
        // 探测命令本身跑不起来（路径/模块问题）时，退回到凭据文件判断，不把调用栈暴露给用户
        logger.warn("CodeBuddy login probe failed", { error: message });
        const state = readAccountState();
        return { loggedIn: state.loggedIn, error: state.loggedIn ? "" : "CLI 探测失败，请直接尝试发送消息" };
    }
}
