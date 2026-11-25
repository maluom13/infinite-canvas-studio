import { Alert, Button, Input, Popconfirm, Tag } from "antd";
import { LogIn, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useMuseStore, MUSE_CHANNEL_ID } from "@/stores/use-muse-store";
import { useConfigStore } from "@/stores/use-config-store";
import { checkMuseNetwork, checkMuseProtocol, deleteMuseAccount, keepaliveMuseAccounts, museAccountAction } from "@/services/api/muse";

export function ConfigMuse() {
    const [accountBusy, setAccountBusy] = useState("");
    const [accountMessage, setAccountMessage] = useState("");
    const [checkingNetwork, setCheckingNetwork] = useState(false);
    const [networkError, setNetworkError] = useState("");
    const [accountLabel, setAccountLabel] = useState("");
    const [protocolNetwork, setProtocolNetwork] = useState<{ ok: boolean; route?: string; detail?: string } | null>(null);
    const [checkingProtocol, setCheckingProtocol] = useState(false);
    const { status, loading, loggingIn, error, hint, refresh, login } = useMuseStore();
    const connected = useConfigStore((state) => state.config.channels.some((channel) => channel.id === MUSE_CHANNEL_ID));
    useEffect(() => { void refresh(); }, [refresh]);
    useEffect(() => { void checkMuseProtocol().then(setProtocolNetwork).catch(() => setProtocolNetwork(null)); }, []);
    const ready = status?.accounts.some((account) => account.ready);
    const stale = (status?.accounts || []).filter((account) => !account.ready);
    const removeStale = async () => {
        setAccountBusy("cleanup");
        setAccountMessage("");
        try {
            let removed = 0;
            for (const account of stale) {
                await deleteMuseAccount(account.id);
                removed += 1;
            }
            setAccountMessage(`已清理 ${removed} 个失效账号`);
            await refresh();
        } catch (error) {
            setAccountMessage(error instanceof Error ? error.message : "清理失败");
        } finally {
            setAccountBusy("");
        }
    };
    const egress = status?.egress;
    const fresh = Boolean(egress?.checked_at && egress.checked_at <= Date.now() / 1000 + 60 && Date.now() / 1000 - egress.checked_at <= 300);
    const known = Boolean(fresh && egress?.ip && /^[A-Z]{2}$/.test((egress.country || "").toUpperCase()));
    const cn = known && egress?.country?.toUpperCase() === "CN";
    return (
        <section className="space-y-5 py-2">
            <div>
                <div className="flex items-center gap-2 text-base font-semibold">Muse {connected && ready ? <Tag color="success">已接入</Tag> : null}</div>
                <p className="mt-2 text-sm opacity-65">Muse 负责生成图片和视频；Codex 负责 Agent 对话、规划与画布操作。连接后 Muse 会成为图片和视频的默认生成模型。</p>
            </div>
            {error ? <Alert type="error" showIcon title={error} /> : null}
            {hint ? <Alert type="info" showIcon title={hint} /> : null}
            <div className="space-y-3 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="text-base font-semibold">添加 Muse 账号</div>
                <ol className="list-decimal space-y-1 pl-5 text-sm opacity-70"><li>点击下方按钮，打开独立登录窗口。</li><li>在窗口中登录要添加的 Muse 账号。</li><li>登录完成后等待窗口自动关闭，账号会出现在列表中。</li></ol>
                <Input aria-label="Muse 账号名称" placeholder="给账号起个名字（可不填）" value={accountLabel} onChange={(event) => setAccountLabel(event.target.value)} />
                <Button type="primary" icon={<LogIn className="size-4" />} loading={loggingIn} onClick={() => void login(undefined, accountLabel)}>添加 Muse 账号（弹出登录窗口）</Button>
                <div className="flex flex-wrap items-center gap-2 text-xs"><span>{protocolNetwork ? protocolNetwork.ok ? `新接口网络可达${protocolNetwork.route ? ` · ${protocolNetwork.route}` : ""}` : `新接口网络未就绪${protocolNetwork.detail ? `：${protocolNetwork.detail}` : ""}` : "新接口网络状态未确认"}</span><Button size="small" loading={checkingProtocol} onClick={async () => { setCheckingProtocol(true); try { setProtocolNetwork(await checkMuseProtocol(true)); } catch { setProtocolNetwork(null); } finally { setCheckingProtocol(false); } }}>重新检测新接口</Button></div>
                <p className="text-xs opacity-55">网络可达不代表账号会话有效。登录完成前请保留弹出的窗口。</p>
            </div>
            <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">{cn ? `Muse 浏览器出口：${egress?.ip} · 中国大陆` : known ? `Muse 浏览器出口：${egress?.ip} · ${egress?.country?.toUpperCase()}` : "Muse 浏览器出口：尚未检测或结果已过期"}</span><Button size="small" loading={checkingNetwork} onClick={async () => { setCheckingNetwork(true); setNetworkError(""); try { await checkMuseNetwork(); await refresh(); } catch (error) { setNetworkError(error instanceof Error ? error.message : "出口检测失败"); } finally { setCheckingNetwork(false); } }}>检测出口</Button></div>
                <div className="mt-2 text-xs opacity-60">{egress?.checked_at ? `最近检测：${new Date(egress.checked_at * 1000).toLocaleString()}${fresh ? "" : "（已过期）"}。` : "尚未检测。"}通过 Muse 浏览器检测，结果最多缓存 5 分钟；此状态不代表新接口或账号一定可用。</div>
                {cn ? <div className="mt-1 text-xs text-orange-500">当前出口可能影响 Muse 使用，请检查代理。</div> : null}{networkError ? <div className="mt-1 text-xs text-red-500">{networkError}</div> : null}
            </div>
            <div className="flex flex-wrap gap-2">
                <Button type="primary" icon={<LogIn className="size-4" />} loading={loggingIn} onClick={() => void login()}>登录 Muse</Button>
                {ready ? <Button loading={loading} disabled={loggingIn} onClick={() => void refresh(true)}>{connected ? "更新 Muse 模型" : "使用已登录账号"}</Button> : null}
                <Button type="text" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>刷新状态</Button>
            </div>
            <div className="space-y-3">
                <div className="flex items-center justify-between gap-2"><div className="text-base font-semibold">账号列表 {status?.accounts.length ?? ""}</div><Button size="small" disabled={!!accountBusy} loading={accountBusy === "all"} onClick={async () => { setAccountBusy("all"); try { const result = await keepaliveMuseAccounts(); setAccountMessage(result.message); await refresh(); } catch (error) { setAccountMessage(error instanceof Error ? error.message : "保活失败"); } finally { setAccountBusy(""); } }}>一键保活所有账号</Button>{stale.length ? <Popconfirm title={`清理 ${stale.length} 个失效账号？`} description="删除的是本机保存的登录记录，不影响 Muse 账号本身；需要时可重新登录。" okText="清理" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void removeStale()}><Button size="small" danger loading={accountBusy === "cleanup"} disabled={!!accountBusy || loggingIn} icon={<Trash2 className="size-3.5" />}>清理失效 {stale.length}</Button></Popconfirm> : null}</div>
                <div className="text-xs opacity-60">账号状态来自本机 Muse 服务；测试会打开 Muse 验证会话。</div>
                {accountMessage ? <Alert showIcon type="info" title={accountMessage} /> : null}
                {status?.accounts.map((account) => (
                    <div key={account.id} className="space-y-3 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                        <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{account.label || "Muse 账号"}</span><Tag color={account.ready ? "success" : "warning"}>{account.ready ? "登录记录有效" : account.enabled ? "需要检查" : "已暂停"}</Tag>{account.protocol ? <><Tag color={account.protocol.oldOk ? "success" : "warning"}>老接口 {account.protocol.oldOk ? "✓" : "未就绪"}</Tag><Tag color={account.protocol.newOk ? "success" : "warning"}>新接口 {account.protocol.newOk ? "✓" : "未就绪"}</Tag></> : <Tag>接口状态未知</Tag>}</div>
                        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">{[["总调用", account.useCount ?? 0], ["今日视频 成/败", `${account.today?.video_success ?? 0} / ${account.today?.video_failed ?? 0}`], ["今日图片 成/败", `${account.today?.image_success ?? 0} / ${account.today?.image_failed ?? 0}`], ["额度已用", account.quota?.found && account.quota.weeklyUsed != null ? `${account.quota.weeklyUsed}%` : "未查询"]].map(([label, value]) => <div key={label} className="rounded-md bg-black/5 p-2 dark:bg-white/5"><div className="text-sm font-semibold">{value}</div><div className="mt-1 opacity-60">{label}</div></div>)}</div>
                        <div className="text-xs opacity-65">有效期：{account.expiresAt ? new Date(account.expiresAt * 1000).toLocaleString() : "未知"} · 额度查询：{account.quota?.checkedAt ? new Date(account.quota.checkedAt * 1000).toLocaleString() : "未知"}{account.quota?.extraLeft ? ` · ${account.quota.extraLeft}` : ""}</div>
                        <div className="flex flex-wrap gap-2">{([["test", "测试"], ["keepalive", "保活"], ["sync", "补登新接口"], ["quota", "查额度"]] as const).map(([action, label]) => <Button key={action} size="small" disabled={!!accountBusy || loggingIn} loading={accountBusy === `${account.id}:${action}`} onClick={async () => { setAccountBusy(`${account.id}:${action}`); setAccountMessage(""); try { const result = await museAccountAction(account.id, action); setAccountMessage(result.message); await refresh(); } catch (error) { setAccountMessage(error instanceof Error ? error.message : "操作失败"); } finally { setAccountBusy(""); } }}>{label}</Button>)}<Button size="small" disabled={loggingIn || !!accountBusy} onClick={() => void login(account.id)}>重新登录</Button><Popconfirm title={`删除账号「${account.label || account.id}」？`} description="只删除本机保存的登录记录，不影响 Muse 账号本身；需要时可重新添加登录。" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={async () => { setAccountBusy(`${account.id}:delete`); setAccountMessage(""); try { const result = await deleteMuseAccount(account.id); setAccountMessage(result.message); await refresh(); } catch (error) { setAccountMessage(error instanceof Error ? error.message : "删除失败"); } finally { setAccountBusy(""); } }}><Button size="small" danger disabled={loggingIn || !!accountBusy} loading={accountBusy === `${account.id}:delete`} icon={<Trash2 className="size-3.5" />}>删除</Button></Popconfirm></div>
                    </div>
                ))}
                {status && !status.accounts.length ? <p className="text-sm opacity-60">还没有 Muse 账号，点击上方按钮开始登录。</p> : null}
            </div>
            {connected && ready ? <div className="text-sm"><div className="mb-2 font-medium">可用模型</div>{status?.models.map((model) => <Tag key={model.name}>{model.capability === "video" ? "视频" : "图片"} · {model.name}</Tag>)}</div> : null}
            <p className="text-xs opacity-55">账号由本机 Muse 服务管理，生成使用该账号的额度。作品保存在当前画布。</p>
        </section>
    );
}
