import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A JVM import names the package a file DECLARES. `legacy/Club.java` declares `com.example.league` though no
 * directory spells it, and a mirrored `com/example/garage/Club.java` is a namesake of another package.
 */
describe("JVM imports resolve by the declared package, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-declared-package-"));
    const java = join(dir, "java", "src", "main", "java");
    const kotlin = join(dir, "kotlin", "src", "main", "kotlin");
    for (const [root, ext] of [[java, "java"], [kotlin, "kt"]] as const) {
      await mkdir(join(root, "legacy"), { recursive: true });
      await mkdir(join(root, "com", "example", "garage"), { recursive: true });
      await mkdir(join(root, "com", "example", "staff"), { recursive: true });
      if (ext === "java") {
        await writeFile(join(root, "legacy", "Club.java"), `package com.example.league;\npublic class Club { public void promote() {} }\n`);
        await writeFile(join(root, "com", "example", "garage", "Club.java"), `package com.example.garage;\npublic class Club { public void promote() {} }\n`);
        await writeFile(join(root, "com", "example", "staff", "Coach.java"),
          `package com.example.staff;\nimport com.example.league.Club;\npublic class Coach { public void run(Club c) { c.promote(); } }\n`);
      } else {
        await writeFile(join(root, "legacy", "Club.kt"), `package com.example.league\nclass Club { fun promote() {} }\n`);
        await writeFile(join(root, "com", "example", "garage", "Club.kt"), `package com.example.garage\nclass Club { fun promote() {} }\n`);
        await writeFile(join(root, "com", "example", "staff", "Coach.kt"),
          `package com.example.staff\nimport com.example.league.Club\nclass Coach { fun run(c: Club) { c.promote() } }\n`);
      }
    }
    for (const name of ["java", "kotlin"]) {
      await analyze({ projectRoot: join(dir, name), outputDir: join(dir, `out-${name}`), lsp: false, gitHistory: false, stableOutput: true });
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ["java", "src/main/java", "java"],
    ["kotlin", "src/main/kotlin", "kt"],
  ])("%s: the import and the call reach the declaring file, not the mirrored namesake", async (name, root, ext) => {
    const summary = await loadReportSummary(join(dir, `out-${name}`));
    const coach = `${root}/com/example/staff/Coach.${ext}`;
    const links = (summary.symbolLinks ?? []).filter((l) => l.sourceFile === coach);
    const targets = new Set(links.map((l) => l.targetFile));
    expect(targets).toContain(`${root}/legacy/Club.${ext}`);
    expect(targets).not.toContain(`${root}/com/example/garage/Club.${ext}`);
  });
});
