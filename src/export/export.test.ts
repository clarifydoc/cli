import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { loadReportSummary } from "../core/report-payload.js";
import { EXPORT_FORMATS, findExportFormat, renderExport } from "./index.js";

describe("exports", () => {
  it("renders every format from a fixture summary", async () => {
    const summary = await loadReportSummary(resolve(__dirname, "../../test-output/sample-microservices"));
    expect(EXPORT_FORMATS.map((f) => f.name)).toContain("ARCHITECTURE.md");
    for (const f of EXPORT_FORMATS) {
      const text = renderExport(f.name, summary);
      expect(text.length, f.name).toBeGreaterThan(20);
    }
    expect(renderExport("context.mmd", summary)).toMatch(/^%% ClarifyDoc — Sub-projects/);
    expect(findExportFormat("flows.md")?.name).toBe("FLOWS.md");
    expect(() => renderExport("nope.txt", summary)).toThrow(/Unknown export/);
  });
});
