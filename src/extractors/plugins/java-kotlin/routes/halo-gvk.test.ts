import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/** Real-repo FP: 11 extension kinds whose `@GVK` group is a sibling class's constant had no CRUD routes (66). */
const FILES: Record<string, string> = {
  "build.gradle": "plugins { id 'java' }\n",
  "src/main/java/com/example/league/content/Constant.java": `package com.example.league.content;

public enum Constant {
    ;

    public static final String GROUP = "content.league.example.com";
    public static final String VERSION = "v1alpha1";
}
`,
  "src/main/java/com/example/league/content/Club.java": `package com.example.league.content;

@GVK(group = Constant.GROUP, version = Constant.VERSION, kind = Club.KIND, plural = "clubs", singular = "club")
public class Club extends AbstractExtension {
    public static final String KIND = "Club";
}
`,
};

describe("@GVK CRUD routes whose group is another class's constant", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-halo-gvk-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("are served at the constants' values", () => {
    const routes = summary.routeMap.filter((r) => r.filePath.endsWith("Club.java")).map((r) => `${r.httpMethod} ${r.path}`);
    expect(routes).toEqual([
      "GET /apis/content.league.example.com/v1alpha1/clubs",
      "POST /apis/content.league.example.com/v1alpha1/clubs",
      "GET /apis/content.league.example.com/v1alpha1/clubs/{name}",
      "PUT /apis/content.league.example.com/v1alpha1/clubs/{name}",
      "PATCH /apis/content.league.example.com/v1alpha1/clubs/{name}",
      "DELETE /apis/content.league.example.com/v1alpha1/clubs/{name}",
    ]);
  });
});
