import { describe, it, expect } from "vitest";
import { boundLines, fileBound, leafOf, routeBoundLine, routeLiteralPattern, symbolBound } from "./caller-bounds.js";
import type { ToolContext } from "./context.js";
import type { LoadedAnalysis } from "../store.js";
import type { FileAnalysis, ProjectAnalysis } from "../../types/analysis.js";

const call = (name: string, line: number, extra: object = {}) => ({ name, kind: "internal", target: null, line, ...extra });

// The workshop calls `renew` on receivers the linker could not type; one `renew` call did resolve.
const FILES: Record<string, Partial<FileAnalysis>> = {
  "src/garage.ts": {
    exports: [{ name: "Garage", kind: "class" }, { name: "renew", kind: "function" }] as never,
    classes: [{ name: "Garage", methods: [{ name: "renew", calls: [] }] }] as never,
    diBindings: [{ service: "IGarage", implementation: "Garage", line: 3 }] as never,
  },
  "src/workshop.ts": { functions: [{ name: "service", calls: [call("car.renew", 10), call("fleet.renew", 11), call("garage.renew", 12), call("db.query", 13, { kind: "database" })] }] as never },
  "src/workshop.test.ts": { functions: [{ name: "t", calls: [call("x.renew", 4)] }] as never },
};

function setup() {
  const summary = {
    fileProjects: Object.fromEntries(Object.keys(FILES).map((f) => [f, "root"])),
    symbolLinks: [{ sourceFile: "src/workshop.ts", sourceSymbol: "service", sourceLine: 12, callName: "garage.renew", targetFile: "src/garage.ts", targetSymbol: "Garage.renew", targetLine: 5, confidence: "EXTRACTED" }],
    classGraph: undefined,
  } as unknown as ProjectAnalysis;
  const ctx = { store: { projectRoot: "/nowhere", fileAnalysis: async (f: string) => (FILES[f] as FileAnalysis) ?? null } } as unknown as ToolContext;
  const loaded = { summary, index: { byFile: new Map() } } as unknown as LoadedAnalysis;
  return { ctx, loaded };
}

describe("caller bounds", () => {
  it("counts unresolved calls named like the member, minus the resolved site, tests said apart", async () => {
    const { ctx, loaded } = setup();
    const b = await symbolBound(ctx, loaded, "src/garage.ts", "Garage.renew");
    expect(b.unresolvedNamed).toBe(3);
    expect(b.reasons[0]).toContain("3 calls named `renew` elsewhere did not resolve");
    expect(b.reasons[0]).toContain("(1 in tests)");
    expect(b.reasons[0]).toContain("src/workshop.ts:10, src/workshop.ts:11, src/workshop.test.ts:4");
    expect(b.reasons.join("\n")).toContain("built by 1 container registration (IGarage at src/garage.ts:3)");
    expect(boundLines("`Garage.renew()`", b)[0]).toContain("a lower bound, not a proof");
  });

  it("states the bound even when nothing hides a caller", async () => {
    const { ctx, loaded } = setup();
    const b = await symbolBound(ctx, loaded, "src/garage.ts", "Garage.park");
    expect(b.reasons.filter((r) => r.includes("named `park`"))).toEqual([]);
    expect(boundLines("`park`", { reasons: [], unresolvedNamed: 0 }).join("\n")).toContain("a lower bound");
  });

  it("a file's bound sums unresolved calls named like its exports", async () => {
    const { ctx, loaded } = setup();
    const b = await fileBound(ctx, loaded, "src/garage.ts");
    expect(b.unresolvedNamed).toBe(3);
    expect(b.reasons[0]).toContain("3 unresolved calls elsewhere are named like an export");
  });

  it("reads a call's leaf in every spelling", () => {
    expect([leafOf("a.b.find"), leafOf("Club::find"), leafOf("$club->find"), leafOf("find()")]).toEqual(["find", "find", "find", "find"]);
  });

  it("matches a route's path as a client writes it, not a longer path or a prefixed one", () => {
    const re = routeLiteralPattern("/api/clubs/:id")!;
    expect(re.test("get(`/api/clubs/${id}`)")).toBe(true);
    expect(re.test('get("/api/clubs/" + id)')).toBe(true);
    expect(re.test('get("/api/clubs")')).toBe(false);
    expect(re.test('get("/v2/api/clubs/7")')).toBe(false);
    expect(routeLiteralPattern("/:id")).toBeNull();
    expect(routeBoundLine({ files: [], searchable: true, scanned: 12, capped: false })).toContain("no analysed file holds its path");
  });
});
