import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCanvasToolRequest } from "./operations.js";

function opsOf(name: Parameters<typeof buildCanvasToolRequest>[0], input: Record<string, unknown>) {
    const request = buildCanvasToolRequest(name, input, null);
    return (request.input as { ops: Array<Record<string, any>> }).ops;
}

test("generation flow reuses referenced nodes when the prompt only mentions them", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "@[node:text-1]", referenceNodeIds: ["text-1"], title: "Flow", autoRun: true });
    const addedTextNodes = ops.filter((op) => op.type === "add_node" && op.nodeType === "text");
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    const runs = ops.filter((op) => op.type === "run_generation");
    assert.equal(addedTextNodes.length, 0);
    assert.equal(ops.filter((op) => op.type === "connect_nodes" && op.fromNodeId === "text-1" && String(op.toNodeId).startsWith("config-")).length, 1);
    assert.match(String(config?.metadata?.prompt), /^@\[node:text-1\]$/);
    assert.equal(runs.length, 1);
});

test("generation flow still creates a prompt node for prose prompts", () => {
    const ops = opsOf("canvas_generate_image", { prompt: "a cat on a roof", referenceNodeIds: ["text-1"], autoRun: true });
    assert.equal(ops.filter((op) => op.type === "add_node" && op.nodeType === "text").length, 1);
    const config = ops.find((op) => op.type === "add_node" && op.nodeType === "config");
    assert.match(String(config?.metadata?.prompt), /@\[node:text-/);
});

test("video reference images default to reference mode while explicit first/last frame mode is preserved", () => {
    const state = { nodes: [{ id: "character", type: "image" as const, position: { x: 0, y: 0 }, width: 100, height: 100 }, { id: "scene", type: "image" as const, position: { x: 0, y: 0 }, width: 100, height: 100 }] };
    const input = { prompt: "同一角色走入场景", referenceNodeIds: ["character", "scene"] };
    const getOps = (extra: Record<string, unknown> = {}) => (buildCanvasToolRequest("canvas_generate_video", { ...input, ...extra }, state).input as { ops: Array<Record<string, any>> }).ops;
    const reference = getOps();
    assert.equal(reference.find((op) => op.nodeType === "config")?.metadata.videoMode, "reference");
    assert.deepEqual(reference.filter((op) => op.type === "connect_nodes" && ["character", "scene"].includes(op.fromNodeId)).map((op) => op.fromNodeId), ["character", "scene"]);
    assert.equal(getOps({ videoMode: "frames" }).find((op) => op.nodeType === "config")?.metadata.videoMode, "frames");
});
