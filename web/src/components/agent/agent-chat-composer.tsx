import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Dropdown, Tooltip } from "antd";
import { ArrowUp, Check, ChevronUp, Cpu, Gauge, Hand, ImagePlus, LoaderCircle, Mic, RefreshCw, ShieldAlert, ShieldCheck, ShieldOff, Sparkles, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { canvasThemes } from "@/lib/canvas-theme";
import { ModelPicker } from "@/components/model-picker";
import { useConfigStore } from "@/stores/use-config-store";
import { useAgentStore, type AgentModel, type AgentPermissionMode, type AgentReasoningEffort } from "@/stores/use-agent-store";
import type { AgentChatAttachment } from "./agent-chat-message";
import { AgentChatPromptInput } from "./agent-chat-prompt-input";

export function AgentChatComposer({
    prompt,
    attachments = [],
    disabled,
    sending,
    placeholder,
    theme,
    onPromptChange,
    onSubmit,
    onStop,
    onAddFiles,
    onRemoveAttachment,
    confirmTools,
    onConfirmToolsChange,
    permissionMode,
    onPermissionModeChange,
    models,
    model,
    reasoningEffort,
    onModelChange,
    onReasoningEffortChange,
    left,
}: {
    prompt: string;
    attachments?: AgentChatAttachment[];
    disabled?: boolean;
    sending?: boolean;
    placeholder: string;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onPromptChange: (value: string) => void;
    onSubmit: () => void;
    onStop?: () => void;
    onAddFiles?: (files: FileList | File[] | null) => void | Promise<void>;
    onRemoveAttachment?: (id: string) => void;
    confirmTools?: boolean;
    onConfirmToolsChange?: (confirmTools: boolean) => void;
    permissionMode?: AgentPermissionMode;
    onPermissionModeChange?: (permissionMode: AgentPermissionMode) => void;
    models?: AgentModel[];
    model?: string;
    reasoningEffort?: AgentReasoningEffort | "";
    onModelChange?: (model: string) => void;
    onReasoningEffortChange?: (effort: AgentReasoningEffort) => void;
    left?: ReactNode;
}) {
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const promptRef = useRef(prompt);
    promptRef.current = prompt;
    const [recording, setRecording] = useState(false);
    const [transcribing, setTranscribing] = useState(false);
    const [voiceError, setVoiceError] = useState("");
    useEffect(() => () => { if (recorderRef.current?.state === "recording") { recorderRef.current.onstop = null; recorderRef.current.stop(); } streamRef.current?.getTracks().forEach((track) => track.stop()); }, []);
    const toggleVoice = async () => {
        if (recorderRef.current?.state === "recording") { recorderRef.current.stop(); return; }
        setVoiceError("");
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            const recorder = new MediaRecorder(stream);
            recorderRef.current = recorder;
            const chunks: Blob[] = [];
            recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
            recorder.onstop = async () => {
                stream.getTracks().forEach((track) => track.stop()); streamRef.current = null; recorderRef.current = null; setRecording(false);
                if (!chunks.length) { setVoiceError("没有录到声音，请重试。"); return; }
                setTranscribing(true);
                try {
                    const data = new FormData(); data.append("file", new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), "voice.webm"); data.append("model", "whisper-1"); data.append("language", "zh");
                    const response = await fetch("/muse/v1/audio/transcriptions", { method: "POST", body: data });
                    const result = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(result.error?.message || result.detail || "语音识别失败，请检查本地 Muse 服务。");
                    const text = String(result.text || "").trim();
                    if (!text) throw new Error("没有识别到文字，请重试。");
                    onPromptChange(`${promptRef.current}${promptRef.current.trim() ? "\n" : ""}${text}`);
                } catch (error) { setVoiceError(error instanceof Error ? error.message : "语音识别失败。"); } finally { setTranscribing(false); }
            };
            recorder.start(); setRecording(true);
        } catch { streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null; setVoiceError("无法使用麦克风，请检查浏览器麦克风权限。"); }
    };
    const canvasReferences = useAgentStore((state) => state.canvasReferences);
    const selectionKey = useAgentStore((state) => (state.canvasContext?.snapshot.selectedNodeIds || []).join("|"));
    // 直接按画布当前选区取节点，选什么就显示什么（含文本/配置节点）
    const selectionNodes = useMemo(() => {
        if (!selectionKey) return [];
        const snapshot = useAgentStore.getState().canvasContext?.snapshot;
        if (!snapshot) return [];
        const ids = new Set(selectionKey.split("|"));
        return snapshot.nodes
            .filter((node) => ids.has(node.id))
            .map((node) => ({ id: node.id, title: selectionNodeTitle(node) }));
    }, [selectionKey]);
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canSubmit = !disabled && !sending && Boolean(prompt.trim() || attachments.length || canvasReferences.length);
    return (
        <div className="px-2 pb-2 pt-2" onWheelCapture={(event) => event.stopPropagation()}>
            <div className="mb-2 space-y-1.5 px-1" style={{ color: theme.node.text }}>
                <div className="flex items-center gap-2"><span className="w-16 shrink-0 text-xs" style={{ color: theme.node.muted }}>Agent 视频</span><ModelPicker config={config} value={config.videoModel} capability="video" fullWidth onChange={(value) => updateConfig("videoModel", value)} onMissingConfig={(kind) => openConfigDialog(false, kind || "muse")} /></div>
                <div className="flex items-center gap-2"><span className="w-16 shrink-0 text-xs" style={{ color: theme.node.muted }}>Agent 图片</span><ModelPicker config={config} value={config.imageModel} capability="image" fullWidth onChange={(value) => updateConfig("imageModel", value)} onMissingConfig={(kind) => openConfigDialog(false, kind || "muse")} /></div>
                <p className="text-xs leading-5" style={{ color: theme.node.muted }}>Agent 生成图片和视频时使用这里的默认模型；选择同时更新画布的默认模型。Codex 对话模型在输入框下方选择。</p>
            </div>
            <div className="rounded-[24px] border px-3 pb-3 pt-3 shadow-lg" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke }}>
                {selectionNodes.length ? (
                    <div className="mb-2" data-canvas-no-zoom>
                        <div className="mb-1.5 flex items-center gap-1 text-xs" style={{ color: theme.node.muted }}>
                            <Sparkles className="size-3.5" />
                            {t("agent.composer.selectionCount", { count: selectionNodes.length })}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {selectionNodes.slice(0, 8).map((item) => (
                                <span key={item.id} className="inline-flex max-w-[11rem] items-center gap-1 rounded-full border pl-2 pr-1 py-0.5 text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.text }} title={item.title}>
                                    <button type="button" className="truncate" onClick={() => onPromptChange(`${prompt}${prompt.trim() ? " " : ""}@${item.title}`)}>@{item.title}</button>
                                    <button
                                        type="button"
                                        className="grid size-4 shrink-0 place-items-center rounded-full opacity-60 hover:opacity-100"
                                        aria-label={t("agent.composer.removeSelection", { title: item.title })}
                                        onClick={() => {
                                            const remaining = selectionNodes.filter((node) => node.id !== item.id).map((node) => node.id);
                                            useAgentStore.getState().canvasContext?.applyOps([{ type: "select_nodes", ids: remaining }]);
                                        }}
                                    >
                                        <X className="size-3" />
                                    </button>
                                </span>
                            ))}
                            {selectionNodes.length > 8 ? <span className="rounded-full border px-2 py-0.5 text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>+{selectionNodes.length - 8}</span> : null}
                        </div>
                    </div>
                ) : null}
                {attachments.length ? (
                    <div className="thin-scrollbar mb-2 flex gap-2 overflow-x-auto pb-1">
                        {attachments.map((item) => (
                            <div key={item.id} className="group relative size-14 shrink-0 overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke }} title={item.name}>
                                <img src={item.url} alt={item.name} className="size-full object-cover" />
                                {onRemoveAttachment ? (
                                    <button type="button" className="absolute right-1 top-1 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition group-hover:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => onRemoveAttachment(item.id)} aria-label={t("agent.composer.removeImage")}>
                                        <X className="size-3" />
                                    </button>
                                ) : null}
                            </div>
                        ))}
                    </div>
                ) : null}
                <AgentChatPromptInput value={prompt} disabled={disabled || sending} placeholder={placeholder} theme={theme} onChange={onPromptChange} onSubmit={() => { if (canSubmit) void onSubmit(); }} onAddFiles={onAddFiles} />
                {voiceError ? <div role="alert" className="mt-2 text-xs text-red-500">{voiceError}</div> : null}
                <div className="@container mt-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1">
                        {onAddFiles ? (
                            <>
                                <input ref={fileInputRef} hidden type="file" accept="image/*" multiple onChange={(event) => {
                                    void onAddFiles(event.target.files);
                                    event.target.value = "";
                                }} />
                                <Tooltip title={t("agent.composer.uploadImage")}>
                                    <Button type="text" shape="circle" className="!h-9 !w-9 !min-w-9" disabled={disabled || sending} style={{ color: theme.node.muted }} icon={<ImagePlus className="size-4" />} onClick={() => fileInputRef.current?.click()} aria-label={t("agent.composer.uploadImage")} />
                                </Tooltip>
                            </>
                        ) : null}
                        {onConfirmToolsChange ? <ToolConfirmationMenu confirmTools={Boolean(confirmTools)} theme={theme} onChange={onConfirmToolsChange} /> : null}
                        {permissionMode && onPermissionModeChange ? <PermissionModeMenu permissionMode={permissionMode} theme={theme} onChange={onPermissionModeChange} /> : null}
                        {models?.length && model && onModelChange ? <AgentModelControls models={models} model={model} reasoningEffort={reasoningEffort} onModelChange={onModelChange} onReasoningEffortChange={onReasoningEffortChange} /> : null}
                        {left}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <Tooltip title={recording ? "停止录音并转文字" : transcribing ? "正在识别语音" : "语音转文字"}><Button type="text" shape="circle" disabled={disabled || sending || transcribing} loading={transcribing} danger={recording} icon={recording ? <Square className="size-4" /> : <Mic className="size-4" />} onClick={() => void toggleVoice()} aria-label={recording ? "停止录音并转文字" : "语音转文字"} /></Tooltip>
                        {sending && onStop ? (
                            <Tooltip title={t("agent.composer.stop")} placement="top"><Button danger shape="circle" className="!h-10 !w-10 !min-w-10" icon={<Square className="size-4" />} onClick={() => void onStop()} aria-label={t("agent.composer.stop")} /></Tooltip>
                        ) : (
                            <Tooltip title={t("agent.composer.send")} placement="top"><Button type="primary" shape="circle" className="!h-10 !w-10 !min-w-10" disabled={!canSubmit} icon={sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />} onClick={() => void onSubmit()} aria-label={t("agent.composer.send")} /></Tooltip>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

function AgentModelControls({ models, model, reasoningEffort, onModelChange, onReasoningEffortChange }: { models: AgentModel[]; model: string; reasoningEffort?: AgentReasoningEffort | ""; onModelChange: (model: string) => void; onReasoningEffortChange?: (effort: AgentReasoningEffort) => void }) {
    const { t } = useTranslation();
    const current = models.find((item) => item.model === model) || models[0];
    const efforts = current.supportedReasoningEfforts || [];
    const showReasoning = Boolean(reasoningEffort && efforts.length && onReasoningEffortChange);
    const effortLabel = (effort: AgentReasoningEffort) => t(`agent.composer.effort.${effort}`);
    const [modelOpen, setModelOpen] = useState(false);
    const [reasoningOpen, setReasoningOpen] = useState(false);
    return (
        <div className="flex min-w-0 items-center gap-1">
            <Tooltip title={t("agent.composer.model", { model: current.displayName || current.model })} placement="top" open={modelOpen ? false : undefined}>
                <span className="inline-flex shrink-0">
                    <Select value={model} open={modelOpen} onOpenChange={setModelOpen} onValueChange={onModelChange}>
                        <SelectTrigger hideChevron className="h-9 w-9 min-w-9 justify-center gap-0 rounded-full border-0 bg-transparent px-0 text-xs font-medium shadow-none hover:bg-black/5 focus:ring-0 @min-[660px]:w-auto @min-[660px]:min-w-36 @min-[660px]:max-w-36 @min-[660px]:justify-start @min-[660px]:gap-1.5 @min-[660px]:px-2.5 dark:bg-transparent dark:hover:bg-white/10" aria-label={t("agent.composer.selectModel", { model: current.displayName || current.model })}>
                            <Cpu className="size-3.5 shrink-0 opacity-70" />
                            <span className="hidden min-w-0 flex-1 truncate text-left @min-[660px]:inline">{current.displayName || current.model}</span>
                            <ChevronUp className="hidden size-3 opacity-50 @min-[660px]:block" />
                        </SelectTrigger>
                        <SelectContent data-canvas-no-zoom position="popper" side="top" align="start" sideOffset={6} className="z-[1200] w-64 rounded-xl border border-border/70 bg-popover p-1 shadow-xl">
                            {models.map((item) => <SelectItem key={item.model} value={item.model}>{item.displayName || item.model}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </span>
            </Tooltip>
            {showReasoning ? (
            <Tooltip title={t("agent.composer.reasoning", { effort: effortLabel(reasoningEffort as AgentReasoningEffort) })} placement="top" open={reasoningOpen ? false : undefined}>
                <span className="inline-flex shrink-0">
                    <Select value={reasoningEffort as string} open={reasoningOpen} onOpenChange={setReasoningOpen} onValueChange={(value) => onReasoningEffortChange?.(value as AgentReasoningEffort)}>
                        <SelectTrigger hideChevron className="h-9 w-9 min-w-9 justify-center gap-0 rounded-full border-0 bg-transparent px-0 text-xs font-medium shadow-none hover:bg-black/5 focus:ring-0 @min-[660px]:w-auto @min-[660px]:min-w-[4.5rem] @min-[660px]:justify-start @min-[660px]:gap-1.5 @min-[660px]:px-2.5 dark:bg-transparent dark:hover:bg-white/10" aria-label={t("agent.composer.selectReasoning", { effort: effortLabel(reasoningEffort as AgentReasoningEffort) })}>
                            <Gauge className="size-3.5 opacity-70" />
                            <span className="hidden @min-[660px]:inline">{effortLabel(reasoningEffort as AgentReasoningEffort)}</span>
                            <ChevronUp className="hidden size-3 opacity-50 @min-[660px]:block" />
                        </SelectTrigger>
                        <SelectContent data-canvas-no-zoom position="popper" side="top" align="start" sideOffset={6} className="z-[1200] min-w-32 rounded-xl border border-border/70 bg-popover p-1 shadow-xl">
                            {efforts.map((item) => <SelectItem key={item.reasoningEffort} value={item.reasoningEffort}>{effortLabel(item.reasoningEffort)}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </span>
            </Tooltip>
            ) : null}
        </div>
    );
}

function PermissionModeMenu({ permissionMode, theme, onChange }: { permissionMode: AgentPermissionMode; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (permissionMode: AgentPermissionMode) => void }) {
    const { t } = useTranslation();
    const permissionOptions: Array<{ key: AgentPermissionMode; title: string; shortTitle: string; description: string; icon: ReactNode }> = [
        { key: "request", title: t("agent.composer.permission.request"), shortTitle: t("agent.composer.permission.request"), description: t("agent.composer.permission.requestDescription"), icon: <ShieldAlert className="size-3.5" /> },
        { key: "automatic", title: t("agent.composer.permission.automatic"), shortTitle: t("agent.composer.permission.automatic"), description: t("agent.composer.permission.automaticDescription"), icon: <ShieldCheck className="size-3.5" /> },
        { key: "full", title: t("agent.composer.permission.full"), shortTitle: t("agent.composer.permission.fullShort"), description: t("agent.composer.permission.fullDescription"), icon: <ShieldOff className="size-3.5" /> },
    ];
    const current = permissionOptions.find((item) => item.key === permissionMode) || permissionOptions[0];
    const [open, setOpen] = useState(false);
    return (
        <Tooltip title={t("agent.composer.permissionLabel", { mode: current.shortTitle })} placement="top" open={open ? false : undefined}>
            <span className="inline-flex shrink-0">
                <Dropdown
                    trigger={["click"]}
                    placement="topLeft"
                    open={open}
                    onOpenChange={setOpen}
                    menu={{
                        items: permissionOptions.map((item) => ({
                            key: item.key,
                            label: <ConfirmationOption icon={item.icon} title={item.title} description={item.description} selected={permissionMode === item.key} />,
                            onClick: () => onChange(item.key),
                        })),
                    }}
                >
                    <button type="button" className="flex h-9 w-9 min-w-9 shrink-0 items-center justify-center gap-0 rounded-full px-0 text-xs font-medium transition hover:bg-black/5 @min-[660px]:h-9 @min-[660px]:w-auto @min-[660px]:min-w-0 @min-[660px]:justify-start @min-[660px]:gap-1.5 @min-[660px]:px-2.5 dark:hover:bg-white/10" style={{ color: permissionMode === "full" ? "#ea580c" : theme.node.text }} aria-label={t("agent.composer.selectPermission", { mode: current.title })}>
                        {current.icon}
                        <span className="hidden @min-[660px]:inline">{current.shortTitle}</span>
                        <ChevronUp className="hidden size-3 opacity-50 @min-[660px]:block" />
                    </button>
                </Dropdown>
            </span>
        </Tooltip>
    );
}

function ToolConfirmationMenu({ confirmTools, theme, onChange }: { confirmTools: boolean; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onChange: (confirmTools: boolean) => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const mode = t(confirmTools ? "agent.composer.tools.manual" : "agent.composer.tools.automatic");
    return (
        <Tooltip title={t("agent.composer.tools.label", { mode })} placement="top" open={open ? false : undefined}>
            <span className="inline-flex shrink-0">
                <Dropdown
                    trigger={["click"]}
                    placement="topLeft"
                    open={open}
                    onOpenChange={setOpen}
                    menu={{
                        items: [
                            {
                                key: "manual",
                                label: <ConfirmationOption icon={<Hand className="size-4" />} title={t("agent.composer.tools.manual")} description={t("agent.composer.tools.manualDescription")} selected={confirmTools} />,
                                onClick: () => onChange(true),
                            },
                            {
                                key: "automatic",
                                label: <ConfirmationOption icon={<RefreshCw className="size-4" />} title={t("agent.composer.tools.automatic")} description={t("agent.composer.tools.automaticDescription")} selected={!confirmTools} />,
                                onClick: () => onChange(false),
                            },
                        ],
                    }}
                >
                    <button type="button" className="flex h-9 w-9 min-w-9 shrink-0 items-center justify-center gap-0 rounded-full px-0 text-xs font-medium transition hover:bg-black/5 @min-[660px]:w-auto @min-[660px]:min-w-0 @min-[660px]:justify-start @min-[660px]:gap-1.5 @min-[660px]:px-2.5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label={t("agent.composer.tools.select", { mode })}>
                        {confirmTools ? <Hand className="size-3.5" /> : <RefreshCw className="size-3.5" />}
                        <span className="hidden @min-[660px]:inline">{mode}</span>
                        <ChevronUp className="hidden size-3 opacity-50 @min-[660px]:block" />
                    </button>
                </Dropdown>
            </span>
        </Tooltip>
    );
}

function ConfirmationOption({ icon, title, description, selected }: { icon: ReactNode; title: string; description: string; selected: boolean }) {
    return (
        <div className="flex min-w-64 items-start gap-3 py-1">
            <span className="mt-0.5 shrink-0">{icon}</span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{title}</span>
                <span className="mt-0.5 block text-xs leading-5 opacity-60">{description}</span>
            </span>
            {selected ? <Check className="mt-0.5 size-4 shrink-0" /> : null}
        </div>
    );
}

/** 选区节点在「会带上…」一栏里的显示名：标题优先，其次内容片段，最后退回类型名。 */
function selectionNodeTitle(node: { type?: string; title?: string; metadata?: Record<string, unknown> }) {
    const title = String(node.title || "").trim();
    if (title) return title.split("\n")[0].trim().slice(0, 24);
    const content = String(node.metadata?.content || "").trim();
    if (content) return content.split("\n")[0].trim().slice(0, 24);
    return node.type || "节点";
}
