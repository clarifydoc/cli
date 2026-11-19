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
    const [r] = findRoutes(backend.routeMap, "GET /api/players/:id");
    const anchor = routeAnchor(r!, backend.symbolLinks)!;
    expect(anchor).toBe("route:GET /:id");
    const text = buildSequence(backend, { file: r!.filePath!, symbol: anchor, title: "GET /api/players/:id" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("sequenceDiagram");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at("getPlayerById()")).toBeGreaterThan(at("requireAuth()"));
    expect(at("prisma.player.findUnique")).toBeGreaterThan(at("getPlayerById()"));
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
    const text = buildSequence(backend, { file: "routes/players.ts", symbol: "route:GET /:id", title: "x" }, { depth: 1 });
    expect(text).toContain("depth 1 reached");
  });
});

describe("sequence frames", () => {
  it("wraps calls in the loops, branches and catches around them, from each function's control flow", async () => {
    const { sequenceFrames } = await import("./sequence-frames.js");
    const { sequenceFiles } = await import("./sequence.js");
    const pressure = await loadReportSummary(join("test-output", "sample-pressure"));
    const [r] = findRoutes(pressure.routeMap, "POST /cars/reconcile");
    const seed = { file: r!.filePath!, symbol: routeAnchor(r!, pressure.symbolLinks)! };
    const frames = await sequenceFrames(join("test-fixtures", "sample-pressure"), sequenceFiles(pressure, seed));
    const text = buildSequence(pressure, { ...seed, title: "POST /cars/reconcile" }, { frames });
    const lines = text.split("\n").map((l) => l.trim());
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    // rowToCar() runs for each stuck row; authorizePayment() only for a positive total, inside the loop.
    expect(at("loop for (const row of stuck.rows)")).toBeGreaterThan(at("assertScope()"));
    expect(at("rowToCar()")).toBeGreaterThan(at("loop for (const row of stuck.rows)"));
    expect(at("opt (car.total #gt; 0)")).toBeGreaterThan(at("rowToCar()"));
    expect(at("authorizePayment()")).toBeGreaterThan(at("opt (car.total #gt; 0)"));
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

describe("routeAnchor with registrars", () => {
  const link = (sourceSymbol: string) => ({ sourceFile: "api/routes.go", sourceSymbol }) as unknown as Parameters<typeof routeAnchor>[1][number];
  const links = [link("route:GET /items @registerClubs"), link("route:GET /items @registerPlayers"), link("route:GET /items")];
  it("gives each registrar's row its own anchor", () => {
    const row = { httpMethod: "GET", path: "/items", filePath: "api/routes.go" };
    expect(routeAnchor({ ...row, registrar: "registerClubs" }, links)).toBe("route:GET /items @registerClubs");
    expect(routeAnchor({ ...row, registrar: "registerPlayers" }, links)).toBe("route:GET /items @registerPlayers");
    expect(routeAnchor(row, links)).toBe("route:GET /items");
    expect(routeAnchor({ ...row, registrar: "registerCars" }, links)).toBeNull();
  });
});

describe("buildSequence and a shared component", () => {
  const link = (sf: string, ss: string, tf: string, ts: string, extra: object = {}) =>
    ({ sourceFile: sf, sourceSymbol: ss, sourceLine: 1, callName: ts, targetFile: tf, targetSymbol: ts, targetLine: 1, confidence: "EXTRACTED", ...extra });
  const dialog = "src/ui/ConfirmDialog.tsx";
  const summary = {
    symbolLinks: [
      link("src/pages/ClubPage.tsx", "ClubPage", dialog, "ConfirmDialog", { relation: "calls" }),
      link("src/pages/ClubPage.tsx", "(reference)", dialog, "ConfirmDialog", { strategy: "dispatch:renders", relation: "reference" }),
      link("src/pages/PlayerPage.tsx", "(reference)", dialog, "ConfirmDialog", { strategy: "dispatch:renders", relation: "reference" }),
      link(dialog, "ConfirmDialog", "src/pages/ClubPage.tsx", "dropClub", { strategy: "dispatch:prop-callback", relation: "dispatch", viaUsage: [{ file: "src/pages/ClubPage.tsx", line: 4 }] }),
      link(dialog, "ConfirmDialog", "src/pages/PlayerPage.tsx", "dropPlayer", { strategy: "dispatch:prop-callback", relation: "dispatch", viaUsage: [{ file: "src/pages/PlayerPage.tsx", line: 4 }] }),
    ],
  } as unknown as ProjectAnalysis;

  it("leaves a shared child through the binding its entering page made, not another page's", () => {
    const text = buildSequence(summary, { file: "src/pages/ClubPage.tsx", symbol: "ClubPage", title: "ClubPage" });
    expect(text).toContain("dropClub()");
    expect(text).not.toContain("dropPlayer()");
  });
});
