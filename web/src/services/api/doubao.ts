export type DoubaoLoginStatus = { loggedIn: boolean; state: string; message: string; loginAt: number; home: string; browserOpen?: boolean };

async function doubaoRequest<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`/doubao/${path}`, { ...options, headers: { "Content-Type": "application/json" }, cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "豆包请求失败");
    return payload;
}

export const getDoubaoLogin = () => doubaoRequest<DoubaoLoginStatus>("status");
export const startDoubaoLogin = () => doubaoRequest<{ message: string }>("login", { method: "POST", body: "{}" });
export const logoutDoubao = () => doubaoRequest<{ message: string }>("logout", { method: "POST", body: "{}" });
