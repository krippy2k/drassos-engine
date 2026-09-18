export interface GraphLike {
  nodes: Array<{ id: string; x: number; y: number; parentId: string | null }>;
  edges: Array<{ from: string; to: string }>;
}

export interface HistoryLike {
  id?: string;
  seq: number;
  type: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) {
    return "—";
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  if (ms < 3_600_000) {
    return `${Math.round(ms / 60_000)} m`;
  }
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export function filterEvents(events: HistoryLike[], typeFilter: string): HistoryLike[] {
  const needle = typeFilter.trim().toLowerCase();
  if (!needle) {
    return events;
  }
  return events.filter((event) => event.type.toLowerCase().includes(needle));
}

export function descendantIds(edges: Array<{ from: string; to: string }>, rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    const list = children.get(edge.from) ?? [];
    list.push(edge.to);
    children.set(edge.from, list);
  }
  const out = new Set<string>();
  const walk = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (out.has(child)) {
        continue;
      }
      out.add(child);
      walk(child);
    }
  };
  walk(rootId);
  return out;
}

export function visibleGraph<T extends GraphLike>(graph: T, collapsed: Set<string>): T {
  const hidden = new Set<string>();
  for (const id of collapsed) {
    for (const child of descendantIds(graph.edges, id)) {
      hidden.add(child);
    }
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => !hidden.has(node.id)),
    edges: graph.edges.filter((edge) => !hidden.has(edge.from) && !hidden.has(edge.to)),
  };
}

export function graphBounds(nodes: Array<{ x: number; y: number }>, pad = 48): {
  minX: number;
  minY: number;
  width: number;
  height: number;
} {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, width: 800, height: 320 };
  }
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const maxX = Math.max(...xs) + pad + 160;
  const maxY = Math.max(...ys) + pad + 56;
  return { minX, minY, width: Math.max(320, maxX - minX), height: Math.max(220, maxY - minY) };
}

export function reconnectDelay(attempt: number): number {
  return Math.min(8_000, 400 * 2 ** Math.max(0, attempt));
}

export function nodeKindColor(kind: string): string {
  switch (kind) {
    case "workflow":
      return "#e08a4a";
    case "agent":
      return "#7ea4d9";
    case "model":
      return "#d6b25e";
    case "tool":
      return "#87b089";
    case "mcp":
      return "#6bb8a8";
    case "human":
      return "#d36b6b";
    case "child":
      return "#c08bd6";
    case "timer":
      return "#9a927f";
    case "activity":
      return "#8aa4c8";
    default:
      return "#efe7d6";
  }
}

export function statusFill(status: string | undefined): string {
  const value = (status ?? "").toLowerCase();
  if (value === "completed" || value === "fired") {
    return "rgba(135, 176, 137, 0.22)";
  }
  if (value === "failed" || value === "timed_out" || value === "cancelled") {
    return "rgba(211, 107, 107, 0.22)";
  }
  if (value === "waiting" || value === "suspended" || value === "retrying") {
    return "rgba(224, 138, 74, 0.2)";
  }
  if (value === "running" || value === "queued") {
    return "rgba(126, 164, 217, 0.2)";
  }
  return "rgba(44, 51, 66, 0.8)";
}

export interface FlattenedOperation {
  id: string;
  type: string;
  name: string;
  children?: FlattenedOperation[];
  [key: string]: unknown;
}

export function flattenTree(root: FlattenedOperation | null | undefined): FlattenedOperation[] {
  if (!root) {
    return [];
  }
  const out: FlattenedOperation[] = [];
  const walk = (node: FlattenedOperation) => {
    out.push(node);
    (node.children ?? []).forEach((child) => walk(child as FlattenedOperation));
  };
  walk(root);
  return out;
}
