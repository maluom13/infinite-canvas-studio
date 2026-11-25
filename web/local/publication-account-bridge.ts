import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Plugin } from "vite";

import { dataPath } from "./runtime-paths";

const root = process.env.PUBLISHER_HOME || dataPath("publisher");
const sauRoot = path.join(root, "social-auto-upload-main");
const sauExe = path.join(root, "venv", "Scripts", "sau.exe");
const logDir = path.join(root, "logs");
const platforms = ["tencent", "kuaishou", "douyin"] as const;
type Platform = (typeof platforms)[number];
const account = "default";
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
/** 单次发布上限：真实发布通常 2-5 分钟，超过 8 分钟基本是卡住了。 */
const PUBLISH_TIMEOUT = 8 * 60 * 1000;
/** 只有「快速失败」才值得自动重试，避免超时后再等一轮。 */
const RETRY_WINDOW = 120 * 1000;
/** 平台定时发布最早/最晚范围，超出范围直接拦下，省得跑到一半才报错。 */
const MIN_LEAD_MS = 30 * 60 * 1000;
const MAX_LEAD_MS = 14 * 24 * 60 * 60 * 1000;

const platformNames: Record<Platform, string> = { tencent: "视频号", kuaishou: "快手", douyin: "抖音" };

/** SAU 把账号 Cookie 存在仓库 cookies 目录，文件名是 <platform>_<account>.json。 */
function cookieFile(platform: Platform) {
    return path.join(sauRoot, "cookies", `${platform}_${account}.json`);
}

function statusFile(platform: Platform) {
    return path.join(root, "accounts", platform, "status.json");
}

type PublishRecord = {
    id: string;
    platform: Platform;
    title: string;
    status: "success" | "scheduled" | "failed";
    message?: string;
    hint?: string;
    projectTitle?: string;
    at: number;
    attempts?: number;
    durationMs?: number;
    logId?: string;
    scheduledAt?: number;
};

const historyFile = path.join(root, "history.json");

/** 发布记录只保留最近 100 条，够页面展示又不至于越滚越大。 */
async function appendHistory(record: PublishRecord) {
    let list: PublishRecord[] = [];
    try {
        const data = JSON.parse(await readFile(historyFile, "utf8")) as PublishRecord[];
        if (Array.isArray(data)) list = data;
    } catch {
        list = [];
    }
    list.unshift(record);
    await mkdir(root, { recursive: true });
    await writeFile(historyFile, JSON.stringify(list.slice(0, 100)), "utf8");
}

async function readHistory(): Promise<PublishRecord[]> {
    try {
        const data = JSON.parse(await readFile(historyFile, "utf8")) as PublishRecord[];
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

async function writeStatus(platform: Platform, state: string, message: string) {
    const file = statusFile(platform);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ state, message, updatedAt: Date.now() }), "utf8");
}

/** 读取账号状态：登录失效优先于「有 Cookie」，否则用户永远看不到过期提示。 */
async function readStatus(platform: Platform) {
    let login: { state?: string; message?: string } = {};
    try {
        login = JSON.parse(await readFile(statusFile(platform), "utf8")) as { state?: string; message?: string };
    } catch {
        login = {};
    }
    const cookies = await readFile(cookieFile(platform), "utf8")
        .then((text) => {
            try {
                const data = JSON.parse(text) as unknown;
                // SAU 的 cookie 文件是数组；空数组说明还没登录成功
                return Array.isArray(data) ? data.length > 0 : Boolean(data && typeof data === "object" && Object.keys(data as object).length);
            } catch {
                return false;
            }
        })
        .catch(() => false);
    if (login.state === "expired") {
        return { platform, state: "expired", message: login.message || "登录已失效，请重新扫码", connected: false, publishingReady: false, expired: true };
    }
    if (cookies) return { platform, state: "connected", message: `${platformNames[platform]}账号已连接`, connected: true, publishingReady: true, expired: false };
    if (login.state === "waiting") return { platform, state: "waiting", message: login.message || "请在登录窗口中扫码", connected: false, publishingReady: false, expired: false };
    return { platform, state: login.state || "unconnected", message: login.message || "尚未登录", connected: false, publishingReady: false, expired: false };
}

type Attempt = { code: number; output: string; timedOut: boolean; durationMs: number };
type Failure = { kind: "expired" | "timeout" | "transient" | "unknown"; hint: string };

