import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { loadReportSummary } from "../core/report-payload.js";
import { EXPORT_FORMATS, findExportFormat, renderExport } from "./index.js";

describe("exports", () => {
  it("renders every format from a fixture summary", async () => {
    const summary = await loadReportSummary(resolve(__dirname, "../../test-output/sample-microservices"));
    expect(EXPORT_FORMATS.map((f) => f.name)).toContain("ARCHITECTURE.md");
    // The fixture's services keep their data elsewhere: the entity and data-access tables are their header only.
    const empty = new Set([
      ...(summary.entityGraph?.nodes.length ? [] : ["entities.nodes.csv"]),
      ...(summary.dataAccessGraph?.nodes.length ? [] : ["data-access.nodes.csv"]),
    ]);
    for (const f of EXPORT_FORMATS) {
      const text = renderExport(f.name, summary);
      if (empty.has(f.name)) expect(text.trim().split("\n"), f.name).toHaveLength(1);
      else expect(text.length, f.name).toBeGreaterThan(20);
    }
    expect(renderExport("context.mmd", summary)).toMatch(/^%% ClarifyDoc — Sub-projects/);
    expect(findExportFormat("flows.md")?.name).toBe("FLOWS.md");
    expect(() => renderExport("nope.txt", summary)).toThrow(/Unknown export/);
  });
});

describe("FLOWS.md", () => {
  it("says where each route parameter's value starts on the client", () => {
    const route = { kind: "api", path: "/api/v2/clubs/{id}", httpMethod: "GET", handler: "Get", line: 20, filePath: "api/ClubsController.cs" };
    const summary = {
      routeMap: [route],
      apiRouteLinks: [{ source: "web/client/sdk.gen.ts", sourceLine: 2, method: "GET", url: "/clubs/{id}", target: "api/ClubsController.cs", targetLine: 20, handler: "Get", routePath: "/api/v2/clubs/{id}", confidence: "EXTRACTED" }],
      paramOrigins: [
        {
          sink: { file: "web/client/sdk.gen.ts", line: 2, url: "/clubs/{id}", slot: "id" },
          origin: { kind: "route-param", name: "clubId", file: "web/views/ClubView.vue", line: 4, screen: "ClubView", routePath: "/clubs/:clubId", inRoutePath: true },
          hops: [{ file: "web/views/ClubView.vue", symbol: "<setup>", line: 4, arg: 0 }, { file: "web/client/queries/clubs.ts", symbol: "clubQuery", line: 3, arg: 0, field: "path.id" }],
          route: { file: "api/ClubsController.cs", line: 20, method: "GET", path: "/api/v2/clubs/{id}", param: "id" },
        },
        {
          sink: { file: "web/client/sdk.gen.ts", line: 2, url: "/clubs/{id}", slot: "id" },
          origin: { kind: "unknown", file: "web/client/queries/clubs.ts", line: 8 },
          hops: [{ file: "web/client/queries/clubs.ts", symbol: "deleteClub", line: 8, arg: 0, field: "path.id" }],
          route: { file: "api/ClubsController.cs", line: 20, method: "GET", path: "/api/v2/clubs/{id}", param: "id" },
        },
      ],
    };
    const text = renderExport("FLOWS.md", summary as never);
    expect(text).toContain("**Parameters fed by**");
    expect(text).toMatch(/\| `id` \| route parameter `clubId` of ClubView \(`\/clubs\/:clubId`\) \| .*ClubView\.vue.*4.* \| <setup> → clubQuery \|/);
    expect(text).toContain("`id`: 1 caller hands the value on through code the analysis does not follow.");
  });
});
