import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

import { getGroupWrapRect } from "./canvas-node-geometry";

/**
 * 横向保持紧凑、纵向多留白：行与行要能一眼分开，列与列只需要不粘连。
 * 之前 80/80 太散（整块太宽），后来压到 40/40 又糊成一块，这里取中间值。
 */
const COLUMN_GAP = 48;
const ROW_GAP = 64;
const SECTION_GAP = 200;
/** 每列最多排几行，满了向右换一列。竖排 6 个大约是一屏能扫完的长度，太长就得一直往下滚。 */
const ROWS_PER_COLUMN = 6;

export function organizeLayout(nodes: CanvasNodeData[], connections: CanvasConnection[], selected: Set<string>) {
    let result = nodes;
    for (const group of nodes.filter((node) => node.type === CanvasNodeType.Group && (!selected.size || selected.has(node.id)))) {
        const members = result.filter((node) => node.metadata?.groupId === group.id && node.type !== CanvasNodeType.Group);
        if (members.length < 2) continue;
        const local = members.map((node) => ({ ...node, metadata: { ...node.metadata, groupId: undefined } }));
        const arranged = organizeLooseLayout(local, connections, new Set());
        if (!arranged) continue;
        const box = getGroupWrapRect(arranged);
        const memberIds = new Set(members.map((node) => node.id));
        const obstacles = result.filter((node) => node.id !== group.id && !memberIds.has(node.id));
        let dx = 0;
        let obstacle: CanvasNodeData | undefined;
        while ((obstacle = obstacles.find((node) => box.x + dx < node.position.x + node.width + COLUMN_GAP && box.x + dx + box.width + COLUMN_GAP > node.position.x && box.y < node.position.y + node.height + COLUMN_GAP && box.y + box.height + COLUMN_GAP > node.position.y))) dx = obstacle.position.x + obstacle.width + COLUMN_GAP - box.x;
        const positions = new Map(arranged.map((node) => [node.id, { x: node.position.x + dx, y: node.position.y }]));
        result = result.map((node) => node.id === group.id ? { ...node, position: { x: box.x + dx, y: box.y }, width: box.width, height: box.height } : positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node);
    }
    const loose = organizeLooseLayout(result, connections, selected);
    return loose || (result !== nodes ? result : null);
}

