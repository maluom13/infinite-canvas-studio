import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Plugin } from "vite";

import { CODEX_HOME, projectPath } from "./runtime-paths";

const executable = process.env.CANVAS_CODEX_EXECUTABLE || process.execPath;
const cli = process.env.CANVAS_CODEX_EXECUTABLE ? [] : [projectPath("canvas-agent", "node_modules", "@openai", "codex", "bin", "codex.js")];
const run = promisify(execFile);
let pending = false;
let failure = "";

export function codexLogin(): Plugin {
    return { name: "local-codex-login", configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/local-codex/")) return next();
            const host = req.headers.host || "";
            if (!/^(127\.0\.0\.1|localhost):3010$/.test(host) || req.headers["x-canvas-local"] !== "1" || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site" || (req.method === "POST" && req.headers.origin !== `http://${host}`)) { res.writeHead(403); res.end(); return; }
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            if (req.url === "/local-codex/status" && req.method === "GET") {
                try { const { stdout, stderr } = await run(executable, [...cli, "login", "status"], { env: { ...process.env, CODEX_HOME }, windowsHide: true }); res.end(JSON.stringify({ loggedIn: /logged in/i.test(stdout + stderr) && !/not logged in/i.test(stdout + stderr), pending, error: failure })); }
                catch { res.end(JSON.stringify({ loggedIn: false, pending, error: failure })); }
                return;
            }
            if (req.url === "/local-codex/login" && req.method === "POST") {
                if (!pending) {
                    pending = true; failure = "";
                    const child = spawn(executable, [...cli, "login"], { env: { ...process.env, CODEX_HOME }, windowsHide: true, stdio: "ignore" });
                    child.once("error", () => { pending = false; failure = "无法启动 Codex 登录，请确认 Codex 已安装。"; });
                    child.once("exit", (code) => { pending = false; if (code !== 0) failure = "登录未完成，请重试。"; });
                }
                res.end(JSON.stringify({ pending })); return;
            }
            res.writeHead(404); res.end();
        });
    } };
}
