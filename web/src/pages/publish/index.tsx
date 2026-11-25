import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, DatePicker, Empty, Input, Modal, Select, Spin } from "antd";
import dayjs from "dayjs";
import { Check, CheckCircle2, Clock, ExternalLink, Play, RefreshCw, Search, Upload, XCircle } from "lucide-react";

import { PublicationDialog } from "@/pages/canvas/publication-dialog";
import { generatePublicationCopy, publicationBrand, publicationPlatforms, publishVideoToPlatform, type PublicationCopy, type PublicationFailure, type PublicationPlatform } from "@/services/api/publication";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type Account = { platform: string; connected?: boolean; message: string; state?: string; expired?: boolean };
type Work = { key: string; projectId: string; projectTitle: string; node: CanvasNodeData };
type HistoryRecord = { id: string; platform: PublicationPlatform; title: string; status: "success" | "scheduled" | "failed"; message?: string; hint?: string; projectTitle?: string; at: number; attempts?: number; logId?: string; scheduledAt?: number };
type FailedPlatform = { platform: PublicationPlatform; error: string; logId?: string };
type BatchItem = { key: string; title: string; stage: string; failed?: boolean; done?: boolean; failedPlatforms?: FailedPlatform[] };

const platformName = (id: PublicationPlatform) => publicationPlatforms.find((platform) => platform.id === id)?.name || id;

