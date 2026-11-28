import { describe, expect, test } from "bun:test";

import { extractMultipartImage } from "../local/multipart-image";

/** 造一张足够大的假 PNG（提取逻辑会拒绝小于 100 字节的）。 */
function fakePng(size = 512) {
    const bytes = Buffer.alloc(size);
    // PNG 头，让内容看起来像真图
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    for (let i = 8; i < size; i += 1) bytes[i] = i % 251;
    return bytes;
}

/** 用浏览器同款 FormData 序列化，确保测试跑的是真实格式。 */
async function serialize(form: FormData): Promise<Buffer> {
    const request = new Request("http://localhost/doubao/v1/videos", { method: "POST", body: form });
    return Buffer.from(await request.arrayBuffer());
}

describe("extractMultipartImage", () => {
    test("浏览器 FormData：name 后带 filename 也能取到图", async () => {
        const png = fakePng();
        const form = new FormData();
        form.append("prompt", "让画面动起来");
        form.append("image[]", new Blob([png], { type: "image/png" }), "ref_1.png");
        form.append("images", new Blob([png], { type: "image/png" }), "ref_1.png");

        const raw = await serialize(form);
        const result = extractMultipartImage(raw);

        expect(result).toBeDefined();
        expect(result!.ext).toBe("png");
        expect(result!.bytes.length).toBe(png.length);
        // 逐字节比对，确认二进制没被编码破坏
        expect(Buffer.compare(result!.bytes, png)).toBe(0);
    });

    test("只有 images 字段（首帧模式）也能取到", async () => {
        const png = fakePng();
        const form = new FormData();
        form.append("prompt", "首帧");
        form.append("first_frame", new Blob([png], { type: "image/png" }), "first.png");
        form.append("images", new Blob([png], { type: "image/png" }), "first.png");

        const result = extractMultipartImage(await serialize(form));
        expect(result).toBeDefined();
        expect(result!.bytes.length).toBe(png.length);
    });

    test("jpeg 识别成 jpg", async () => {
        const jpg = fakePng();
        const form = new FormData();
        form.append("prompt", "x");
        form.append("images", new Blob([jpg], { type: "image/jpeg" }), "ref.jpg");

        const result = extractMultipartImage(await serialize(form));
        expect(result!.ext).toBe("jpg");
    });

    test("只有提示词、没有图片 → 返回 undefined", async () => {
        const form = new FormData();
        form.append("prompt", "纯文字，没有参考图");
        form.append("size", "720x1280");

        expect(extractMultipartImage(await serialize(form))).toBeUndefined();
    });

    test("图片字段太小（不像真图）→ 返回 undefined", async () => {
        const form = new FormData();
        form.append("prompt", "x");
        form.append("images", new Blob([Buffer.from("tiny")], { type: "image/png" }), "t.png");

        expect(extractMultipartImage(await serialize(form))).toBeUndefined();
    });

    test("空请求体不抛错", () => {
        expect(extractMultipartImage(Buffer.alloc(0))).toBeUndefined();
    });
});
