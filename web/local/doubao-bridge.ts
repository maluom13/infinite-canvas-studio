import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

import { dataPath } from "./runtime-paths";

/** 豆包是独立账号与独立生成通道：登录态、浏览器、任务、作品都在自己的目录，不碰 Muse。 */
const defaultHome = process.env.DOUBAO_HOME || dataPath("doubao");
const loginScript = fileURLToPath(new URL("./doubao-login.py", import.meta.url));
const generateScript = fileURLToPath(new URL("./doubao-generate.py", import.meta.url));
const pythonPath = process.env.DOUBAO_PYTHON || dataPath("publisher", "venv", "Scripts", "python.exe");
/** 别人的机器上可能只有 Edge：按 配置 → Chrome → Edge 找第一个真实存在的，别写死 Chrome 路径。 */
const chromePath = (() => {
    const configured = process.env.DOUBAO_CHROME || process.env.CANVAS_CHROME;
    if (configured) return configured;
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter((root): root is string => Boolean(root));
    const candidates = roots.flatMap((root) => [
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);
    return candidates.find((candidate) => existsSync(candidate)) ?? "chrome";
})();
const cdpPort = Number(process.env.DOUBAO_CDP_PORT || 19402);
const chatUrl = "https://www.doubao.com/chat/";
const waitingTtlMs = 20 * 60 * 1000;

type LoginState = { state: string; message: string; at?: number };
type Job = { id: string; kind: "image" | "video"; status: string; message?: string; file?: string; createdAt?: number; updatedAt?: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function doubaoHome() {
    return process.env.DOUBAO_HOME || defaultHome;
}

async function readSession(home: string) {
    try {
        const raw = await readFile(path.join(home, "session.json"), "utf8");
        const data = JSON.parse(raw) as { cookies?: Array<{ name?: string; domain?: string; expires?: number }> };
        const now = Date.now() / 1000;
        const alive = (data.cookies || []).some((cookie) => cookie.name === "sessionid" && String(cookie.domain || "").includes("doubao.com") && (!cookie.expires || cookie.expires < 0 || cookie.expires > now));
        return { loggedIn: alive, cookieCount: (data.cookies || []).length };
    } catch {
        return { loggedIn: false, cookieCount: 0 };
    }
}

async function readLoginState(home: string): Promise<LoginState> {
    try {
        const raw = await readFile(path.join(home, "status.json"), "utf8");
        const data = JSON.parse(raw) as LoginState;
        const at = Number(data.at || 0) * 1000;
        // 脚本被关掉时状态可能停在 waiting，超过 20 分钟就当作没有在登录
        if (data.state === "waiting" && at && Date.now() - at > waitingTtlMs) return { state: "idle", message: "上次登录没有完成，请重新登录。", at };
        return { state: String(data.state || "idle"), message: String(data.message || ""), at };
    } catch {
        return { state: "idle", message: "", at: 0 };
    }
}

async function cdpAlive() {
    try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1500) });
        return response.ok;
    } catch {
        return false;
    }
}

/** 豆包浏览器保持常驻：人机验证只需要在窗口里过一次，后续生成可以直接复用。 */
async function ensureBrowser(home: string) {
    if (await cdpAlive()) return;
    await mkdir(home, { recursive: true });
    const child = spawn(chromePath, [
        `--user-data-dir=${path.join(home, "profile")}`,
        `--remote-debugging-port=${cdpPort}`,
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,900",
        chatUrl,
    ], { detached: true, stdio: "ignore" });
    child.unref();
    if (child.pid) await writeFile(path.join(home, "browser.pid"), String(child.pid), "utf8").catch(() => undefined);
    for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(500);
        if (await cdpAlive()) return;
    }
    throw new Error("豆包浏览器启动失败，请检查 Chrome 是否安装。");
}

async function stopBrowser(home: string) {
    try {
        const pid = (await readFile(path.join(home, "browser.pid"), "utf8")).trim();
        if (pid) spawn("taskkill", ["/PID", pid, "/F", "/T"], { stdio: "ignore", windowsHide: true });
    } catch {
        // 没有 pid 文件就交给用户手动关闭
    }
    await rm(path.join(home, "browser.pid"), { force: true }).catch(() => undefined);
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!(await cdpAlive())) return;
        await sleep(300);
    }
}

async function readJob(home: string, id: string): Promise<Job | null> {
    try {
        return JSON.parse(await readFile(path.join(home, "jobs", `${id}.json`), "utf8")) as Job;
    } catch {
        return null;
    }
}

async function writeJob(home: string, job: Job) {
    await mkdir(path.join(home, "jobs"), { recursive: true });
    await writeFile(path.join(home, "jobs", `${job.id}.json`), JSON.stringify(job), "utf8");
}

