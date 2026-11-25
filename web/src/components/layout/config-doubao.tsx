import { Alert, Button, Popconfirm, Tag } from "antd";
import { LogIn, LogOut, RefreshCw, Unplug, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getDoubaoLogin, logoutDoubao, startDoubaoLogin, type DoubaoLoginStatus } from "@/services/api/doubao";
import { encodeChannelModel, modelOptionsFromChannels, useConfigStore } from "@/stores/use-config-store";

const DOUBAO_CHANNEL_ID = "doubao-local";

const stateText: Record<string, string> = {
    idle: "未登录",
    waiting: "等待登录…",
    closed: "登录窗口已关闭",
    timeout: "登录超时",
    error: "登录失败",
    done: "已登录",
};

/** 豆包是独立账号体系：单独登录、单独保存，完全不走 Muse 的账号、额度或浏览器。 */
export function ConfigDoubao() {
    const [status, setStatus] = useState<DoubaoLoginStatus | null>(null);
    const [busy, setBusy] = useState("");
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const timer = useRef<number | null>(null);

    const stopPolling = () => {
        if (timer.current) window.clearInterval(timer.current);
        timer.current = null;
    };

    const refresh = useCallback(async () => {
        try {
            const data = await getDoubaoLogin();
            setStatus(data);
            setError("");
            return data;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "读取豆包登录状态失败");
            return null;
        }
    }, []);

    const watch = useCallback(() => {
        stopPolling();
        timer.current = window.setInterval(async () => {
            const data = await refresh();
            if (!data) return;
            if (data.state !== "waiting") {
                stopPolling();
                if (data.loggedIn) setMessage("豆包登录成功，登录态已保存在本机。");
                else if (data.state !== "idle") setMessage(data.message || "登录未完成，请重试。");
            }
        }, 2500);
    }, [refresh]);

    useEffect(() => {
        void (async () => {
            const data = await refresh();
            if (data?.state === "waiting" && !data.loggedIn) watch();
        })();
        return stopPolling;
    }, [refresh, watch]);

    const login = async () => {
        setBusy("login");
        setMessage("");
        setError("");
        try {
            const result = await startDoubaoLogin();
            setMessage(result.message);
            await refresh();
            watch();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "打开豆包登录窗口失败");
        } finally {
            setBusy("");
        }
    };

    const logout = async () => {
        setBusy("logout");
        setMessage("");
        setError("");
        try {
            const result = await logoutDoubao();
            setMessage(result.message);
            stopPolling();
            await refresh();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "退出豆包登录失败");
        } finally {
            setBusy("");
        }
    };

    const loggedIn = Boolean(status?.loggedIn);
    const stateLabel = loggedIn ? "已登录" : stateText[status?.state || "idle"] || "未登录";
    const channels = useConfigStore((state) => state.config.channels);
    const connected = channels.some((channel) => channel.id === DOUBAO_CHANNEL_ID);

    /** 把豆包作为独立渠道接进画布：模型走 /doubao/v1，不经过 Muse。 */
    const connect = (withDefaults = true) => {
        const config = useConfigStore.getState().config;
        const channel = {
            id: DOUBAO_CHANNEL_ID,
            name: "豆包",
            baseUrl: "/doubao/v1",
            apiKey: "local-session",
            apiFormat: "openai" as const,
            models: [
                { name: "doubao-image", capability: "image" as const },
                { name: "doubao-video", capability: "video" as const },
            ],
        };
        const next = [...config.channels.filter((item) => item.id !== DOUBAO_CHANNEL_ID), channel];
        useConfigStore.setState({
            config: {
                ...config,
                channels: next,
                models: modelOptionsFromChannels(next),
                ...(withDefaults
                    ? {
                        imageModel: encodeChannelModel(DOUBAO_CHANNEL_ID, "doubao-image"),
                        videoModel: encodeChannelModel(DOUBAO_CHANNEL_ID, "doubao-video"),
                    }
                    : {}),
            },
        });
        setMessage("豆包已接入画布，模型里可以选 doubao-image / doubao-video。");
    };

    const setAsDefault = () => {
        const config = useConfigStore.getState().config;
        useConfigStore.setState({
            config: {
                ...config,
                imageModel: encodeChannelModel(DOUBAO_CHANNEL_ID, "doubao-image"),
                videoModel: encodeChannelModel(DOUBAO_CHANNEL_ID, "doubao-video"),
            },
        });
        setMessage("已把豆包设为默认图片、视频模型。");
    };

    const disconnect = () => {
        const config = useConfigStore.getState().config;
        const next = config.channels.filter((item) => item.id !== DOUBAO_CHANNEL_ID);
        useConfigStore.setState({
            config: {
                ...config,
                channels: next,
                models: modelOptionsFromChannels(next),
                imageModel: config.imageModel.startsWith(DOUBAO_CHANNEL_ID) ? "" : config.imageModel,
                videoModel: config.videoModel.startsWith(DOUBAO_CHANNEL_ID) ? "" : config.videoModel,
            },
        });
        setMessage("已取消豆包接入，画布模型里不再显示豆包。");
    };

    /** 已登录时自动把豆包渠道加进画布（不改默认模型，避免顶掉用户原来的选择）。 */
    useEffect(() => {
        if (!status?.loggedIn || connected) return;
        connect(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status?.loggedIn, connected]);

    return (
        <section className="space-y-5 py-2">
            <div>
                <div className="flex items-center gap-2 text-base font-semibold">
                    豆包 <Tag color="orange">独立账号</Tag>
                </div>
                <p className="mt-2 text-sm leading-6 opacity-70">
                    豆包有自己的一套账号和登录态，跟 Muse 完全分开：不用 Muse 的账号、额度或浏览器，登录信息只保存在本机。
                </p>
            </div>

            {message ? <Alert showIcon type="info" title={message} /> : null}
            {error ? <Alert showIcon type="error" title={error} /> : null}

            <div className="space-y-3 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                        登录状态
                        <Tag color={loggedIn ? "success" : status?.state === "waiting" ? "processing" : "default"}>{stateLabel}</Tag>
                    </div>
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={async () => { setLoading(true); try { const data = await refresh(); if (data?.state === "waiting" && !data.loggedIn) watch(); } finally { setLoading(false); } }}>刷新状态</Button>
                </div>
                <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                    <div className="rounded-md bg-black/5 p-2 dark:bg-white/5">
                        <div className="text-sm font-semibold">{loggedIn ? "已登录豆包" : "还没有登录"}</div>
                        <div className="mt-1 opacity-60">登录时间</div>
                        <div className="mt-1 opacity-80">{status?.loginAt ? new Date(status.loginAt * 1000).toLocaleString() : "—"}</div>
                    </div>
                    <div className="rounded-md bg-black/5 p-2 dark:bg-white/5">
                        <div className="text-sm font-semibold">登录态位置</div>
                        <div className="mt-1 opacity-60">本机独立目录</div>
                        <div className="mt-1 break-all opacity-80">{status?.home || "—"}</div>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button type="primary" icon={<LogIn className="size-4" />} loading={busy === "login"} disabled={Boolean(busy) || status?.state === "waiting"} onClick={() => void login()}>
                        {loggedIn ? "重新登录豆包" : "登录豆包"}
                    </Button>
                    <Popconfirm title="退出豆包登录？" description="只会删除本机的豆包登录态和专用浏览器配置，不影响豆包账号本身。" okText="退出" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void logout()}>
                        <Button danger icon={<LogOut className="size-4" />} loading={busy === "logout"} disabled={Boolean(busy) || !loggedIn}>退出登录</Button>
                    </Popconfirm>
                </div>
                <p className="text-xs leading-5 opacity-55">
                    点「登录豆包」会打开一个独立的 Chrome 窗口，在里面扫码或登录即可；检测到登录后窗口自动关闭，登录态存到上面的目录，不会写进 Muse。
                </p>
            </div>

            <div className="space-y-3 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                        画布生成
                        <Tag color={connected ? "success" : "default"}>{connected ? "已接入" : "未接入"}</Tag>
                    </div>
                    <span className="text-xs opacity-55">豆包窗口：{status?.browserOpen ? "运行中" : "未启动"}</span>
                </div>
                <p className="text-xs leading-5 opacity-65">
                    接入后，画布模型里会出现 <b>doubao-image</b>（图片）和 <b>doubao-video</b>（视频）。图片通常几十秒，视频约 3–5 分钟；生成时会复用同一只豆包窗口，遇到人机验证在窗口里完成一次即可继续。
                </p>
                <div className="flex flex-wrap gap-2">
                    {connected ? <Button type="primary" icon={<Zap className="size-4" />} onClick={setAsDefault}>设为默认模型</Button> : <Button type="primary" icon={<Zap className="size-4" />} disabled={!loggedIn} onClick={() => connect()}>接入画布</Button>}
                    <Button icon={<Unplug className="size-4" />} disabled={!connected} onClick={disconnect}>取消接入</Button>
                </div>
                <p className="text-xs leading-5 opacity-55">
                    豆包视频固定约 10 秒、720p，图片会带豆包水印；生成消耗你自己的豆包网页额度。这条通道独立运行，不经过 Muse。
                </p>
            </div>
        </section>
    );
}