/** Local layout by connections only; no image recognition or semantic labels. */
function organizeLooseLayout(nodes: CanvasNodeData[], connections: CanvasConnection[], selected: Set<string>) {
    const chosen = nodes.filter((node) => (selected.size ? selected.has(node.id) : true) && node.type !== CanvasNodeType.Group && !node.metadata?.groupId);
    if (chosen.length < 2) return null;
    const ids = new Set(chosen.map((node) => node.id));
    const byId = new Map(chosen.map((node) => [node.id, node]));
    const incoming = new Map<string, string[]>(), outgoing = new Map<string, string[]>();
    for (const edge of connections) {
        if (!ids.has(edge.fromNodeId) || !ids.has(edge.toNodeId)) continue;
        incoming.set(edge.toNodeId, [...(incoming.get(edge.toNodeId) || []), edge.fromNodeId]);
        outgoing.set(edge.fromNodeId, [...(outgoing.get(edge.fromNodeId) || []), edge.toNodeId]);
    }
    type FlowRow = { text: CanvasNodeData[]; config: CanvasNodeData[]; result: CanvasNodeData[] };
    const sections = new Map<string, FlowRow[]>(), used = new Set<string>();
    const addRow = (project: string, category: number, row: FlowRow) => {
        const key = `${project}\0${category}`;
        sections.set(key, [...(sections.get(key) || []), row]);
        [...row.text, ...row.config, ...row.result].forEach((node) => used.add(node.id));
    };
    const order = (a: CanvasNodeData, b: CanvasNodeData) => a.position.x - b.position.x || a.position.y - b.position.y;
    for (const config of chosen.filter((node) => node.type === CanvasNodeType.Config).sort(order)) {
        const sources = (incoming.get(config.id) || []).map((id) => byId.get(id)).filter((node): node is CanvasNodeData => Boolean(node && !used.has(node.id) && (node.type === CanvasNodeType.Text || ([CanvasNodeType.Image, CanvasNodeType.Video].includes(node.type as CanvasNodeType) && (outgoing.get(node.id)?.length || 0) === 1)))).sort(order);
        const results = (outgoing.get(config.id) || []).map((id) => byId.get(id)).filter((node): node is CanvasNodeData => Boolean(node && [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio].includes(node.type as CanvasNodeType) && !used.has(node.id))).sort(order);
        addRow("画布", 0, { text: sources, config: [config], result: results });
    }
    for (const node of chosen.filter((item) => !used.has(item.id)).sort(order)) {
        addRow("画布", 0, { text: node.type === CanvasNodeType.Text ? [node] : [], config: [], result: node.type === CanvasNodeType.Text ? [] : [node] });
    }
    const projects = ["画布"];
    const positions = new Map<string, { x: number; y: number }>();
    const fixed = nodes.filter((node) => !ids.has(node.id));
    let left = Math.min(...chosen.map((node) => node.position.x));
    const startTop = Math.min(...chosen.map((node) => node.position.y));
    for (const project of projects) for (let category = 0; category < 10; category++) {
        const sectionRows = sections.get(`${project}\0${category}`); if (!sectionRows?.length) continue;
        const keys = ["text", "config", "result"] as const;
        for (let start = 0; start < sectionRows.length; start += ROWS_PER_COLUMN) {
            // 每列都从同一高度起排，满了往右换列，避免排成一条看不到底的长竖列
            const top = startTop;
            const rows = sectionRows.slice(start, start + ROWS_PER_COLUMN);
            // 每组单独算列宽和行高：只有 1 张图的流程不再被别的流程撑出 3 个空槽位，
            // 特别高的节点也只影响它所在的那一组。
            const slots = keys.flatMap((key) => {
                const count = Math.max(0, ...rows.map((row) => row[key].length));
                return Array.from({ length: count }, (_, index) => ({ key, index, width: Math.max(0, ...rows.map((row) => row[key][index]?.width || 0)) }));
            });
            // 行高按行各算各的：整组共用最大高度时，一个长文本节点会把所有行一起撑开，
            // 矮节点之间就会空出一大块。这里只让真正高的那一行占高度。
            const rowHeights = rows.map((row) => {
                const heights = keys.flatMap((key) => row[key].map((node) => node.height));
                return heights.length ? Math.max(...heights) : 0;
            });
            const rowTops: number[] = [];
            let cursor = top;
            rowHeights.forEach((height) => {
                rowTops.push(cursor);
                cursor += height + ROW_GAP;
            });
            const sectionWidth = slots.reduce((sum, slot) => sum + slot.width + COLUMN_GAP, 0) - COLUMN_GAP;
            const sectionHeight = rowTops.length ? rowTops[rowTops.length - 1] + rowHeights[rowHeights.length - 1] - top : 0;
            let collision: CanvasNodeData | undefined;
            while ((collision = fixed.find((node) => left < node.position.x + node.width + COLUMN_GAP && left + sectionWidth + COLUMN_GAP > node.position.x && top < node.position.y + node.height + COLUMN_GAP && top + sectionHeight + COLUMN_GAP > node.position.y))) left = collision.position.x + collision.width + COLUMN_GAP;
            rows.forEach((row, index) => {
                let x = left;
                const y = rowTops[index];
                slots.forEach(({ key, index: slotIndex, width }) => {
                    const node = row[key][slotIndex];
                    if (node) positions.set(node.id, { x: x + (width - node.width) / 2, y });
                    x += width + COLUMN_GAP;
                });
            });
            // 换到右边一列，而不是继续往下长
            left += sectionWidth + SECTION_GAP;
        }
    }
    // 排完后整体平移，让整理前后的包围盒中心重合：否则内容会从原位置整体跳到左上角。
    const placed = nodes.filter((node) => positions.has(node.id));
    if (!placed.length) return null;
    const beforeLeft = Math.min(...chosen.map((node) => node.position.x));
    const beforeTop = Math.min(...chosen.map((node) => node.position.y));
    const beforeRight = Math.max(...chosen.map((node) => node.position.x + node.width));
    const beforeBottom = Math.max(...chosen.map((node) => node.position.y + node.height));
    const afterLeft = Math.min(...placed.map((node) => positions.get(node.id)!.x));
    const afterTop = Math.min(...placed.map((node) => positions.get(node.id)!.y));
    const afterRight = Math.max(...placed.map((node) => positions.get(node.id)!.x + node.width));
    const afterBottom = Math.max(...placed.map((node) => positions.get(node.id)!.y + node.height));
    const dx = (beforeLeft + beforeRight) / 2 - (afterLeft + afterRight) / 2;
    const dy = (beforeTop + beforeBottom) / 2 - (afterTop + afterBottom) / 2;
    return nodes.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, position: { x: position.x + dx, y: position.y + dy } } : node;
    });
}
