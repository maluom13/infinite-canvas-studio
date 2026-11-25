/** 画布右侧对话可使用的本机 Agent 引擎。 */
export type AgentEngine = "codex" | "workbuddy";

const STORAGE_KEY = "infinite-canvas.agent.engine";

/** 读取当前选择的对话引擎，默认使用 Codex。 */
export function readAgentEngine(): AgentEngine {
    try {
        return localStorage.getItem(STORAGE_KEY) === "workbuddy" ? "workbuddy" : "codex";
    } catch {
        return "codex";
    }
}

/** 保存当前选择的对话引擎。 */
export function writeAgentEngine(engine: AgentEngine) {
    try {
        localStorage.setItem(STORAGE_KEY, engine);
    } catch {
        // 隐私模式下本地存储不可写，忽略即可
    }
}
