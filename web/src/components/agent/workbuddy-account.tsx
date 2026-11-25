import { useCallback, useEffect, useState } from "react";
import { App, Button } from "antd";

type WorkbuddyStatus = { installed: boolean; loggedIn: boolean; cliPath: string; version: string; account: string; error: string };

/** WorkBuddy 账号卡片：展示本机 CodeBuddy CLI 状态并触发一次登录。 */
export function WorkbuddyAccount({ url, token }: { url: string; token: string }) {
    const { message, modal } = App.useApp();
    const [status, setStatus] = useState<WorkbuddyStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [probing, setProbing] = useState(false);

    const request = useCallback(
        async (path: string, init?: RequestInit) => {
            const base = url.replace(/\/$/, "");
            const response = await fetch(`${base}${path}`, {
                ...init,
                headers: { "content-type": "application/json", "x-canvas-agent-token": token, ...(init?.headers || {}) },
                cache: "no-store",
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
            return body as WorkbuddyStatus;
        },
        [url, token],
    );

    const refresh = useCallback(
        async (probe = false) => {
            if (!url || !token) {
                setStatus({ installed: false, loggedIn: false, cliPath: "", version: "", account: "", error: "请先连接本地 Agent，再读取 WorkBuddy 状态。" });
                return;
            }
            if (probe) setProbing(true);
            else setLoading(true);
            try {
                setStatus(await request(`/agent/workbuddy/status${probe ? "?probe=1" : ""}`));
            } catch (error) {
                setStatus({ installed: false, loggedIn: false, cliPath: "", version: "", account: "", error: error instanceof Error ? error.message : "无法读取 WorkBuddy 状态" });
            } finally {
                if (probe) setProbing(false);
                else setLoading(false);
            }
        },
        [request, url, token],
    );

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const openLoginPage = async () => {
        try {
            const body = (await request("/agent/workbuddy/login", { method: "POST", body: "{}" })) as unknown as { url?: string };
            if (body?.url) window.open(body.url, "_blank", "noopener,noreferrer");
            message.success("已打开 WorkBuddy 登录页，用手机扫码或在页面里完成登录，然后点「验证登录」。");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "无法打开 WorkBuddy 登录页");
        }
    };

    const login = () => {
        if (!status?.loggedIn) {
            void openLoginPage();
            return;
        }
        modal.confirm({
            title: "切换 WorkBuddy 账号？",
            content: "会先退出当前账号，再打开登录页。必须完成扫码登录，否则 WorkBuddy 引擎会暂时不可用。",
            okText: "继续切换",
            cancelText: "取消",
            onOk: () => void openLoginPage(),
        });
    };

    const statusText = !status ? "正在检查…" : !status.installed ? "未检测到 WorkBuddy 内置 CLI" : status.loggedIn ? "已登录，可在对话中使用" : "CLI 已就绪，但账号未登录";

    return (
        <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
            <div className="text-sm font-semibold">WorkBuddy 账号</div>
            <div className="mt-2 text-xs opacity-70">WorkBuddy 负责理解指令、规划与操作画布；图片和视频仍由下方配置的生成模型完成。</div>
            <div className="mt-2 text-xs opacity-70">状态：{statusText}</div>
            {status?.version ? <div className="mt-1 text-xs opacity-55">CodeBuddy CLI {status.version}</div> : null}
            {status?.cliPath ? <div className="mt-1 break-all text-[11px] opacity-45">{status.cliPath}</div> : null}
            {status?.error ? <div className="mt-2 text-xs text-red-500">{status.error}</div> : null}
            <div className="mt-3 flex flex-wrap gap-2">
                {status?.installed ? (
                    <Button type={status.loggedIn ? "default" : "primary"} size="small" onClick={() => void login()}>
                        {status.loggedIn ? "切换账号" : "登录 WorkBuddy"}
                    </Button>
                ) : null}
                <Button size="small" loading={probing} onClick={() => void refresh(true)}>
                    验证登录
                </Button>
                <Button size="small" loading={loading} onClick={() => void refresh()}>
                    刷新状态
                </Button>
            </div>
            <div className="mt-2 text-xs opacity-55">登录会打开 WorkBuddy 官方登录页，用手机扫码或在页面里确认即可；账号凭证由 WorkBuddy 自行保管，画布不读取也不保存。</div>
        </section>
    );
}
