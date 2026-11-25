import type { FaceAnalysis } from "./remake-face-prompt";
export type RemakeSegment = {
    start: number; end: number; state: "pending" | "submitting" | "polling" | "completed" | "failed";
    taskId?: string; width?: number; height?: number;
    faceAnalysis?: FaceAnalysis; generationPrompt?: string;
};
export type RemakeJob = {
    id: string; projectId: string; sourceId: string; prompt: string; model: string; modelOption: string;
    ratio: string; resolution: string; size: string; generateAudio: boolean; watermark: boolean;
    x: number; y: number; width: number; height: number;
    state: "uploading" | "queued" | "splitting" | "running" | "paused" | "completed";
    error?: string; segments: RemakeSegment[]; createdAt: string;
    analysisModel?: string;
};
export const REMAKE_POLL_MS = 2500; // Same cadence as the existing video task poller.
