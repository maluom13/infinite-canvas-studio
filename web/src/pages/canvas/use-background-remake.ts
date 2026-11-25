import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";
import { nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { REMAKE_POLL_MS, type RemakeJob } from "../../../local/remake-types";

export async function remakeCommand(id: string, action: "pause" | "resume" | "retry") {
    const response = await fetch(`/local-remake/jobs/${id}/${action}`, { method: "POST", headers: { "X-Canvas-Local": "1" } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "后台任务操作失败");
}
export function remakeNodes(job: RemakeJob): { nodes: CanvasNodeData[]; connections: CanvasConnection[] } {
    const nodes: CanvasNodeData[] = [], connections: CanvasConnection[] = [];
    const asset = (name: string) => `/local-remake/jobs/${job.id}/asset/${name}`;
    job.segments.forEach((segment, index) => {
        const prefix = `remake-${job.id}-${index}`, videoId = `${prefix}-source`, configId = `${prefix}-config`, resultId = `${prefix}-result`;
        const y = job.y + index * (Math.max(job.height, 240) + 80), fileIndex = String(index).padStart(5, "0");
        const video = asset(`scene-${fileIndex}.mp4`);
        nodes.push({ id: videoId, type: CanvasNodeType.Video, title: `片段 ${index + 1} · 原片 ${segment.start.toFixed(2)}–${segment.end.toFixed(2)} 秒`, position: { x: job.x, y }, width: job.width, height: job.height, metadata: { content: video, mimeType: "video/mp4", status: "success" } });
        nodes.push({ id: `${prefix}-frame`, type: CanvasNodeType.Image, title: `片段 ${index + 1} · 首帧`, position: { x: job.x + job.width + 96, y }, width: job.width, height: job.height, metadata: { content: asset(`scene-${fileIndex}.jpg`), mimeType: "image/jpeg", status: "success" } });
        const prompt = `${segment.generationPrompt || job.prompt}\n@[node:${videoId}]`;
        nodes.push({ id: configId, type: CanvasNodeType.Config, title: `片段 ${index + 1} · 复刻配置`, position: { x: job.x + job.width * 2 + 192, y }, width: 340, height: 240, metadata: { backgroundRemakeId: job.id, status: "idle", generationMode: "video", videoMode: "reference", model: job.modelOption, size: job.ratio, seconds: String(segment.end - segment.start), prompt, composerContent: prompt } });
        const size = nodeSizeFromRatio(job.ratio, job.width, job.height) || { width: job.width, height: job.height };
        nodes.push({ id: resultId, type: CanvasNodeType.Video, title: `片段 ${index + 1} · 复刻结果`, position: { x: job.x + job.width * 2 + 628, y }, ...size, metadata: {
            backgroundRemakeId: job.id, status: segment.state === "completed" ? "success" : job.state === "paused" ? "error" : "loading",
            content: segment.state === "completed" ? asset(`result-${index}.mp4`) : undefined,
            naturalWidth: segment.width, naturalHeight: segment.height, mimeType: "video/mp4",
            errorDetails: segment.state !== "completed" && job.state === "paused" ? job.error || "后台任务已暂停，可在任务中心继续。" : undefined,
            prompt: segment.generationPrompt || job.prompt, model: job.modelOption, size: job.ratio, seconds: String(segment.end - segment.start), videoMode: "reference", references: [video],
        } });
        for (const [fromNodeId, toNodeId] of [[job.sourceId, videoId], [videoId, configId], [configId, resultId]]) connections.push({ id: `${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId });
    });
    return { nodes, connections };
}
export function useBackgroundRemake(projectId: string, loaded: boolean, setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>, setConnections: Dispatch<SetStateAction<CanvasConnection[]>>) {
    const [jobs, setJobs] = useState<RemakeJob[]>([]), [error, setError] = useState("");
    useEffect(() => {
        setJobs([]); setError("");
        if (!loaded || !projectId) return;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        const signatures = new Map<string, string>();
        const controller = new AbortController();
        const sync = async () => {
            try {
                const response = await fetch(`/local-remake/jobs?project=${encodeURIComponent(projectId)}`, { signal: controller.signal });
                if (!response.ok) throw new Error("后台任务进度暂时无法读取，请检查本机画布服务。");
                const { jobs: next }: { jobs: RemakeJob[] } = await response.json();
                if (disposed) return;
                setJobs(next); setError("");
                for (const job of next) {
                    const signature = JSON.stringify(job);
                    if (signatures.get(job.id) === signature) continue;
                    signatures.set(job.id, signature);
                    const patch = remakeNodes(job);
                    if (!patch.nodes.length) continue;
                    setNodes((previous) => {
                        const existing = new Set(previous.map((node) => node.id));
                        const outputs = new Map(patch.nodes.filter((node) => node.metadata?.backgroundRemakeId).map((node) => [node.id, node]));
                        return [...previous.map((node) => { const updated = outputs.get(node.id); return updated ? { ...node, metadata: { ...node.metadata, ...updated.metadata } } : node; }), ...patch.nodes.filter((node) => !existing.has(node.id))];
                    });
                    setConnections((previous) => { const existing = new Set(previous.map((link) => link.id)); return [...previous, ...patch.connections.filter((link) => !existing.has(link.id))]; });
                }
            } catch (error) { if (!disposed) setError(error instanceof Error ? error.message : "后台任务读取失败"); }
            finally { if (!disposed) timer = setTimeout(sync, REMAKE_POLL_MS); }
        };
        void sync();
        return () => { disposed = true; controller.abort(); clearTimeout(timer); };
    }, [projectId, loaded, setNodes, setConnections]);
    return { jobs, error };
}
