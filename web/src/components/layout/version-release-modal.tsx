import { useEffect, type CSSProperties } from "react";
import { Modal, Tag, Timeline } from "antd";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useVersionCheck } from "@/hooks/use-version-check";
import { APP_VERSION } from "@/constant/env";

function getTagColor(type: string) {
    if (type === "新增" || type === "Added") return "green";
    if (type === "修复" || type === "Fixed") return "red";
    if (type === "调整" || type === "Changed") return "blue";
    if (type === "文档" || type === "Docs") return "purple";
    return "default";
}

function releaseTypeLabel(type: string, t: TFunction) {
    const key = ({ 新增: "added", 修复: "fixed", 调整: "changed", 优化: "optimized", 文档: "docs" } as Record<string, string>)[type];
    return key ? t(`version.types.${key}`) : type;
}

type VersionReleaseModalProps = {
    className?: string;
    style?: CSSProperties;
};

/**
 * 自动提示只做一次，按版本号记住。
 * 这个组件在「画布顶栏」和「应用导航」各挂了一份，模块级标记保证只弹一个窗。
 */
const NOTIFIED_VERSION_KEY = "canvas.update.lastNotified";
let notifyShownThisSession = false;

export function VersionReleaseModal({ className, style }: VersionReleaseModalProps) {
    const { t } = useTranslation();
    const { open, setOpen, openReleaseModal, latestVersion, releases, checking, hasNewVersion, checkLatestRelease } = useVersionCheck();
    const downloadUrl = "https://github.com/maluom13/infinite-canvas-studio/archive/refs/heads/main.zip";

    // 光靠一个小绿点，多数人不会注意到。发现新版时主动弹一次，
    // 但同一版本只弹一次——否则每次打开都打断人，比不提示还糟。
    useEffect(() => {
        if (!hasNewVersion || notifyShownThisSession) return;
        let notified = "";
        try {
            notified = localStorage.getItem(NOTIFIED_VERSION_KEY) || "";
        } catch {
            // 隐私模式下 localStorage 不可用，当作没提示过
        }
        if (notified === latestVersion) return;
        notifyShownThisSession = true;
        const timer = window.setTimeout(() => {
            try {
                localStorage.setItem(NOTIFIED_VERSION_KEY, latestVersion);
            } catch {
                // 存不了就算了，最多下次再提示一次
            }
            openReleaseModal();
        }, 6000);
        return () => window.clearTimeout(timer);
    }, [hasNewVersion, latestVersion, openReleaseModal]);

    return (
        <>
            <button
                type="button"
                className={
                    hasNewVersion
                        ? "shrink-0 cursor-pointer rounded-full border border-green-700/20 bg-green-600 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm transition hover:bg-green-700"
                        : className || "shrink-0 cursor-pointer text-xs font-medium text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-white"
                }
                style={hasNewVersion ? undefined : style}
                onClick={openReleaseModal}
                title={hasNewVersion ? t("version.newAvailableTitle", { version: latestVersion }) : t("version.viewUpdates")}
                aria-label={hasNewVersion ? t("version.newAvailableTitle", { version: latestVersion }) : t("version.viewUpdates")}
            >
                {hasNewVersion ? (
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span className="size-1.5 rounded-full bg-white/90" />
                        {t("version.newAvailable")}
                    </span>
                ) : (
                    APP_VERSION
                )}
            </button>
            <Modal title={t("version.title")} open={open} width={680} centered footer={null} onCancel={() => setOpen(false)}>
                <div className="mb-5 grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-xs text-stone-500 dark:text-stone-400">{t("version.currentVersion")}</div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{APP_VERSION}</div>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-xs text-stone-500 dark:text-stone-400">{t("version.latestVersion")}</div>
                            <button
                                type="button"
                                className="cursor-pointer bg-transparent p-0 text-[11px] font-normal text-stone-400 underline-offset-2 transition hover:text-stone-700 hover:underline dark:text-stone-500 dark:hover:text-stone-300"
                                onClick={() => void checkLatestRelease(true)}
                            >
                                {t(checking ? "version.checking" : "version.checkUpdates")}
                            </button>
                        </div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{latestVersion}</div>
                    </div>
                </div>
                {hasNewVersion ? (
                    <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-950/30">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-xs font-semibold text-green-800 dark:text-green-300">{t("version.howToUpdate")}</div>
                            <a href={downloadUrl} target="_blank" rel="noreferrer" className="text-[11px] font-medium text-green-700 underline underline-offset-2 dark:text-green-400">
                                {t("version.updateDownload")}
                            </a>
                        </div>
                        <div className="mt-1 text-xs leading-5 text-green-800/90 dark:text-green-300/90">{t("version.updateSteps")}</div>
                    </div>
                ) : null}
                <div className="max-h-[56vh] overflow-y-auto pr-2">
                    <Timeline
                        items={releases.map((release) => ({
                            content: (
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-semibold text-stone-950 dark:text-stone-100">{release.version === "Unreleased" ? t("version.unreleased") : release.version}</span>
                                        <span className="text-xs text-stone-500 dark:text-stone-400">{release.date}</span>
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {release.version === latestVersion ? <Tag color="green">{t("version.latest")}</Tag> : null}
                                            {release.version === APP_VERSION ? <Tag>{t("version.current")}</Tag> : null}
                                        </div>
                                    </div>
                                    <div className="mt-2 space-y-1.5">
                                        {release.items.map((item, index) => (
                                            <div key={`${release.version}-${index}`} className="flex items-start gap-2 text-sm leading-6 text-stone-700 dark:text-stone-300">
                                                <Tag color={getTagColor(item.type)} className="m-0 mt-0.5 shrink-0 whitespace-nowrap">
                                                    {releaseTypeLabel(item.type, t)}
                                                </Tag>
                                                <span className="min-w-0 flex-1">{item.content}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ),
                        }))}
                    />
                </div>
            </Modal>
        </>
    );
}
