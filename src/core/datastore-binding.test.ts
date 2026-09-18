import { describe, it, expect } from "vitest";
import "../extractors/registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../parsers/parser-manager.js";
import { extractJsVariableAliases } from "../extractors/plugins/javascript/variable-aliases.js";
import { JavaScriptDataSourceExtractor } from "../extractors/plugins/javascript/data-sources.js";
import { JavaScriptImportExportExtractor } from "../extractors/plugins/javascript/imports-exports.js";
import { enrichFileDataSources } from "./import-index.js";
import { createEmptyAnalysis, type FileAnalysis } from "../types/analysis.js";

/**
 * `const prisma = new PrismaClient()` is the commonest ORM idiom there is, and
 * every call on that receiver resolved to no datastore: the data-access graph
 * collected them all under one "(unresolved)" node. Two causes — the alias
 * extractor ignored `new` expressions, and aliases were computed AFTER
 * enrichment, so even the factory shape it did understand arrived too late.
 */
async function analyze(src: string, file = "repo.ts"): Promise<FileAnalysis> {
  const tree = await parseSource(src, "typescript" as any, file);
  const a = createEmptyAnalysis(file, "typescript");
  a.imports = new JavaScriptImportExportExtractor().extractImports(tree, src);
  a.dataSources = new JavaScriptDataSourceExtractor().extract(tree, src);
  const aliases = extractJsVariableAliases(tree, a.imports);
  enrichFileDataSources(a, undefined, aliases);
  return a;
}

const dbTargets = (a: FileAnalysis) =>
  a.dataSources.filter((d) => d.kind === "database").map((d) => [d.name, d.target, d.access, d.targetConfidence]);

describe("datastore binding through a constructed receiver", () => {
  it("resolves `new PrismaClient()` and keeps the read/write verb", async () => {
    const a = await analyze(`
      import { PrismaClient } from "@prisma/client";
      const prisma = new PrismaClient();
      export const list = () => prisma.order.findMany();
      export const add = (d: unknown) => prisma.order.create({ data: d });
    `);
    expect(dbTargets(a)).toEqual(
      expect.arrayContaining([
        ["prisma.order.findMany", "@prisma/client", "read", "INFERRED"],
        ["prisma.order.create", "@prisma/client", "write", "INFERRED"],
      ]),
    );
  });

  it("resolves an awaited constructor", async () => {
    const a = await analyze(`
      import { Client } from "pg";
      const client = await new Client();
      export const go = () => client.query("SELECT 1");
    `);
    const targets = a.dataSources.map((d) => d.target);
    expect(targets).toContain("pg");
  });

  it("resolves a factory binding, which used to arrive after enrichment", async () => {
    const a = await analyze(`
      import { drizzle } from "drizzle-orm/node-postgres";
      const db = drizzle(process.env.DB!);
      export const all = () => db.select().from("orders");
    `);
    expect(dbTargets(a).every(([, target]) => target === "drizzle-orm/node-postgres")).toBe(true);
  });

  it("drops a name bound to two different modules rather than guessing", async () => {
    const tree = await parseSource(
      `import { PrismaClient } from "@prisma/client";
       import { Client } from "pg";
       function a() { const c = new PrismaClient(); }
       function b() { const c = new Client(); }`,
      "typescript" as any,
      "x.ts",
    );
    const imports = new JavaScriptImportExportExtractor().extractImports(tree, "");
    expect(extractJsVariableAliases(tree, imports).has("c")).toBe(false);
  });

  it("leaves an unbound receiver alone", async () => {
    const a = await analyze(`export const go = (prisma: any) => prisma.order.findMany();`);
    expect(dbTargets(a).every(([, target]) => target === null)).toBe(true);
  });
});
