import type { ExecutionGraph, GraphEdge, GraphNode, ObservableOperation } from "./types.ts";

const NODE_GAP_X = 196;
const NODE_GAP_Y = 108;

export function graphFromTrace(root: ObservableOperation): ExecutionGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const levels = new Map<string, number>();
  const order: ObservableOperation[] = [];

  const walk = (node: ObservableOperation, depth: number) => {
    levels.set(node.id, depth);
    order.push(node);
    for (const child of node.children) {
      edges.push({ from: node.id, to: child.id });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);

  const byLevel = new Map<number, ObservableOperation[]>();
  for (const node of order) {
    const depth = levels.get(node.id) ?? 0;
    const list = byLevel.get(depth) ?? [];
    list.push(node);
    byLevel.set(depth, list);
  }

  const maxWidth = Math.max(1, ...[...byLevel.values()].map((list) => list.length));
  for (const [depth, list] of byLevel) {
    const offset = ((maxWidth - list.length) * NODE_GAP_X) / 2;
    list.forEach((node, index) => {
      nodes.push({
        id: node.id,
        type: node.type,
        name: node.name,
        status: node.status,
        runId: node.runId,
        parentId: node.parentId,
        durationMs: node.durationMs,
        attempt: node.attempt,
        x: offset + index * NODE_GAP_X,
        y: depth * NODE_GAP_Y,
      });
    });
  }

  return { nodes, edges };
}

export function flattenOperations(root: ObservableOperation): ObservableOperation[] {
  const out: ObservableOperation[] = [];
  const walk = (node: ObservableOperation) => {
    out.push(node);
    node.children.forEach(walk);
  };
  walk(root);
  return out;
}
