import { readFile, stat, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream";
import type { Plugin } from "vite";

import { CANVAS_CONFIG_PATH, MUSE_INSTALL_CONFIG, PROJECT_ROOT } from "./runtime-paths";

type Installation = { poolKey: string; ports: { pool: number; protocol: number } };
type BridgeOptions = { readInstallation?: () => Promise<Installation> };

/**
 * 桥接的行为版本。改了错误提示、路径解析这类「看不见」的逻辑就加一。
 * 用途：对方报错时先看 /muse/version —— 版本低或 404 就说明他跑的是旧代码，
 * 再多的排查都是白费。曾经就因为旧代码里写着「请重新运行 D 盘启动入口」，
 * 对方的机器上根本没有 D 盘。
 */
const BRIDGE_VERSION = 3;
const STARTED_AT = new Date().toISOString();

const exists = async (file: string) => {
    try { await stat(file); return true; } catch { return false; }
};

/**
 * 找 MuseCanvas 的 install.json。
 * 顺序：环境变量 → 用户配置文件的 museInstall → 常见安装位置。
 * MuseCanvas 可能装在任意磁盘，写死一个路径在别人机器上必然读不到。
 */
export async function resolveInstallPath(): Promise<string> {
    if (process.env.MUSE_INSTALL_CONFIG && await exists(process.env.MUSE_INSTALL_CONFIG)) return process.env.MUSE_INSTALL_CONFIG;
    const candidates: string[] = [];
    try {
        const cfg = JSON.parse(await readFile(CANVAS_CONFIG_PATH, "utf8")) as { museInstall?: string; museLauncher?: string; stateDir?: string };
        if (cfg.museInstall) candidates.push(cfg.museInstall);
        if (cfg.museLauncher) candidates.push(join(dirname(cfg.museLauncher), "MuseCanvasData", "install.json"));
        if (cfg.stateDir) candidates.push(join(dirname(dirname(cfg.stateDir)), "MuseCanvasData", "install.json"));
    } catch { /* 没有配置文件就走下面的探测 */ }
    if (MUSE_INSTALL_CONFIG) candidates.push(MUSE_INSTALL_CONFIG);
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "MuseCanvasData", "install.json"));
    if (process.env.ProgramData) candidates.push(join(process.env.ProgramData, "MuseCanvasData", "install.json"));
    for (const drive of ["C", "D", "E", "F", "G"]) {
        candidates.push(`${drive}:/CodexOutputs/MuseCanvasData/install.json`);
        candidates.push(`${drive}:/MuseCanvasData/install.json`);
    }
    for (const candidate of candidates) {
        if (await exists(candidate)) return candidate;
    }
    throw new Error("Muse 通道未启用（可选功能）。出图不需要它——请把画布顶部的生成通道切到「豆包」并登录豆包账号，即可出图出视频。若你机器上本来就装了 MuseCanvas，可在 canvas.config.json 里把 museInstall 指向它的 MuseCanvasData\\install.json 来启用 Muse 通道。");
}

const readInstallation = async (): Promise<Installation> => JSON.parse(await readFile(await resolveInstallPath(), "utf8"));

/**
 * 把生成协议池对齐到当前的账号列表。
 * 协议池是独立于账号列表的配置：删了账号但没清这里，协议照样会轮到它，
 * 每次都报「No valid saved Muse session」，看起来像随机的生成失败。
 */
export async function pruneProtocolAccounts(): Promise<number> {
    const configPath = join(dirname(await resolveInstallPath()), "protocol", "config.json");
    const protocolConfig = JSON.parse(await readFile(configPath, "utf8")) as { api_key?: string; accounts?: { pool_account_id?: string }[] };
    const accounts = protocolConfig.accounts || [];
    if (!accounts.length) return 0;
    const installation = await readInstallation();
    const response = await fetch(`http://127.0.0.1:${installation.ports.pool}/admin/accounts`, { headers: { Authorization: `Bearer ${installation.poolKey}` } });
    if (!response.ok) return 0;
    const payload = (await response.json()) as { accounts?: { id: string }[] };
    const alive = new Set((payload.accounts || []).map((account) => account.id));
    const kept = accounts.filter((account) => !account.pool_account_id || alive.has(account.pool_account_id));
    if (kept.length === accounts.length) return 0;
    protocolConfig.accounts = kept;
    await writeFile(configPath, JSON.stringify(protocolConfig, null, 2), "utf8");
    await fetch(`http://127.0.0.1:${installation.ports.protocol}/api/reload-accounts`, { method: "POST", headers: { Authorization: `Bearer ${protocolConfig.api_key || ""}` } }).catch(() => undefined);
    return accounts.length - kept.length;
}

