import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

import { dataPath } from "./runtime-paths";

/** Bootstrap only the local installation; never expose the connection token cross-origin. */
export function localAgentConnection(): Plugin {
    const install: NonNullable<Plugin["configureServer"]> = (server) => {
        server.middlewares.use(async (req, res, next) => {
            if (req.url !== "/local-agent/connection") return next();
            const host = req.headers.host || "";
            if (req.method !== "GET" || !/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers["x-canvas-local"] !== "1" || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site") {
                res.writeHead(403); res.end(); return;
            }
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            try {
                const config = JSON.parse(await readFile(dataPath("agent", "canvas-agent.json"), "utf8"));
                if (config.url !== "http://127.0.0.1:17381" || typeof config.token !== "string" || !config.token) throw new Error("Invalid local configuration");
                res.end(JSON.stringify({ url: config.url, token: config.token }));
            } catch {
                res.statusCode = 503;
                res.end(JSON.stringify({ error: "本机 Codex 连接信息尚未就绪，请运行 D 盘的 InfiniteCanvas-Start 启动入口。" }));
            }
        });
    };
    return { name: "local-agent-connection", configureServer: install };
}
