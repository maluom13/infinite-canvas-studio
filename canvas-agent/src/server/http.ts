import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";

import { interruptCodebuddyTurn, listCodebuddyModels, openCodebuddyLogin, readCodebuddyStatus, runCodebuddyText, runCodebuddyTurn } from "../agent/codebuddy.js";
import { appendWorkbuddyMessages, createWorkbuddyThreadId, deleteWorkbuddyThreads, ensureWorkbuddyThread, getWorkbuddyThread, listWorkbuddyThreads, setWorkbuddySessionId } from "../agent/workbuddy-history.js";
import { runClaudeTurn } from "../agent/claude.js";
import { archiveCodexThread, CodexSkillLookupError, configureCodexSkill, generateCodexSkillDraft, interruptCodexTurn, isRecoverableThreadError, listCodexModels, listCodexSkills, listCodexThreads, readCodexThread, resolveCodexApproval, resolveCodexSkill, resumeCodexThread, runCodexTurn, startCodexThread, summarizeCodexThread } from "../agent/codex.js";
import type { CodexReasoningEffort, CodexSkillSelector } from "../agent/codex-protocol.js";
import { messageMetadataStore } from "../agent/message-metadata.js";
import type { AgentAttachment, AgentPermissionMode } from "../agent/types.js";
import { AGENT_PROTOCOL_VERSION, CanvasSession } from "../canvas/session.js";
import { DEFAULT_PORT, ensureSiteWorkspace, loadConfig, saveConfig, updateSiteWorkspace, type CanvasAgentConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { checkVersions } from "../version-check.js";
import { SkillStore, SkillStoreError } from "../skills/store.js";

/** 启动仅监听本机的 Canvas Agent HTTP 服务。 */
export function startHttpServer() {
    const config = loadConfig(true);
    const port = Number(process.env.PORT) || Number(new URL(config.url).port) || DEFAULT_PORT;
    config.url = `http://127.0.0.1:${port}`;
    saveConfig(config);

    const initialWorkspace = ensureSiteWorkspace(config);
    const session = new CanvasSession(initialWorkspace.activeThreadId || "");
    const skillStore = new SkillStore(initialWorkspace.workspacePath);
    /** 将 Agent 事件广播到所属线程或全部网页。 */
    const emit = (type: string, payload: unknown) => {
        const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
        if (type === "skills_changed") {
            session.emitAll(type, value);
            return;
        }
        if (type === "agent_bootstrap" && value.phase === "preheat") {
            if (value.type === "mcp.startup") session.updateConversationMcp(String(value.name || ""), startupStatus(value.status), String(value.error || "") || null, String(value.failureReason || "") || null);
            if (value.type === "mcp.complete") session.completeConversationMcpInventory(mcpInventory(value.services));
        }
        const scope = session.codexBusy ? session.codexEventScope : { threadId: "", turnId: "", sourceClientId: "" };
        const threadId = String(value.threadId || value.thread_id || scope.threadId || ensureSiteWorkspace(config).activeThreadId || "");
        const turnId = String(value.turnId || value.turn_id || scope.turnId || "");
        const sourceClientId = String(value.sourceClientId || scope.sourceClientId || "");
        const data = {
            ...value,
            ...(threadId ? { threadId, thread_id: threadId } : {}),
            ...(turnId ? { turnId, turn_id: turnId } : {}),
            ...(sourceClientId ? { sourceClientId } : {}),
        };
        session.trackCodexEvent(type, data);
        threadId ? session.emitThread(type, threadId, data) : session.emitAll(type, data);
    };
    /** 保存并广播当前站点工作空间的活跃线程。 */
    const setActiveThread = (activeThreadId: string, payload: Record<string, unknown> = {}, preserveConversation = false) => {
        const workspace = updateSiteWorkspace(config, { activeThreadId: activeThreadId || undefined });
        if (!preserveConversation) session.activateConversation(activeThreadId, String(payload.sourceClientId || "") || undefined);
        if (!session.codexBusy && session.codexThreadId !== activeThreadId) session.setCodexState({ threadId: activeThreadId, turnId: "" });
        session.emitThread("workspace_changed", activeThreadId, { ...payload, activeThreadId, conversation: session.conversationStateSnapshot });
        return workspace;
    };
    let draftThreadStart: ReturnType<typeof startCodexThread> | null = null;
    let skillDraftRunning = false;
    const prepareDraftThread = (clientId: string, permission: AgentPermissionMode) => {
        if (draftThreadStart) return draftThreadStart;
        const workspace = ensureSiteWorkspace(config);
        let prepared!: ReturnType<typeof startCodexThread>;
        prepared = (async () => {
            emit("agent_bootstrap", { type: "codex.preparing", sourceClientId: clientId });
            try {
                const thread = await startCodexThread(emit, workspace.workspacePath, permission, true);
                if (draftThreadStart !== prepared) return thread;
                const threadId = String((thread as Record<string, unknown>).id || "");
                if (threadId && !ensureSiteWorkspace(config).activeThreadId) {
                    session.completeConversationPreparation(threadId);
                    setActiveThread(threadId, { emptyThread: true, draftThread: true, sourceClientId: clientId }, true);
                }
                return thread;
            } catch (error) {
                if (draftThreadStart === prepared) {
                    const text = error instanceof Error ? error.message : String(error);
                    session.failConversationPreparation(text);
                    emit("agent_bootstrap", { type: "codex.prepare_failed", sourceClientId: clientId, error: text });
                }
                throw error;
            } finally {
                if (draftThreadStart === prepared) draftThreadStart = null;
            }
        })();
        draftThreadStart = prepared;
        return prepared;
    };
    /** 恢复已有线程并等待完整 MCP 清单，供启动恢复和手动切换共用。 */
    const prepareExistingThread = async (threadId: string, clientId = "", permission: AgentPermissionMode = "request") => {
        const workspace = ensureSiteWorkspace(config);
        session.beginConversation({ conversationId: threadId, threadId, sourceClientId: clientId || undefined });
        emit("agent_bootstrap", { type: "codex.preparing", threadId, sourceClientId: clientId || undefined });
        const result = await resumeCodexThread(emit, threadId, workspace.workspacePath, permission, true);
        session.completeConversationPreparation(threadId);
        return result;
    };
    const failPreparedConversation = (error: unknown, threadId: string, clientId = "") => {
        const text = error instanceof Error ? error.message : String(error);
        session.failConversationPreparation(text);
        emit("agent_bootstrap", { type: "codex.prepare_failed", threadId, sourceClientId: clientId || undefined, error: text });
    };
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "30mb" }));
    app.use((req, res, next) => {
        if (!logger.enabled) return next();
        const startedAt = Date.now();
        const url = requestUrl(req, config);
        res.on("finish", () => {
            if (req.method === "OPTIONS" || (res.statusCode < 400 && ["/health", "/canvas/state", "/canvas/activate"].includes(url.pathname))) return;
            logger.debug(`HTTP ${req.method} ${url.pathname}`, { status: res.statusCode, durationMs: Date.now() - startedAt });
        });
        next();
    });
    app.use((req, res, next) => {
        const url = requestUrl(req, config);
        if (!setCors(req, res, url, config)) return void res.status(403).json({ ok: false, error: "origin not allowed" });
        if (req.method === "OPTIONS") return void res.json({});
        next();
    });
    app.get("/health", (_req, res) => {
        // /health 不校验 token，只暴露连通性信息；WorkBuddy 账号、CLI 路径、线程 ID 走带 token 的 /agent/workbuddy/status。
        const { ok, protocolVersion, hasCanvas, clients, codexBusy } = session.health();
        res.json({ ok, protocolVersion, hasCanvas, clients, codexBusy });
    });
    app.get("/config", (_req, res) => res.json({ ok: true, protocolVersion: AGENT_PROTOCOL_VERSION, url: config.url, hasToken: true }));
    app.use((req, res, next) => {
        if (validToken(req, requestUrl(req, config), config.token)) return next();
        res.status(401).json({ ok: false, error: "invalid token" });
    });
    app.get("/events", (req, res) => {
        session.openEvents(requestUrl(req, config), res, ensureSiteWorkspace(config).activeThreadId || "");
    });
    app.post("/canvas/state", (req, res) => {
        session.updateState(req.body, String(req.query.clientId || "") || undefined);
        res.json({ ok: true });
    });
    app.get("/canvas/clients", route(async (_req, res) => {
        res.json({ ok: true, ...session.canvasClients() });
    }));
    app.post("/canvas/activate", (req, res) => {
        session.activateClient(String(req.query.clientId || ""));
        res.json({ ok: true });
    });
    app.post("/canvas/result", (req, res) => {
        // 没有 JSON body 时 req.body 是 undefined，直接取字段会抛 TypeError 变成 500。
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const ok = session.resolveResult(String(req.query.clientId || ""), body);
        res.status(ok ? 200 : 409).json({ ok });
    });
    app.get("/agent/attachments/:attachmentId", route(async (req, res) => {
        const attachment = session.getTurnAttachment(String(req.query.clientId || ""), routeParam(req.params.attachmentId));
        const data = attachment.dataUrl.split(",", 2)[1];
        if (!data) throw new Error("图片附件内容无效");
        res.setHeader("Cache-Control", "no-store");
        res.type(attachment.type).send(Buffer.from(data, "base64"));
    }));
    app.get("/agent/message-assets/:messageKey/:assetFile", route(async (req, res) => {
        const asset = await messageMetadataStore.readAsset(routeParam(req.params.messageKey), routeParam(req.params.assetFile));
        if (!asset) return void res.status(404).json({ ok: false, error: "message asset not found" });
        res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        res.type(asset.contentType).send(asset.data);
    }));
    app.post("/agent/local-file/reveal", route(async (req, res) => {
        const filePath = String(req.body?.path || "");
        if (!path.isAbsolute(filePath)) return res.status(400).json({ ok: false, error: "文件路径必须是绝对路径" });
        const file = await stat(filePath);
        await revealLocalFile(filePath, file.isDirectory());
        res.json({ ok: true });
    }));
    app.post("/agent/local-image", route(async (req, res) => {
        const filePath = String(req.body?.path || "");
        if (!path.isAbsolute(filePath) || !/\.(?:avif|gif|jpe?g|png|webp)$/i.test(filePath)) return res.status(400).json({ ok: false, error: "图片路径无效" });
        const file = await stat(filePath);
        if (!file.isFile()) return res.status(400).json({ ok: false, error: "图片文件无效" });
        res.setHeader("Cache-Control", "no-store");
        res.type(path.extname(filePath)).send(await readFile(filePath));
    }));
    app.post("/api/tools", route(async (req, res) => res.json({ ok: true, result: await session.callTool(req.body?.name, req.body?.input || {}) })));
    app.get("/agent/codex/workspace", (_req, res) => {
        const workspace = ensureSiteWorkspace(config);
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot });
    });
    app.get("/agent/codex/models", route(async (_req, res) => res.json({ ok: true, ...(await listCodexModels(emit)) })));
    app.get("/agent/codex/skills", route(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const result = await listCodexSkills(emit, workspace.workspacePath, String(req.query.forceReload || "") === "1");
        res.json({ ok: true, data: result.skills.map((skill) => ({ ...skill, managed: skillStore.isManagedPath(skill.path) })), errors: result.errors });
    }));
    app.post("/agent/codex/skills/draft", codexMutation(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const source = String(req.body?.source || "");
        if (source !== "conversation" && source !== "canvas") return res.status(400).json({ ok: false, error: "Skill 草稿来源无效" });
        const clientId = String(req.body?.clientId || "");
        if (!clientId || !session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开，请重新连接后再试" });
        const model = String(req.body?.model || "") || undefined;
        const effort = reasoningEffort(req.body?.effort);
        const previousCodexState = session.codexStateSnapshot;
        skillDraftRunning = true;
        try {
            if (source === "conversation") {
                const threadId = String(req.body?.threadId || "");
                if (!threadId) return res.status(409).json({ ok: false, error: "当前没有可提炼的对话" });
                if (threadId !== (workspace.activeThreadId || "")) return res.status(409).json({ ok: false, error: "当前对话已在其他页面切换，请同步后重试" });
                const history = await readCodexThread(emit, threadId, workspace.workspacePath);
                if (!history.messages.some((message) => message.role === "user" && message.turnId)) return res.status(409).json({ ok: false, error: "当前对话还没有可提炼的已完成内容" });
                session.setCodexState({ busy: true, threadId, turnId: "" }, { preserveReplay: true });
                const data = await generateCodexSkillDraft(emit, workspace.workspacePath, { source, threadId, model, effort });
                if (!session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开，请重新连接后再试" });
                return res.json({ ok: true, data });
            }
            const snapshot = session.canvasStateForClient(clientId);
            if (!snapshot || (snapshot as Record<string, unknown>).hasCanvas === false) return res.status(409).json({ ok: false, error: "当前页面没有可提炼的画布" });
            session.setCodexState({ busy: true, threadId: workspace.activeThreadId || "", turnId: "" }, { preserveReplay: true });
            const data = await generateCodexSkillDraft(emit, workspace.workspacePath, { source, snapshot, model, effort });
            if (!session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起提炼的网页已断开，请重新连接后再试" });
            return res.json({ ok: true, data });
        } finally {
            skillDraftRunning = false;
            session.setCodexState(previousCodexState, { preserveReplay: true });
        }
    }));
    app.get("/agent/codex/skills/:name", route(async (req, res) => {
        res.json({ ok: true, data: await skillStore.get(routeParam(req.params.name)) });
    }));
    app.post("/agent/codex/skills", codexMutation(async (req, res) => {
        const data = await skillStore.create(req.body);
        session.emitAll("skills_changed", { forceReload: true });
        res.status(201).json({ ok: true, data });
    }));
    app.post("/agent/codex/skills/:name/enabled", codexMutation(async (req, res) => {
        if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ ok: false, error: "Skill 启用状态无效" });
        const workspace = ensureSiteWorkspace(config);
        const selector = skillSelector(req.body);
        if (selector.name !== routeParam(req.params.name)) return res.status(400).json({ ok: false, error: "Skill 选择无效" });
        const data = await configureCodexSkill(emit, workspace.workspacePath, selector, req.body.enabled);
        session.emitAll("skills_changed", { forceReload: true });
        res.json({ ok: true, data });
    }));
    app.post("/agent/codex/skills/:name/delete", codexMutation(async (req, res) => {
        await skillStore.delete(routeParam(req.params.name), String(req.body?.expectedRevision || ""));
        session.emitAll("skills_changed", { forceReload: true });
        res.json({ ok: true });
    }));
    app.post("/agent/codex/skills/:name", codexMutation(async (req, res) => {
        const data = await skillStore.update(routeParam(req.params.name), req.body);
        session.emitAll("skills_changed", { forceReload: true });
        res.json({ ok: true, data });
    }));
    app.get("/agent/codex/threads", route(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const result = await listCodexThreads(emit, { cwd: workspace.workspacePath, searchTerm: String(req.query.searchTerm || "") });
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot, ...result });
    }));
    app.post("/agent/codex/threads/new", codexMutation(async (req, res) => {
        const clientId = String(req.body?.clientId || "");
        session.beginConversation({ sourceClientId: clientId });
        setActiveThread("", { emptyThread: true, draftThread: true, sourceClientId: clientId }, true);
        const thread = await prepareDraftThread(clientId, permissionMode(req.body?.permissionMode));
        res.json({ ok: true, workspace: ensureSiteWorkspace(config), conversation: session.conversationStateSnapshot, thread: summarizeCodexThread(thread), messages: [] });
    }));
    app.post("/agent/codex/threads/reset", codexMutation(async (req, res) => {
        const clientId = String(req.body?.clientId || "");
        session.beginConversation({ sourceClientId: clientId });
        setActiveThread("", { emptyThread: true, draftThread: true, sourceClientId: clientId }, true);
        await prepareDraftThread(clientId, permissionMode(req.body?.permissionMode));
        res.json({ ok: true, workspace: ensureSiteWorkspace(config), conversation: session.conversationStateSnapshot });
    }));
    app.get("/agent/codex/threads/:threadId", route(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const threadId = routeParam(req.params.threadId);
        res.json({ ok: true, workspace, conversation: session.conversationStateSnapshot, ...(await readCodexThread(emit, threadId, workspace.workspacePath)) });
    }));
    app.post("/agent/codex/history/ack", (req, res) => {
        const threadId = String(req.body?.threadId || "");
        const turnIds = Array.isArray(req.body?.turnIds) ? req.body.turnIds.map(String) : [];
        session.acknowledgeCodexHistory(threadId, turnIds);
        res.json({ ok: true });
    });
    app.post("/agent/codex/threads/:threadId/resume", codexMutation(async (req, res) => {
        const threadId = routeParam(req.params.threadId);
        const clientId = String(req.body?.clientId || "");
        try {
            const result = await prepareExistingThread(threadId, clientId, permissionMode(req.body?.permissionMode));
            const nextWorkspace = setActiveThread(threadId, { sourceClientId: clientId }, true);
            res.json({ ok: true, workspace: nextWorkspace, conversation: session.conversationStateSnapshot, ...result });
        } catch (error) {
            failPreparedConversation(error, threadId, clientId);
            throw error;
        }
    }));
    app.post("/agent/codex/threads/:threadId/delete", codexMutation(async (req, res) => {
        const workspace = ensureSiteWorkspace(config);
        const threadId = routeParam(req.params.threadId);
        await archiveCodexThread(emit, threadId, workspace.workspacePath);
        const nextWorkspace = setActiveThread(workspace.activeThreadId === threadId ? "" : workspace.activeThreadId || "", { sourceClientId: String(req.body?.clientId || "") });
        res.json({ ok: true, workspace: nextWorkspace, conversation: session.conversationStateSnapshot });
    }));
    app.post("/agent/codex/turn", codexMutation(async (req, res) => {
        const attachments = Array.isArray(req.body?.attachments) ? (req.body.attachments as AgentAttachment[]) : [];
        const workspace = ensureSiteWorkspace(config);
        const prompt = String(req.body?.prompt || "");
        if (!prompt.trim()) return res.status(400).json({ ok: false, error: "请输入任务内容" });
        const clientId = String(req.body?.clientId || "");
        if (!clientId || !session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起任务的网页已断开，请重新连接后再试" });
        const requestedThreadId = String(req.body?.threadId || "");
        const activeThreadId = workspace.activeThreadId || "";
        const conversation = session.conversationStateSnapshot;
        const requestedConversationId = String(req.body?.conversationId || "");
        const expectedRevision = Number(req.body?.expectedRevision || 0);
        if (requestedThreadId !== activeThreadId || conversation.threadId !== activeThreadId || (requestedConversationId && requestedConversationId !== conversation.conversationId) || (expectedRevision && expectedRevision !== conversation.revision)) {
            return res.status(409).json({ ok: false, code: "CONVERSATION_STALE", error: "当前会话已切换，已同步最新状态，请确认后重试", state: conversation });
        }
        if (!activeThreadId || !["ready", "warning"].includes(conversation.status)) {
            return res.status(409).json({ ok: false, code: "CONVERSATION_NOT_READY", error: "Codex 对话仍在初始化，请等待 MCP 加载完成", state: conversation });
        }
        const model = String(req.body?.model || "") || undefined;
        const effort = reasoningEffort(req.body?.effort);
        const skill = req.body?.skill === undefined ? undefined : await resolveCodexSkill(emit, workspace.workspacePath, skillSelector(req.body.skill), true);
        const messageId = String(req.body?.messageId || Date.now());
        const messageText = String(req.body?.messageText || prompt || `发送了 ${attachments.length} 张图片`);
        const messageMetadata = await messageMetadataStore.recordPending(messageId, req.body?.messageMetadata);
        let threadId = activeThreadId;
        logger.info("Codex turn accepted", { threadId: req.body?.threadId, model: model || "default", reasoningEffort: effort || "default", promptLength: prompt.length, attachmentCount: attachments.length });
        session.bindClient(clientId);
        session.markConversationRunning(threadId);
        session.setCodexState({ busy: true, threadId, turnId: "" });
        try {
            let turnId = "";
            const attachmentRefs = session.setTurnAttachments(clientId, attachments);
            session.emitThread("chat_message", threadId, {
                sourceClientId: clientId,
                message: { id: `${threadId}:pending:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId: "", role: "user", text: messageText, ...messageMetadata },
            });
            let chatTurnId = "";
            /** 将包装层日志和兜底错误固定广播到当前 turn。 */
            const lifecycleEmit = (type: string, payload: unknown) => {
                const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : { value: payload };
                const eventThreadId = String(value.threadId || value.thread_id || threadId);
                const eventTurnId = String(value.turnId || value.turn_id || turnId);
                const sourceClientId = String(value.sourceClientId || clientId);
                session.emitThread(type, eventThreadId, {
                    ...value,
                    threadId: eventThreadId,
                    thread_id: eventThreadId,
                    ...(eventTurnId ? { turnId: eventTurnId, turn_id: eventTurnId } : {}),
                    ...(sourceClientId ? { sourceClientId } : {}),
                });
            };
            void runCodexTurn(withAttachmentContext(prompt, attachmentRefs), lifecycleEmit, attachments, {
                threadId,
                cwd: workspace.workspacePath,
                permissionMode: permissionMode(req.body?.permissionMode),
                model,
                effort,
                ...(skill ? { skill: { name: skill.name, path: skill.path } } : {}),
                messageText,
                appEmit: emit,
                onStart: () => session.bindClient(clientId),
                onThread: (actualThreadId) => {
                    const threadChanged = actualThreadId !== threadId;
                    void messageMetadataStore.bindThread(messageId, actualThreadId).catch((error) => logger.warn("Failed to bind message metadata to thread", { clientMessageId: messageId, threadId: actualThreadId, error }));
                    if (actualThreadId !== threadId) {
                        threadId = actualThreadId;
                        setActiveThread(threadId, { emptyThread: true, sourceClientId: clientId });
                    }
                    session.markConversationRunning(threadId);
                    session.setCodexState({ busy: true, threadId, turnId: "" });
                    if (threadChanged) {
                        session.emitThread("chat_message", threadId, {
                            sourceClientId: clientId,
                            message: { id: `${threadId}:pending:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId: "", role: "user", text: messageText, ...messageMetadata },
                        });
                    }
                },
                onTurn: (actualTurnId) => {
                    turnId = actualTurnId;
                    void messageMetadataStore.bindTurn(messageId, threadId, turnId).catch((error) => logger.warn("Failed to bind message metadata to turn", { clientMessageId: messageId, threadId, turnId, error }));
                    if (chatTurnId !== turnId) {
                        chatTurnId = turnId;
                        session.emitThread("chat_message", threadId, {
                            turnId,
                            sourceClientId: clientId,
                            message: { id: `${threadId}:${turnId}:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId, role: "user", text: messageText, ...messageMetadata },
                        });
                    }
                    logger.info("Codex turn started", { threadId, turnId, model: model || "default", reasoningEffort: effort || "default" });
                    session.setCodexState({ busy: true, threadId, turnId });
                },
                onFinish: () => {
                    logger.info("Codex turn finished", { threadId, turnId });
                    if (!turnId) void messageMetadataStore.remove(messageId, threadId).catch((error) => logger.warn("Failed to remove unbound message metadata", { clientMessageId: messageId, error }));
                    session.clearTurnAttachments(clientId);
                    if (clientId) session.releaseClient(clientId);
                    session.setCodexState({ busy: false, threadId, turnId });
                    session.finishConversationRun(threadId);
                },
            });
            res.json({ ok: true, threadId });
        } catch (error) {
            await messageMetadataStore.remove(messageId, threadId).catch((metadataError) => logger.warn("Failed to remove rejected message metadata", { clientMessageId: messageId, error: metadataError }));
            session.releaseClient(clientId);
            session.setCodexState({ busy: false, threadId, turnId: "" });
            session.finishConversationRun(threadId);
            throw error;
        }
    }));

    /** 将 Codex 写操作串行化，避免多窗口在异步请求期间交叉修改会话。 */
    function codexMutation(handler: (req: Request, res: Response) => unknown | Promise<unknown>) {
        return route(async (req, res) => {
            if (!session.beginCodexMutation()) return res.status(409).json({ ok: false, code: "CONVERSATION_BUSY", error: "Codex 正在运行或正在切换会话，请稍后重试", state: session.conversationStateSnapshot });
            try {
                return await handler(req, res);
            } finally {
                session.endCodexMutation();
            }
        });
    }
    app.post("/agent/codex/approval", route(async (req, res) => {
        const decision = String(req.body?.decision || "");
        if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return res.status(400).json({ ok: false, error: "无效的审批决定" });
        const ok = await resolveCodexApproval(String(req.body?.requestId || ""), decision);
        res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "审批请求已失效" }) });
    }));
    app.post("/agent/codex/interrupt", route(async (req, res) => {
        const ok = await interruptCodexTurn(skillDraftRunning ? undefined : String(req.body?.threadId || ""));
        res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "当前没有可停止的任务" }) });
    }));
    app.post("/agent/claude/turn", (req, res) => {
        runClaudeTurn(String(req.body?.prompt || ""), emit);
        res.json({ ok: true });
    });
    app.get("/agent/workbuddy/status", route(async (req, res) => {
        res.json({ ok: true, ...readCodebuddyStatus(String(req.query.probe || "") === "1") });
    }));
    app.get("/agent/workbuddy/models", route(async (_req, res) => {
        res.json({ ok: true, data: await listCodebuddyModels() });
    }));
    app.post("/agent/workbuddy/copy", route(async (req, res) => {
        const context = String(req.body?.context || "").trim().slice(0, 3000);
        if (!context) return res.status(400).json({ ok: false, error: "请先补充作品说明" });
        const prompt = [
            "你是资深短视频运营，熟悉 2026 年抖音、快手、视频号的推荐机制。根据作品说明，为三个平台各写一份发布文案。",
            "",
            "硬性规则：",
            "1. hook（前3秒钩子）：必须用冲突、悬念、结果前置或痛点提问开场，口语化，20-40 字；不要自我介绍、不要铺垫、不要“大家好”。",
            "2. title（标题）：必须给出点击理由（人群/场景 + 收益/反差/数字），禁止平铺直叙的描述型标题，例如“冬天出门怎么穿才够暖”不合格；可改成“零下10度只穿3件，出门反而更暖？”这类有钩子的写法。",
            "3. description（简介）：痛点或场景 → 内容看点 → 一句互动引导（提问或“收藏起来”），自然埋 1-2 个用户会搜索的关键词；2-3 句，不用 emoji 堆砌。",
            "4. tags（标签）：3-5 个，组合为「1 个大类词 + 2 个精准垂类词 + 1 个场景/人群词」；禁止“原片素材、视频、日常、分享、生活记录”这类泛标签；不带 #。",
            "5. coverText（封面大字）：≤10 字，高对比、制造好奇或利益点，不要重复标题。",
            "6. bestTime（建议发布时间）：按平台给一个时间段。",
            "",
            "平台差异：",
            "- douyin：公域赛马，3-5 秒留存最重要；节奏快、利益点前置、可带数字；标题 ≤24 字；避免纯标题党。bestTime 19:00-22:00。",
            "- kuaishou：普惠+关系，口语接地气，像和家人们聊天，突出真实经验/本地/圈层；不要过度戏剧化；标题 ≤20 字。bestTime 20:00-23:00。",
            "- tencent：社交推荐为主，克制、有价值、适合熟人转发；不要夸张标题党；标题 ≤16 字。bestTime 12:00-13:00 或 20:00-22:00。",
            "",
            "底线：不得虚构作品说明里没有的剧情、对白、人物身份、数据、获奖或热点；信息不足时写得克制，不编造。",
            "只输出一个 JSON 对象，不要解释、不要 markdown 代码块，格式：",
            '{"copies":[{"platform":"douyin","title":"","description":"","tags":[""],"hook":"","coverText":"","bestTime":""},{"platform":"kuaishou","title":"","description":"","tags":[""],"hook":"","coverText":"","bestTime":""},{"platform":"tencent","title":"","description":"","tags":[""],"hook":"","coverText":"","bestTime":""}]}',
            "",
            "作品说明：",
            context,
        ].join("\n");
        try {
            const text = await runCodebuddyText(prompt, 120000);
            const copies = parsePublicationCopies(text);
            if (!copies) return res.status(502).json({ ok: false, error: "模型没有返回完整的三平台文案，请重试" });
            res.json({ ok: true, copies });
        } catch (error) {
            res.status(502).json({ ok: false, error: error instanceof Error ? error.message : "文案生成失败" });
        }
    }));
    app.post("/agent/workbuddy/login", route(async (_req, res) => {
        try {
            const url = await openCodebuddyLogin();
            res.json({ ok: true, url });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("Failed to open WorkBuddy login page", { error: message });
            res.status(500).json({ ok: false, error: message || "无法打开 WorkBuddy 登录页" });
        }
    }));
    app.post("/agent/workbuddy/interrupt", route(async (_req, res) => {
        const ok = interruptCodebuddyTurn();
        res.status(ok ? 200 : 409).json({ ok, ...(ok ? {} : { error: "当前没有正在运行的 WorkBuddy 任务" }) });
    }));
    app.get("/agent/workbuddy/threads", route(async (_req, res) => {
        res.json({ ok: true, data: listWorkbuddyThreads() });
    }));
    app.get("/agent/workbuddy/threads/:threadId", route(async (req, res) => {
        const thread = getWorkbuddyThread(routeParam(req.params.threadId));
        if (!thread) return res.status(404).json({ ok: false, error: "会话不存在或已删除" });
        res.json({ ok: true, thread });
    }));
    app.post("/agent/workbuddy/threads/delete", route(async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [String(req.body?.id || "")];
        const removed = deleteWorkbuddyThreads(ids.filter(Boolean));
        res.json({ ok: true, removed });
    }));
    app.post("/agent/workbuddy/turn", route(async (req, res) => {
        const prompt = String(req.body?.prompt || "");
        if (!prompt.trim()) return res.status(400).json({ ok: false, error: "请输入任务内容" });
        const clientId = String(req.body?.clientId || "");
        if (!clientId || !session.hasClient(clientId)) return res.status(409).json({ ok: false, error: "发起任务的网页已断开，请重新连接后再试" });
        const workspace = ensureSiteWorkspace(config);
        const messageId = String(req.body?.messageId || Date.now());
        const messageText = String(req.body?.messageText || prompt);
        // 会话 id 由前端维护；没传就开一个新的，历史记录会按它归组
        const threadId = ensureWorkbuddyThread(String(req.body?.threadId || "") || createWorkbuddyThreadId(), messageText).id;
        const thread = getWorkbuddyThread(threadId);
        appendWorkbuddyMessages(threadId, [{ id: messageId, role: "user", text: messageText }]);
        session.bindClient(clientId);
        session.emitThread("chat_message", threadId, {
            sourceClientId: clientId,
            message: { id: `${threadId}:pending:synthetic:user`, itemId: "synthetic:user", clientMessageId: messageId, threadId, turnId: "", role: "user", text: messageText },
        });
        logger.info("WorkBuddy turn accepted", { threadId, model: String(req.body?.model || "default"), promptLength: prompt.length, resume: Boolean(thread?.sessionId) });
        void runCodebuddyTurn(prompt, emit, {
            cwd: workspace.workspacePath,
            model: String(req.body?.model || "") || undefined,
            permissionMode: String(req.body?.permissionMode || ""),
            messageText,
            threadId,
            resumeSessionId: thread?.sessionId || undefined,
            onSession: (sessionId) => setWorkbuddySessionId(threadId, sessionId),
            onAnswer: (text) => appendWorkbuddyMessages(threadId, [{ role: "assistant", text }]),
        })
            .catch((error) => logger.error("WorkBuddy turn failed", { error }))
            .finally(() => session.releaseClient(clientId));
        res.json({ ok: true, threadId });
    }));
    app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));
    app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
        logger.error("HTTP request failed", { method: req.method, path: req.path, error });
        if (error instanceof SkillStoreError || error instanceof CodexSkillLookupError) return void res.status(error.statusCode).json({ ok: false, error: error.message });
        // body-parser 的 400/413 等错误自带 status，不能一律当成 500。
        res.status(Number((error as { status?: number }).status) || 500).json({ ok: false, error: error.message });
    });

    app.listen(port, "127.0.0.1", () => {
        console.log("Infinite Canvas Agent");
        checkVersions();
        console.log(`Local URL: ${config.url}`);
        console.log(`Connect token: ${config.token}`);
        console.log("Codex MCP is not installed by this command.");
        console.log("Optional MCP add: codex mcp add infinite-canvas -- npx -y @basketikun/canvas-agent@latest mcp");
        console.log("Remove manually added MCP: codex mcp remove infinite-canvas");
        if (logger.enabled) console.log(`Debug log: ${logger.filePath}`);
        logger.info("Canvas Agent started", { url: config.url, workspace: ensureSiteWorkspace(config).workspacePath, debugLog: logger.filePath });
        const activeThreadId = initialWorkspace.activeThreadId || "";
        if (activeThreadId && session.beginCodexMutation()) {
            void prepareExistingThread(activeThreadId).catch(async (error) => {
                if (!isRecoverableThreadError(error)) return failPreparedConversation(error, activeThreadId);
                session.beginConversation();
                setActiveThread("", { emptyThread: true, draftThread: true }, true);
                await prepareDraftThread("", "request");
            }).finally(() => session.endCodexMutation()).catch(() => undefined);
        }
    });
}

/** 将异步 Express 路由异常交给统一错误处理中间件。 */
function route(handler: (req: Request, res: Response) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
}

/** 从 Express 路由参数中读取单个字符串。 */
function routeParam(value: string | string[]) {
    return Array.isArray(value) ? value[0] || "" : value;
}

function permissionMode(value: unknown): AgentPermissionMode {
    return value === "automatic" || value === "full" ? value : "request";
}

function reasoningEffort(value: unknown): CodexReasoningEffort | undefined {
    return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra" ? value : undefined;
}

function startupStatus(value: unknown): "starting" | "ready" | "failed" | "cancelled" {
    return value === "starting" || value === "ready" || value === "failed" ? value : "cancelled";
}

function mcpInventory(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const server = item as Record<string, unknown>;
        const name = String(server.name || "");
        return name ? [{ name, authStatus: String(server.authStatus || "") || undefined }] : [];
    });
}

/** 读取浏览器提交的 Skill 选择器；真实路径随后必须通过原生列表校验。 */
function skillSelector(value: unknown): CodexSkillSelector {
    const selector = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const name = typeof selector.name === "string" ? selector.name : "";
    const skillPath = typeof selector.path === "string" ? selector.path : "";
    if (!name || !skillPath) throw new CodexSkillLookupError("Skill 选择无效", 400);
    return { name, path: skillPath };
}

/** 使用当前操作系统的文件管理器定位本地文件。 */
function revealLocalFile(filePath: string, isDirectory: boolean) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    const args = process.platform === "darwin"
        ? ["-R", filePath]
        : process.platform === "win32"
            ? [isDirectory ? filePath : `/select,${filePath}`]
            : [isDirectory ? filePath : path.dirname(filePath)];
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
        child.once("error", reject);
    });
}

/** 结合服务配置解析当前请求 URL。 */
function requestUrl(req: Request, config: CanvasAgentConfig) {
    return new URL(req.originalUrl || req.url || "/", config.url);
}

/** 设置跨域响应头并记录通过 token 授权的来源。 */
function setCors(req: Request, res: Response, url: URL, config: CanvasAgentConfig) {
    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-canvas-agent-token");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (!origin || req.method === "OPTIONS" || url.pathname === "/health" || url.pathname === "/config") return true;
    config.origins ||= [];
    if (validToken(req, url, config.token) && !config.origins.includes(origin)) {
        config.origins.push(origin);
        saveConfig(config);
    }
    res.setHeader("Vary", "Origin");
    return config.origins.includes(origin);
}

/** 校验请求查询参数或请求头中的连接 token。 */
function validToken(req: Request, url: URL, token: string) {
    const header = req.headers["x-canvas-agent-token"];
    return url.searchParams.get("token") === token || header === token || (Array.isArray(header) && header.includes(token));
}

/** 向 Agent 提示词追加本轮图片附件引用说明。 */
function withAttachmentContext(prompt: string, attachments: Array<{ id: string; name: string }>) {
    if (!attachments.length) return prompt;
    const list = attachments.map((item, index) => `${index + 1}. attachmentId=${item.id}, name=${JSON.stringify(item.name)}`).join("\n");
    return `${prompt}\n\n本轮可用图片附件（顺序与图片输入一致）：\n${list}\n需要把附件放入画布或作为生成参考图时，先调用 canvas_create_attachment_nodes，再使用返回的画布节点 ID 创建生成流程。`;
}

/** 从模型输出里抠出第一个 JSON 对象，容忍 ```json 包裹或前后解释。 */
function parseJsonObject(text: string): unknown {
    const start = text.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escape) escape = false;
            else if (char === "\\") escape = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === "{") depth += 1;
        else if (char === "}") {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(text.slice(start, index + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

type PublicationCopy = { platform: "tencent" | "kuaishou" | "douyin"; title: string; description: string; tags: string[]; hook: string; coverText: string; bestTime: string };

/** 各平台标题上限：超了平台会截断，这里先按规则裁好。 */
const TITLE_LIMITS: Record<PublicationCopy["platform"], number> = { douyin: 24, kuaishou: 20, tencent: 16 };

/** 校验并裁剪三平台文案，缺任何一个平台都算失败，避免前端拿到半份数据。 */
function parsePublicationCopies(text: string): PublicationCopy[] | null {
    const data = parseJsonObject(text) as { copies?: unknown } | null;
    const copies = Array.isArray(data?.copies) ? (data?.copies as Array<Record<string, unknown>>) : [];
    const result = (["tencent", "kuaishou", "douyin"] as const).map((platform) => {
        const item = copies.find((copy) => copy && copy.platform === platform);
        if (!item) return null;
        const title = String(item.title || "").trim();
        const description = String(item.description || "").trim();
        const tags = Array.isArray(item.tags) ? item.tags.map((tag) => String(tag || "").trim().replace(/^#+/, "")).filter(Boolean).slice(0, 5) : [];
        if (!title) return null;
        return {
            platform,
            title: Array.from(title).slice(0, TITLE_LIMITS[platform]).join(""),
            description: description.slice(0, 600),
            tags,
            hook: String(item.hook || "").trim().slice(0, 120),
            coverText: String(item.coverText || "").trim().slice(0, 16),
            bestTime: String(item.bestTime || "").trim().slice(0, 40),
        };
    });
    return result.every(Boolean) ? (result as PublicationCopy[]) : null;
}
