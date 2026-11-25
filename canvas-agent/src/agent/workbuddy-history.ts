import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../utils/logger.js";
import { errorMessage } from "../utils/value.js";

/** WorkBuddy 会话里的一条消息。 */
export type WorkbuddyMessage = { id: string; role: "user" | "assistant"; text: string; createdAt: number };

/** 一个 WorkBuddy 会话：id 是画布侧线程号，sessionId 是 CLI 的会话号（用于 --resume）。 */
export type WorkbuddyThread = { id: string; title: string; sessionId: string; createdAt: number; updatedAt: number; messages: WorkbuddyMessage[] };

/** 会话列表里展示的摘要。 */
export type WorkbuddyThreadSummary = { id: string; title: string; preview: string; createdAt: number; updatedAt: number; messageCount: number };

const MAX_THREADS = 60;
const MAX_MESSAGES = 200;
const DEFAULT_TITLE = "新对话";

type Store = { version: 1; threads: WorkbuddyThread[] };

let cache: Store | null = null;

/** 历史文件放在 canvas-agent 私有工作区，和 Codex 的历史互不影响。 */
function storeFile() {
    const home = process.env.CANVAS_AGENT_HOME || path.join(os.tmpdir(), "canvas-agent");
    return path.join(home, "workbuddy-history.json");
}

function load(): Store {
    if (cache) return cache;
    try {
        const data = JSON.parse(fs.readFileSync(storeFile(), "utf8")) as Store;
        cache = { version: 1, threads: Array.isArray(data.threads) ? data.threads.filter(isThread) : [] };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.debug("WorkBuddy history read failed", { error: errorMessage(error) });
        cache = { version: 1, threads: [] };
    }
    return cache;
}

function isThread(value: unknown): value is WorkbuddyThread {
    const item = value as WorkbuddyThread | undefined;
    return Boolean(item && typeof item.id === "string" && item.id && Array.isArray(item.messages));
}

/** 原子写入，避免进程中途退出留下半个 JSON。 */
function save() {
    const data = load();
    data.threads.sort((left, right) => right.updatedAt - left.updatedAt);
    data.threads = data.threads.slice(0, MAX_THREADS);
    const file = storeFile();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(data), "utf8");
        fs.renameSync(temp, file);
    } catch (error) {
        logger.warn("WorkBuddy history write failed", { error: errorMessage(error) });
    }
}

/** 只接受字母数字与常见分隔符，避免客户端传入奇怪路径。 */
function normalizeId(value: string) {
    return String(value || "").trim().replace(/[^\w:-]/g, "").slice(0, 80);
}

/** 生成一个新的画布侧会话 id。 */
export function createWorkbuddyThreadId() {
    return `wb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function listWorkbuddyThreads(): WorkbuddyThreadSummary[] {
    return load().threads.map((thread) => {
        const last = thread.messages.at(-1);
        return { id: thread.id, title: thread.title || DEFAULT_TITLE, preview: last?.text.slice(0, 80) || "", createdAt: thread.createdAt, updatedAt: thread.updatedAt, messageCount: thread.messages.length };
    });
}

export function getWorkbuddyThread(id: string): WorkbuddyThread | null {
    const key = normalizeId(id);
    return load().threads.find((thread) => thread.id === key) || null;
}

/** 找到会话，没有就建一个；标题默认取首条用户消息。 */
export function ensureWorkbuddyThread(id: string, title = "") {
    const key = normalizeId(id) || createWorkbuddyThreadId();
    const data = load();
    let thread = data.threads.find((item) => item.id === key);
    if (!thread) {
        const now = Date.now();
        thread = { id: key, title: title.trim().slice(0, 40) || DEFAULT_TITLE, sessionId: "", createdAt: now, updatedAt: now, messages: [] };
        data.threads.unshift(thread);
        save();
    } else if (title && (!thread.title || thread.title === DEFAULT_TITLE)) {
        thread.title = title.trim().slice(0, 40);
        thread.updatedAt = Date.now();
        save();
    }
    return thread;
}

/** 追加消息，按 id 去重，保留最近若干条。 */
export function appendWorkbuddyMessages(id: string, messages: Array<Omit<WorkbuddyMessage, "id" | "createdAt"> & { id?: string }>) {
    const thread = ensureWorkbuddyThread(id);
    const now = Date.now();
    for (const message of messages) {
        const text = String(message.text || "").trim();
        if (!text) continue;
        const messageId = message.id || `${thread.id}:${now}:${thread.messages.length}`;
        if (thread.messages.some((item) => item.id === messageId)) continue;
        thread.messages.push({ id: messageId, role: message.role, text, createdAt: now });
    }
    thread.messages = thread.messages.slice(-MAX_MESSAGES);
    thread.updatedAt = now;
    save();
    return thread;
}

/** 记录 CLI 会话号，下次用 --resume 接着聊。 */
export function setWorkbuddySessionId(id: string, sessionId: string) {
    const thread = ensureWorkbuddyThread(id);
    const value = String(sessionId || "").trim().slice(0, 120);
    if (!value || thread.sessionId === value) return thread;
    thread.sessionId = value;
    thread.updatedAt = Date.now();
    save();
    return thread;
}

export function deleteWorkbuddyThreads(ids: string[]) {
    const keys = new Set(ids.map(normalizeId).filter(Boolean));
    if (!keys.size) return 0;
    const data = load();
    const before = data.threads.length;
    data.threads = data.threads.filter((thread) => !keys.has(thread.id));
    save();
    return before - data.threads.length;
}
