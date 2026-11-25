import { expect, test } from "bun:test";
import { classifyFailure } from "./publication-account-bridge";

test("登录失效优先识别，避免盲目重试", () => {
    expect(classifyFailure(1, "Error: cookie missing or expired", false).kind).toBe("expired");
    expect(classifyFailure(1, "请先登录后再上传", false).kind).toBe("expired");
    expect(classifyFailure(1, "login required", false).kind).toBe("expired");
});

test("超时提示先确认是否已发出，防止重复发布", () => {
    const failure = classifyFailure(-1, "", true);
    expect(failure.kind).toBe("timeout");
    expect(failure.hint).toContain("创作者后台");
});

test("网络问题归为可自动重试", () => {
    expect(classifyFailure(1, "ECONNRESET", false).kind).toBe("transient");
    expect(classifyFailure(1, "request timed out", false).kind).toBe("transient");
});

test("未知失败把最后一行日志当原因", () => {
    const failure = classifyFailure(3, "step 1 ok\n上传失败：文件损坏\n", false);
    expect(failure.kind).toBe("unknown");
    expect(failure.hint).toContain("文件损坏");
});
