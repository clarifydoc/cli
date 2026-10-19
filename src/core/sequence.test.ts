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

  it("caps depth and marks recursion instead of following it", () => {
    const text = buildSequence(backend, { file: "routes/users.ts", symbol: "route:GET /:id", title: "x" }, { depth: 1 });
    expect(text).toContain("depth 1 reached");
  });
});
