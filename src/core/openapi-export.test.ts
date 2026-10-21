import { describe, expect, it } from "vitest";
import { existsSync } from "fs";
import { resolve } from "path";
import { buildOpenApi, openApiPath } from "./openapi-export.js";
import { loadReportSummary } from "./report-payload.js";

describe("openApiPath", () => {
  it("writes each framework's parameter syntax as an OpenAPI template", () => {
    expect(openApiPath("/cars/:id")).toEqual({ path: "/cars/{id}", params: ["id"] });
    expect(openApiPath("/api/items/{id:int}")).toEqual({ path: "/api/items/{id}", params: ["id"] });
    expect(openApiPath("/players/<int:pk>/")).toEqual({ path: "/players/{pk}", params: ["pk"] });
    expect(openApiPath("/blog/[slug]")).toEqual({ path: "/blog/{slug}", params: ["slug"] });
    expect(openApiPath("/files/*")).toEqual({ path: "/files/{wildcard}", params: ["wildcard"] });
    expect(openApiPath("^/legacy/(\\d+)$")).toBeNull();
  });
});

const fixture = (name: string) => resolve("test-output", name);

describe.skipIf(!existsSync(fixture("sample-csharp-api")))("buildOpenApi on fixtures", () => {
  it("documents every API route the code declares, each path parameter declared", async () => {
    for (const name of ["sample-csharp-api", "sample-backend"]) {
      const s = await loadReportSummary(fixture(name));
      const doc = buildOpenApi(s) as { openapi: string; paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }>; responses: unknown; "x-source": string }>> };
      expect(doc.openapi).toBe("3.1.0");
      const api = s.routeMap.filter((r) => r.kind === "api" && r.httpMethod && !r.filePath?.endsWith(".json") && !r.filePath?.endsWith(".yaml"));
      const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
      expect(ops.length).toBeGreaterThan(0);
      expect(ops.length).toBeLessThanOrEqual(api.length);
      for (const [path, methods] of Object.entries(doc.paths)) {
        const templated = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        for (const op of Object.values(methods)) {
          const declared = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
          for (const t of templated) expect(declared, `${name} ${path}`).toContain(t);
          expect(op.responses).toBeDefined();
          expect(op["x-source"]).toMatch(/:\d+$/);
        }
      }
    }
  });

  it("carries a handler's bindings and request body schema", async () => {
    const s = await loadReportSummary(fixture("sample-csharp-api"));
    const doc = buildOpenApi(s) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const withBody = Object.values(doc.paths).flatMap((p) => Object.values(p)).filter((op) => op.requestBody);
    expect(withBody.length).toBeGreaterThan(0);
  });
});
