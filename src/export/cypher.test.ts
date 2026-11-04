import { describe, it, expect } from "vitest";
import { toCypher } from "./cypher.js";
import type { ExportGraph } from "./graph-model.js";

function graph(partial: Partial<ExportGraph>): ExportGraph {
  return { kind: "classes", description: "Classes.", directed: true, nodes: [], edges: [], ...partial };
}

describe("toCypher", () => {
  it("merges a node on its id alone, then sets its type label and properties", () => {
    const text = toCypher(
      graph({ nodes: [{ id: "src/Club.java", label: "Club", type: "Class", attrs: { path: "src/Club.java" } }] }),
      "league",
      "2026-01-01",
    );
    // A MERGE pattern carrying the type label would duplicate the node when another
    // export (or a later run) gives the same id another type.
    expect(text).toContain(
      "MERGE (n:`ClarifyDoc` {id: 'src/Club.java'}) SET n:`Class`, n += {label: 'Club', path: 'src/Club.java'};",
    );
    expect(text).not.toMatch(/MERGE \(n:`ClarifyDoc`:`Class`/);
  });

  it("keeps parallel relationships of one type apart by a key, so a reload neither duplicates nor collapses them", () => {
    const nodes = [
      { id: "club", label: "Club", type: "Entity", attrs: {} },
      { id: "player", label: "Player", type: "Entity", attrs: {} },
    ];
    const edges = [
      { source: "club", target: "player", relation: "RELATES_TO", attrs: { fields: "players" } },
      { source: "club", target: "player", relation: "RELATES_TO", attrs: { fields: "captain" } },
      { source: "player", target: "club", relation: "RELATES_TO", attrs: { fields: "club" } },
    ];
    const text = toCypher(graph({ nodes, edges }), "league", "2026-01-01");
    expect(text).toContain("MERGE (a)-[r:`RELATES_TO` {key: 0}]->(b)\nSET r += {fields: 'players'};");
    expect(text).toContain("MERGE (a)-[r:`RELATES_TO` {key: 1}]->(b)\nSET r += {fields: 'captain'};");
    // A single relationship between its endpoints needs no key.
    expect(text).toContain("MERGE (a)-[r:`RELATES_TO`]->(b)\nSET r += {fields: 'club'};");
    // Deterministic: the same graph renders the same script.
    expect(toCypher(graph({ nodes, edges }), "league", "2026-01-01")).toBe(text);
  });
});
