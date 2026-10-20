import { describe, it, expect } from "vitest";
import { join } from "path";
import { loadReportSummary } from "./report-payload.js";
import { checkCitations, factId, factsOf, routeFactId } from "./fact-ids.js";

describe("fact IDs", () => {
  it("hash a line-free key: the same fact keeps its ID when its line moves", () => {
    const route = { httpMethod: "GET", path: "/api/users/:id", filePath: "routes/users.ts" };
    expect(routeFactId({ ...route })).toBe(routeFactId({ ...route }));
    expect(routeFactId(route)).toMatch(/^R-[0-9a-f]{6}$/);
    expect(routeFactId({ ...route, path: "/api/users" })).not.toBe(routeFactId(route));
    expect(factId("entity", "User @ models/user.ts")).toMatch(/^E-[0-9a-f]{6}$/);
  });

  it("cover routes, links, entities and data access, and check a document's citations", async () => {
    const summary = await loadReportSummary(join("test-output", "sample-backend"));
    const facts = factsOf(summary);
    const kinds = new Set([...facts.values()].map((f) => f.kind));
    expect([...kinds].sort()).toEqual(expect.arrayContaining(["access", "entity", "route"]));
    // Unique within the project.
    expect(new Set(facts.keys()).size).toBe(facts.size);
    const r = summary.routeMap.find((x) => x.httpMethod === "GET" && x.path === "/api/users/:id")!;
    const id = routeFactId(r);
    expect(facts.get(id)).toMatchObject({ kind: "route", text: expect.stringContaining("GET /api/users/:id"), file: r.filePath });
    const doc = `The user lookup is served by [${id}].\nIt also mentions [R-000000], which does not exist, and [${id}] again.`;
    expect(checkCitations(doc, facts)).toEqual([
      { id, fact: expect.objectContaining({ kind: "route" }), line: 1 },
      { id: "R-000000", fact: null, line: 2 },
    ]);
  });
});
