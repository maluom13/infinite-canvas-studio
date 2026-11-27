/**
 * 阿里云百炼「万相 2.7 图生视频」适配脚本。
 *
 * 用途：画布默认的 OpenAI 格式请求 /v1/videos，阿里云不认（会 404）。
 * 这个脚本改用阿里云自己的接口：
 *   创建：POST /api/v1/services/aigc/video-generation/video-synthesis
 *   查询：GET  /api/v1/tasks/{task_id}
 *
 * 怎么用：
 *   1. 在画布「配置 → 渠道」里编辑 wan2.7 这个渠道
 *   2. 接口地址填你的百炼 endpoint，例如：
 *      https://<你的WorkspaceId>.cn-beijing.maas.aliyuncs.com/api/v1
 *      （注意：结尾是 /api/v1，不是 /v1；脚本会用 request 原样拼接，不再自动加 /v1）
 *   3. 模型名填 wan2.7-i2v-2026-04-25
 *   4. 打开这个模型的「自定义脚本」，把本文件全文粘进去
 *   5. API Key 填百炼的 sk- 开头的 Key
 *
 * 说明：首帧图直接用 dataURL 传给阿里云（官方支持，无需公网 URL）。
 */

/**
 * 生成图生视频任务并等待结果。
 * @param {string} prompt 用户提示词
 * @param {string[]} images 参考图 dataURL 数组，第一张作为首帧
 * @param {string} model 模型名
 * @param {string} baseUrl 渠道接口地址（原样，已含 /api/v1）
 * @param {string} apiKey 百炼 API Key
 * @param {object} params 生成参数
 * @param {number} params.seconds 视频时长（秒）
 * @param {string} params.resolution 分辨率，如 720P
 * @param {boolean} params.watermark 是否加水印
 */
async function wan27I2V(prompt, images, model, baseUrl, apiKey, params) {
    const seconds = params.seconds || 10;
    const resolution = (params.resolution || "720P").toUpperCase().includes("1080") ? "1080P" : "720P";

    // 关键：画布的 request 对相对路径会自动补 /v1，所以这里拼成绝对 URL 绕过它。
    // baseUrl 传进来是原样的（例如 https://xxx.cn-beijing.maas.aliyuncs.com/api/v1），
    // 去掉可能的结尾斜杠后直接拼阿里云的完整路径。
    const root = String(baseUrl || "").trim().replace(/\/+$/, "");
    const createUrl = `${root}/services/aigc/video-generation/video-synthesis`;
    const taskUrl = (id) => `${root}/tasks/${id}`;
    const media = [];
    if (images && images.length) {
        media.push({ type: "first_frame", url: images[0] });
        if (images.length > 1) media.push({ type: "last_frame", url: images[1] });
    }

    const body = {
        model: model || "wan2.7-i2v-2026-04-25",
        input: { prompt, media },
        parameters: {
            resolution,
            duration: seconds,
            prompt_extend: true,
            watermark: Boolean(params.watermark),
        },
    };

    const created = await request({
        method: "POST",
        url: createUrl,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
        },
        data: body,
    });

    const taskId = created && created.output && created.output.task_id;
    if (!taskId) throw new Error("阿里云没有返回 task_id：" + JSON.stringify(created));

    // 轮询任务，extract 返回真值即结束
    const result = await poll(
        () => request({
            method: "GET",
            url: taskUrl(taskId),
            headers: { Authorization: `Bearer ${apiKey}` },
        }),
        (data) => {
            if (!data || !data.output) return null;
            const status = data.output.task_status;
            if (status === "FAILED") throw new Error("视频生成失败：" + (data.output.message || JSON.stringify(data.output)));
            if (status === "SUCCEEDED") {
                const video = data.output.video_url || (data.output.result && data.output.result.video_url);
                if (!video) throw new Error("任务成功但没有返回视频地址");
                return video;
            }
            return null;
        },
        { intervalMs: 15000, timeoutMs: 900000 },
    );

    return result;
}

return await wan27I2V({ prompt, images, model, baseUrl, apiKey, params });