/** Only the local canvas can use this bridge. The Muse credential never enters browser storage. */
export function createMuseBridge(options: BridgeOptions = {}) {
    return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url || "/", "http://localhost");
        if (!url.pathname.startsWith("/muse/")) return next();
        const json = (status: number, value: unknown) => {
            res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(JSON.stringify(value));
        };
        const host = req.headers.host || "";
        const localOrigin = `http://${host}`;
        if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || (req.headers.origin && req.headers.origin !== localOrigin) || req.headers["sec-fetch-site"] === "cross-site" || (req.method !== "GET" && req.headers.origin !== localOrigin)) {
            return json(403, { error: "Muse 仅允许当前本机画布访问。" });
        }
        try {
            // 版本探针放在读配置之前：配置读不到时，它也必须能回答「你跑的是哪一版」。
            if (url.pathname === "/muse/version" && req.method === "GET") {
                const readVersion = async () => {
                    for (const dir of [PROJECT_ROOT, process.cwd()]) {
                        try { return (await readFile(join(dir, "VERSION"), "utf8")).trim(); } catch { /* 换下一个 */ }
                    }
                    return "";
                };
                let install: Record<string, unknown>;
                try {
                    install = { ok: true, path: await resolveInstallPath() };
                } catch (error) {
                    install = { ok: false, error: error instanceof Error ? error.message : "读不到 install.json" };
                }
                return json(200, {
                    bridge: BRIDGE_VERSION,
                    startedAt: STARTED_AT,
                    version: await readVersion(),
                    projectRoot: PROJECT_ROOT,
                    workingDirectory: process.cwd(),
                    install,
                    hint: "bridge 低于 3 或这里 404，说明这台机器跑的是旧代码：先更新再排查。",
                });
            }
            // 「本机根本没装 MuseCanvas」是最常见的「点登录没反应」。这一层要在读配置之前拦，
            // 否则会直接抛错，自检页反而看不到结论。
            if (url.pathname === "/muse/diagnose" && req.method === "GET") {
                try {
                    await resolveInstallPath();
                } catch (error) {
                    return json(200, {
                        ok: false,
                        bridge: BRIDGE_VERSION,
                        steps: [{ name: "Muse 通道", ok: false, detail: error instanceof Error ? error.message : "读不到 install.json", fix: "用豆包通道出图：画布顶部把生成通道切到「豆包」并登录即可。Muse 通道是可选功能，不装也能正常出图。" }],
                        summary: "Muse 通道未启用（可选）。这不影响出图——本程序用自带的豆包通道。",
                        notes: [
                            "出图不需要 Muse：在画布顶部把生成通道切到「豆包」，登录豆包账号即可。",
                            "Muse 通道只是可选项，需要你自己已有 MuseCanvas 才能用，本程序不提供也不引导购买账号。",
                            "如果你机器上本来就装了 MuseCanvas 并想用它，在 canvas.config.json 里把 museInstall 指向它的 install.json。",
                        ],
                    });
                }
            }
            const config = await (options.readInstallation || readInstallation)();
            if (!config.poolKey || !Number.isInteger(config.ports.pool) || !Number.isInteger(config.ports.protocol)) throw new Error("Muse 本机安装配置不完整。");
            const headers = { Authorization: `Bearer ${config.poolKey}` };
            const pool = `http://127.0.0.1:${config.ports.pool}`;
            const protocol = `http://127.0.0.1:${config.ports.protocol}`;
            if (url.pathname === "/muse/status" && req.method === "GET") {
                const [accountsResponse, modelsResponse, networkResponse] = await Promise.all([fetch(`${pool}/admin/accounts`, { headers }), fetch(`${protocol}/v1/models`, { headers }), fetch(`${pool}/admin/network`, { headers }).catch(() => null)]);
                if (!accountsResponse.ok || !modelsResponse.ok) return json(503, { error: `Muse 服务未就绪：账号池或生成协议没有响应。请确认 MuseCanvas 已启动（Muse 面板可看状态）；打开 ${localOrigin}/muse/diagnose 可看是哪一层断了。` });
                const accounts = await accountsResponse.json();
                const models = await modelsResponse.json();
                const network = networkResponse?.ok ? await networkResponse.json() : null;
                const protocolStatus = await fetch(`${pool}/admin/protocol/status`, { headers }).then((r) => r.ok ? r.json() : null).catch(() => null);
                return json(200, {
                    accounts: (accounts.accounts || []).map((a: Record<string, unknown>) => ({
                        id: a.id, label: a.label, enabled: Boolean(a.enabled),
                        ready: Boolean(a.enabled && a.essential_ok && a.ok !== false && (!a.expires_at || Number(a.expires_at) * 1000 > Date.now())),
                        useCount: a.use_count, today: a.today, expiresAt: a.expires_at, lastUsed: a.last_used,
                        quota: a.quota ? { found: (a.quota as Record<string, unknown>).found, weeklyUsed: (a.quota as Record<string, unknown>).weekly_used_pct, extraLeft: (a.quota as Record<string, unknown>).extra_left, checkedAt: (a.quota as Record<string, unknown>).checked_at } : null,
                        protocol: (protocolStatus?.accounts || []).filter((p: { id: unknown }) => p.id === a.id).map((p: { old_ok: boolean; new_ok: boolean }) => ({ oldOk: p.old_ok, newOk: p.new_ok }))[0] || null,
                    })),
                    models: (models.data || []).map((m: { id: string }) => ({ name: m.id, capability: /video/i.test(m.id) ? "video" : "image" })),
                    egress: network?.egress ? { ip: network.egress.ip, country: network.egress.country, checked_at: network.egress.checked_at } : null,
                });
            }
            // 自检：把「登录不了 Muse」拆成可判断的几层，避免对方只能描述“登不上”。
            // 浏览器打开 http://127.0.0.1:3010/muse/diagnose 就能看到结果。
            if (url.pathname === "/muse/diagnose" && req.method === "GET") {
                const steps: { name: string; ok: boolean; detail: string; fix?: string }[] = [];
                const probe = async (name: string, base: string, path: string, fix: string) => {
                    try {
                        const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(5000) });
                        if (response.status === 401 || response.status === 403) {
                            steps.push({ name, ok: false, detail: `HTTP ${response.status}：密钥与正在运行的服务不匹配`, fix: "install.json 里的 poolKey 不是正在运行这套 MuseCanvas 的。请用它自己的启动入口启动，或重装到同一目录。" });
                            return null;
                        }
                        if (!response.ok) {
                            steps.push({ name, ok: false, detail: `HTTP ${response.status}`, fix });
                            return null;
                        }
                        steps.push({ name, ok: true, detail: `HTTP ${response.status}` });
                        return await response.json().catch(() => null);
                    } catch (error) {
                        steps.push({ name, ok: false, detail: error instanceof Error ? error.message : "连接失败", fix });
                        return null;
                    }
                };
                const installPath = await resolveInstallPath();
                steps.push({ name: "MuseCanvas 配置", ok: true, detail: installPath });
                const accounts = await probe("账号池", pool, "/admin/accounts", "MuseCanvas 没在运行。用 MuseCanvas 自己的入口启动一次（或本程序启动时自动带起），再点重试。");
                const models = await probe("生成协议", protocol, "/v1/models", "账号池起来了但生成协议没响应。在 MuseCanvas 页面确认六个服务都正常，必要时 -Action Stop 再 Start。");
                const list = Array.isArray(accounts?.accounts) ? accounts.accounts as Record<string, unknown>[] : [];
                const ready = list.filter((account) => Boolean(account.enabled) && Boolean(account.essential_ok) && account.ok !== false && (!account.expires_at || Number(account.expires_at) * 1000 > Date.now())).length;
                if (accounts) steps.push({ name: "已有 Muse 账号", ok: ready > 0, detail: `共 ${list.length} 个，可用 ${ready} 个`, fix: ready > 0 ? undefined : "服务是好的，缺的是账号：点画布顶部 Muse → 添加账号，用你本人的 Muse 账号登录。" });
                const ok = Boolean(accounts && models && ready > 0);
                return json(200, {
                    ok,
                    bridge: BRIDGE_VERSION,
                    steps,
                    summary: ok
                        ? "链路正常：配置、账号池、生成协议都通，且至少有一个可用账号。"
                        : "链路有问题，按 steps 里 ok=false 的那一项处理。",
                    notes: [
                        "Muse 账号必须由本人登录，本程序不代登录、也不保存密码。",
                        "登录窗口不关、账号加不进来：多是 MuseCanvas 版本旧，0.23.3 修过这个问题，升级后再试。",
                        "没有 Muse 账号或邀请码时无法登录，这是账号问题不是软件问题——邀请码在 MuseCanvas 页面公告里。",
                    ],
                });
            }
            const loginStart = url.pathname === "/muse/login" && req.method === "POST";
            const action = /^\/muse\/accounts\/([a-zA-Z0-9_-]+)\/(test|keepalive|quota|sync)$/.exec(url.pathname);
            if (action && req.method === "POST") {
                const target = action[2] === "sync" ? `${pool}/admin/protocol/sync` : `${pool}/admin/accounts/${action[1]}/${action[2]}`;
                const response = await fetch(target, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: action[2] === "sync" ? JSON.stringify({ account_id: action[1] }) : "{}" });
                const result = await response.json().catch(() => ({}));
                if (!response.ok || result.ok === false) return json(response.ok ? 400 : response.status, { error: result.message || result.error || result.detail || result.reason || "操作未完成" });
                return json(200, { ok: true, message: result.message || (action[2] === "quota" && !result.found ? "未读取到额度，请重试" : "操作完成") });
            }
            if (url.pathname === "/muse/accounts/keepalive-all" && req.method === "POST") {
                const response = await fetch(`${pool}/admin/accounts/keepalive?force=true`, { method: "POST", headers });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) return json(response.status, { error: "保活请求失败" });
                return json(200, { ok: true, message: result.status === "busy" ? "保活任务正在运行" : `保活完成：${result.refreshed_count || 0} 个账号` });
            }
            // 删除账号：只移除本机保存的登录记录，不影响 Muse 账号本身；删完可重新添加登录。
            const remove = /^\/muse\/accounts\/([a-zA-Z0-9_-]+)\/delete$/.exec(url.pathname);
            if (remove && req.method === "POST") {
                const response = await fetch(`${pool}/admin/accounts/${remove[1]}`, { method: "DELETE", headers });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) return json(response.status, { error: result.message || result.error || result.detail || "删除账号失败" });
                // 顺手把生成协议池里对应的条目一起清掉，否则协议还会轮到已删账号。
                const pruned = await pruneProtocolAccounts().catch(() => 0);
                return json(200, { ok: true, message: result.message || `账号已删除${pruned ? `，已同步清理 ${pruned} 个协议条目` : ""}` });
            }
            if (url.pathname === "/muse/protocol-network" && req.method === "GET") {
                const response = await fetch(`${protocol}/api/netcheck${url.searchParams.get("force") === "1" ? "?force=1" : ""}`, { headers });
                if (!response.ok) return json(502, { error: "无法读取 Muse 新接口网络状态。" });
                const data = await response.json();
                return json(200, { ok: Boolean(data.ok), route: data.route, detail: data.detail });
            }
            if (url.pathname === "/muse/network/check" && req.method === "POST") {
                const check = await fetch(`${pool}/admin/network/check?force=true`, { method: "POST", headers });
                if (!check.ok) return json(502, { error: "Muse 浏览器出口检测失败，请检查服务和网络。" });
                const data = await check.json();
                return json(200, { egress: data.egress ? { ip: data.egress.ip, country: data.egress.country, checked_at: data.egress.checked_at } : null });
            }
            const loginStatus = /^\/muse\/login\/[a-zA-Z0-9_-]+$/.test(url.pathname) && req.method === "GET";
            const apiPath = url.pathname.slice("/muse".length);
            const generation = req.method === "POST" && ["/v1/images/generations", "/v1/images/edits", "/v1/videos", "/v1/audio/transcriptions"].includes(apiPath);
            const readApi = req.method === "GET" && (apiPath === "/v1/models" || /^\/v1\/(images\/tasks\/[^/]+|videos\/[^/]+(?:\/content)?|media\/[^/]+)$/.test(apiPath));
            if (!loginStart && !loginStatus && !generation && !readApi) return json(404, { error: "Muse 接口不存在。" });
            const target = loginStart ? `${pool}/admin/login-window` : loginStatus ? `${pool}/admin/login-window/${url.pathname.split("/").pop()}` : `${apiPath === "/v1/audio/transcriptions" ? pool : protocol}${apiPath}${url.search}`;
            const upstream = httpRequest(target, {
                method: req.method,
                headers: { ...headers, ...(req.headers["content-type"] ? { "Content-Type": req.headers["content-type"] } : {}), ...(req.headers.range ? { Range: req.headers.range } : {}) },
            }, (response) => {
                const contentType = String(response.headers["content-type"] || "application/octet-stream");
                if (!response.statusCode || response.statusCode >= 400) {
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                    response.on("end", () => {
                        const body = Buffer.concat(chunks).toString("utf8");
                        if (/no valid saved muse session/i.test(body)) return json(response.statusCode || 502, { error: { message: "Muse 新接口没有有效登录会话。请点击画布顶部 Muse，在账号旁选择“重新登录”，完成后再重试。" } });
                        res.writeHead(response.statusCode || 502, { "Content-Type": contentType, "Cache-Control": "no-store" });
                        res.end(body);
                    });
                } else if (contentType.includes("json")) {
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                    response.on("error", () => { if (!res.writableEnded) json(502, { error: "Muse 响应中断，请检查任务状态。" }); });
                    response.on("end", () => {
                        try {
                            let payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                            if (loginStart || loginStatus) {
                                const { id, status, phase, label, error, detail, hint, note } = payload;
                                payload = { id, status, phase, label, error, detail, hint, note };
                            }
                            // Keep generated media on the authenticated same-origin route.
                            const body = JSON.stringify(payload, (_key, value) => typeof value === "string" && /^(?:http:\/\/(?:localhost|127\.0\.0\.1):\d+)?\/v1\/(?:media\/|videos\/)/.test(value)
                                ? value.replace(/^(?:http:\/\/(?:localhost|127\.0\.0\.1):\d+)?\/v1\//, `${localOrigin}/muse/v1/`) : value);
                            res.writeHead(response.statusCode || 502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
                            res.end(body);
                        } catch { if (!res.writableEnded) json(502, { error: "Muse 返回了无法读取的响应。" }); }
                    });
                } else {
                    res.writeHead(response.statusCode || 502, {
                        "Content-Type": contentType, "Cache-Control": "no-store",
                        ...(response.headers["content-range"] ? { "Content-Range": response.headers["content-range"] } : {}),
                        ...(response.headers["content-length"] ? { "Content-Length": response.headers["content-length"] } : {}),
                    });
                    pipeline(response, res, () => {});
                }
            });
            upstream.on("error", () => { if (!res.headersSent) json(503, { error: "无法连接本机 Muse 服务。请确认 MuseCanvas 正在运行（Muse 面板可看状态）。" }); else res.destroy(); });
            req.on("aborted", () => upstream.destroy());
            res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
            req.pipe(upstream);
        } catch (error) {
            // 把具体原因透出去：多数情况是找不到 install.json 或 MuseCanvas 没启动，
            // 一句笼统的「请重新运行启动入口」会让人不知道去改哪里。
            if (!res.headersSent) json(503, { error: error instanceof Error ? error.message : "无法读取 MuseCanvas 配置。" });
        }
    };
}

export function museBridge(): Plugin {
    return { name: "local-muse-bridge", configureServer(server) { server.middlewares.use(createMuseBridge()); }, configurePreviewServer(server) { server.middlewares.use(createMuseBridge()); } };
}
