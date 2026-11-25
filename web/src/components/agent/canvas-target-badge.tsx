import { useCallback, useEffect, useState } from "react";
import { App, Button, Dropdown, Tooltip } from "antd";
import { Layers, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore } from "@/stores/use-agent-store";

type CanvasClient = { clientId: string; projectId: string; title: string };
type ClientsResponse = { ok?: boolean; target?: string; clients?: CanvasClient[] };

/** 当前 Agent 操作目标画布的指示器：多个网页同时连接时可以点开切换。 */
export function CanvasTargetBadge({ theme }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const connected = useAgentStore((state) => state.connected);
    const endpoint = useAgentStore((state) => state.url);
    const token = useAgentStore((state) => state.token);
    const [clients, setClients] = useState<CanvasClient[]>([]);
    const [target, setTarget] = useState("");
    const [open, setOpen] = useState(false);

    const load = useCallback(async () => {
        if (!connected || !endpoint || !token) return;
        try {
            const base = endpoint.replace(/\/$/, "");
            const response = await fetch(`${base}/canvas/clients`, { headers: { "x-canvas-agent-token": token }, cache: "no-store" });
            const body = (await response.json()) as ClientsResponse;
            setClients(Array.isArray(body.clients) ? body.clients : []);
            setTarget(String(body.target || ""));
        } catch {
            setClients([]);
        }
    }, [connected, endpoint, token]);

    useEffect(() => {
        void load();
    }, [load]);

    const current = clients.find((client) => client.clientId === target) || clients[0];
    if (!current) return null;

    const switchTo = async (clientId: string) => {
        try {
            const base = endpoint.replace(/\/$/, "");
            await fetch(`${base}/canvas/activate?clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "x-canvas-agent-token": token } });
            setTarget(clientId);
            message.success(t("agent.panel.canvasTargetSwitched", { title: clients.find((item) => item.clientId === clientId)?.title || "" }));
            void load();
        } catch {
            message.warning(t("agent.panel.canvasTargetFailed"));
        }
    };

    return (
        <Tooltip title={t("agent.panel.canvasTarget", { title: current.title || current.projectId })} placement="bottom">
            <Dropdown
                trigger={["click"]}
                open={open}
                onOpenChange={(next) => {
                    setOpen(next);
                    if (next) void load();
                }}
                menu={{
                    items: clients.map((client) => ({
                        key: client.clientId,
                        label: <span className="inline-flex items-center gap-2 text-xs">{client.title || client.projectId}{client.clientId === target ? <span className="text-[10px] opacity-60">当前</span> : null}</span>,
                    })),
                    onClick: ({ key, domEvent }) => {
                        domEvent.stopPropagation();
                        setOpen(false);
                        if (key !== target) void switchTo(key);
                    },
                }}
            >
                <Button size="small" type="text" className="!h-8 !max-w-40 !px-1.5" aria-label={t("agent.panel.canvasTarget", { title: current.title || current.projectId })}>
                    <Layers className="size-3.5 shrink-0" style={{ color: theme.node.muted }} />
                    <span className="hidden truncate text-xs @min-[680px]:inline" style={{ color: theme.node.muted }}>{current.title || current.projectId}</span>
                    {clients.length > 1 ? <span className="text-[10px]" style={{ color: theme.node.muted }}>+{clients.length - 1}</span> : null}
                </Button>
            </Dropdown>
        </Tooltip>
    );
}

/** 一键重跑画布上生成失败的配置节点。 */
export function RetryFailedButton({ theme }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [busy, setBusy] = useState(false);

    const retry = async () => {
        const state = useAgentStore.getState();
        const snapshot = state.canvasContext?.snapshot;
        const failed = (snapshot?.nodes || []).filter((node) => node.type === "config" && (node.metadata?.status === "error" || Boolean(node.metadata?.errorDetails)));
        if (!failed.length) {
            message.info(t("agent.panel.retryNone"));
            return;
        }
        setBusy(true);
        try {
            const base = state.url.replace(/\/$/, "");
            const response = await fetch(`${base}/api/tools`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-canvas-agent-token": state.token },
                body: JSON.stringify({ name: "canvas_retry_failed_generations", input: {} }),
            });
            const body = (await response.json()) as { ok?: boolean; error?: string };
            if (!body.ok) throw new Error(body.error || "retry failed");
            message.success(t("agent.panel.retrySubmitted", { count: failed.length }));
        } catch (error) {
            message.warning(error instanceof Error ? error.message : t("agent.panel.retryFailed"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Tooltip title={t("agent.panel.retryFailedHint")} placement="bottom">
            <Button size="small" type="text" loading={busy} className="!h-8 !w-8 !min-w-8 !px-0" aria-label={t("agent.panel.retryFailedHint")} onClick={() => void retry()}>
                <RefreshCw className="size-3.5" style={{ color: theme.node.muted }} />
            </Button>
        </Tooltip>
    );
}
