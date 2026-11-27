/**
 * 统一的 API 错误解析。
 *
 * 目的：失败时告诉用户「到底是什么原因」，而不是只显示一个状态码。
 * 各渠道返回结构五花八门：OpenAI 用 error.message，百炼用 message/code，
 * 中转站可能用 msg、detail、或把错误塞在 body 里。这里尽量都认。
 */

/** 从任意形状的错误体里抠出人能读的消息。 */
export function extractApiMessage(value: unknown, depth = 0): string {
    if (!value || depth > 4) return "";
    if (typeof value === "string") {
        const text = value.trim();
        if (!text) return "";
        if (/^\{|^\[/ .test(text)) {
            try {
                return extractApiMessage(JSON.parse(text), depth + 1);
            } catch {
                // 不是 JSON，按纯文本处理
            }
        }
        if (/<[a-z][\s\S]*>/i.test(text)) return `HTML 错误页：${text.slice(0, 80)}...`;
        return text;
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    // 常见字段，按优先级
    const candidates = [
        record.msg,
        record.message,
        record.detail,
        record.error_description,
        record.error,
        record.reason,
        record.output && (record.output as Record<string, unknown>).message,
        record.data,
    ];
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null) continue;
        const parsed = extractApiMessage(candidate, depth + 1);
        if (parsed) return parsed;
    }
    // 有些中转站把错误放在 errors 数组
    const errors = record.errors;
    if (Array.isArray(errors) && errors.length) {
        const parsed = extractApiMessage(errors[0], depth + 1);
        if (parsed) return parsed;
    }
    return "";
}

/** 错误码（字符串或数字）也带出来，便于对照文档。 */
export function extractApiCode(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    const code = record.code ?? (record.error as Record<string, unknown> | undefined)?.code;
    return code === undefined || code === null ? "" : String(code);
}

/**
 * 把「状态码 + 服务端消息」翻成能看懂的原因。
 * 返回 null 表示没有可补充的通用解释，调用方用原文即可。
 */
export function explainStatus(status: number | undefined, message: string): string | null {
    const lower = message.toLowerCase();
    // 额度/余额问题：优先按文案判断，比状态码准
    if (/insufficient|balance|quota|余额|额度|欠费|付费|arrears|no credit/i.test(lower)) {
        return "账户余额或额度不足。请到服务商控制台确认余额、套餐和该模型的调用权限。";
    }
    if (/authentication|unauthorized|invalid api key|api key|forbidden|鉴权|密钥|权限/i.test(lower) || status === 401 || status === 403) {
        return "鉴权失败。请检查 API Key 是否正确、是否开通了这个模型的权限。";
    }
    if (/not found|404|does not exist|unsupported model|model not found|模型不存在|不支持/i.test(lower) || status === 404) {
        return "接口或模型不存在。多半是接口路径不对、或模型名选错（例如拿图像模型去生成视频）。";
    }
    if (/rate.?limit|too many requests|限流|429/i.test(lower) || status === 429) {
        return "请求太频繁或额度已用完，被限流了。等一会儿再试。";
    }
    if (/timeout|timed out|超时/i.test(lower)) {
        return "服务端处理超时。视频生成本来就慢，可以重试；若一直超时，换更短时长或别的模型。";
    }
    if (/content|safety|审核|违规|sensitive|blocked/i.test(lower)) {
        return "内容被安全审核拦截。换一个提示词或参考图再试。";
    }
    if (/parameter|参数|invalid|格式|badrequest/i.test(lower) || status === 400) {
        return "请求参数有问题。检查模型名、分辨率、时长、参考图是否符合该模型要求。";
    }
    if (status && status >= 500) {
        return "服务端暂时不可用（5xx）。等一会儿重试，或换一个渠道。";
    }
    if (status) return `请求失败（HTTP ${status}）。`;
    return null;
}

/** 组合成最终展示给用户的错误：原文 + 人话解释 + 错误码。 */
export function formatApiError(status: number | undefined, raw: unknown, fallback: string): string {
    const message = extractApiMessage(raw);
    const code = extractApiCode(raw);
    const explanation = explainStatus(status, message);
    const parts: string[] = [];
    if (message) parts.push(message);
    else parts.push(fallback + (status ? `（HTTP ${status}）` : ""));
    if (code && code !== message) parts.push(`错误码：${code}`);
    if (explanation && explanation !== message) parts.push(explanation);
    return parts.join(" · ");
}
