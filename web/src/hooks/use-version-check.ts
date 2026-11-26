import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "@/constant/env";
import { parseChangelog, type ReleaseInfo } from "@/lib/release";

/**
 * 检查的是本分叉自己的版本线，不是上游 basketikun/infinite-canvas。
 * 上游那份永远只有原项目的版本号，查它会导致：本分叉的新版本永远发现不了，
 * 而上游一升版就提示「有新版本」，下载到的却是与本项目增强无关的代码。
 *
 * 每台机器的网络环境不同（raw.githubusercontent 在部分网络下不可达），
 * 所以按顺序尝试多个源，任一成功即用；全部失败时保持当前版本，不误报有新版本。
 */
const latestVersionUrls = [
    "https://cdn.jsdelivr.net/gh/maluom13/infinite-canvas-studio@main/VERSION",
    "https://raw.githubusercontent.com/maluom13/infinite-canvas-studio/main/VERSION",
];
const latestChangelogUrls = [
    "https://cdn.jsdelivr.net/gh/maluom13/infinite-canvas-studio@main/CHANGELOG.md",
    "https://raw.githubusercontent.com/maluom13/infinite-canvas-studio/main/CHANGELOG.md",
];

async function fetchFirstAvailable(urls: string[]): Promise<string> {
    for (const url of urls) {
        try {
            // 只做超时控制：不可达的源不该让「检查更新」一直转圈。
            const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!response.ok) continue;
            const text = await response.text();
            if (text.trim()) return text;
        } catch {
            // 换下一个源
        }
    }
    throw new Error("all sources failed");
}

function isValidVersion(text: string) {
    return /^v?\d+\.\d+\.\d+/.test(text.trim());
}

/**
 * 版本号必须取多个源里最新的那个，而不是「第一个成功的」。
 * jsDelivr 对 @main 有缓存（可能几小时），如果它先返回旧版本，
 * 用户就会一直看到「已是最新」，反而发现不了刚发的版。
 */
async function fetchLatestVersion(): Promise<string> {
    const results = await Promise.allSettled(
        latestVersionUrls.map(async (url) => {
            const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw new Error(String(response.status));
            const text = (await response.text()).trim();
            if (!isValidVersion(text)) throw new Error("invalid version");
            return text;
        }),
    );
    const versions = results.filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled").map((result) => result.value);
    if (!versions.length) throw new Error("all sources failed");
    return versions.reduce((latest, current) => (isNewerVersion(current, latest) ? current : latest));
}

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

function toVersionParts(version: string) {
    // 支持 v0.21.0-studio.1 这种四段写法：前三位跟 semver，第四位是本分叉自己的发版序号。
    // 少了第四位会导致 studio.1 → studio.2 被判定为「同一版本」，永远提示已是最新。
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-studio\.(\d+))?/i);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? Number(match[4]) : 0];
}

function isNewerVersion(latestVersion: string, currentVersion: string) {
    const latest = toVersionParts(latestVersion);
    const current = toVersionParts(currentVersion);
    if (!latest || !current) return false;
    return latest.some((value, index) => value > current[index] && latest.slice(0, index).every((part, prevIndex) => part === current[prevIndex]));
}

export function useVersionCheck() {
    const { t } = useTranslation();
    const currentVersion = APP_VERSION;
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    const [latestVersion, setLatestVersion] = useState(currentVersion);
    const [releases, setReleases] = useState<ReleaseInfo[]>(localReleases);
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const hasNewVersion = isNewerVersion(latestVersion, currentVersion);

    const checkLatestVersion = useCallback(async () => {
        try {
            const version = await fetchLatestVersion();
            setLatestVersion(version || currentVersion);
            return true;
        } catch {
            return false;
        }
    }, [currentVersion]);

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            setChecking(true);
            try {
                const [version, changelog] = await Promise.all([fetchLatestVersion(), fetchFirstAvailable(latestChangelogUrls)]);
                setLatestVersion(version || currentVersion);
                if (changelog.trim()) setReleases(parseChangelog(changelog));
                if (showMessage) message.success(t("version.updated"));
                return true;
            } catch {
                setLatestVersion(currentVersion);
                setReleases(localReleases);
                // 网络不通时不要把「检查失败」和「有新版本」混在一起：
                // 保持当前版本号，提示网络原因，避免用户以为已经是最新。
                if (showMessage) message.error(t("version.updateFailed"));
                return false;
            } finally {
                setChecking(false);
            }
        },
        [currentVersion, localReleases, message, t],
    );

    useEffect(() => {
        void checkLatestVersion();
    }, [checkLatestVersion]);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        void checkLatestRelease();
    }, [checkLatestRelease]);

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion,
        releases,
        checking,
        hasNewVersion,
        checkLatestRelease,
    };
}
