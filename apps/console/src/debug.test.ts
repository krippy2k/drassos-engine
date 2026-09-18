import { describe, expect, it } from "vitest";
import {
  descendantIds,
  filterEvents,
  flattenTree,
  formatDuration,
  graphBounds,
  reconnectDelay,
  visibleGraph,
} from "./debug.ts";

describe("console debugger helpers", () => {
  it("filters timeline events by type", () => {
    const events = [
      { seq: 1, type: "workflow.started", timestamp: "t" },
      { seq: 2, type: "agent.started", timestamp: "t" },
      { seq: 3, type: "workflow.failed", timestamp: "t" },
    ];
    expect(filterEvents(events, "failed")).toHaveLength(1);
    expect(filterEvents(events, "")).toHaveLength(3);
  });

  it("formats durations and reconnect backoff", () => {
    expect(formatDuration(12)).toBe("12 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(reconnectDelay(0)).toBe(400);
    expect(reconnectDelay(4)).toBe(6400);
    expect(reconnectDelay(20)).toBe(8000);
  });

  it("collapses nested graph operations and computes a view box", () => {
    const graph = {
      nodes: [
        { id: "w", x: 0, y: 0, parentId: null },
        { id: "a", x: 0, y: 100, parentId: "w" },
        { id: "m", x: 0, y: 200, parentId: "a" },
      ],
      edges: [
        { from: "w", to: "a" },
        { from: "a", to: "m" },
      ],
    };
    expect([...descendantIds(graph.edges, "a")]).toEqual(["m"]);
    const collapsed = visibleGraph(graph, new Set(["a"]));
    expect(collapsed.nodes.map((node) => node.id)).toEqual(["w", "a"]);
    const bounds = graphBounds(graph.nodes);
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  });

  it("flattens a trace tree for inspector selection", () => {
    const ops = flattenTree({
      id: "w",
      type: "workflow",
      name: "tour",
      children: [{ id: "a", type: "agent", name: "researcher", children: [] }],
    });
    expect(ops.map((item) => item.id)).toEqual(["w", "a"]);
  });
});
