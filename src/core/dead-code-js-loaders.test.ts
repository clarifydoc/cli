import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * JS/TS files loaded without a plain import — a computed name, a Vue `<script src>`, a script a CI
 * pipeline or Makefile runs, a `bin/` script with no `bin` field, a folder of migrations, a code
 * generator's output — are not unreachable. Every group has a file nothing loads, which stays reported.
 * Labels written by hand from the sources below.
 */
const FILES: Record<string, string> = {
  "package.json": '{"name":"club-app","main":"src/main.ts"}',
  "src/main.ts": `import path from "path";
import Club from "./Club.vue";
export async function load(n: string, mode: string) {
  await import(\`./plugins/\${n}\`);
  await import("./cars/" + n);
  const g = require(\`./garages/\${n}.js\`);
  return [Club, g, path.resolve("configs", \`config.\${mode}.ts\`)];
}
`,
  "src/plugins/striker.ts": `import "../shared/kit"; export const striker = 1;`,
  "src/shared/kit.ts": "export const kit = 1;",
  "src/cars/estate.ts": "export const estate = 1;",
  "src/garages/north.js": "exports.north = 1;",
  "configs/config.dev.ts": "export default {};",
  "src/Club.vue": `<template><div>club</div></template>\n<script lang="ts" src="./club.ts"></script>\n`,
  "src/club.ts": `import "./clubKit"; export default {};`,
  "src/clubKit.ts": "export const kit = 1;",
  ".github/workflows/nightly.yml": `name: nightly
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: node ops/nightly.mjs
      - run: npx tsx run.ts
        working-directory: tasks
      - run: |
          cd jobs && node sweep.js
`,
  "ops/nightly.mjs": `import "./nightlyKit.js"; export default 1;`,
  "ops/nightlyKit.ts": "export const k = 1;",
  "tasks/run.ts": `import "./runKit"; export default 1;`,
  "tasks/runKit.ts": "export const k = 1;",
  "jobs/sweep.js": `import "./sweepKit.js"; export default 1;`,
  "jobs/sweepKit.js": "export const k = 1;",
  ".gitlab-ci.yml": "job:\n  script:\n    - npx tsx pipeline/gl.ts\n",
  "pipeline/gl.ts": "export default 1;",
  Makefile: "all:\n\tnode build/mk.js\n",
  "build/mk.js": "export default 1;",
  "bin/club.js": `#!/usr/bin/env node\nrequire("../src/engine");\n`,
  "src/engine.ts": "export const engine = 1;",
  "src/data-migrations/001.ts": `import "../shared/kit"; export const up = 1;`,
  "src/typeorm_migrations/002.ts": "export const up = 1;",
  "src/db/migrate/003.ts": "export const up = 1;",
  "codegen.yml": "schema: x\ngenerates:\n  src/gql/types.ts:\n    plugins: [typescript]\n  src/gql/preset/:\n    preset: client\n",
  "src/gql/types.ts": "export type T = 1;",
  "src/gql/preset/gql.ts": "export const g = 1;",
  // Nothing loads these.
  "src/dead-control.ts": "export const control = 1;",
  "src/migration.ts": "export const m = 1;",
  "src/migrationsHelper.ts": "export const m = 1;",
  "src/premigrations/004.ts": "export const m = 1;",
};

describe("JS dead code — files loaded without a plain import", () => {
  let dir: string;
  let dead: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-js-loaders-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    dead = (summary.deadCode?.files ?? []).map((f) => f.filePath).sort();
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports only the files nothing loads", () => {
    expect(dead).toEqual(["src/dead-control.ts", "src/migration.ts", "src/migrationsHelper.ts", "src/premigrations/004.ts"]);
  });
});
