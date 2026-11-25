import { Button } from "antd";
import { useEffect, useState } from "react";
import { useConfigStore, modelOptionName } from "@/stores/use-config-store";

export function CodexAccount() {
    const imageModel = useConfigStore((state) => state.config.imageModel);
    const videoModel = useConfigStore((state) => state.config.videoModel);
    const [status, setStatus] = useState<{ loggedIn: boolean; pending: boolean; error: string } | null>(null);
    const refresh = async () => {
        try {
            const response = await fetch("/local-codex/status", { headers: { "X-Canvas-Local": "1" }, cache: "no-store" });
            if (!response.ok) throw new Error();
            setStatus(await response.json());
        } catch { setStatus({ loggedIn: false, pending: false, error: "无法读取 Codex 登录状态，请检查本地服务。" }); }
    };
    useEffect(() => { void refresh(); }, []);
    useEffect(() => { if (!status?.pending) return; const timer = setInterval(() => void refresh(), 2500); return () => clearInterval(timer); }, [status?.pending]);
    const login = async () => {
        try {
            const response = await fetch("/local-codex/login", { method: "POST", headers: { "X-Canvas-Local": "1" } });
            if (!response.ok) throw new Error();
            setStatus((current) => ({ loggedIn: current?.loggedIn || false, pending: true, error: "" }));
        } catch { setStatus({ loggedIn: false, pending: false, error: "无法启动登录，请重试。" }); }
    };
    return <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
        <div className="text-sm font-semibold">Codex 账号</div>
        <div className="mt-2 text-xs opacity-70">Codex 负责理解指令、规划与操作画布；图片和视频由下方配置的生成模型完成。</div>
        <div className="mt-2 space-y-1 text-xs opacity-70"><div>Agent 图片：{imageModel ? modelOptionName(imageModel) : "未配置"}</div><div>Agent 视频：{videoModel ? modelOptionName(videoModel) : "未配置"}</div></div>
        <div className="mt-2 text-xs opacity-70">{!status ? "正在检查登录状态…" : status.pending ? "请在打开的浏览器中完成 ChatGPT 登录；完成后状态会自动更新。" : status.loggedIn ? "Codex 状态：已登录 ChatGPT，可在右侧对话中使用。" : "Codex 状态：未登录，请登录 ChatGPT。"}</div>
        {status?.error ? <div className="mt-2 text-xs text-red-500">{status.error}</div> : null}
        <div className="mt-3 flex gap-2">{status ? <Button type={status.loggedIn ? "default" : "primary"} size="small" loading={status.pending} onClick={() => void login()}>{status.loggedIn ? "ChatGPT 已登录 · 重新登录／换账号" : "登录 ChatGPT"}</Button> : null}<Button size="small" onClick={() => void refresh()}>刷新状态</Button></div>
        <div className="mt-2 text-xs opacity-55">使用本机 Codex 的共享登录账号；换号也会影响使用同一账号配置的 Codex 应用。</div>
    </section>;
}
