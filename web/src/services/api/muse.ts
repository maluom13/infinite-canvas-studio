import type { ChannelModel } from "@/stores/use-config-store";

export type MuseAccount = { id: string; label: string; enabled: boolean; ready: boolean; useCount?: number; expiresAt?: number; lastUsed?: number; today?: { image_success?: number; image_failed?: number; video_success?: number; video_failed?: number }; quota?: { found?: boolean; weeklyUsed?: number; extraLeft?: string; checkedAt?: number } | null; protocol?: { oldOk: boolean; newOk: boolean } | null };
export type MuseEgress = { ip?: string; country?: string; checked_at?: number };
export type MuseStatus = { accounts: MuseAccount[]; models: ChannelModel[]; egress?: MuseEgress | null };
export type MuseLogin = { id?: string; status?: string; phase?: string; hint?: string; error?: string; label?: string };

async function museRequest<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`/muse/${path}`, { ...options, headers: { "Content-Type": "application/json" }, cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : payload.error?.message || payload.detail || "Muse 请求失败，请检查本机服务。");
    return payload;
}

export const getMuseStatus = () => museRequest<MuseStatus>("status");
export const checkMuseNetwork = () => museRequest<{ egress: MuseEgress | null }>("network/check", { method: "POST" });
export const museAccountAction = (id: string, action: "test" | "keepalive" | "quota" | "sync") => museRequest<{ message: string }>(`accounts/${encodeURIComponent(id)}/${action}`, { method: "POST" });
export const deleteMuseAccount = (id: string) => museRequest<{ message: string }>(`accounts/${encodeURIComponent(id)}/delete`, { method: "POST" });
export const keepaliveMuseAccounts = () => museRequest<{ message: string }>("accounts/keepalive-all", { method: "POST" });
export const startMuseLogin = (accountId?: string, label = "") => museRequest<MuseLogin>("login", { method: "POST", body: JSON.stringify(accountId ? { account_id: accountId } : { label: label.trim() }) });
export const checkMuseProtocol = (force = false) => museRequest<{ ok: boolean; route?: string; detail?: string }>(`protocol-network${force ? "?force=1" : ""}`);
export const getMuseLogin = (id: string) => museRequest<MuseLogin>(`login/${encodeURIComponent(id)}`);
