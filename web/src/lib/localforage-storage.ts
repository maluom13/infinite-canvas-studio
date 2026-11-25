import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

// IndexedDB 写入失败（配额/被禁用）时会降级写 localStorage，这里记下哪些 key 走了降级，
// 否则读取优先读 localforage，会把用户刚改的设置静默回滚成旧值。
const FALLBACK_KEYS = "__fallback_keys__";

function fallbackKeys() {
    try {
        return new Set<string>(JSON.parse(window.localStorage.getItem(FALLBACK_KEYS) || "[]") as string[]);
    } catch {
        return new Set<string>();
    }
}

function markFallback(name: string, enabled: boolean) {
    const keys = fallbackKeys();
    if (enabled) keys.add(name);
    else keys.delete(name);
    try {
        window.localStorage.setItem(FALLBACK_KEYS, JSON.stringify([...keys]));
    } catch {
        // localStorage 也写不进去时只能放弃标记，不影响主流程。
    }
}

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        if (fallbackKeys().has(name)) return window.localStorage.getItem(name);
        try {
            return (await localforage.getItem<string>(name)) || window.localStorage.getItem(name);
        } catch {
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
            markFallback(name, false);
        } catch {
            try {
                window.localStorage.setItem(name, value);
                markFallback(name, true);
            } catch {
                // 两种存储都满时保持静默，避免 persist 抛出未处理的 rejection。
            }
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        markFallback(name, false);
        window.localStorage.removeItem(name);
        try {
            await localforage.removeItem(name);
        } catch {
            // 已经清掉 localStorage 的副本，IndexedDB 删除失败无需额外处理。
        }
    },
};
