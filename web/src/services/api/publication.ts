export const publicationPlatforms = [
    { id: "tencent", name: "视频号", url: "https://channels.weixin.qq.com/" },
    { id: "kuaishou", name: "快手", url: "https://cp.kuaishou.com/" },
    { id: "douyin", name: "抖音", url: "https://creator.douyin.com/" },
] as const;
export type PublicationPlatform = typeof publicationPlatforms[number]["id"];
/** 平台品牌色：卡片、按钮共用，避免各页面各写一套。 */
export const publicationBrand: Record<PublicationPlatform, { color: string; tint: string }> = {
    tencent: { color: "#07C160", tint: "rgba(7,193,96,.14)" },
    kuaishou: { color: "#FF6A00", tint: "rgba(255,106,0,.14)" },
    douyin: { color: "#FE2C55", tint: "rgba(254,44,85,.14)" },
};
export type PublicationCopy = { platform: PublicationPlatform; title: string; description: string; tags: string[]; hook?: string; coverText?: string; bestTime?: string };
/** 文案生成只依赖作品说明；首尾帧参数保留用于兼容旧草稿。 */
export async function generatePublicationCopy(input: { context: string; model?: string; first?: string; last?: string }): Promise<PublicationCopy[]> {
    const response = await fetch("/local-publication/copy", { method: "POST", headers: { "Content-Type": "application/json", "X-Canvas-Local": "1" }, body: JSON.stringify({ context: input.context, model: input.model || "" }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "文案生成失败");
    return data.copies;
}

export type PublicationFailure = Error & { hint?: string; logId?: string; expired?: boolean; kind?: string };

export type PublishResult = { attempts: number; durationMs?: number; logId?: string; scheduled?: boolean; scheduledAt?: number };

/** 把视频 blob 传给本地发布服务；单平台一次请求。传 at 时走平台原生定时发布。 */
export async function publishVideoToPlatform(input: { content: string; platform: PublicationPlatform; copy: PublicationCopy; projectTitle?: string; at?: number }): Promise<PublishResult> {
    const response = await fetch(input.content);
    if (!response.ok) throw new Error("读取视频失败");
    const blob = await response.blob();
    if (!blob.size) throw new Error("视频内容为空");
    const params = new URLSearchParams({ platform: input.platform, title: input.copy.title, desc: input.copy.description, tags: input.copy.tags.join(","), projectTitle: input.projectTitle || "" });
    if (input.at) params.set("at", String(input.at));
    const upload = await fetch(`/local-publication/publish?${params.toString()}`, { method: "POST", headers: { "X-Canvas-Local": "1", "Content-Type": blob.type || "video/mp4" }, body: blob });
    const data = await upload.json() as { ok?: boolean; error?: string; hint?: string; logId?: string; expired?: boolean; kind?: string; attempts?: number; durationMs?: number; scheduled?: boolean; scheduledAt?: number };
    if (!upload.ok || !data.ok) {
        const error = new Error(data.error || data.hint || "发布失败") as PublicationFailure;
        error.hint = data.hint;
        error.logId = data.logId;
        error.expired = data.expired;
        error.kind = data.kind;
        throw error;
    }
    return { attempts: data.attempts || 1, durationMs: data.durationMs, logId: data.logId, scheduled: data.scheduled, scheduledAt: data.scheduledAt };
}
