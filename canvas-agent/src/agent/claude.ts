import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { AGENT_PROMPT } from "../config.js";
import { createAgentLogWriter } from "../utils/agent-runtime.js";
import { errorMessage } from "../utils/value.js";
import type { AgentEmit } from "./types.js";

/** 使用 Claude CLI 执行一次带 Canvas Agent 工具的任务。 */
export function runClaudeTurn(prompt: string, emit: AgentEmit) {
    const fullPrompt = withAgentPrompt(prompt);
    if (!fullPrompt) return;
    const child = spawnAgent("claude", ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--allowedTools", "mcp__infinite-canvas__*"], emit);
    if (!child) return;
    // prompt 走 stdin：Windows 下必须用 shell 启动 claude.cmd，把用户内容拼进命令行会被 cmd.exe 当命令执行。
    child.stdin?.end(fullPrompt);
    pipeJsonLines(child, emit, "claude");
}

/** 为 Claude CLI 请求拼接 Canvas Agent 指令。 */
function withAgentPrompt(prompt: string) {
    return prompt.trim() ? `${AGENT_PROMPT}\n\n用户请求：${prompt}` : "";
}

/** 将 Claude CLI 的 JSON Lines 输出转换为 Agent 事件。 */
function pipeJsonLines(child: ReturnType<typeof spawn>, emit: AgentEmit, agent: string) {
    let out = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const stderr = createAgentLogWriter((text) => emit("agent_log", { text }));
    child.stdout?.on("data", (chunk) => {
        out += stdoutDecoder.write(chunk);
        const lines = out.split(/\r?\n/);
        out = lines.pop() || "";
        lines.filter(Boolean).forEach((line) => {
            try {
                emit("agent_event", { agent, ...JSON.parse(line) });
            } catch {
                emit("agent_event", { agent, type: "raw", text: line });
            }
        });
    });
    child.stderr?.on("data", (chunk) => stderr.write(stderrDecoder.write(chunk)));
    child.on("error", (error) => {
        stderr.flush();
        emit("agent_error", { message: error.message });
    });
    child.on("close", (code) => {
        stderr.flush();
        emit("agent_done", { agent, code });
    });
}

/** 启动外部 Agent CLI，并将同步启动异常转换为事件。 */
function spawnAgent(name: string, args: string[], emit: AgentEmit) {
    try {
        return spawn(name, args, { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32", windowsHide: true });
    } catch (error) {
        emit("agent_error", { message: errorMessage(error) });
        return null;
    }
}
