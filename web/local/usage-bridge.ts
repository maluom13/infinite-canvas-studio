/**
 * 本地活跃记录。
 *
 * 设计原则：
 * - 不联网、不上传任何数据。所有记录只写在本机数据目录。
 * - 匿名：只有一个随机安装 ID，不含用户名、路径、账号、IP。
 * - 可关闭：环境变量 CANVAS_USAGE_DISABLED=1。
 *
 * 为什么不做「在线汇总所有使用者」：那必须有中心服务器接收上报。
 * 没有后端时，任何声称能在线看到别人活跃数的做法都不可信
 * （免费匿名计数服务要么记录 IP、要么可被任意刷数、要么随时关停）。
 * 若要在线汇总，配置 CANVAS_USAGE_ENDPOINT 指向你自己的服务即可，
 * 上报格式见 POST /usage/report 的说明。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Plugin } from "vite";

import { dataPath } from "./runtime-paths";

const USAGE_FILE = dataPath("usage", "activity.json");
const DISABLED = process.env.CANVAS_USAGE_DISABLED === "1";
const ENDPOINT = process.env.CANVAS_USAGE_ENDPOINT || "";

type Activity = {
    installId: string;
    createdAt: string;
    lastSeen: string;
    days: string[]; // 去重后的活跃日期 YYYY-MM-DD
    launches: number; // 累计启动次数
};

const empty = (): Activity => ({
    installId: `ic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    days: [],
    launches: 0,
});

async function readActivity(): Promise<Activity> {
    try {
        const data = JSON.parse(await readFile(USAGE_FILE, "utf8"));
        if (data && typeof data.installId === "string" && Array.isArray(data.days)) return data as Activity;
    } catch {
        // 读不到就当首次运行
    }
    return empty();
}

async function writeActivity(data: Activity) {
    await mkdir(dirname(USAGE_FILE), { recursive: true });
    await writeFile(USAGE_FILE, JSON.stringify(data, null, 2), "utf8");
}

/** 记录一次启动：同一天只记一个活跃日，但启动次数累加。 */
export async function recordLaunch(): Promise<Activity | null> {
    if (DISABLED) return null;
    try {
        const data = await readActivity();
        const today = new Date().toISOString().slice(0, 10);
        if (!data.days.includes(today)) data.days.push(today);
        data.launches += 1;
        data.lastSeen = new Date().toISOString();
        await writeActivity(data);

        // 可选上报：只有配了自己的服务端才发。失败静默，不影响画布。
        if (ENDPOINT) {
            try {
                await fetch(ENDPOINT, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ installId: data.installId, date: today }),
                    signal: AbortSignal.timeout(5000),
                });
            } catch {
                // 上报失败不影响本地记录
            }
        }
        return data;
    } catch {
        return null;
    }
}

export function usageBridge(): Plugin {
    const middleware = () => async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url || "/", "http://localhost");
        const json = (code: number, body: unknown) => {
            res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(body));
        };

        if (url.pathname === "/usage/local" && req.method === "GET") {
            if (DISABLED) return json(200, { enabled: false, note: "本地活跃记录已关闭（CANVAS_USAGE_DISABLED=1）" });
            try {
                const data = await readActivity();
                return json(200, {
                    enabled: true,
                    installId: data.installId,
                    createdAt: data.createdAt,
                    lastSeen: data.lastSeen,
                    activeDays: data.days.length,
                    launches: data.launches,
                    reporting: ENDPOINT ? "configured" : "off",
                    note: ENDPOINT ? "已配置上报端点" : "仅本机记录，未联网上传",
                });
            } catch (error) {
                return json(500, { error: error instanceof Error ? error.message : "读取失败" });
            }
        }

        // 首次打开画布时由前端调用一次，写当天活跃记录
        if (url.pathname === "/usage/ping" && req.method === "POST") {
            if (DISABLED) return json(200, { ok: true, skipped: true });
            const data = await recordLaunch();
            return json(200, { ok: Boolean(data), skipped: !data });
        }

        next();
    };

    return {
        name: "local-usage-bridge",
        configureServer(server) { server.middlewares.use(middleware()); },
        configurePreviewServer(server) { server.middlewares.use(middleware()); },
    };
}
