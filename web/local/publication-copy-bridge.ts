import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

import { dataPath } from "./runtime-paths";

const agentConfig = dataPath("agent", "canvas-agent.json");

/** 文案生成转发给 canvas-agent：复用 WorkBuddy 的登录态与独立 CLI home。 */
export function publicationCopyBridge(): Plugin {
    return { name: "publication-copy", configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
            if (req.url !== "/local-publication/copy") return next();
            const host = req.headers.host || "";
            const json = (status: number, data: unknown) => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); } };
            if (req.method !== "POST" || !/^(localhost|127\.0\.0\.1):3010$/.test(host) || req.headers.origin !== `http://${host}` || req.headers["x-canvas-local"] !== "1") return json(403, { error: "仅允许本机画布访问" });
            try {
                const chunks: Buffer[] = [];
                for await (const chunk of req) chunks.push(Buffer.from(chunk));
                const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { context?: unknown };
                const context = typeof input.context === "string" ? input.context.trim() : "";
                if (!context) return json(400, { error: "请先补充作品说明" });
                const config = JSON.parse(await readFile(agentConfig, "utf8")) as { url: string; token: string };
                const response = await fetch(`${config.url}/agent/workbuddy/copy?token=${encodeURIComponent(config.token)}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ context }),
                });
                const data = (await response.json()) as { ok?: boolean; copies?: unknown; error?: string };
                if (!response.ok || !data.ok || !Array.isArray(data.copies)) throw new Error(data.error || "文案生成失败");
                json(200, { copies: data.copies });
            } catch (error) { json(500, { error: error instanceof Error ? error.message : "文案生成失败" }); }
        });
    } };
}
