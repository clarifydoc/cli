import { describe, it, expect, beforeAll } from "vitest";
import { join } from "path";
import { loadReportSummary } from "./report-payload.js";
import { buildSequence, findRoutes, routeAnchor } from "./sequence.js";
import type { ProjectAnalysis } from "../types/analysis.js";

describe("buildSequence", () => {
  let backend: ProjectAnalysis;
  let cqrs: ProjectAnalysis;
  beforeAll(async () => {
    backend = await loadReportSummary(join("test-output", "sample-backend"));
    cqrs = await loadReportSummary(join("test-output", "sample-fullstack-cqrs"));
  });

  it("draws a route's calls in order, its data access, and returns", () => {
    const [r] = findRoutes(backend.routeMap, "GET /api/users/:id");
    const anchor = routeAnchor(r!, backend.symbolLinks)!;
    expect(anchor).toBe("route:GET /:id");
    const text = buildSequence(backend, { file: r!.filePath!, symbol: anchor, title: "GET /api/users/:id" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("sequenceDiagram");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at("getUserById()")).toBeGreaterThan(at("requireAuth()"));
    expect(at("prisma.user.findUnique")).toBeGreaterThan(at("getUserById()"));
    expect(text).toMatch(/-\)auth_ts: requireAuth\(\) \?/);
    expect(lines.at(-2)).toMatch(/-->>Client: response$/);
  });

  it("crosses into the tier that serves an HTTP call", () => {
    const text = buildSequence(cqrs, { file: "web/src/api/owners.ts", symbol: "listOwners", title: "listOwners" });
    expect(text).toContain("owners_ts->>OwnersController: HTTP GET /Owners");
    expect(text).toMatch(/GetOwnersQueryHandler->>DB_Owner: /);
  });

  it("draws a lane per directory with --lanes package, and keeps an expanded directory's classes", () => {
    const participants = (text: string) => text.split("\n").filter((l) => l.trim().startsWith("participant")).map((l) => l.replace(/^.* as /, ""));
    const byClass = participants(buildSequence(cqrs, { file: "web/src/api/owners.ts", symbol: "listOwners", title: "x" }));
    expect(byClass).toContain("OwnersController");
    const byPackage = participants(buildSequence(cqrs, { file: "web/src/api/owners.ts", symbol: "listOwners", title: "x" }, { lanes: "package" }));
    expect(byPackage).toContain("web/src/api/");
    expect(byPackage.some((p) => p.endsWith("/") && p.toLowerCase().includes("controller"))).toBe(true);
    expect(byPackage).not.toContain("OwnersController");
    const dir = byPackage.find((p) => p.endsWith("/") && p.toLowerCase().includes("controller"))!.replace(/\/$/, "");
    const expanded = participants(buildSequence(cqrs, { file: "web/src/api/owners.ts", symbol: "listOwners", title: "x" }, { lanes: "package", expand: [dir] }));
    expect(expanded).toContain("OwnersController");
    expect(expanded).toContain("web/src/api/");
  });

  it("caps depth and marks recursion instead of following it", () => {
    const text = buildSequence(backend, { file: "routes/users.ts", symbol: "route:GET /:id", title: "x" }, { depth: 1 });
    expect(text).toContain("depth 1 reached");
  });
});

describe("sequence frames", () => {
  it("wraps calls in the loops, branches and catches around them, from each function's control flow", async () => {
    const { sequenceFrames } = await import("./sequence-frames.js");
    const { sequenceFiles } = await import("./sequence.js");
    const pressure = await loadReportSummary(join("test-output", "sample-pressure"));
    const [r] = findRoutes(pressure.routeMap, "POST /orders/reconcile");
    const seed = { file: r!.filePath!, symbol: routeAnchor(r!, pressure.symbolLinks)! };
    const frames = await sequenceFrames(join("test-fixtures", "sample-pressure"), sequenceFiles(pressure, seed));
    const text = buildSequence(pressure, { ...seed, title: "POST /orders/reconcile" }, { frames });
    const lines = text.split("\n").map((l) => l.trim());
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    // rowToOrder() runs for each stuck row; authorizePayment() only for a positive total, inside the loop.
    expect(at("loop for (const row of stuck.rows)")).toBeGreaterThan(at("assertScope()"));
    expect(at("rowToOrder()")).toBeGreaterThan(at("loop for (const row of stuck.rows)"));
    expect(at("opt (order.total #gt; 0)")).toBeGreaterThan(at("rowToOrder()"));
    expect(at("authorizePayment()")).toBeGreaterThan(at("opt (order.total #gt; 0)"));
    // Every frame opened is closed.
    const opened = lines.filter((l) => /^(loop|alt|opt|break) /.test(l)).length;
    expect(lines.filter((l) => l === "end").length).toBe(opened);
    expect(opened).toBeGreaterThan(1);

    const unframed = buildSequence(pressure, { ...seed, title: "x" });
    expect(unframed).not.toMatch(/^\s*(loop|opt|alt|break) /m);
  });

  it("opens an else arm where the false branch begins, and closes frames as calls leave them", async () => {
    const summary = {
      symbolLinks: [
        { sourceFile: "a.ts", sourceSymbol: "run", sourceLine: 3, targetFile: "a.ts", targetSymbol: "one", targetLine: 20, callName: "one", relation: "call", confidence: "EXTRACTED" },
        { sourceFile: "a.ts", sourceSymbol: "run", sourceLine: 6, targetFile: "a.ts", targetSymbol: "two", targetLine: 21, callName: "two", relation: "call", confidence: "EXTRACTED" },
        { sourceFile: "a.ts", sourceSymbol: "run", sourceLine: 9, targetFile: "a.ts", targetSymbol: "three", targetLine: 22, callName: "three", relation: "call", confidence: "EXTRACTED" },
      ],
      symbolDataAccess: [],
    } as unknown as ProjectAnalysis;
    const frames = new Map([["a.ts", [{ kind: "alt" as const, label: "if (ok)", line: 2, endLine: 7, elseLine: 5 }]]]);
    const body = buildSequence(summary, { file: "a.ts", symbol: "run", title: "run" }, { frames }).split("\n").map((l) => l.trim()).filter((l) => !l.startsWith("participant"));
    expect(body.slice(3, 9)).toEqual(["alt if (ok)", "a_ts->>a_ts: one()", "else", "a_ts->>a_ts: two()", "end", "a_ts->>a_ts: three()"]);
  });
});
