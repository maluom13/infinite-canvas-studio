import { App } from "antd";
import copy from "copy-to-clipboard";
import { useTranslation } from "react-i18next";

export function useCopyText() {
    const { message } = App.useApp();
    const { t } = useTranslation();

    return (value: string, successText = t("common.copied")) => {
        // 非安全上下文（http 局域网地址）下复制会失败，不能一律提示成功。
        void copy(value).then((ok) => (ok ? message.success(successText) : message.error(t("common.copyFailed"))));
    };
}
