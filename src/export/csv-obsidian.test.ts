import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { loadReportSummary } from "../core/report-payload.js";
import { findExportBundle, renderExport } from "./index.js";
import { csvCell } from "./text.js";
import type { Summary } from "./types.js";

/** RFC 4180 rows, enough to read back what the writer wrote. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(field), rows.push(row), (row = []), (field = ""), i++;
    } else field += ch;
  }
  return rows;
}

const load = (fixture: string) => loadReportSummary(resolve(__dirname, "../../test-output", fixture)) as Promise<Summary>;

describe("CSV exports", () => {
  it("quotes what would break a row and defuses what a spreadsheet would run", () => {
    expect(csvCell('a,b "c"\nd')).toBe('"a,b ""c""\nd"');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("@scope/pkg")).toBe("'@scope/pkg");
    expect(csvCell("-1")).toBe("-1");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(null)).toBe("");
    expect(parseCsv(`${["x", 'a,"b"', "c\nd"].map(csvCell).join(",")}\r\n`)).toEqual([["x", 'a,"b"', "c\nd"]]);
  });

  it("lists every route with its callers and what it reaches, and every entity with who reaches it", async () => {
    const summary = await load("sample-react");
    const routes = parseCsv(renderExport("routes.csv", summary));
    expect(routes[0]).toEqual(["kind", "method", "path", "handler", "file", "line", "project", "guards", "callers", "caller_files", "reaches"]);
    expect(routes.length - 1).toBe(summary.routeMap!.length);
    const del = routes.find((r) => r[1] === "DELETE" && r[2] === "/api/parts/:id")!;
    expect(del.slice(4, 7)).toEqual(["backend/src/routes/parts.ts", "31", "backend"]);
    expect(Number(del[8])).toBeGreaterThan(0);
    expect(del[10]).toContain("db-write parts");

    const entities = parseCsv(renderExport("entities.csv", summary));
    const parts = entities.find((r) => r[0] === "parts")!;
    expect(parts[8]).toContain("backend/src/db/parts.ts:36 removePart");
    expect(Number(parts[9])).toBe(4);
  });

  it("writes each graph as a node table and an edge table that agree", async () => {
    const summary = await load("sample-react");
    const nodes = parseCsv(renderExport("files.nodes.csv", summary));
    const edges = parseCsv(renderExport("files.edges.csv", summary));
    expect(nodes[0]!.slice(0, 3)).toEqual(["id", "label", "type"]);
    expect(edges[0]!.slice(0, 4)).toEqual(["source", "target", "type", "relation"]);
    const ids = new Set(nodes.slice(1).map((r) => r[0]));
    expect(edges.length).toBeGreaterThan(1);
    for (const e of edges.slice(1)) {
      expect(ids.has(e[0]) && ids.has(e[1]), `${e[0]} → ${e[1]}`).toBe(true);
      expect(e[2]).toBe("Directed");
    }
  });
});

describe("Obsidian vault", () => {
  it("writes a note per route, screen and entity, linked along screen → route → entity", async () => {
    const summary = await load("sample-react");
    const files = findExportBundle("obsidian")!.render(summary);
    const byPath = new Map(files.map((f) => [f.path, f.content]));
    expect(files[0]!.path).toBe("sample-react.md");
    expect(files.filter((f) => f.path.startsWith("Routes/")).length).toBe(summary.routeMap!.length);
    expect(files.filter((f) => f.path.startsWith("Screens/")).length).toBe(summary.screens!.length);
    expect(new Set(files.map((f) => f.path)).size).toBe(files.length);
    for (const f of files) expect(f.path, f.path).not.toMatch(/[\\:*?"<>|]/);

    const route = byPath.get("Routes/DELETE ∕api∕parts∕꞉id.md")!;
    expect(route).toMatch(/^---\ntype: "route"\nkind: "api"\nmethod: "DELETE"\npath: "\/api\/parts\/:id"\n/);
    expect(route).toContain("Declared at `backend/src/routes/parts.ts:31` in [[Sub-projects/backend|backend]].");
    expect(route).toContain("- db-write [[Entities/parts|parts]]");

    const entity = byPath.get("Entities/parts.md")!;
    expect(entity).toContain("## Reached by routes\n\n- [[Routes/DELETE ∕api∕parts∕꞉id|DELETE /api/parts/:id]]");

    // Every wikilink lands on a note the vault has.
    const notes = new Set(files.map((f) => f.path.replace(/\.md$/, "")));
    for (const f of files) {
      for (const m of f.content.matchAll(/\[\[([^|\]]+)\|/g)) expect(notes.has(m[1]!), `${f.path} → ${m[1]}`).toBe(true);
    }
  });
});
