import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** test-fixtures/sample-express-validation, against the request schemas its README labels by hand. */
const fixture = resolve("test-fixtures/sample-express-validation");

describe.skipIf(!existsSync(fixture))("sample-express-validation", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-validation-"));
    out = join(dir, "sample-express-validation");
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives each route the body its validator names — zod, drizzle-zod, joi, celebrate, yup, TypeBox", async () => {
    const s = await loadReportSummary(out);
    const schemas = Object.fromEntries(
      s.routeMap.filter((r) => r.requestSchema).map((r) => [`${r.httpMethod} ${r.path}`, (r.requestSchema!.required ?? []).slice().sort().join(",") || "—"]),
    );
    expect(schemas).toEqual({
      "POST /api/players": "active,email,password",
      "POST /api/signup": "email,password",
      "POST /api/games": "scoutId,title",
      "PATCH /api/games/:id": "—",
      "POST /api/teams": "name,visibility",
      "PATCH /api/profile": "—",
      "POST /api/tags": "kind,label",
    });
    // A drizzle-zod schema over a table another file declares has that table's columns.
    const profile = s.routeMap.find((r) => r.path === "/api/profile")!.requestSchema!;
    expect(Object.keys(profile.properties ?? {}).sort()).toEqual(["active", "createdAt", "email", "id", "name"]);
  });
});
