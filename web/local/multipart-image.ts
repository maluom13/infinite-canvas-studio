/**
 * 从 multipart/form-data 请求体里取出第一张图片。
 *
 * 为什么单独放一个文件：这段逻辑曾经写错（要求 name 引号后立刻换行，
 * 而浏览器实际会带 `; filename="..."`），结果图明明传了却被判成「没有参考图」。
 * 抽出来是为了能被测试直接覆盖，避免再犯。
 */

export type MultipartImage = { bytes: Buffer; ext: string };

const NAME_PATTERN = /Content-Disposition:[^\r\n]*name="(?:images|image\[\])"[^\r\n]*\r\n((?:[^\r\n]+\r\n)*)\r\n/i;

function extFromContentType(contentType: string) {
    const value = contentType.trim().toLowerCase();
    if (value.includes("png")) return "png";
    if (value.includes("webp")) return "webp";
    if (value.includes("bmp")) return "bmp";
    return "jpg";
}

/** 取第一张参考图；没有就返回 undefined。 */
export function extractMultipartImage(raw: Buffer): MultipartImage | undefined {
    // 按 latin1 读，保证二进制不被 UTF-8 破坏（byte 与字符一一对应）
    const text = raw.toString("binary");
    const head = NAME_PATTERN.exec(text);
    if (!head) return undefined;

    const start = head.index + head[0].length;
    let end = text.indexOf("\r\n--", start);
    if (end < 0) end = text.length;

    const typeMatch = /Content-Type:\s*([^\r\n;]+)/i.exec(head[1]);
    const ext = extFromContentType(typeMatch ? typeMatch[1] : "");
    const bytes = Buffer.from(text.slice(start, end), "binary");
    if (bytes.length < 100) return undefined;
    return { bytes, ext };
}
