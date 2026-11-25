export const faceKinds = ["visible", "hood", "mosaic", "blur", "mask", "other", "mixed", "uncertain"] as const;
export type FaceAnalysis = { summary: string; subjects: Array<{ subject: string; kind: typeof faceKinds[number]; detail: string }> };
const instructions: Record<typeof faceKinds[number], string> = {
    visible: "仅复刻原片实际可见的五官，不额外添加头套、口罩或打码。",
    hood: "保留原片头套的颜色、材质、轮廓、开口与覆盖范围；头套随头部运动，不摘下、不透明化，不补出被遮挡的人脸。",
    mosaic: "保留原片面部马赛克的位置、覆盖范围、颗粒效果和强度，随面部运动连续跟踪，不漏出被遮挡五官，不把马赛克改成头套。",
    blur: "保留原片面部模糊遮挡的范围和强度，随面部移动；不锐化、去模糊或补出隐藏五官，不把模糊改成头套。",
    mask: "保留原片面罩或口罩的款式、颜色和遮挡范围，只保留原片可见的面部区域，不摘除遮挡。",
    other: "保留原片实际遮挡物及遮挡关系，不移走遮挡物，不凭空补出隐藏的人脸。",
    mixed: "按参考视频中的时间变化保留每种遮挡状态及出现、消失时机，不把某一帧的遮挡扩展到整段，不擅自增加露脸镜头。",
    uncertain: "仅依据参考视频保留可见内容，不猜测模糊区域下的脸，也不擅自给清晰人脸增加头套或打码。",
};
export function parseFaceAnalysis(value: unknown): FaceAnalysis {
    const data = value as FaceAnalysis;
    if (!data || typeof data.summary !== "string" || !Array.isArray(data.subjects) || data.subjects.some((s) => !s || typeof s.subject !== "string" || !s.subject.trim() || typeof s.detail !== "string" || !faceKinds.includes(s.kind))) throw new Error("人脸遮挡分析结果无效，未提交视频生成。");
    return data;
}
export function buildRemakePrompt(base: string, analysis: FaceAnalysis) {
    return `${base.trim()}\n\n【本段人脸可见性与遮挡约束】\n以下约束优先于上文要求完整展示五官、表情或禁止特效的通用描述：原片已有的头套、面罩、打码和模糊均属于必须保留的原始画面。只能复刻可见区域，不需要展示被遮挡的人脸，不还原、猜测或生成遮挡下的五官。\n采样观察（仅首、中、尾帧，不代表逐帧分析）：${analysis.summary}\n${analysis.subjects.map((s) => `人物定位：${s.subject}\n可见情况：${s.detail}\n复刻要求：${instructions[s.kind]}`).join("\n")}\n同段多人分别遵循各自遮挡状态，不能把某个人的遮挡套到其他人身上。采样之间的变化以参考视频为准；不凭空新增遮挡或露脸镜头。`;
}
