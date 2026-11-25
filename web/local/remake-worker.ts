import { spawn } from "node:child_process";
import { createWriteStream, existsSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { clampVideoSeconds } from "../src/lib/media-size";
import { REMAKE_POLL_MS, type RemakeJob } from "./remake-types";
import { analyzeRemakeFaces } from "./remake-face-analysis";
import { buildRemakePrompt, type FaceAnalysis } from "./remake-face-prompt";
import { dataPath, FFPROBE, MUSE_INSTALL_CONFIG, PYTHON } from "./runtime-paths";

export const jobRoot = dataPath("remake-jobs");
export const validId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);
export async function saveJob(dir: string, job: RemakeJob) {
    await writeFile(path.join(dir, "job.json.tmp"), JSON.stringify(job));
    await rename(path.join(dir, "job.json.tmp"), path.join(dir, "job.json"));
}
export function isWorkerAlive(dir: string) {
    try { const pid = Number(readFileSync(path.join(dir, "worker.lock"), "utf8")); if (!Number.isSafeInteger(pid) || pid < 1) return true; process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function runCommand(exe: string, args: string[]) {
    return new Promise<string>((resolve, reject) => {
        const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.on("data", (data) => stdout += data); child.stderr.on("data", (data) => stderr += data);
        child.once("error", reject); child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || "本地视频处理失败")));
    });
}
export type WorkerDependencies = {
    analyze: (job: RemakeJob, index: number, dir: string) => Promise<FaceAnalysis>;
    split: (dir: string) => Promise<Array<{ start: number; end: number }>>;
    submit: (job: RemakeJob, index: number, dir: string) => Promise<string>;
    poll: (id: string, dir: string, index: number) => Promise<{ state: "pending" | "failed" | "completed"; width?: number; height?: number }>;
    delay: () => Promise<void>;
};
// Only this worker writes job.json after upload. Commands are separate marker files.
export async function runJob(dir: string, deps: WorkerDependencies) {
    const job: RemakeJob = JSON.parse(await readFile(path.join(dir, "job.json"), "utf8"));
    try {
        if (job.state === "completed" || job.state === "uploading") return;
        if (job.segments.some((segment) => segment.state === "submitting" && !segment.taskId)) {
            throw new Error("上次提交结果未知，已暂停以避免重复扣费。请先在 Muse 核对该段任务，不能直接重提。");
        }
        job.error = undefined;
        if (existsSync(path.join(dir, "retry"))) {
            for (const segment of job.segments) if (segment.state === "failed") { segment.state = "pending"; delete segment.taskId; }
            await saveJob(dir, job);
            unlinkSync(path.join(dir, "retry"));
        }
        if (!job.segments.length) {
            job.state = "splitting"; await saveJob(dir, job);
            job.segments = (await deps.split(dir)).map(({ start, end }) => ({ start, end, state: "pending" }));
            if (!job.segments.length) throw new Error("未切出有效视频片段");
            await saveJob(dir, job);
        }
        for (let index = 0; index < job.segments.length; index++) {
            const segment = job.segments[index];
            if (segment.state === "completed") continue;
            if (existsSync(path.join(dir, "pause"))) { job.state = "paused"; await saveJob(dir, job); return; }
            job.state = "running";
            if (!segment.taskId) {
                await saveJob(dir, job);
                if (!segment.faceAnalysis) {
                    segment.faceAnalysis = await deps.analyze(job, index, dir);
                    segment.generationPrompt = buildRemakePrompt(job.prompt, segment.faceAnalysis);
                    await saveJob(dir, job);
                }
                if (existsSync(path.join(dir, "pause"))) { job.state = "paused"; await saveJob(dir, job); return; }
                segment.state = "submitting"; await saveJob(dir, job);
                segment.taskId = await deps.submit(job, index, dir);
                segment.state = "polling"; await saveJob(dir, job);
            }
            // Retain the existing 120-query limit. A manual resume polls the saved ID.
            for (let attempt = 0; attempt < 120; attempt++) {
                const result = await deps.poll(segment.taskId, dir, index);
                if (result.state === "failed") { segment.state = "failed"; throw new Error(`第 ${index + 1} 段生成失败。Muse 已返回失败状态，已暂停后续提交。`); }
                if (result.state === "completed") { Object.assign(segment, { state: "completed", width: result.width, height: result.height }); await saveJob(dir, job); break; }
                if (attempt === 119) throw new Error("查询等待已结束，任务编号已保存；点击继续仅查询原任务，不会重复提交。");
                await deps.delay();
            }
        }
        job.state = "completed"; await saveJob(dir, job);
    } catch (error) {
        job.state = "paused";
        job.error = error instanceof Error ? error.message : "后台任务失败";
        await saveJob(dir, job);
    }
}

