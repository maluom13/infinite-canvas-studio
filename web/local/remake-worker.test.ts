import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runJob, saveJob, type WorkerDependencies } from "./remake-worker";
import type { RemakeJob } from "./remake-types";
import { buildRemakePrompt, parseFaceAnalysis } from "./remake-face-prompt";
import { tempPath } from "./runtime-paths";

async function fixture() {
    const dir = await mkdtemp(tempPath("remake-test-"));
    const job: RemakeJob = { id: "test", projectId: "test", sourceId: "source", prompt: "test", model: "muse-video", modelOption: "muse-video", ratio: "16:9", resolution: "720p", size: "1280x720", generateAudio: true, watermark: false, x: 0, y: 0, width: 320, height: 180, state: "queued", segments: [], createdAt: new Date().toISOString() };
    await saveJob(dir, job);
    const read = async (): Promise<RemakeJob> => JSON.parse(await readFile(path.join(dir, "job.json"), "utf8"));
    const events: string[] = [];
    const deps: WorkerDependencies = {
        analyze: async () => ({ summary: "没有人物", subjects: [] }),
        split: async () => [{ start: 0, end: 10 }, { start: 10, end: 12 }],
        submit: async (_job, index) => { events.push(`submit:${index}`); return `task-${index}`; },
        poll: async (id) => { events.push(`poll:${id}`); return { state: "completed", width: 1280, height: 720 }; },
        delay: async () => {},
    };
    return { dir, job, read, deps, events };
}
test("segments run sequentially and completed work is not resubmitted after restart", async () => {
    const f = await fixture(); await runJob(f.dir, f.deps);
    assert.deepEqual(f.events, ["submit:0", "poll:task-0", "submit:1", "poll:task-1"]);
    const job = await f.read(); assert.equal(job.state, "completed"); assert.equal(job.segments[1].end - job.segments[1].start, 2);
    await runJob(f.dir, f.deps); assert.equal(f.events.length, 4);
});
test("query failure preserves task ID; resume queries existing task", async () => {
    const f = await fixture();
    await runJob(f.dir, { ...f.deps, poll: async () => { throw new Error("offline"); } });
    assert.equal((await f.read()).state, "paused"); assert.equal((await f.read()).segments[0].taskId, "task-0");
    await runJob(f.dir, f.deps); assert.equal(f.events.filter((event) => event === "submit:0").length, 1);
    assert.equal((await f.read()).state, "completed");
});
test("unknown submission result never automatically submits again", async () => {
    const f = await fixture(); let submissions = 0;
    const deps = { ...f.deps, submit: async () => { submissions++; throw new Error("connection lost after upload"); } };
    await runJob(f.dir, deps); await runJob(f.dir, deps);
    assert.equal(submissions, 1); assert.match((await f.read()).error!, /提交结果未知/);
});
test("stop during a segment finishes it and does not submit the next", async () => {
    const f = await fixture();
    await runJob(f.dir, { ...f.deps, poll: async () => { await writeFile(path.join(f.dir, "pause"), ""); return { state: "completed" }; } });
    const job = await f.read(); assert.equal(job.state, "paused"); assert.equal(job.segments[0].state, "completed"); assert.equal(job.segments[1].state, "pending");
    assert.deepEqual(f.events, ["submit:0"]);
});
test("provider failure pauses batch and explicit retry preserves completed segments", async () => {
    const f = await fixture();
    await runJob(f.dir, { ...f.deps, poll: async (id) => ({ state: id === "task-1" ? "failed" : "completed" }) });
    assert.equal((await f.read()).segments[0].state, "completed"); assert.equal((await f.read()).state, "paused");
    await writeFile(path.join(f.dir, "retry"), ""); await runJob(f.dir, f.deps);
    assert.equal(f.events.filter((event) => event === "submit:0").length, 1);
    assert.equal(f.events.filter((event) => event === "submit:1").length, 2);
    assert.equal((await f.read()).state, "completed");
});
test("different people retain their own covering rules", () => {
    const analysis = parseFaceAnalysis({ summary: "两个人分别戴头套和打码", subjects: [
        { subject: "左侧黑衣人物", kind: "hood", detail: "黑色布头套，仅露眼睛" },
        { subject: "右侧白衣人物", kind: "mosaic", detail: "面部方块马赛克" },
    ] });
    const prompt = buildRemakePrompt("五官与原片完全一致", analysis);
    assert.match(prompt, /左侧黑衣人物/); assert.match(prompt, /右侧白衣人物/);
    assert.match(prompt, /不把马赛克改成头套/); assert.match(prompt, /不补出被遮挡的人脸/);
    assert.match(prompt, /优先于上文/);
});
test("visible and uncertain faces do not request invented masks", () => {
    const prompt = buildRemakePrompt("复刻", { summary: "部分不可判断", subjects: [
        { subject: "前景人物", kind: "visible", detail: "脸清晰可见" },
        { subject: "远处人物", kind: "uncertain", detail: "距离过远" },
    ] });
    assert.match(prompt, /不额外添加头套/); assert.match(prompt, /不猜测模糊区域下的脸/);
    assert.throws(() => parseFaceAnalysis({ summary: "x", subjects: [{ subject: "x", kind: "invented", detail: "x" }] }));
});
test("analysis failure pauses before submitting to Muse", async () => {
    const f = await fixture();
    await runJob(f.dir, { ...f.deps, analyze: async () => { throw new Error("analysis offline"); } });
    assert.equal((await f.read()).state, "paused"); assert.equal((await f.read()).segments[0].state, "pending"); assert.deepEqual(f.events, []);
});
test("analysis and actual submitted prompt persist across resume", async () => {
    const f = await fixture(); let analyzed = 0;
    const deps = { ...f.deps, analyze: async () => { analyzed++; return { summary: "戴头套", subjects: [{ subject: "人物", kind: "hood" as const, detail: "蓝色头套" }] }; }, poll: async () => { throw new Error("offline"); } };
    await runJob(f.dir, deps);
    const saved = await f.read(); assert.match(saved.segments[0].generationPrompt!, /蓝色头套/);
    await runJob(f.dir, deps); assert.equal(analyzed, 1); assert.equal(f.events.filter((v) => v === "submit:0").length, 1);
});
