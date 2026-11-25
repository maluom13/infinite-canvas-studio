import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { createMuseBridge } from "./muse-bridge";

const secret = "test-local-secret";
let source: Server, bridge: Server, origin: string;
let lastRequest = { path: "", auth: "", body: "", contentType: "" };
async function listen(server: Server) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as { port: number }).port;
}
beforeAll(async () => {
    source = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        lastRequest = { path: req.url || "", auth: req.headers.authorization || "", body: Buffer.concat(chunks).toString(), contentType: req.headers["content-type"] || "" };
        if (req.url === "/v1/media/test.mp4") { res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": "bytes 0-3/4" }); res.end("MP4!"); return; }
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/admin/accounts") return res.end(JSON.stringify({ accounts: [{ id: "a", label: "Account", enabled: true, ok: true, essential_ok: true, cookies: "private-cookie" }, { id: "expired", enabled: true, essential_ok: true, expires_at: 1 }] }));
        if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "muse-image" }, { id: "muse-video" }] }));
        if (req.url === "/admin/login-window") return res.end(JSON.stringify({ id: "login-1", status: "waiting", key: secret }));
        if (req.url === "/admin/login-window/login-1") return res.end(JSON.stringify({ status: "done", label: "Account", cookie: "private-cookie" }));
        if (req.url === "/v1/videos/bad") { res.statusCode = 403; return res.end(JSON.stringify({ error: { message: "Account needs login" } })); }
        if (req.url === "/v1/videos") return res.end(JSON.stringify({ id: "video-1", status: "queued" }));
        res.end(JSON.stringify({ data: [{ url: "http://localhost:18611/v1/media/test.mp4" }] }));
    });
    const port = await listen(source);
    const middleware = createMuseBridge({ readInstallation: async () => ({ poolKey: secret, ports: { pool: port, protocol: port } }) });
    bridge = createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end(); }); });
    origin = `http://127.0.0.1:${await listen(bridge)}`;
});
afterAll(() => { source.closeAllConnections(); source.close(); bridge.closeAllConnections(); bridge.close(); });

test("status only returns safe account metadata and model capabilities", async () => {
    const text = await (await fetch(`${origin}/muse/status`)).text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("private-cookie");
    const data = JSON.parse(text);
    expect(data.accounts[0].ready).toBe(true);
    expect(data.accounts[1].ready).toBe(false);
    expect(data.models.map((m: { capability: string }) => m.capability)).toEqual(["image", "video"]);
});
test("rejects cross-origin reads, writes, missing Origin mutations and unrelated admin paths", async () => {
    for (const path of ["status", "login", "v1/images/generations"]) expect((await fetch(`${origin}/muse/${path}`, { headers: { Origin: "https://example.com" }, method: path === "status" ? "GET" : "POST" })).status).toBe(403);
    expect((await fetch(`${origin}/muse/login`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${origin}/muse/admin/accounts`)).status).toBe(404);
});
test("login and re-login forward to the service without exposing credentials", async () => {
    const reply = await fetch(`${origin}/muse/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ account_id: "a" }) });
    expect(await reply.json()).toEqual({ id: "login-1", status: "waiting" });
    expect(lastRequest.path).toBe("/admin/login-window");
    expect(lastRequest.auth).toBe(`Bearer ${secret}`);
    expect(JSON.parse(lastRequest.body)).toEqual({ account_id: "a" });
    expect(await (await fetch(`${origin}/muse/login/login-1`)).json()).toEqual({ status: "done", label: "Account" });
});
test("image request keeps input and rewrites generated media to the authenticated local route", async () => {
    const input = { model: "muse-image", prompt: "test", n: 1 };
    const reply = await fetch(`${origin}/muse/v1/images/generations`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Authorization: "Bearer local-session" }, body: JSON.stringify(input) });
    expect(JSON.parse(lastRequest.body)).toEqual(input);
    expect(lastRequest.auth).toBe(`Bearer ${secret}`);
    expect((await reply.json()).data[0].url).toBe(`${origin}/muse/v1/media/test.mp4`);
});
test("video multipart references survive forwarding", async () => {
    const form = new FormData(); form.append("model", "muse-video"); form.append("first_frame", new Blob(["image-bytes"], { type: "image/png" }), "first.png");
    const reply = await fetch(`${origin}/muse/v1/videos`, { method: "POST", headers: { Origin: origin }, body: form });
    expect((await reply.json()).id).toBe("video-1");
    expect(lastRequest.contentType).toContain("multipart/form-data; boundary=");
    expect(lastRequest.body).toContain("image-bytes");
    expect(lastRequest.body).toContain('name="first_frame"');
});
test("media streaming retains range and upstream errors remain errors", async () => {
    const media = await fetch(`${origin}/muse/v1/media/test.mp4`, { headers: { Range: "bytes=0-3" } });
    expect(media.status).toBe(206); expect(media.headers.get("content-range")).toBe("bytes 0-3/4"); expect(await media.text()).toBe("MP4!");
    const error = await fetch(`${origin}/muse/v1/videos/bad`);
    expect(error.status).toBe(403); expect((await error.json()).error.message).toBe("Account needs login");
});
