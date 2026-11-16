import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A CommonJS barrel states its names with `module.exports = { build }` over what it `require`d: a
 * call through it reaches the module that defines the name, never a namesake beside it.
 */
const FILES: Record<string, string> = {
  "package.json": `{"name":"league"}\n`,
  "thing.js": `function build() { return 1; }\nmodule.exports = { build };\n`,
  "decoy.js": `function build() { return 2; }\nfunction rename() { return 3; }\nmodule.exports = { build, rename };\n`,
  "maker.js": `function make() { return 4; }\nmodule.exports = make;\n`,
  "barrel.js": `const { build } = require('./thing');\nconst maker = require('./maker');\nmodule.exports = { build, forge: maker };\n`,
  "main.js": `const { build, forge } = require('./barrel');\nfunction run() { build(); }\nfunction runForge() { forge(); }\n`,
};

describe("CommonJS barrel re-export", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-cjs-barrel-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const target = (symbol: string, callName: string) => {
    const l = summary.symbolLinks.find((x) => x.sourceFile === "main.js" && x.sourceSymbol === symbol && x.callName === callName);
    return l ? `${l.targetFile}::${l.targetSymbol}` : null;
  };

  it("follows a destructured name through the barrel to its definition", () => {
    expect(target("run", "build")).toBe("thing.js::build");
  });

  it("follows a renamed key whose value is a required module's default", () => {
    expect(target("runForge", "forge")).toBe("maker.js::make");
  });

  it("never links the namesake beside the barrel", () => {
    expect(summary.symbolLinks.filter((l) => l.targetFile === "decoy.js" && l.sourceFile === "main.js")).toEqual([]);
  });
});