const queue: Array<{ id: string; kind: "image" | "video"; prompt: string }> = [];
let draining = false;

async function drain() {
    if (draining) return;
    draining = true;
    try {
        while (queue.length) {
            const task = queue.shift()!;
            const home = await doubaoHome();
            try {
                await ensureBrowser(home);
                await mkdir(path.join(home, "logs"), { recursive: true });
                const child = spawn(pythonPath, [generateScript, "--job", task.id, "--kind", task.kind, "--prompt", task.prompt, "--timeout", task.kind === "video" ? "900" : "300"], {
                    cwd: path.dirname(generateScript),
                    env: { ...process.env, DOUBAO_HOME: home, DOUBAO_CDP: `http://127.0.0.1:${cdpPort}`, PYTHONIOENCODING: "utf-8" },
                    stdio: "ignore",
                    windowsHide: true,
                });
                await new Promise<void>((resolve) => {
                    child.once("close", () => resolve());
                    child.once("error", () => resolve());
                });
            } catch (error) {
                await writeJob(home, { id: task.id, kind: task.kind, status: "failed", message: error instanceof Error ? error.message : "豆包生成失败", updatedAt: Date.now() });
            }
        }
    } finally {
        draining = false;
    }
}

async function enqueue(home: string, kind: "image" | "video", prompt: string) {
    const id = `db_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await writeJob(home, { id, kind, status: "queued", message: "排队中", createdAt: Date.now(), updatedAt: Date.now() });
    queue.push({ id, kind, prompt });
    void drain();
    return id;
}

const mediaTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4" };

/** 豆包网页默认按提示词自己定比例，这里把画布选的尺寸翻译成一句构图要求。 */
function ratioHint(size: unknown) {
    const match = /^(\d+)x(\d+)$/i.exec(String(size || "").trim());
    if (!match) return "";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return "";
    const ratio = width / height;
    if (Math.abs(ratio - 1) < 0.05) return "，画面比例 1:1 正方形构图";
    if (Math.abs(ratio - 16 / 9) < 0.08) return "，画面比例 16:9 横屏构图";
    if (Math.abs(ratio - 9 / 16) < 0.08) return "，画面比例 9:16 竖屏构图";
    return ratio > 1 ? "，横向构图" : "，竖向构图";
}

function jobStatus(job: Job | null) {
    if (!job) return "processing";
    if (job.status === "done") return "completed";
    if (job.status === "failed") return "failed";
    return "processing";
}

export function doubaoBridge(): Plugin {
    let running = false;
    return {
        name: "doubao-standalone",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = new URL(req.url || "/", "http://localhost");
                if (!url.pathname.startsWith("/doubao/")) return next();
                const host = req.headers.host || "";
                const sameOrigin = /^(127\.0\.0\.1|localhost):\d+$/.test(host) && (!req.headers.origin || req.headers.origin === `http://${host}`) && req.headers["sec-fetch-site"] !== "cross-site";
                const json = (status: number, value: unknown) => {
                    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
                    res.end(JSON.stringify(value));
                };
                if (!sameOrigin) return json(403, { error: "豆包通道只允许本机画布访问。" });

                const readBody = async () => {
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) chunks.push(Buffer.from(chunk));
                    return Buffer.concat(chunks);
                };

                void (async () => {
                    try {
                        const home = await doubaoHome();
                        if (url.pathname === "/doubao/status" && req.method === "GET") {
                            const [session, login] = await Promise.all([readSession(home), readLoginState(home)]);
                            return json(200, {
                                loggedIn: session.loggedIn,
                                state: login.state,
                                message: login.message,
                                loginAt: login.state === "done" ? Math.floor((login.at || 0) / 1000) : 0,
                                home,
                                browserOpen: await cdpAlive(),
                            });
                        }
                        if (url.pathname === "/doubao/login" && req.method === "POST") {
                            if (running) return json(409, { error: "登录窗口已经打开了，请先在窗口里完成登录。" });
                            running = true;
                            const child = spawn(pythonPath, [loginScript], {
                                cwd: path.dirname(loginScript),
                                env: { ...process.env, DOUBAO_HOME: home, DOUBAO_CDP: `http://127.0.0.1:${cdpPort}`, PYTHONIOENCODING: "utf-8" },
                                stdio: "ignore",
                                windowsHide: true,
                                detached: true,
                            });
                            child.once("exit", () => { running = false; });
                            child.once("error", () => { running = false; });
                            child.unref();
                            return json(200, { ok: true, message: "已打开豆包登录窗口，登录成功后会自动保存。" });
                        }
                        if (url.pathname === "/doubao/logout" && req.method === "POST") {
                            await stopBrowser(home);
                            await rm(path.join(home, "session.json"), { force: true });
                            await rm(path.join(home, "status.json"), { force: true });
                            await rm(path.join(home, "profile"), { recursive: true, force: true });
                            return json(200, { ok: true, message: "已退出豆包登录，并清除本机登录态。" });
                        }
                        if (url.pathname === "/doubao/v1/models" && req.method === "GET") {
                            return json(200, {
                                object: "list",
                                data: [
                                    { id: "doubao-image", object: "model", owned_by: "doubao", description: "豆包图片生成（网页额度）" },
                                    { id: "doubao-video", object: "model", owned_by: "doubao", description: "豆包视频生成（网页额度）" },
                                ],
                            });
                        }
                        if (url.pathname === "/doubao/v1/images/generations" && req.method === "POST") {
                            const body = JSON.parse((await readBody()).toString("utf8") || "{}") as { prompt?: string; model?: string; size?: string };
                            const prompt = String(body.prompt || "").trim();
                            if (!prompt) return json(400, { error: { message: "提示词不能为空" } });
                            const session = await readSession(home);
                            if (!session.loggedIn) return json(401, { error: { message: "豆包还没有登录，请先在设置的「豆包」里登录。" } });
                            const id = await enqueue(home, "image", `${prompt}${ratioHint(body.size)}`);
                            return json(200, { object: "image.task", task_id: id, id, status: "queued" });
                        }
                        const imageTask = /^\/doubao\/v1\/images\/tasks\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
                        if (imageTask && req.method === "GET") {
                            const job = await readJob(home, imageTask[1]);
                            if (!job) return json(404, { error: { message: "任务不存在" } });
                            const status = jobStatus(job);
                            if (status === "failed") return json(200, { object: "image.task", task_id: job.id, status: "failed", error: { message: job.message || "豆包生成失败" } });
                            if (status === "completed" && job.file) return json(200, { object: "image.task", task_id: job.id, status: "completed", data: [{ url: `/doubao/v1/media/${job.file}` }] });
                            return json(200, { object: "image.task", task_id: job.id, status: "processing", message: job.message || "生成中" });
                        }
                        if (url.pathname === "/doubao/v1/videos" && req.method === "POST") {
                            const raw = (await readBody()).toString("utf8");
                            const prompt = /name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)?.[1] || /name="prompt"\r\n\r\n([\s\S]*)$/.exec(raw)?.[1] || "";
                            const size = /name="size"\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)?.[1] || "";
                            if (!prompt.trim()) return json(400, { error: { message: "提示词不能为空" } });
                            const session = await readSession(home);
                            if (!session.loggedIn) return json(401, { error: { message: "豆包还没有登录，请先在设置的「豆包」里登录。" } });
                            const id = await enqueue(home, "video", `${prompt.trim()}${ratioHint(size)}`);
                            return json(200, { id, status: "queued", object: "video" });
                        }
                        const videoTask = /^\/doubao\/v1\/videos\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
                        if (videoTask && req.method === "GET") {
                            const job = await readJob(home, videoTask[1]);
                            if (!job) return json(404, { error: { message: "任务不存在" } });
                            const status = jobStatus(job);
                            if (status === "failed") return json(200, { id: job.id, status: "failed", error: { message: job.message || "豆包生成失败" } });
                            if (status === "completed" && job.file) return json(200, { id: job.id, status: "completed", video_url: `/doubao/v1/media/${job.file}` });
                            return json(200, { id: job.id, status: "processing", progress: 0 });
                        }
                        const videoContent = /^\/doubao\/v1\/videos\/([A-Za-z0-9_-]+)\/content$/.exec(url.pathname);
                        if (videoContent && req.method === "GET") {
                            const job = await readJob(home, videoContent[1]);
                            if (!job?.file) return json(404, { error: { message: "视频还没有生成完成" } });
                            return serveMedia(home, job.file, res, json);
                        }
                        const media = /^\/doubao\/v1\/media\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
                        if (media && req.method === "GET") {
                            return serveMedia(home, media[1], res, json);
                        }
                        return json(404, { error: "豆包接口不存在。" });
                    } catch (error) {
                        return json(500, { error: error instanceof Error ? error.message : "豆包操作失败" });
                    }
                })();
            });
        },
    };
}

async function serveMedia(home: string, name: string, res: import("node:http").ServerResponse, json: (status: number, value: unknown) => void) {
    const file = path.join(home, "media", path.basename(name));
    try {
        const info = await stat(file);
        if (!info.isFile()) return json(404, { error: "文件不存在" });
        const ext = path.extname(file).slice(1).toLowerCase();
        res.writeHead(200, { "Content-Type": mediaTypes[ext] || "application/octet-stream", "Content-Length": info.size, "Cache-Control": "no-store" });
        createReadStream(file).pipe(res);
    } catch {
        return json(404, { error: "文件不存在" });
    }
}