async function museRequest(endpoint: string, init?: RequestInit) {
    const config = JSON.parse(await readFile(MUSE_INSTALL_CONFIG, "utf8"));
    return fetch(`http://127.0.0.1:${config.ports.protocol}/v1${endpoint}`, { ...init, headers: { Authorization: `Bearer ${config.poolKey}` } });
}
async function payload(response: Response) {
    if (!response.ok) throw new Error(`Muse 请求失败（HTTP ${response.status}），请检查账号及原任务状态。`);
    const json = await response.json();
    if (json.code !== undefined && json.code !== 0 && json.code !== "0") throw new Error("Muse 返回失败状态，请检查原任务。");
    return json.data || json;
}
export const productionDependencies: WorkerDependencies = {
    analyze: (job, index, dir) => analyzeRemakeFaces(job, index, dir, runCommand),
    async split(dir) {
        await runCommand(PYTHON, [path.join(path.dirname(fileURLToPath(import.meta.url)), "split_scenes.py"), path.join(dir, "source.video"), path.join(dir, "scenes.json"), dir, "segments", "files"]);
        return JSON.parse(await readFile(path.join(dir, "scenes.json"), "utf8")).scenes;
    },
    async submit(job, index, dir) {
        const form = new FormData();
        for (const [key, value] of Object.entries({ model: job.model, prompt: job.segments[index].generationPrompt!, seconds: clampVideoSeconds(String(job.segments[index].end - job.segments[index].start)), size: job.size, ratio: job.ratio, resolution_name: job.resolution, generate_audio: String(job.generateAudio), watermark: String(job.watermark), mode: "reference" })) form.append(key, value);
        form.append("video[]", new Blob([await readFile(path.join(dir, `scene-${String(index).padStart(5, "0")}.mp4`))], { type: "video/mp4" }), "reference.mp4");
        const result = await payload(await museRequest("/videos", { method: "POST", body: form }));
        const id = result.id || result.task_id;
        if (typeof id !== "string" || !id) throw new Error("Muse 未返回任务编号，提交状态未知，请核对后处理。");
        return id;
    },
    async poll(id, dir, index) {
        const result = await payload(await museRequest(`/videos/${encodeURIComponent(id)}`));
        if (["failed", "cancelled"].includes(result.status)) return { state: "failed" };
        if (result.status !== "completed" && !result.url && !result.video_url && !result.result_url && !result.content?.video_url) return { state: "pending" };
        // Download through Muse's authenticated content endpoint; do not expose tokens or trust arbitrary result URLs.
        const response = await museRequest(`/videos/${encodeURIComponent(id)}/content`);
        if (!response.ok || !response.body) throw new Error("结果下载失败，已保留任务编号，继续时重新获取原结果。");
        const temp = path.join(dir, `result-${index}.part`), output = path.join(dir, `result-${index}.mp4`);
        await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temp));
        const info = JSON.parse(await runCommand(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", temp]));
        if (!info.streams?.[0]?.width) throw new Error("下载结果不是可播放的视频，已保留原任务编号。");
        await rename(temp, output);
        return { state: "completed", width: info.streams[0].width, height: info.streams[0].height };
    },
    delay: () => new Promise((resolve) => setTimeout(resolve, REMAKE_POLL_MS)),
};

async function main(id: string) {
    if (!validId(id)) throw new Error("Invalid job ID");
    const dir = path.join(jobRoot, id), lock = path.join(dir, "worker.lock");
    if (existsSync(lock)) { if (isWorkerAlive(dir)) return; unlinkSync(lock); }
    let fd: number;
    try { fd = openSync(lock, "wx"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
    try { writeFileSync(fd, String(process.pid)); closeSync(fd); await runJob(dir, productionDependencies); }
    finally { unlinkSync(lock); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv[2]).catch(() => { process.exitCode = 1; });
}
