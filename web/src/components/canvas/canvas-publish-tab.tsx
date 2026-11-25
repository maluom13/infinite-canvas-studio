import { useEffect, useState } from "react";
import { App, Button } from "antd";
import { Check, RefreshCw, Upload } from "lucide-react";

import type { CanvasTheme } from "@/lib/canvas-theme";
import { publicationBrand as PLATFORM_BRAND, publicationPlatforms, type PublicationPlatform } from "@/services/api/publication";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type Account = { platform: string; connected?: boolean; message: string; state?: string };

/** 画布侧边栏的发布页：先选目标平台，再发布当前画布里的视频。 */
export function CanvasPublishTab({ nodes, theme, onPublish }: { nodes: CanvasNodeData[]; theme: CanvasTheme; onPublish: (node: CanvasNodeData, platforms: PublicationPlatform[]) => void }) {
    const { message } = App.useApp();
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<PublicationPlatform[]>(publicationPlatforms.map((platform) => platform.id));
    const videos = nodes.filter((node) => node.type === CanvasNodeType.Video && Boolean(node.metadata?.content));
    const toggle = (platform: PublicationPlatform) => setSelected((current) => current.includes(platform) ? current.filter((item) => item !== platform) : [...current, platform]);

    const refresh = async (notify = false) => {
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
    };
    useEffect(() => { void refresh(); }, []);

    const login = async (platform: string) => {
        try {
            const response = await fetch(`/local-publication/accounts/${platform}/login`, { method: "POST", headers: { "X-Canvas-Local": "1" } });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "登录失败");
            message.info("已打开登录窗口，扫码后点右上角刷新账号状态");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败");
        }
    };

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 px-3 pb-1.5 pt-1">
                <span className="text-xs font-medium opacity-60">发布账号</span>
                <button
                    type="button"
                    onClick={() => void refresh(true)}
                    disabled={loading}
                    className="ml-auto grid size-6 place-items-center rounded-md opacity-60 transition hover:bg-black/5 hover:opacity-100 disabled:opacity-30 dark:hover:bg-white/10"
                    aria-label="刷新账号状态"
                    title="刷新账号状态"
                >
                    <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
                </button>
            </div>
            <div className="flex items-baseline gap-2 px-3 pb-2">
                <span className="text-sm font-semibold">发布到</span>
                <span className="text-[11px] opacity-50">点击选择平台，已选 {selected.length}/3</span>
            </div>
            <div className="space-y-1.5 px-3 pb-3">
                {publicationPlatforms.map((platform) => {
                    const account = accounts.find((item) => item.platform === platform.id);
                    const connected = Boolean(account?.connected);
                    const active = selected.includes(platform.id);
                    const brand = PLATFORM_BRAND[platform.id];
                    return (
                        <div
                            key={platform.id}
                            className="flex items-stretch overflow-hidden rounded-xl border-2 transition"
                            style={{ borderColor: active ? brand.color : theme.node.stroke, background: active ? brand.tint : "transparent" }}
                        >
                            <button
                                type="button"
                                onClick={() => toggle(platform.id)}
                                aria-pressed={active}
                                className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left transition"
                                title={active ? `取消${platform.name}` : `选择${platform.name}`}
                            >
                                <span className="grid size-8 shrink-0 place-items-center rounded-lg text-sm font-bold text-white" style={{ background: brand.color }}>{platform.name.slice(0, 1)}</span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-sm font-semibold leading-snug" style={{ color: active ? theme.node.text : theme.node.muted }}>{platform.name}</span>
                                    <span className="mt-0.5 block text-[11px] leading-4" style={{ color: connected ? brand.color : theme.node.muted, opacity: connected ? 1 : 0.7 }}>{connected ? "已登录，可发布" : "未登录，需扫码"}</span>
                                </span>
                                <span className="grid size-5 shrink-0 place-items-center rounded-full border-2 transition" style={{ borderColor: active ? brand.color : theme.node.stroke, background: active ? brand.color : "transparent" }}>
                                    {active ? <Check className="size-3 text-white" strokeWidth={3} /> : null}
                                </span>
                            </button>
                            {connected ? null : (
                                <button
                                    type="button"
                                    onClick={() => void login(platform.id)}
                                    className="shrink-0 px-2.5 text-xs font-semibold transition hover:bg-black/5 dark:hover:bg-white/10"
                                    style={{ color: brand.color, borderLeft: `1px solid ${theme.node.stroke}` }}
                                >
                                    登录
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="flex items-baseline gap-2 px-3 pb-1.5">
                <span className="text-sm font-semibold">可发布视频</span>
                <span className="text-[11px] opacity-50">{videos.length}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {videos.length ? (
                    <div className="space-y-1">
                        {videos.map((node) => (
                            <div key={node.id} className="flex items-center gap-2 rounded-lg p-1.5 transition hover:bg-black/5 dark:hover:bg-white/5">
                                <video src={`${node.metadata!.content}#t=0.1`} muted playsInline preload="metadata" className="h-12 w-16 shrink-0 rounded-md object-cover" />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium leading-snug">{node.title || "未命名视频"}</div>
                                    <div className="truncate text-[11px] opacity-50">{node.metadata?.status === "success" ? "已生成" : node.metadata?.status === "error" ? "生成失败" : "生成中"}</div>
                                </div>
                                <Button size="small" type="primary" className="!h-8 !px-3 !text-xs !font-semibold" icon={<Upload className="size-3.5" />} disabled={!selected.length} onClick={() => onPublish(node, selected)}>发布</Button>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="px-3 pt-12 text-center text-xs opacity-40">画布中还没有可发布的视频</div>
                )}
            </div>
            <div className="border-t px-3 py-2 text-[11px] leading-4 opacity-50" style={{ borderColor: theme.toolbar.border }}>
                点「发布」先预览并生成标题标签，确认后才会上传到平台。
            </div>
        </div>
    );
}
