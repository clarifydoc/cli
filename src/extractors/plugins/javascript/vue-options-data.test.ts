import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A Vue Options API component's `data()` member built by a construction types `this.<member>` in its methods,
 * computed, watchers and hooks (real-repo FP: `settings: new Settings(…)`, then `this.settings.save()` on change).
 * Decoys: a member `data()` starts as `null`, a namesake class in a file the component does not import, and a
 * plain object's `this` outside any component.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0" } }),
  "src/model/club.js": `export class Club {
  save() { return fetch("/api/clubs", { method: "PUT" }); }
}
`,
  "src/legacy/club.js": `export class Club {
  save() { return fetch("/legacy/clubs"); }
}
`,
  "src/ClubSettings.vue": `<template><button @click="onChange">Save</button></template>
<script>
import { Club } from "./model/club";
export default {
  data() {
    return { club: new Club(), rival: null, title: "Club" };
  },
  watch: {
    title() { this.club.save(); },
  },
  methods: {
    onChange() {
      this.club
        .save()
        .then(() => {});
    },
    onRival() { this.rival.save(); },
  },
};
</script>
`,
  "src/plain.js": `export const helper = {
  run() { return this.club.save(); },
};
`,
};

const linksFrom = (s: ProjectAnalysis, file: string): string[] =>
  (s.symbolLinks ?? [])
    .filter((l) => l.sourceFile === file && l.strategy !== "reference")
    .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol}`);

describe("Vue Options API data() members typing this", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-vue-options-data-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links this.club.save in a method and a watcher to the class data() constructs, never the namesake", () => {
    const rows = linksFrom(summary, "src/ClubSettings.vue");
    expect(rows).toContain("onChange -this.club.save-> src/model/club.js#Club.save");
    expect(rows).toContain("title -this.club.save-> src/model/club.js#Club.save");
    expect(rows.filter((r) => r.includes("legacy"))).toEqual([]);
  });

  it("types nothing from a null member, and nothing outside a component", () => {
    expect(linksFrom(summary, "src/ClubSettings.vue").filter((r) => r.startsWith("onRival"))).toEqual([]);
    expect(linksFrom(summary, "src/plain.js").filter((r) => r.includes("Club.save"))).toEqual([]);
  });
});
