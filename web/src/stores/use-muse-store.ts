import { create } from "zustand";
import { getMuseLogin, getMuseStatus, museAccountAction, startMuseLogin, type MuseStatus } from "@/services/api/muse";
import { encodeChannelModel, modelOptionsFromChannels, useConfigStore } from "@/stores/use-config-store";

export const MUSE_CHANNEL_ID = "muse-local";

function connectModels(status: MuseStatus) {
    if (!status.accounts.some((account) => account.ready)) throw new Error("请先登录一个有效的 Muse 账号。");
    if (!status.models.length) throw new Error("Muse 暂未返回可用模型，请稍后刷新。");
    const config = useConfigStore.getState().config;
    const channel = { id: MUSE_CHANNEL_ID, name: "Muse", baseUrl: "/muse/v1", apiKey: "local-session", apiFormat: "openai" as const, models: status.models };
    const channels = [...config.channels.filter((item) => item.id !== MUSE_CHANNEL_ID), channel];
    const image = status.models.find((model) => model.capability === "image");
    const video = status.models.find((model) => model.capability === "video");
    useConfigStore.setState({ config: { ...config, channels, models: modelOptionsFromChannels(channels), ...(image ? { imageModel: encodeChannelModel(channel.id, image.name) } : {}), ...(video ? { videoModel: encodeChannelModel(channel.id, video.name) } : {}) } });
}

type MuseStore = {
    status: MuseStatus | null;
    loading: boolean;
    loggingIn: boolean;
    error: string;
    hint: string;
    refresh: (connect?: boolean) => Promise<void>;
    login: (accountId?: string, label?: string) => Promise<void>;
};

const MUSE_LOGIN_MAX_POLLS = 120;

export const useMuseStore = create<MuseStore>((set, get) => ({
    status: null, loading: false, loggingIn: false, error: "", hint: "",
    refresh: async (connect = false) => {
        set({ loading: true, error: "" });
        try {
            const status = await getMuseStatus();
            set({ status });
            if (connect) { connectModels(status); set({ hint: "Muse 已接入，可以在当前画布选择 Muse 模型生成图片或视频。" }); }
        } catch (error) { set({ status: null, error: error instanceof Error ? error.message : "无法连接 Muse。" }); }
        finally { set({ loading: false }); }
    },
    login: async (accountId, label) => {
        if (get().loggingIn) return;
        set({ loggingIn: true, error: "", hint: "正在打开 Muse 登录窗口…" });
        try {
            const session = await startMuseLogin(accountId, label);
            if (!session.id) throw new Error("Muse 没有返回登录窗口，请重试。");
            set({ hint: "请在弹出的 Muse 窗口完成登录。成功后会自动接入，请先保留登录窗口。" });
            // Match the existing Muse login window's status interval.
            // 最多等 5 分钟：关掉登录窗口或桥接卡住时不能一直 loading。
            let finished = false;
            for (let attempt = 0; attempt < MUSE_LOGIN_MAX_POLLS && !finished; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 2500));
                const current = await getMuseLogin(session.id);
                if (current.status === "waiting") {
                    if (current.phase === "importing") set({ hint: current.hint || "已检测到登录，正在保存账号，请稍候…" });
                    continue;
                }
                if (current.status !== "done") throw new Error(current.error || "登录未完成，请重新登录。");
                await get().refresh(true);
                // 新登录的账号要同步进生成协议池才会参与并发生成；不同步的话协议只用旧账号，
                // 加了账号速度也不会变。同步是幂等的，已一致的账号返回 changed=false。
                await Promise.all((get().status?.accounts || [])
                    .filter((account) => account.ready)
                    .map((account) => museAccountAction(account.id, "sync").catch(() => undefined)));
                finished = true;
            }
            if (!finished) throw new Error("等待 Muse 登录超时，请重新登录。");
        } catch (error) { set({ error: error instanceof Error ? error.message : "Muse 登录失败。", hint: "" }); }
        finally { set({ loggingIn: false }); }
    },
}));
