import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";
import { useAgentStore } from "@/stores/use-agent-store";

export async function connectInstalledAgent() {
    const current = useAgentStore.getState();
    if (current.connected || current.enabled || current.fragmentBootstrap || hasAgentUrlBootstrap(window.location.hash)) return;
    try {
        const response = await fetch("/local-agent/connection", { headers: { "X-Canvas-Local": "1" }, cache: "no-store" });
        const config = await response.json();
        if (!response.ok) throw new Error(config.error || "无法读取本机 Codex 连接信息。");
        const latest = useAgentStore.getState();
        if (latest.connected || latest.enabled || latest.fragmentBootstrap) return;
        latest.setAgentState({ url: config.url, token: config.token, connectError: "" });
        useAgentStore.getState().connectAgent({ silent: true });
    } catch (error) {
        useAgentStore.getState().setAgentState({ connectError: error instanceof Error ? error.message : "本机 Codex 自动连接失败。" });
    }
}
