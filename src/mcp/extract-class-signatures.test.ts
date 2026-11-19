/** `clarifydoc_extract` on a class: the whole body when it fits the budget, its member signatures when it does not. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
import { buildMcpServer } from "./server.js";

let root = "";
let server: ReturnType<typeof buildMcpServer>["server"];

async function extract(args: Record<string, unknown>): Promise<string> {
  const r = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clarifydoc_extract", arguments: args } })) as { result: { content: Array<{ text: string }> } };
  return r.result.content[0]!.text;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "clarifydoc-extract-sig-"));
  let big = "class MatchReport:\n    home_goals: int = 0\n\n";
  for (let i = 0; i < 40; i++) {
    big += `    def record_goal_${i}(self, minute: int, scorer: str) -> int:\n        total = minute + ${i}\n        if scorer:\n            total += 1\n        return total\n\n`;
  }
  await writeFile(join(root, "report.py"), `${big}\nclass Garage:\n    def park(self, car):\n        return car\n`, "utf-8");
  ({ server } = buildMcpServer({ projectRoot: root, analysisDir: join(root, ".clarifydoc", basename(root)), allowAnalyze: true, allowColdStart: true }));
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("clarifydoc_extract on a class", () => {
  it("returns member signatures, not a cut body, when the class does not fit the budget", async () => {
    const text = await extract({ symbol: "MatchReport", maxTokens: 300 });
    expect(text).toContain("member signatures");
    expect(text).toContain("def record_goal_0(self, minute: int, scorer: str) -> int:");
    expect(text).toContain("home_goals: int");
    expect(text).not.toContain("total = minute + 0");
    expect(text).not.toContain("cut at the budget");
    expect(text).toMatch(/… \d+ more members?/);
  });

  it("prints a class that fits the budget whole, as before", async () => {
    const text = await extract({ symbol: "Garage" });
    expect(text).toContain("## Garage() — report.py:");
    expect(text).toContain("def park(self, car):\n        return car");
    expect(text).not.toContain("member signatures");
  });
});
