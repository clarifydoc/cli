import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

describe("Convex builders defined in another module", () => {
  const root = mkdtempSync(join(tmpdir(), "clarifydoc-convex-src-"));
  const out = mkdtempSync(join(tmpdir(), "clarifydoc-convex-out-"));
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  beforeAll(async () => {
    write("package.json", JSON.stringify({ name: "league", dependencies: { convex: "1", "convex-helpers": "0.1", react: "18" } }));
    write("convex/lib/auth.ts", [
      'import { customQuery, customMutation } from "convex-helpers/server/customFunctions";',
      'import { query, mutation } from "../_generated/server";',
      "export const authedQuery = customQuery(query, { args: {}, input: async (ctx) => ({ ctx, args: {} }) });",
      "export const authedMutation = customMutation(mutation, { args: {}, input: async (ctx) => ({ ctx, args: {} }) });",
      "",
    ].join("\n"));
    write("convex/lib/other.ts", [
      'import { customQuery } from "some-other-library";',
      'import { query } from "../_generated/server";',
      "export const looseQuery = customQuery(query, {});",
      "",
    ].join("\n"));
    write("convex/clubs.ts", [
      'import { authedQuery, authedMutation } from "./lib/auth";',
      'import { looseQuery } from "./lib/other";',
      "export const list = authedQuery({ args: {}, handler: async (ctx) => ctx.db.query(\"clubs\").collect() });",
      "export const sign = authedMutation({ args: {}, handler: async (ctx) => ctx.db.insert(\"players\", {}) });",
      "export const loose = looseQuery({ args: {}, handler: async () => 1 });",
      "",
    ].join("\n"));
    write("convex/http.ts", [
      'import { httpRouter } from "convex/server";',
      'import { httpAction } from "./_generated/server";',
      'const CLUBS = "/clubs";',
      'const VERB = "POST";',
      "const http = httpRouter();",
      "http.route({ path: CLUBS, method: VERB, handler: httpAction(async () => new Response()) });",
      "",
    ].join("\n"));
    write("src/Clubs.tsx", [
      'import { useQuery } from "convex/react";',
      'import { api } from "../convex/_generated/api";',
      "export function Clubs() { const clubs = useQuery(api.clubs.list); return null; }",
      "",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(() => {
    for (const dir of [root, out]) rmSync(dir, { recursive: true, force: true });
  });

  it("serves functions built with an imported custom builder, and only those", async () => {
    const s = await loadReportSummary(out);
    const routes = s.routeMap.map((r) => `${r.httpMethod} ${r.path}`);
    expect(routes).toContain("GET /convex/clubs.list");
    expect(routes).toContain("POST /convex/clubs.sign");
    expect(routes).not.toContain("GET /convex/clubs.loose");
    expect(routes).not.toContain("POST /convex/clubs.loose");
    const links = (s.apiRouteLinks ?? []).map((l) => `${l.source} ${l.method} ${l.url} -> ${l.target}`);
    expect(links).toContain("src/Clubs.tsx GET /convex/clubs.list -> convex/clubs.ts");
  });

  it("reads an http route whose path and method are constants of the file", async () => {
    const s = await loadReportSummary(out);
    expect(s.routeMap.map((r) => `${r.httpMethod} ${r.path}`)).toContain("POST /clubs");
  });
});
