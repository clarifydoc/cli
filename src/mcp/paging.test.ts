import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { bulletList, page, pageFooter } from "./format.js";
import { askTool } from "./ask.js";

describe("paging", () => {
  const items = Array.from({ length: 10 }, (_, i) => `r${i}`);
  it("pages a list and says which offset comes next, where it ends, or that it ran past the end", () => {
    const first = page(items, 0, 4);
    expect([first.shown, pageFooter(first, 10)]).toEqual([["r0", "r1", "r2", "r3"], "  … 6 more — next page: `offset=4`"]);
    const mid = page(items, 4, 4);
    expect(pageFooter(mid, 10, "more", "or filter")).toBe("  … 2 more (showing 5–8 of 10) — next page: `offset=8`, or filter");
    expect(pageFooter(page(items, 8, 4), 10)).toBe("  (end of the list: 9–10 of 10)");
    expect(pageFooter(page(items, 40, 4), 10)).toBe("  (offset 40 is past the end: 10 in all — start again at offset=0)");
    expect(pageFooter(page(items, 0, 20), 10)).toBe("");
  });
  it("keeps the old tail on a nested list nobody pages", () => {
    expect(bulletList(items, 2, (x) => x).at(-1)).toBe("  … 8 more (raise `limit` to see them)");
    expect(bulletList(items, 2, (x) => x, { offset: 2 }).at(-1)).toBe("  … 6 more (showing 3–4 of 10) — next page: `offset=4`");
  });
});

const analysisDir = resolve("test-output/sample-backend");
describe.skipIf(!existsSync(join(analysisDir, "project-summary.json")))("paged tools", () => {
  const config = { projectRoot: resolve("test-fixtures/sample-backend"), analysisDir, allowAnalyze: false, allowColdStart: false };
  it("walks every route a page at a time, each seen once", async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < 100; offset += 5) {
      const { text } = await askTool(config, "routes", { limit: 5, offset });
      const rows = text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.replace(/ \(.*$/, ""));
      seen.push(...rows);
      if (!/next page: `offset=/.test(text)) break;
    }
    const all = (await askTool(config, "routes", { limit: 500 })).text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.replace(/ \(.*$/, ""));
    expect(seen).toEqual(all);
  });
});