export default function PublishPage() {
    const { message, modal } = App.useApp();
    const projects = useCanvasStore((state) => state.projects);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [history, setHistory] = useState<HistoryRecord[]>([]);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<PublicationPlatform[]>(publicationPlatforms.map((platform) => platform.id));
    const [keyword, setKeyword] = useState("");
    const [canvasFilter, setCanvasFilter] = useState("all");
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [preview, setPreview] = useState<Work | null>(null);
    const [target, setTarget] = useState<Work | null>(null);
    const [batchItems, setBatchItems] = useState<BatchItem[] | null>(null);
    const [batchRunning, setBatchRunning] = useState(false);
    const [logView, setLogView] = useState<{ id: string; text: string } | null>(null);
    /** 有值就走平台原生定时发布，空就是立即发。 */
    const [scheduleAt, setScheduleAt] = useState<number | null>(null);

    const refreshHistory = useCallback(async () => {
        try {
            const response = await fetch("/local-publication/history");
            if (!response.ok) throw new Error();
            const data = await response.json() as { data?: HistoryRecord[] };
            setHistory(data.data || []);
        } catch {
            /* 历史读不到不影响主流程 */
        }
    }, []);

    const refreshAccounts = useCallback(async (notify = false) => {
        setLoading(true);
        try {
            const response = await fetch("/local-publication/accounts");
            if (!response.ok) throw new Error();
            const data = await response.json() as { accounts?: Account[] };
            setAccounts(data.accounts || []);
            if (notify) message.success("账号状态已刷新");
        } catch {
            if (notify) message.error("账号状态读取失败");
        } finally {
            setLoading(false);
        }
    }, [message]);

    useEffect(() => {
        void refreshAccounts();
        void refreshHistory();
    }, [refreshAccounts, refreshHistory]);

    const login = async (platform: string) => {
        try {
            const response = await fetch(`/local-publication/accounts/${platform}/login`, { method: "POST", headers: { "X-Canvas-Local": "1" } });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "登录失败");
            message.info("已打开登录窗口，扫码后点右上角「刷新账号」");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败");
        }
    };

    const works = useMemo(() => {
        const list: Work[] = [];
        for (const project of projects) {
            for (const node of project.nodes) {
                if (node.type !== CanvasNodeType.Video || !node.metadata?.content) continue;
                list.push({ key: `${project.id}:${node.id}`, projectId: project.id, projectTitle: project.title, node });
            }
        }
        return list;
    }, [projects]);

    const canvasOptions = useMemo(() => {
        const ids = new Map<string, string>();
        works.forEach((work) => ids.set(work.projectId, work.projectTitle));
        return [{ value: "all", label: "全部画布" }, ...[...ids.entries()].map(([value, label]) => ({ value, label }))];
    }, [works]);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return works.filter((work) => (canvasFilter === "all" || work.projectId === canvasFilter)
            && (!query || `${work.node.title} ${work.projectTitle}`.toLowerCase().includes(query)));
    }, [works, keyword, canvasFilter]);

    const toggle = (platform: PublicationPlatform) => setSelected((current) => current.includes(platform) ? current.filter((item) => item !== platform) : [...current, platform]);
    const toggleChecked = (key: string) => setChecked((current) => {
        const next = new Set(current);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
    });
    const allChecked = filtered.length > 0 && filtered.every((work) => checked.has(work.key));
    const connectedCount = accounts.filter((account) => account.connected).length;
    const successCount = history.filter((record) => record.status === "success").length;
    const scheduledCount = history.filter((record) => record.status === "scheduled").length;

    const updateBatch = (key: string, patch: Partial<BatchItem>) => setBatchItems((current) => current ? current.map((item) => item.key === key ? { ...item, ...patch } : item) : current);

    /** 批量发布：单个平台失败不影响其它平台；传 onlyKeys 时只重跑这些作品。 */
    const runBatch = async (onlyKeys?: string[]) => {
        const items = works.filter((work) => onlyKeys ? onlyKeys.includes(work.key) : checked.has(work.key));
        const targets = [...selected];
        if (!items.length || !targets.length) return;
        setBatchItems(items.map((work) => ({ key: work.key, title: work.node.title || work.projectTitle, stage: "等待中" })));
        setBatchRunning(true);
        let expiredHit = false;
        let failedCount = 0;
        for (const work of items) {
            const content = work.node.metadata?.content;
            if (!content) {
                updateBatch(work.key, { stage: "这个节点没有视频文件", failed: true });
                failedCount += 1;
                continue;
            }
            updateBatch(work.key, { stage: "生成标题和标签…" });
            let copies: PublicationCopy[];
            try {
                const context = [work.node.title, work.node.metadata?.prompt, work.projectTitle].filter(Boolean).join("；").slice(0, 2000) || "短视频作品";
                copies = await generatePublicationCopy({ context });
            } catch (error) {
                updateBatch(work.key, { stage: `文案生成失败：${error instanceof Error ? error.message : "未知原因"}`, failed: true });
                failedCount += 1;
                continue;
            }
            const failedPlatforms: FailedPlatform[] = [];
            let okCount = 0;
            for (const platform of targets) {
                const copy = copies.find((item) => item.platform === platform);
                if (!copy) {
                    failedPlatforms.push({ platform, error: "文案缺失" });
                    continue;
                }
                updateBatch(work.key, { stage: scheduleAt ? `预约到 ${dayjs(scheduleAt).format("MM-DD HH:mm")}…` : `发布到${platformName(platform)}…` });
                try {
                    await publishVideoToPlatform({ content, platform, copy, projectTitle: work.projectTitle, at: scheduleAt || undefined });
                    okCount += 1;
                } catch (error) {
                    const failure = error as PublicationFailure;
                    if (failure.expired) expiredHit = true;
                    failedPlatforms.push({ platform, error: failure.message || "发布失败", logId: failure.logId });
                }
            }
            if (!failedPlatforms.length) {
                updateBatch(work.key, {
                    stage: scheduleAt ? `${dayjs(scheduleAt).format("MM-DD HH:mm")} 已预约 ${okCount} 个平台` : `已发布到 ${okCount} 个平台`,
                    done: true,
                });
            } else {
                failedCount += 1;
                updateBatch(work.key, { stage: `${scheduleAt ? "预约" : "发布"}成功 ${okCount} 个，失败 ${failedPlatforms.map((item) => platformName(item.platform)).join("、")}`, failed: true, failedPlatforms });
            }
        }
        setBatchRunning(false);
        void refreshHistory();
        if (expiredHit) {
            message.warning("有平台登录已失效，已标记为失效，请重新扫码后再重试");
            void refreshAccounts();
        } else if (scheduleAt && !failedCount) {
            message.success(`已预约到 ${dayjs(scheduleAt).format("MM-DD HH:mm")}，到点由平台自动发布，本机可以关`);
        }
    };

    const confirmBatch = () => {
        const count = works.filter((work) => checked.has(work.key)).length;
        const when = scheduleAt ? `预约到 ${dayjs(scheduleAt).format("MM-DD HH:mm")} 发布` : "立即发布";
        modal.confirm({
            title: `批量${scheduleAt ? "预约" : "发布"} ${count} 个作品？`,
            content: `将依次为每个作品生成文案并${when}到 ${selected.map(platformName).join("、")}，单个平台失败不会影响其它平台。${scheduleAt ? "提交后由平台到点自动发布，本机不用一直开着。" : ""}`,
            okText: scheduleAt ? "开始预约" : "开始发布",
            cancelText: "取消",
            onOk: () => void runBatch(),
        });
    };

    const openLog = async (id: string) => {
        setLogView({ id, text: "读取中…" });
        try {
            const response = await fetch(`/local-publication/logs/${id}`);
            const data = await response.json() as { text?: string; error?: string };
            setLogView({ id, text: data.text || data.error || "日志为空" });
        } catch {
            setLogView({ id, text: "日志读取失败，文件可能已被清理" });
        }
    };

    const failedKeys = (batchItems || []).filter((item) => item.failed).map((item) => item.key);

    return (
        <main className="h-full overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] text-stone-950 dark:bg-[radial-gradient(rgba(245,245,244,.12)_1px,transparent_1px)] dark:text-stone-100">
            <div className="mx-auto max-w-6xl px-6 py-8">
                <section className="relative overflow-hidden rounded-3xl border border-stone-200 bg-gradient-to-br from-stone-900 via-stone-900 to-stone-800 p-7 text-stone-100 shadow-xl dark:border-stone-700">
                    <div className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full bg-gradient-to-br from-emerald-400/20 via-orange-400/10 to-rose-500/20 blur-2xl" />
                    <div className="relative flex flex-wrap items-end justify-between gap-6">
                        <div>
                            <div className="text-[11px] uppercase tracking-[0.2em] text-stone-400">Publish Center</div>
                            <h1 className="mt-1 text-4xl font-semibold tracking-normal">自动发布</h1>
                            <p className="mt-2 max-w-xl text-sm leading-6 text-stone-400">登录一次，之后选作品就能自动生成标题和标签，发布到视频号、快手、抖音。</p>
                        </div>
                        <div className="flex gap-6">
                            <Stat label="可发布作品" value={works.length} />
                            <Stat label="已登录平台" value={`${connectedCount}/3`} />
                            <Stat label="成功发布" value={successCount} />
                            <Stat label="已预约" value={scheduledCount} />
                        </div>
                    </div>
                </section>

                <section className="mt-7">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h2 className="text-base font-semibold">1. 选择平台并登录</h2>
                        <Button size="small" icon={<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />} onClick={() => { void refreshAccounts(true); void refreshHistory(); }}>{loading ? "刷新中" : "刷新账号"}</Button>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                        {publicationPlatforms.map((platform) => {
                            const account = accounts.find((item) => item.platform === platform.id);
                            const connected = Boolean(account?.connected);
                            const expired = Boolean(account?.expired) || account?.state === "expired";
                            const active = selected.includes(platform.id);
                            const brand = publicationBrand[platform.id];
                            const badge = expired ? "登录失效" : connected ? "已登录" : "未登录";
                            return (
                                <div key={platform.id} className="relative overflow-hidden rounded-2xl border-2 p-4 transition" style={{ borderColor: expired ? "#dc2626" : active ? brand.color : "rgba(120,113,108,.24)", background: expired ? "rgba(220,38,38,.06)" : active ? brand.tint : "transparent" }}>
                                    <button type="button" onClick={() => toggle(platform.id)} aria-pressed={active} className="flex w-full items-start gap-3 text-left">
                                        <span className="grid size-11 shrink-0 place-items-center rounded-xl text-base font-bold text-white shadow-sm" style={{ background: brand.color }}>{platform.name.slice(0, 1)}</span>
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-center gap-2">
                                                <span className="text-lg font-semibold leading-snug">{platform.name}</span>
                                                <span className="rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ background: expired ? "rgba(220,38,38,.14)" : connected ? `${brand.color}22` : "rgba(120,113,108,.14)", color: expired ? "#dc2626" : connected ? brand.color : "rgb(120,113,108)" }}>{badge}</span>
                                            </span>
                                            <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">{expired ? "登录已失效，点「重新扫码」恢复，否则发布会直接失败" : connected ? "可以直接发布，账号状态正常" : "扫码一次，之后无需重复登录"}</span>
                                        </span>
                                        <span className="grid size-5 shrink-0 place-items-center rounded-full border-2" style={{ borderColor: active ? brand.color : "rgba(120,113,108,.45)", background: active ? brand.color : "transparent" }}>
                                            {active ? <Check className="size-3 text-white" strokeWidth={3} /> : null}
                                        </span>
                                    </button>
                                    <div className="mt-3 flex items-center gap-2">
                                        <Button size="small" danger={expired} onClick={() => void login(platform.id)}>{expired ? "重新扫码" : connected ? "重新登录" : "扫码登录"}</Button>
                                        <a className="inline-flex items-center gap-1 text-xs underline opacity-60 transition hover:opacity-100" href={platform.url} target="_blank" rel="noreferrer"><ExternalLink className="size-3" />创作者后台</a>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <p className="mt-2 text-xs text-stone-500 dark:text-stone-500">点卡片选择/取消发布平台；扫码登录会打开独立窗口，完成后回到本页刷新。</p>
                </section>

                <section className="mt-8">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h2 className="text-base font-semibold">2. 选择作品</h2>
                        <span className="text-xs text-stone-500 dark:text-stone-400">共 {works.length} 个视频 · 已选 {selected.length} 个平台</span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Input allowClear prefix={<Search className="size-4 text-stone-400" />} placeholder="搜索作品或画布" value={keyword} onChange={(event) => setKeyword(event.target.value)} className="!w-60" />
                        <Select value={canvasFilter} onChange={setCanvasFilter} options={canvasOptions} className="!w-44" />
                        <Button size="small" onClick={() => setChecked(allChecked ? new Set() : new Set(filtered.map((work) => work.key)))}>{allChecked ? "取消全选" : "全选"}</Button>
                        <span className="text-xs text-stone-500 dark:text-stone-400">已勾选 {checked.size}</span>
                        <div className="ml-auto flex flex-wrap items-center gap-2">
                            <DatePicker
                                showTime={{ format: "HH:mm", minuteStep: 5 }}
                                format="MM-DD HH:mm"
                                placeholder="定时发布（可选）"
                                value={scheduleAt ? dayjs(scheduleAt) : null}
                                disabledDate={(current) => current.endOf("day").valueOf() < Date.now()}
                                onChange={(value) => setScheduleAt(value ? value.valueOf() : null)}
                                allowClear
                                disabled={batchRunning}
                                className="!w-40"
                            />
                            <Button type="primary" icon={scheduleAt ? <Clock className="size-4" /> : <Upload className="size-4" />} disabled={!checked.size || !selected.length || batchRunning} loading={batchRunning} onClick={confirmBatch}>{scheduleAt ? "批量预约" : "批量发布"}</Button>
                        </div>
                    </div>
                    {!hydrated ? (
                        <div className="grid place-items-center py-16"><Spin /></div>
                    ) : filtered.length ? (
                        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {filtered.map((work) => {
                                const isChecked = checked.has(work.key);
                                const width = work.node.width;
                                const height = work.node.height;
                                return (
                                    <div key={work.key} className={`group overflow-hidden rounded-2xl border bg-white/70 transition hover:-translate-y-0.5 hover:shadow-xl dark:bg-stone-900/70 ${isChecked ? "border-stone-900 dark:border-stone-100" : "border-stone-200 dark:border-stone-800"}`}>
                                        <div className="relative aspect-video cursor-pointer overflow-hidden bg-stone-900" onClick={() => setPreview(work)}>
                                            <video src={`${work.node.metadata!.content}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover transition duration-300 group-hover:scale-[1.03]" />
                                            <div className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover:bg-black/25 group-hover:opacity-100">
                                                <span className="grid size-10 place-items-center rounded-full bg-white/90 text-stone-900 shadow"><Play className="size-4" /></span>
                                            </div>
                                            <button
                                                type="button"
                                                aria-pressed={isChecked}
                                                onClick={(event) => { event.stopPropagation(); toggleChecked(work.key); }}
                                                className="absolute left-2 top-2 grid size-6 place-items-center rounded-full border-2 transition"
                                                style={{ borderColor: isChecked ? "#fff" : "rgba(255,255,255,.8)", background: isChecked ? "#fff" : "rgba(0,0,0,.25)" }}
                                                title={isChecked ? "取消选择" : "选择这个作品"}
                                            >
                                                {isChecked ? <Check className="size-3.5 text-stone-900" strokeWidth={3} /> : null}
                                            </button>
                                            {width && height ? <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{width}×{height}</span> : null}
                                        </div>
                                        <div className="p-3">
                                            <div className="truncate text-sm font-semibold" title={work.node.title}>{work.node.title || "未命名视频"}</div>
                                            <div className="mt-0.5 truncate text-xs text-stone-500 dark:text-stone-400">{work.projectTitle}</div>
                                            <Button type="primary" className="mt-3 w-full" icon={<Upload className="size-4" />} disabled={!selected.length} onClick={() => setTarget(work)}>发布</Button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="py-16"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={works.length ? "没有匹配的作品" : "还没有可发布的视频，先去画布里生成一个"} /></div>
                    )}
                </section>

                <section className="mt-10">
                    <div className="flex items-baseline justify-between gap-2">
                        <h2 className="text-base font-semibold">3. 发布记录</h2>
                        <span className="text-xs text-stone-500 dark:text-stone-400">最近 {history.length} 条</span>
                    </div>
                    {history.length ? (
                        <div className="mt-3 divide-y divide-stone-200 overflow-hidden rounded-2xl border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                            {history.slice(0, 10).map((record) => {
                                const brand = publicationBrand[record.platform];
                                const meta = record.status === "success"
                                    ? { label: "成功", color: "#16a34a", icon: <CheckCircle2 className="size-3.5" /> }
                                    : record.status === "scheduled"
                                        ? { label: "已预约", color: "#2563eb", icon: <Clock className="size-3.5" /> }
                                        : { label: "失败", color: "#dc2626", icon: <XCircle className="size-3.5" /> };
                                return (
                                    <div key={record.id} className="flex items-start gap-3 bg-white/60 px-4 py-3 dark:bg-stone-900/60">
                                        <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: brand.color }} />
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-sm font-medium">{record.title}</div>
                                            <div className="truncate text-xs text-stone-500 dark:text-stone-400">{platformName(record.platform)}{record.projectTitle ? ` · ${record.projectTitle}` : ""}{record.status === "scheduled" && record.scheduledAt ? ` · 预约 ${dayjs(record.scheduledAt).format("MM-DD HH:mm")}` : ""}{record.attempts && record.attempts > 1 ? ` · 尝试 ${record.attempts} 次` : ""}</div>
                                            {record.status === "failed" && record.hint ? <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-red-500/90">{record.hint}</div> : null}
                                        </div>
                                        {record.logId ? <button type="button" onClick={() => void openLog(record.logId!)} className="mt-0.5 shrink-0 text-[11px] underline opacity-60 transition hover:opacity-100">日志</button> : null}
                                        <span className="flex shrink-0 items-center gap-1 text-xs" style={{ color: meta.color }}>
                                            {meta.icon}
                                            {meta.label}
                                        </span>
                                        <span className="flex shrink-0 items-center gap-1 text-[11px] text-stone-400"><Clock className="size-3" />{new Date(record.at).toLocaleString("zh-CN", { hour12: false })}</span>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="mt-3 rounded-2xl border border-dashed border-stone-300 py-10 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">还没有发布记录，发布成功后会出现在这里。</div>
                    )}
                </section>
            </div>

            {target ? <PublicationDialog key={`${target.projectId}:${target.node.id}`} node={target.node} projectId={target.projectId} platforms={selected} onClose={() => { setTarget(null); void refreshHistory(); }} /> : null}

            <Modal title="批量发布进度" open={Boolean(batchItems)} onCancel={() => { if (!batchRunning) setBatchItems(null); }} footer={batchRunning ? null : <div className="flex justify-end gap-2">{failedKeys.length ? <Button type="primary" danger onClick={() => void runBatch(failedKeys)}>重试失败项（{failedKeys.length}）</Button> : null}<Button onClick={() => setBatchItems(null)}>关闭</Button></div>} mask={{ closable: !batchRunning }}>
                <div className="max-h-[50vh] space-y-2 overflow-y-auto">
                    {(batchItems || []).map((item) => (
                        <div key={item.key} className="flex items-start gap-3 rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
                            <span className="mt-0.5 grid size-5 shrink-0 place-items-center">
                                {item.failed ? <XCircle className="size-4 text-red-500" /> : item.done ? <CheckCircle2 className="size-4 text-emerald-500" /> : batchRunning ? <Spin size="small" /> : <Clock className="size-4 text-stone-400" />}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium">{item.title}</div>
                                <div className={`text-xs ${item.failed ? "text-red-500" : "text-stone-500 dark:text-stone-400"}`}>{item.stage}</div>
                                {item.failedPlatforms?.length ? (
                                    <div className="mt-1 space-y-0.5">
                                        {item.failedPlatforms.map((failure) => (
                                            <div key={failure.platform} className="text-[11px] leading-4 text-red-500/90">
                                                {platformName(failure.platform)}：{failure.error}
                                                {failure.logId ? <button type="button" onClick={() => void openLog(failure.logId!)} className="ml-1 underline opacity-70 hover:opacity-100">日志</button> : null}
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    ))}
                </div>
                {batchRunning ? <p className="mt-3 text-xs text-stone-500">正在逐个生成文案并发布，单个平台失败会自动重试一次，请勿关闭页面。</p> : null}
            </Modal>

            <Modal title={preview?.node.title || "作品预览"} open={Boolean(preview)} onCancel={() => setPreview(null)} footer={null} width={760} destroyOnHidden>
                {preview ? <video src={preview.node.metadata?.content} controls autoPlay className="max-h-[70vh] w-full rounded-lg bg-black" /> : null}
            </Modal>

            <Modal title={`发布日志 · ${logView?.id || ""}`} open={Boolean(logView)} onCancel={() => setLogView(null)} footer={null} width={880}>
                <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap rounded-lg bg-stone-950 p-3 text-[11px] leading-5 text-stone-200">{logView?.text}</pre>
            </Modal>
        </main>
    );
}

function Stat({ label, value }: { label: string; value: number | string }) {
    return (
        <div>
            <div className="text-2xl font-semibold tracking-tight">{value}</div>
            <div className="mt-0.5 text-[11px] text-stone-400">{label}</div>
        </div>
    );
}
