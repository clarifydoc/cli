import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { askTool } from "../mcp/ask.js";

/**
 * The key a file's twin class is looked up by (`Builder@L3`) is an index detail: it never reaches a written symbol
 * link, a summary row (field writes and reads, thrown types, signatures, top symbols) or an MCP answer.
 */
const FILES: Record<string, string> = {
  "Shop.java": [
    "public class Shop {",
    "  public static class Left {",
    "    public static class Builder {",
    "      private int size;",
    "      public Builder() {}",
    "      public void build() { this.size = 3; if (size > 9) { throw new IllegalStateException(); } }",
    "    }",
    "  }",
    "  public static class Right {",
    "    public static class Builder {",
    "      private int size;",
    "      public Builder() {}",
    "      public void build() { this.size = 4; }",
    "    }",
    "  }",
    "  void go() {",
    "    Left.Builder l = new Left.Builder();",
    "    l.build();",
    "    Right.Builder r = new Right.Builder();",
    "    r.build();",
    "  }",
    "}",
    "",
  ].join("\n"),
  "seats.rb": `module Stadium
  class Seat
    def rank; end
  end
end

module Fans
  class Seat
    def rank; end
  end
end

class Dispatcher
  def go
    stadium_seat = Stadium::Seat.new
    stadium_seat.rank
    fans_seat = Fans::Seat.new
    fans_seat.rank
  end
end
`,
};

describe("a twin class's key stays out of every output", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-twin-guard-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const KEY = /@L\d+/;

  it("is in no file the run wrote (links, summary rows, report data, per-file results)", async () => {
    const walk = async (d: string): Promise<string[]> =>
      (await Promise.all((await readdir(d, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])))).flat();
    const files = (await walk(join(dir, "out"))).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(2);
    for (const f of files) expect(KEY.test(await readFile(f, "utf8")), f).toBe(false);
  });

  it("is in no MCP answer about a twin", async () => {
    const config = { projectRoot: join(dir, "app"), analysisDir: join(dir, "out"), allowAnalyze: false, allowColdStart: false };
    const asks: Array<[string, Record<string, unknown>]> = [
      ["trace", { symbol: "Shop.Left.Builder.build", direction: "callers" }],
      ["trace", { symbol: "Stadium.Seat.rank", direction: "callers" }],
      ["explain", { symbol: "Shop.Right.Builder.build" }],
      ["search", { query: "Builder" }],
      ["extract", { symbol: "Fans.Seat.rank" }],
      ["blast_radius", { file: "Shop.java" }],
    ];
    for (const [tool, args] of asks) {
      const r = await askTool(config, tool, args);
      expect(KEY.test(r.text), `${tool} ${JSON.stringify(args)}`).toBe(false);
    }
  });
});
