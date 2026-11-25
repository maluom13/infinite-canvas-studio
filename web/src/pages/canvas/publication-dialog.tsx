import { useEffect, useState } from "react";
import { App, Button, Checkbox, DatePicker, Input, Modal, Tabs } from "antd";
import dayjs from "dayjs";
import localforage from "localforage";
import { saveAs } from "file-saver";
import type { CanvasNodeData } from "@/types/canvas";
import { useAgentStore } from "@/stores/use-agent-store";
import { generatePublicationCopy, publicationPlatforms, publishVideoToPlatform, type PublicationCopy, type PublicationFailure, type PublicationPlatform } from "@/services/api/publication";

type Draft = { context: string; selected: PublicationPlatform[]; copies: PublicationCopy[] };
type AccountState = { platform: string; state?: string; message: string; connected?: boolean; expired?: boolean };
type PublishState = "idle" | "running" | "done" | "error";

const emptyCopy = (platform: PublicationPlatform): PublicationCopy => ({ platform, title: "", description: "", tags: [], hook: "", coverText: "", bestTime: "" });

export function PublicationDialog({ node, projectId, platforms, onClose }: { node: CanvasNodeData; projectId: string; platforms?: PublicationPlatform[]; onClose: () => void }) {
    const { message } = App.useApp();
    // 从发布面板进来时带目标平台；从节点悬浮菜单进来则默认全选
    const [initialSelected] = useState<PublicationPlatform[]>(() => platforms?.length ? platforms : publicationPlatforms.map((platform) => platform.id));
    const [accounts, setAccounts] = useState<AccountState[]>([]);
    const [publishStates, setPublishStates] = useState<Record<string, PublishState>>({});
    const [publishResults, setPublishResults] = useState<Record<string, string>>({});
    const refreshAccounts = async () => {
        try {
            const response = await fetch("/local-publication/accounts");
            if (!response.ok) throw new Error();
            const data = await response.json() as { accounts: AccountState[] };
            setAccounts(data.accounts || []);
        } catch { message.error("账号状态读取失败"); }
    };
    const login = async (platform: string) => {
        try {
            const response = await fetch(`/local-publication/accounts/${platform}/login`, { method: "POST", headers: { "X-Canvas-Local": "1" } });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error);
            message.info("已打开登录窗口，请扫码；完成后点「刷新账号状态」");
        } catch (error) { message.error(error instanceof Error ? error.message : "登录失败"); }
    };
    const key = `publication-draft:${projectId}:${node.id}`;
    const [draft, setDraft] = useState<Draft>({ context: node.metadata?.prompt || node.title || "", selected: initialSelected, copies: publicationPlatforms.map((platform) => emptyCopy(platform.id)) });
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    /** 有值走平台原生定时，空则立即发布。 */
    const [scheduleAt, setScheduleAt] = useState<number | null>(null);
    useEffect(() => {
        let active = true;
        void localforage.getItem<Draft>(key).then((saved) => {
            if (!active || !saved) return;
            // 合并旧草稿，缺的平台补空文案，避免历史草稿字段不全导致崩溃；目标平台以本次进入时为准
            setDraft({ ...saved, selected: initialSelected, copies: publicationPlatforms.map((platform) => saved.copies?.find((copy) => copy.platform === platform.id) || emptyCopy(platform.id)) });
        }).catch(() => message.warning("草稿读取失败")).finally(() => { if (active) setLoaded(true); });
        return () => { active = false; };
    }, [key, message]);
    useEffect(() => { void refreshAccounts(); }, []);
    const update = (platform: PublicationPlatform, patch: Partial<PublicationCopy>) => setDraft((current) => ({ ...current, copies: current.copies.map((copy) => copy.platform === platform ? { ...copy, ...patch } : copy) }));
    const save = async () => { await localforage.setItem(key, draft); message.success("发布草稿已保存在本机"); };
    const generate = async () => {
        if (!draft.context.trim()) { message.warning("请先补充作品说明"); return; }
        setBusy(true);
        try {
            const copies = await generatePublicationCopy({ context: draft.context, model: useAgentStore.getState().model });
            const next = { ...draft, copies };
            setDraft(next);
            await localforage.setItem(key, next);
            message.success("三个平台的文案已生成，请预览并修改");
        } catch (error) { message.error(error instanceof Error ? error.message : "文案生成失败"); }
        finally { setBusy(false); }
    };
    const publish = async () => {
        const targets = draft.selected.filter((platform) => (draft.copies.find((copy) => copy.platform === platform)?.title || "").trim());
        if (!targets.length) { message.warning("所选平台还没有标题"); return; }
        const content = node.metadata?.content;
        if (!content) { message.error("这个节点没有可发布的视频文件"); return; }
        setBusy(true);
        const nextStates = { ...publishStates };
        const nextResults = { ...publishResults };
        for (const platform of targets) {
            const copy = draft.copies.find((item) => item.platform === platform)!;
            nextStates[platform] = "running";
            setPublishStates({ ...nextStates });
            try {
                await publishVideoToPlatform({ content, platform, copy: { ...copy, title: copy.title.trim(), description: copy.description.trim() }, at: scheduleAt || undefined });
                nextStates[platform] = "done";
                nextResults[platform] = scheduleAt ? `${dayjs(scheduleAt).format("MM-DD HH:mm")} 已预约，到点由平台自动发布` : "发布成功";
            } catch (error) {
                const failure = error as PublicationFailure;
                nextStates[platform] = "error";
                nextResults[platform] = failure.hint || failure.message || "发布失败";
                if (failure.expired) void refreshAccounts();
            }
            setPublishStates({ ...nextStates });
            setPublishResults({ ...nextResults });
        }
        setBusy(false);
        const failed = targets.filter((platform) => nextStates[platform] === "error");
        if (failed.length) message.warning(`有 ${failed.length} 个平台发布失败，请查看对应标签页`);
        else message.success("发布完成");
    };
    const selectedCopies = draft.copies.filter((copy) => draft.selected.includes(copy.platform));
    const canPublish = loaded && !busy && selectedCopies.some((copy) => copy.title.trim());
    return <Modal title="作品发布预览" open width="85vw" onCancel={onClose} footer={null}>
        <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-3"><video src={node.metadata?.content} controls preload="metadata" className="max-h-[60vh] w-full rounded-lg" /><p className="text-sm">{node.title}</p><div className="text-xs opacity-60">请完整预览成片。文案只参考下面的作品说明生成，发布前请核对标题、简介和标签。</div><Input.TextArea aria-label="作品说明" rows={4} value={draft.context} disabled={!loaded || busy} placeholder="补充剧情、看点、作品类型，帮助生成准确的标题与标签" onChange={(event) => setDraft({ ...draft, context: event.target.value })} /><Button loading={busy} disabled={!loaded} onClick={() => void generate()}>用 WorkBuddy 生成标题、简介和标签</Button><div className="rounded-lg border px-3 py-2 text-xs leading-5 opacity-70" style={{ borderColor: "rgba(120,113,108,.25)" }}><div className="font-medium opacity-90">怎么写更容易有流量</div><ul className="mt-1 list-disc space-y-0.5 pl-4"><li>前 3 秒给冲突、悬念或结果，别做铺垫</li><li>标题给点击理由：人群/场景 + 收益、反差或数字</li><li>标签 1 个大类 + 2 个精准 + 1 个场景，别用「原片素材」这类泛词</li><li>简介结尾留一句提问或收藏引导，评论和收藏比点赞更值钱</li></ul></div></div>
            <div className="space-y-4">
                <Checkbox.Group value={draft.selected} disabled={!loaded || busy} options={publicationPlatforms.map((platform) => ({ value: platform.id, label: platform.name }))} onChange={(selected) => setDraft({ ...draft, selected: selected as PublicationPlatform[] })} />
                <Tabs items={publicationPlatforms.map((platform) => {
                    const copy = draft.copies.find((item) => item.platform === platform.id)!;
                    const account = accounts.find((item) => item.platform === platform.id);
                    const state = publishStates[platform.id] || "idle";
                    return { key: platform.id, label: platform.name, children: <div className="space-y-3">
                        <div className={`text-xs ${account?.expired || account?.state === "expired" ? "text-red-500" : account?.connected ? "text-green-600" : "opacity-60"}`}>{account?.message || "账号尚未连接"}{account?.expired ? "，请重新扫码" : ""}</div>
                        <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void login(platform.id)}>扫码登录</Button><Button disabled={busy} onClick={() => void refreshAccounts()}>刷新账号状态</Button><a className="self-center text-xs underline opacity-70" href={platform.url} target="_blank" rel="noreferrer">打开{platform.name}创作者后台</a></div>
                        <label className="block">标题<Input disabled={!loaded || busy} maxLength={platform.id === "tencent" ? 16 : platform.id === "kuaishou" ? 20 : 24} value={copy.title} onChange={(event) => update(platform.id, { title: event.target.value })} /></label>
                        <label className="block">开头 3 秒钩子<Input.TextArea rows={2} disabled={!loaded || busy} maxLength={120} placeholder="冲突 / 悬念 / 结果前置 / 痛点提问，别铺垫" value={copy.hook || ""} onChange={(event) => update(platform.id, { hook: event.target.value })} /></label>
                        <label className="block">封面大字（≤10 字）<Input disabled={!loaded || busy} maxLength={10} value={copy.coverText || ""} onChange={(event) => update(platform.id, { coverText: event.target.value })} /></label>
                        <label className="block">简介<Input.TextArea rows={5} disabled={!loaded || busy} maxLength={600} value={copy.description} onChange={(event) => update(platform.id, { description: event.target.value })} /></label>
                        <label className="block">话题标签<Input disabled={!loaded || busy} value={copy.tags.join(" ")} placeholder="3-5 个：1 大类 + 2 精准 + 1 场景，例如 保暖穿搭 三层穿衣法 通勤" onChange={(event) => update(platform.id, { tags: event.target.value.split(/\s+/).map((tag) => tag.replace(/^#+/, "")).filter(Boolean) })} /></label>
                        {copy.bestTime ? <div className="text-xs opacity-60">建议发布时间：{copy.bestTime}</div> : null}
                        {state !== "idle" ? <div className={`text-xs ${state === "error" ? "text-red-500" : state === "done" ? "text-green-600" : "opacity-70"}`}>{state === "running" ? `正在发布到${platform.name}，请勿关闭页面…` : publishResults[platform.id] || ""}</div> : null}
                    </div> };
                })} />
                <p className="text-xs opacity-60">发布使用本机保存的登录会话，标题、简介、标签会原样提交。选定时发布后，提交完成就能关掉本机，由平台到点发出。</p>
                <div className="flex flex-wrap items-center gap-2"><Button disabled={!loaded || busy} onClick={() => void save().catch(() => message.error("草稿保存失败"))}>保存草稿</Button><Button disabled={!loaded || !draft.selected.length} onClick={() => { const text = draft.copies.filter((copy) => draft.selected.includes(copy.platform)).map((copy) => `${publicationPlatforms.find((p) => p.id === copy.platform)!.name}\n${copy.title}\n${copy.description}\n${copy.tags.map((tag) => "#" + tag).join(" ")}`).join("\n\n"); saveAs(new Blob([text], { type: "text/plain;charset=utf-8" }), "作品发布文案.txt"); }}>导出文案</Button><DatePicker showTime={{ format: "HH:mm", minuteStep: 5 }} format="MM-DD HH:mm" placeholder="定时（可选）" value={scheduleAt ? dayjs(scheduleAt) : null} disabledDate={(current) => current.endOf("day").valueOf() < Date.now()} onChange={(value) => setScheduleAt(value ? value.valueOf() : null)} allowClear disabled={busy} className="!w-40" /><Button type="primary" loading={busy} disabled={!canPublish} onClick={() => void publish()}>{scheduleAt ? "确认预约" : "确认发布"}</Button></div>
            </div>
        </div>
    </Modal>;
}
