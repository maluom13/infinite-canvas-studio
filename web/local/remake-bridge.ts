import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import type { Plugin } from "vite";
import { jobRoot, isWorkerAlive, saveJob, validId } from "./remake-worker";
import type { RemakeJob } from "./remake-types";

/** 按当前文件位置解析同目录的 worker 与 tsx loader，换机器不用改路径。 */
const directory = fileURLToPath(new URL(".", import.meta.url));
function launch(id: string) {
    const child = spawn(process.execPath, ["--import", pathToFileURL(path.resolve(directory, "../../canvas-agent/node_modules/tsx/dist/loader.mjs")).href, path.join(directory, "remake-worker.ts"), id], { detached: true, windowsHide: true, stdio: "ignore" });
    const failed = async () => {
        const dir = path.join(jobRoot, id);
        if (isWorkerAlive(dir)) return;
        try { const job = await load(id); if (["queued", "splitting", "running"].includes(job.state)) { job.state = "paused"; job.error = "后台进程未能正常运行，请检查本机运行环境后点击继续。"; await saveJob(dir, job); } } catch { /* Keep persisted data if the manifest is unavailable. */ }
    };
    child.on("error", () => void failed());
    child.on("exit", (code) => { if (code !== 0) void failed(); });
    child.unref();
}
async function load(id: string): Promise<RemakeJob> { return JSON.parse(await readFile(path.join(jobRoot, id, "job.json"), "utf8")); }
export function remakeBridge(): Plugin {
    return { name: "local-background-remake", configureServer(server) {
        const ready = mkdir(jobRoot, { recursive: true }).then(async () => {
            for (const id of await readdir(jobRoot)) {
                if (!validId(id)) continue;
                try { const job = await load(id); if (["queued", "splitting", "running"].includes(job.state) && !isWorkerAlive(path.join(jobRoot, id))) launch(id); } catch { /* Ignore incomplete uploads and unrelated directories. */ }
            }
        });
        const uploading = new Set<string>();
        server.middlewares.use(async (req, res, next) => {
            const url = new URL(req.url || "/", "http://localhost");
            if (!url.pathname.startsWith("/local-remake/")) return next();
            const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
            const host = req.headers.host || "";
            if (!/^(127\.0\.0\.1|localhost):3010$/.test(host) || req.headers["sec-fetch-site"] === "cross-site" || (req.headers.origin && req.headers.origin !== `http://${host}`) || (req.method !== "GET" && (req.headers.origin !== `http://${host}` || req.headers["x-canvas-local"] !== "1"))) return json(403, { error: "仅允许本机画布访问" });
            try {
                await ready;
                if (url.pathname === "/local-remake/jobs" && req.method === "GET") {
                    const jobs: RemakeJob[] = [];
                    for (const id of await readdir(jobRoot)) {
                        if (!validId(id)) continue;
                        try {
                            const job = await load(id);
                            if (job.projectId !== url.searchParams.get("project")) continue;
                            if (["queued", "splitting", "running"].includes(job.state) && !isWorkerAlive(path.join(jobRoot, id))) launch(id);
                            jobs.push(job);
                        } catch { /* An unfinished creation has no manifest yet. */ }
                    }
                    return json(200, { jobs });
                }
                if (url.pathname === "/local-remake/jobs" && req.method === "POST") {
                    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
                    const input = JSON.parse(Buffer.concat(chunks).toString());
                    if (![input.id, input.projectId, input.sourceId].every((id) => typeof id === "string" && validId(id)) || typeof input.prompt !== "string" || !input.prompt.trim() || typeof input.model !== "string" || !/^muse-video/.test(input.model) || typeof input.modelOption !== "string" || !["16:9", "9:16", "1:1", "4:3", "3:4"].includes(input.ratio) || !/^\d+x\d+$/.test(input.size) || typeof input.resolution !== "string" || ![input.x, input.y, input.width, input.height].every(Number.isFinite) || input.width <= 0 || input.height <= 0) return json(400, { error: "后台复刻参数无效，仅支持本机 Muse 视频模型。" });
                    const dir = path.join(jobRoot, input.id);
                    try { await mkdir(dir); } catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                        const existing = await load(input.id);
                        if (existing.projectId !== input.projectId) return json(409, { error: "任务编号冲突" });
                        return json(200, existing);
                    }
                    // Store only explicit options. Never persist browser API keys or arbitrary URLs.
                    const job: RemakeJob = { id: input.id, projectId: input.projectId, sourceId: input.sourceId, prompt: input.prompt, model: input.model, modelOption: input.modelOption, ratio: input.ratio, resolution: input.resolution, size: input.size, generateAudio: input.generateAudio === true, watermark: input.watermark === true, x: input.x, y: input.y, width: input.width, height: input.height, state: "uploading", segments: [], createdAt: new Date().toISOString(), analysisModel: typeof input.analysisModel === "string" ? input.analysisModel : undefined };
                    await saveJob(dir, job); return json(201, job);
                }
                const match = /^\/local-remake\/jobs\/([a-zA-Z0-9_-]+)\/(source|pause|resume|retry|asset\/((?:scene-\d+\.(?:mp4|jpg))|(?:result-\d+\.mp4)))$/.exec(url.pathname);
                if (!match) return json(404, { error: "任务接口不存在" });
                const [, id, action, asset] = match, dir = path.join(jobRoot, id), job = await load(id);
                if (action === "source" && req.method === "PUT") {
                    if (job.state !== "uploading") return json(200, job);
                    if (uploading.has(id)) return json(409, { error: "视频正在上传" });
                    uploading.add(id);
                    try {
                        await pipeline(req, createWriteStream(path.join(dir, "source.part")));
                        if (!(await stat(path.join(dir, "source.part"))).size) throw new Error("原视频为空");
                        await rename(path.join(dir, "source.part"), path.join(dir, "source.video"));
                        job.state = "queued"; await saveJob(dir, job); launch(id);
                        if (!res.destroyed) return json(202, job);
                    } finally { uploading.delete(id); }
                    return;
                }
                if (action === "pause" && req.method === "POST") { await writeFile(path.join(dir, "pause"), ""); return json(200, { ok: true }); }
                if ((action === "resume" || action === "retry") && req.method === "POST") {
                    if (job.state === "uploading") return json(409, { error: "原视频尚未上传完成，请重新上传。" });
                    if (job.segments.some((s) => s.state === "submitting" && !s.taskId)) return json(409, { error: "提交状态未知，请先在 Muse 核对；为避免重复扣费，不自动重提。" });
                    if (action !== "retry" && job.segments.some((s) => s.state === "failed")) return json(409, { error: "Muse 已确认某段失败。重试会重新提交该段，请使用重试失败段按钮。" });
                    if (isWorkerAlive(dir)) return json(409, { error: "当前步骤仍在运行，请稍后操作。" });
                    await unlink(path.join(dir, "pause")).catch((error) => { if (error.code !== "ENOENT") throw error; });
                    if (action === "retry") await writeFile(path.join(dir, "retry"), "");
                    launch(id); return json(202, { ok: true });
                }
                if (asset && req.method === "GET") {
                    const file = path.join(dir, asset), info = await stat(file);
                    const range = req.headers.range;
                    let start = 0, end = info.size - 1;
                    if (range) {
                        const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
                        if (!parsed || (!parsed[1] && !parsed[2])) { res.writeHead(416, { "Content-Range": `bytes */${info.size}` }); return res.end(); }
                        if (!parsed[1]) start = Math.max(0, info.size - Number(parsed[2]));
                        else { start = Number(parsed[1]); if (parsed[2]) end = Math.min(end, Number(parsed[2])); }
                        if (start > end || start >= info.size) { res.writeHead(416, { "Content-Range": `bytes */${info.size}` }); return res.end(); }
                    }
                    res.writeHead(range ? 206 : 200, { "Content-Type": asset.endsWith(".jpg") ? "image/jpeg" : "video/mp4", "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Cache-Control": "no-store", ...(range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}) });
                    await pipeline(createReadStream(file, { start, end }), res); return;
                }
                json(405, { error: "请求方法不支持" });
            } catch (error) { if (!res.headersSent && !res.destroyed) json(500, { error: error instanceof Error ? error.message : "后台任务请求失败" }); }
        });
    } };
}