/** 跑一次 sau 命令，收集输出；超时会杀掉进程。 */
function runSau(args: string[], timeoutMs: number) {
    return new Promise<{ code: number; output: string; timedOut: boolean }>((resolve) => {
        const child = spawn(sauExe, args, { cwd: sauRoot, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
        let output = "";
        let settled = false;
        let timedOut = false;
        const finish = (code: number) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, output: output.slice(-8000), timedOut });
        };
        const timer = setTimeout(() => {
            timedOut = true;
            output += "\n[执行超时，已终止]";
            try { child.kill(); } catch { /* ignore */ }
            finish(-1);
        }, timeoutMs);
        const collect = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-20000); };
        child.stdout?.on("data", collect);
        child.stderr?.on("data", collect);
        child.once("error", (error) => { output += `\n${error.message}`; finish(-1); });
        child.once("close", (code) => finish(code ?? -1));
    });
}

const expiredPatterns = [/cookie[^\n]{0,40}(missing|expired|invalid|失效|过期)/i, /请(先)?登录/, /登录(已)?(失效|过期)/, /未登录/, /not\s*log(ged)?\s*in/i, /login\s*required/i, /扫码登录/];

/** 把 SAU 的输出翻译成人能看懂的原因和处理建议。 */
export function classifyFailure(code: number, output: string, timedOut: boolean): Failure {
    if (timedOut) {
        return { kind: "timeout", hint: "发布超时，平台可能仍在处理。先到创作者后台确认是否已发出，避免重复发布。" };
    }
    if (expiredPatterns.some((pattern) => pattern.test(output))) {
        return { kind: "expired", hint: "登录已失效，点「扫码登录」重新扫一次再发。" };
    }
    if (/timeout|timed out|连接超时|网络|ECONNRESET|ETIMEDOUT/i.test(output)) {
        return { kind: "transient", hint: "网络波动，已自动重试仍然失败，稍后再发一次。" };
    }
    const lastLine = output.split("\n").map((line) => line.trim()).filter(Boolean).pop();
    return { kind: "unknown", hint: lastLine ? lastLine.slice(0, 160) : `发布进程异常退出（退出码 ${code}）` };
}

/** 视频流写入临时文件；中途失败要顺手清理，避免残留大文件。 */
async function saveUpload(req: IncomingMessage, file: string) {
    let size = 0;
    const out = createWriteStream(file);
    try {
        for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_VIDEO_BYTES) throw new Error("视频超过 300MB，暂不支持发布");
            if (!out.write(chunk)) await new Promise<void>((resolve) => { out.once("drain", () => resolve()); });
        }
    } catch (error) {
        out.destroy();
        await rm(file, { force: true });
        throw error;
    }
    await new Promise<void>((resolve) => out.end(() => resolve()));
    return size;
}

