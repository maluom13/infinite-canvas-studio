/**
 * 图生视频适配脚本 —— 适用于百炼官方 / 百炼中转站（含 qianwenaiapi.com）
 *
 * 背景：画布默认按 OpenAI 格式请求 {baseUrl}/v1/videos，
 * 百炼及其兼容中转站没有这个接口（返回 404），必须用百炼自己的：
 *   创建：POST /api/v1/services/aigc/video-generation/video-synthesis
 *   查询：GET  /api/v1/tasks/{task_id}
 *
 * 怎么用（重要）：
 *   1. 渠道「接口地址」保持你现在填的：https://maas.qianwenaiapi.com/compatible-mode/v1
 *      —— 脚本会自动推导成 https://maas.qianwenaiapi.com，不用你改
 *   2. 在模型列表里添加视频模型：wan2.7-i2v（或 wan2.7-i2v-2026-04-25、
 *      wan2.6-i2v-flash、wan3.0-video 等）。
 *      注意：不要再用 wan2.7-image / wan2.7-image-pro，那是图像模型，不出视频。
 *   3. 给这个视频模型绑定「自定义脚本」，粘贴本文件全文
 *   4. 用它重新生成
 *
 * 参考图：直接用画布里的图片（dataURL），百炼官方支持，无需公网 URL。
 */

/**
 * 提交图生视频任务并等待完成。
 * @param {string} prompt 用户提示词（已含系统提示词）
 * @param {string[]} images 参考图 dataURL 数组，第一张作为首帧
 * @param {string} model 模型名，如 wan2.7-i2v
 * @param {string} baseUrl 渠道接口地址（原样）
 * @param {string} apiKey API Key
 * @param {object} params 生成参数
 * @param {number} params.seconds 视频时长（秒）
 * @param {string} params.resolution 分辨率，如 720P
 * @param {boolean} params.watermark 是否加水印
 */
async function wanI2V(prompt, images, model, baseUrl, apiKey, params) {
    // 从 compatible-mode/v1 或 /v1 推回到 API 根，再拼百炼原生接口。
    // 用绝对路径，绕过画布 request 对相对路径自动补 /v1 的行为。
    const root = String(baseUrl || "").trim().replace(/\/+$/, "")
        .replace(/\/compatible-mode\/v1$/i, "")
        .replace(/\/api\/v1$/i, "")
        .replace(/\/v1$/i, "");
    if (!root) throw new Error("渠道接口地址为空");

    const createUrl = `${root}/api/v1/services/aigc/video-generation/video-synthesis`;
    const taskUrl = (id) => `${root}/api/v1/tasks/${encodeURIComponent(id)}`;

    const seconds = Number(params.seconds) || 10;
    const resolution = String(params.resolution || "720P").toUpperCase().includes("1080") ? "1080P" : "720P";

    const media = [];
    if (images && images.length) {
        media.push({ type: "first_frame", url: images[0] });
        if (images.length > 1) media.push({ type: "last_frame", url: images[1] });
    }
    if (!media.length) throw new Error("图生视频需要至少一张参考图");

    const headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
    };

    const created = await request({
        method: "POST",
        url: createUrl,
        headers,
        data: {
            model: model || "wan2.7-i2v",
            input: { prompt, media },
            parameters: {
                resolution,
                duration: seconds,
                prompt_extend: true,
                watermark: Boolean(params.watermark),
            },
        },
    });

    const taskId = created && created.output && created.output.task_id;
    if (!taskId) throw new Error("接口没有返回 task_id：" + JSON.stringify(created));

    // 视频要几分钟，15 秒查一次，最多等 15 分钟
    const videoUrl = await poll(
        () => request({ method: "GET", url: taskUrl(taskId), headers: { Authorization: `Bearer ${apiKey}` } }),
        (data) => {
            if (!data || !data.output) return null;
            const status = data.output.task_status;
            if (status === "FAILED") throw new Error("视频生成失败：" + (data.output.message || JSON.stringify(data.output)));
            if (status === "SUCCEEDED") {
                const out = data.output;
                const url = out.video_url || (out.result && (out.result.video_url || out.result.url)) || (out.videos && out.videos[0] && out.videos[0].url);
                if (!url) throw new Error("任务成功但没返回视频地址");
                return url;
            }
            return null;
        },
        { intervalMs: 15000, timeoutMs: 900000 },
    );

    return videoUrl;
}

return await wanI2V({ prompt, images, model, baseUrl, apiKey, params });
