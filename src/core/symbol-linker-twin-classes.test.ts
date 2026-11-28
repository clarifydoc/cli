import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A file that declares one class name twice (two nested `Builder`s, `Garage::Table` and `League::Table`) keys each
 * declaration on its own: a typed local, a parameter or a construction lands on the member of the twin the
 * type names — never the later one, never a top-level namesake.
 */
const FILES: Record<string, string> = {
  "Shop.java": [
    "public class Shop {",
    "  public static class Left {",
    "    public static class Builder {",
    "      public Builder() {}",
    "      public void build() {}",
    "    }",
    "  }",
    "  public static class Right {",
    "    public static class Builder {",
    "      public Builder() {}",
    "      public void build() {}",
    "    }",
    "  }",
    "  void go() {",
    "    Left.Builder l = new Left.Builder();",
    "    l.build();",
    "    Right.Builder r = new Right.Builder();",
    "    r.build();",
    "  }",
    "  void take(Left.Builder p) { p.build(); }",
    "}",
    "",
  ].join("\n"),
  "Builder.java": "public class Builder { public void build() {} }\n",
};

describe("a file declaring one class name twice", () => {
  let dir: string;
  let links: Array<{ sourceFile: string; sourceLine: number; callName: string; targetFile: string; targetSymbol: string; targetLine: number }>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-twin-classes-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    links = ((await loadReportSummary(join(dir, "out"))).symbolLinks ?? []) as typeof links;
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const at = (line: number, callName: string) => links.find((l) => l.sourceFile === "Shop.java" && l.sourceLine === line && l.callName === callName);

  it("lands a typed local's member on the twin its type names", () => {
    expect(at(16, "l.build")).toMatchObject({ targetFile: "Shop.java", targetSymbol: "Shop.Left.Builder.build", targetLine: 5 });
    expect(at(18, "r.build")).toMatchObject({ targetFile: "Shop.java", targetSymbol: "Shop.Right.Builder.build", targetLine: 11 });
    expect(at(20, "p.build")).toMatchObject({ targetFile: "Shop.java", targetLine: 5 });
  });

  it("constructs the twin written through its owner", () => {
    expect(at(15, "new Left.Builder")).toMatchObject({ targetFile: "Shop.java", targetLine: 4 });
    expect(at(17, "new Right.Builder")).toMatchObject({ targetFile: "Shop.java", targetLine: 10 });
  });

  it("never reaches the top-level namesake", () => {
    expect(links.filter((l) => l.sourceFile === "Shop.java" && l.targetFile === "Builder.java")).toEqual([]);
  });
});