/** 每次发布留一份完整日志，失败时用户能自己核对，不用只看一句退出码。 */
async function writePublishLog(id: string, header: string[], attempts: Attempt[]) {
    await mkdir(logDir, { recursive: true });
    const body = [
        ...header,
        "",
        ...attempts.flatMap((attempt, index) => [
            `--- 第 ${index + 1} 次尝试｜退出码 ${attempt.code}${attempt.timedOut ? "｜超时" : ""}｜${Math.round(attempt.durationMs / 1000)}s ---`,
            attempt.output || "(无输出)",
            "",
        ]),
    ].join("\n");
    await writeFile(path.join(logDir, `${id}.log`), body, "utf8");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** SAU 只认本地时间 "%Y-%m-%d %H:%M"，由平台自己到点发布。 */
function formatSchedule(date: Date) {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type PublishInput = { id: string; platform: Platform; title: string; desc: string; tags: string[]; projectTitle?: string; file: string; schedule?: Date };

type PublishOutcome =
    | { ok: true; attempts: number; durationMs: number; logId: string; scheduled: boolean }
    | { ok: false; failure: Failure; attempts: number; durationMs: number; logId: string };

/** 立即发布和定时发布共用一条执行路径：重试、分类、日志、账号状态、发布记录都在这里。 */
async function executePublish(input: PublishInput): Promise<PublishOutcome> {
    const startedAt = Date.now();
    const scheduleText = input.schedule ? formatSchedule(input.schedule) : "";
    await writeStatus(input.platform, "publishing", scheduleText ? `正在预约${scheduleText}发布…` : `正在发布到${platformNames[input.platform]}…`);
    const args = [input.platform, "upload-video", "--account", account, "--file", input.file, "--title", input.title, "--desc", input.desc, "--tags", input.tags.join(",")];
    if (scheduleText) args.push("--schedule", scheduleText);
    const attempts: Attempt[] = [];

    const first = await runSau(args, PUBLISH_TIMEOUT);
    attempts.push({ ...first, durationMs: Date.now() - startedAt });
    let failure: Failure | null = first.code === 0 ? null : classifyFailure(first.code, first.output, first.timedOut);

    // 快速失败才自动再试一次：超时和登录失效重试只会让人多等
    if (failure && failure.kind === "transient" && Date.now() - startedAt < RETRY_WINDOW) {
        await writeStatus(input.platform, "publishing", "第一次发布失败，5 秒后自动重试…");
        await sleep(5000);
        const retryStartedAt = Date.now();
        const retry = await runSau(args, PUBLISH_TIMEOUT);
        attempts.push({ ...retry, durationMs: Date.now() - retryStartedAt });
        failure = retry.code === 0 ? null : classifyFailure(retry.code, retry.output, retry.timedOut);
    }

    const durationMs = Date.now() - startedAt;
    await writePublishLog(input.id, [
        `时间：${new Date(startedAt).toLocaleString("zh-CN", { hour12: false })}`,
        `发布方式：${scheduleText ? `定时（${scheduleText}）` : "立即"}`,
        `平台：${platformNames[input.platform]}｜账号：${account}`,
        `标题：${input.title}`,
        `简介：${input.desc.slice(0, 200)}`,
        `标签：${input.tags.join(",")}`,
    ], attempts);

    if (!failure) {
        const scheduled = Boolean(scheduleText);
        await writeStatus(input.platform, "connected", `${platformNames[input.platform]}账号已连接`);
        await appendHistory({ id: input.id, platform: input.platform, title: input.title, status: scheduled ? "scheduled" : "success", projectTitle: input.projectTitle, at: Date.now(), attempts: attempts.length, durationMs, logId: input.id, scheduledAt: input.schedule?.getTime() });
        return { ok: true, attempts: attempts.length, durationMs, logId: input.id, scheduled };
    }

    if (failure.kind === "expired") await writeStatus(input.platform, "expired", `${platformNames[input.platform]}登录已失效，请重新扫码`);
    else await writeStatus(input.platform, "failed", `${platformNames[input.platform]}上次发布失败，请重试`);
    await appendHistory({ id: input.id, platform: input.platform, title: input.title, status: "failed", message: failure.hint, hint: failure.hint, projectTitle: input.projectTitle, at: Date.now(), attempts: attempts.length, durationMs, logId: input.id, scheduledAt: input.schedule?.getTime() });
    return { ok: false, failure, attempts: attempts.length, durationMs, logId: input.id };
}

export function publicationAccountBridge(): Plugin {
    const running = new Set<string>();
    const publishing = new Set<Platform>();
    return {
        name: "publication-accounts",
        configureServer(server) {
            // 发布可能持续数分钟，Node 默认 5 分钟会掐断请求，这里放开
            if (server.httpServer) (server.httpServer as unknown as { requestTimeout: number }).requestTimeout = 0;
            server.middlewares.use(async (req, res, next) => {
                const url = new URL(req.url || "/", "http://127.0.0.1");
                const pathname = url.pathname;
                const loginRoute = /^\/local-publication\/accounts\/(tencent|kuaishou|douyin)\/login$/.exec(pathname);
                const logRoute = /^\/local-publication\/logs\/([\w-]+)$/.exec(pathname);
                const simpleRoute = /^\/local-publication\/(accounts|publish|history)$/.exec(pathname);
                if (!loginRoute && !logRoute && !simpleRoute) return next();
                const host = req.headers.host || "";
                const json = (code: number, value: unknown) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
                if (!/^(localhost|127\.0\.0\.1):3010$/.test(host) || req.headers["sec-fetch-site"] === "cross-site" || (req.headers.origin && req.headers.origin !== `http://${host}`) || (req.method !== "GET" && (req.headers.origin !== `http://${host}` || req.headers["x-canvas-local"] !== "1"))) return json(403, { error: "仅允许本机画布访问" });

                try {
                    if (simpleRoute?.[1] === "history" && req.method === "GET") {
                        return json(200, { data: await readHistory() });
                    }
                    if (simpleRoute?.[1] === "accounts" && req.method === "GET") {
                        return json(200, { accounts: await Promise.all(platforms.map(readStatus)) });
                    }
                    if (logRoute && req.method === "GET") {
                        const id = logRoute[1];
                        try {
                            const text = await readFile(path.join(logDir, `${id}.log`), "utf8");
                            return json(200, { id, text });
                        } catch {
                            return json(404, { error: "日志不存在或已被清理" });
                        }
                    }
                    if (loginRoute && req.method === "POST") {
                        const platform = loginRoute[1] as Platform;
                        if (running.has(platform)) return json(409, { error: "该平台登录窗口已打开，请先完成登录。" });
                        running.add(platform);
                        const loginStartedAt = Date.now();
                        await writeStatus(platform, "waiting", "请在打开的浏览器窗口扫码登录，完成后点「刷新账号状态」。");
                        const child = spawn(sauExe, [platform, "login", "--account", account, "--headed"], { cwd: sauRoot, windowsHide: false, detached: true, stdio: "ignore", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
                        child.once("error", () => { running.delete(platform); void writeStatus(platform, "error", "无法启动登录窗口，请确认发布环境已安装。"); });
                        child.once("exit", async (code) => {
                            running.delete(platform);
                            // 只有 Cookie 在这次登录期间被刷新过，才算真的登录成功；
                            // 否则用户中途关窗时，旧 Cookie 会把「已失效」又改回「已连接」。
                            const refreshed = await stat(cookieFile(platform)).then((info) => info.mtimeMs >= loginStartedAt - 2000).catch(() => false);
                            const status = await readStatus(platform);
                            if (refreshed && status.connected) await writeStatus(platform, "connected", `${platformNames[platform]}账号已连接`);
                            else if (code !== 0) await writeStatus(platform, "error", "登录窗口已关闭，未检测到新登录，请重试。");
                            else await writeStatus(platform, status.state === "expired" ? "expired" : "error", `${platformNames[platform]}登录未完成，请重新扫码。`);
                        });
                        child.unref();
                        return json(202, { ok: true });
                    }
                    if (simpleRoute?.[1] === "publish" && req.method === "POST") {
                        const platform = String(url.searchParams.get("platform") || "") as Platform;
                        const title = String(url.searchParams.get("title") || "").trim();
                        if (!platforms.includes(platform)) return json(400, { error: "不支持的平台" });
                        if (!title) return json(400, { error: "标题不能为空" });
                        const status = await readStatus(platform);
                        if (!status.connected) return json(409, { error: status.expired ? `${platformNames[platform]}登录已失效，请重新扫码` : `请先登录${platformNames[platform]}账号`, expired: status.expired });

                        let schedule: Date | undefined;
                        const rawAt = url.searchParams.get("at");
                        if (rawAt) {
                            const at = Number(rawAt);
                            if (!Number.isFinite(at)) return json(400, { error: "定时时间无效" });
                            if (at < Date.now() + MIN_LEAD_MS) return json(400, { error: `定时发布至少要提前 ${Math.round(MIN_LEAD_MS / 60000)} 分钟` });
                            if (at > Date.now() + MAX_LEAD_MS) return json(400, { error: "定时发布最多只能预约 14 天内" });
                            schedule = new Date(at);
                        }
                        // 同一平台串行：SAU 共用一份 cookie 和一个浏览器实例，并发会互相踢掉
                        if (publishing.has(platform)) return json(409, { error: `${platformNames[platform]}正在发布另一个作品，等这次完成再发` });

                        const jobDir = path.join(root, "jobs");
                        await mkdir(jobDir, { recursive: true });
                        const file = path.join(jobDir, `${platform}-${Date.now()}.mp4`);
                        let size = 0;
                        try {
                            size = await saveUpload(req, file);
                        } catch (error) {
                            return json(413, { error: error instanceof Error ? error.message : "视频写入失败" });
                        }
                        if (!size) { await rm(file, { force: true }); return json(400, { error: "没有收到视频内容" }); }

                        const desc = String(url.searchParams.get("desc") || "").trim();
                        const tags = String(url.searchParams.get("tags") || "").split(",").map((tag) => tag.replace(/^#+/, "").trim()).filter(Boolean).slice(0, 8);
                        const projectTitle = String(url.searchParams.get("projectTitle") || "").slice(0, 60);
                        const id = `${Date.now()}-${platform}`;
                        publishing.add(platform);
                        try {
                            const outcome = await executePublish({ id, platform, title, desc, tags, projectTitle, file, schedule });
                            if (outcome.ok) return json(200, { ok: true, platform, attempts: outcome.attempts, durationMs: outcome.durationMs, logId: outcome.logId, scheduled: outcome.scheduled, scheduledAt: schedule?.getTime() });
                            return json(502, {
                                ok: false,
                                platform,
                                error: `${platformNames[platform]}发布失败：${outcome.failure.hint}`,
                                hint: outcome.failure.hint,
                                kind: outcome.failure.kind,
                                expired: outcome.failure.kind === "expired",
                                attempts: outcome.attempts,
                                logId: outcome.logId,
                            });
                        } finally {
                            publishing.delete(platform);
                            await rm(file, { force: true });
                        }
                    }
                    json(405, { error: "不支持此操作" });
                } catch (error) {
                    json(500, { error: error instanceof Error ? error.message : "发布服务不可用" });
                }
            });
        },
    };
}
