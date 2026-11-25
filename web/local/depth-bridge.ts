import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

import { dataPath, FFMPEG, PYTHON, tempPath } from "./runtime-paths";

/** 同目录的 Python 脚本，按当前文件位置解析，不依赖程序装在哪。 */
const here = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

export function depthBridge(): Plugin {
    return { name: "local-depth-video", configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
            const upscale = /^\/local-depth\/upscale\/(1k|2k|4k)(?:\/(natural|ai))?$/.exec(req.url || "");
            const segments = req.url === "/local-depth/segments";
            const split = req.url === "/local-depth/scenes" || segments;
            if (req.url !== "/local-depth/video" && !upscale && !split) return next();
            const host = req.headers.host || "";
            if (req.method !== "POST" || !/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers.origin !== `http://${host}` || req.headers["x-canvas-local"] !== "1" || req.headers["sec-fetch-site"] === "cross-site") { res.writeHead(403); res.end(); return; }
            let dir = "";

            let child: ReturnType<typeof spawn> | undefined;
            try {
                dir = await mkdtemp(tempPath("depth-"));
                const input = path.join(dir, "source.video"), output = path.join(dir, split ? "scenes.json" : "depth.mp4");
                await pipeline(req, createWriteStream(input));
                if (res.destroyed) return;
                const args = split ? [here("split_scenes.py"), input, output, dir, ...(segments ? ["segments"] : [])] : upscale ? [here("upscale_video.py"), input, output, dir, upscale[1], upscale[2] || "natural"] : [here("depth_video.py"), input, output, dataPath("depth", "model.onnx"), FFMPEG];
                child = spawn(PYTHON, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TEMP: dir, TMP: dir } });
                let error = ""; child.stderr?.on("data", (chunk) => { error += String(chunk); });
                const kill = () => { if (!res.writableEnded && child?.pid) spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); };
                res.on("close", kill);
                await new Promise<void>((resolve, reject) => { child!.once("error", reject); child!.once("exit", (code) => code === 0 ? resolve() : reject(new Error(error || "深度视频处理失败"))); });
                res.removeListener("close", kill);
                res.writeHead(200, { "Content-Type": split ? "application/json; charset=utf-8" : "video/mp4", "Cache-Control": "no-store" });
                await pipeline(createReadStream(output), res);
            } catch (error) {
                if (!res.headersSent && !res.destroyed) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error instanceof Error && error.message.includes("原视频已达到") ? "原视频已达到目标尺寸，请选择更高分辨率。" : upscale ? "超分失败，请检查显卡、磁盘空间和视频文件。" : split ? "视频切分失败，请检查视频文件及本机 FFmpeg。" : "深度解析失败，请检查视频文件及本机模型。" })); }
            } finally { if (dir) await rm(dir, { recursive: true, force: true }); }
        });
    } };
}
