import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * Two shapes of a factory's result with no return type written. A fluent method whose returns are all `return this`
 * hands back the receiver's class (a subclass inheriting the method keeps its own type), and an async factory's
 * `return await useClubApi()` types its result like the plain `return useClubApi()`, for the callers that await it.
 * A method returning `this.sub`, and a namesake class with the same member names, never take the call.
 */
describe("typing a fluent method's and an awaited factory's result", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-factory-fluent-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("package.json", '{"name":"league-web"}');
    await file(
      "src/ClubQuery.ts",
      [
        "export class ClubQuery {",
        "  league = '';",
        "  max = 0;",
        "  sub = new ClubPage();",
        "  withLeague(x: string) { this.league = x; return this; }",
        "  limit(n: number) { this.max = n; return this; }",
        "  fetch() { return []; }",
        "  page() { return this.sub; }",
        "}",
        "export class ClubPage { fetch() { return 1; } }",
        "export class YouthQuery extends ClubQuery {}",
        "",
      ].join("\n"),
    );
    await file(
      "src/CarQuery.ts",
      "export class CarQuery {\n  withLeague(x: string) { return new CarQuery(); }\n  limit(n: number) { return this; }\n  fetch() { return 2; }\n}\n",
    );
    await file(
      "src/search.ts",
      [
        'import { ClubQuery, YouthQuery } from "./ClubQuery";',
        "export function direct() {",
        '  return new ClubQuery().withLeague("a").limit(5).fetch();',
        "}",
        "export function inherited() {",
        '  return new YouthQuery().withLeague("a").limit(5).fetch();',
        "}",
        "export function viaChild() {",
        "  return new ClubQuery().page().fetch();",
        "}",
        "",
      ].join("\n"),
    );
    await file(
      "src/ClubApi.ts",
      [
        "export class ClubApi { load() { return 1; } }",
        "export function useClubApi() { return new ClubApi(); }",
        "export async function makeApi() { return await useClubApi(); }",
        "export async function makeBuilt() { return await new ClubApi(); }",
        "",
      ].join("\n"),
    );
    await file("src/CarApi.ts", "export class CarApi { load() { return 2; } }\n");
    await file(
      "src/load.ts",
      [
        'import { makeApi, makeBuilt } from "./ClubApi";',
        "export async function go() {",
        "  const api = await makeApi();",
        "  api.load();",
        "  const built = await makeBuilt();",
        "  built.load();",
        "}",
        "",
      ].join("\n"),
    );
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linksFrom = async (source: string) => {
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    return (summary.symbolLinks ?? []).filter((l) => l.sourceFile === source && l.relation !== "reference");
  };
  const targets = (links: Awaited<ReturnType<typeof linksFrom>>, suffix: string) =>
    links.filter((l) => l.callName.endsWith(suffix)).map((l) => `${l.targetFile.split("/").pop()}::${l.targetSymbol}`);

  it("follows `return this` through a fluent chain to the receiver's class", async () => {
    const links = await linksFrom("src/search.ts");
    expect(targets(links, ".limit(5).fetch")).toContain("ClubQuery.ts::ClubQuery.fetch");
    expect(targets(links, ".limit")).toContain("ClubQuery.ts::ClubQuery.limit");
    expect(links.some((l) => l.targetFile.endsWith("CarQuery.ts"))).toBe(false);
  });

  it("keeps a subclass's type through an inherited fluent method", async () => {
    const links = await linksFrom("src/search.ts");
    const inherited = links.filter((l) => l.callName.startsWith("new YouthQuery()"));
    expect(inherited.map((l) => `${l.targetFile.split("/").pop()}::${l.targetSymbol}`)).toContain("ClubQuery.ts::ClubQuery.fetch");
  });

  it("does not type a method returning a member as the receiver", async () => {
    const links = await linksFrom("src/search.ts");
    const viaPage = links.filter((l) => l.callName === "new ClubQuery().page().fetch");
    expect(viaPage).toEqual([]);
  });

  it("types an awaited factory's result like the plain one for a caller that awaits it", async () => {
    const links = await linksFrom("src/load.ts");
    // Typed by the factory, not guessed from the member name (a namesake class declares `load` too).
    expect(links.filter((l) => l.callName.endsWith(".load")).map((l) => l.strategy)).toEqual(["injection", "injection"]);
    expect(targets(links, "api.load")).toEqual(["ClubApi.ts::ClubApi.load"]);
    expect(targets(links, "built.load")).toEqual(["ClubApi.ts::ClubApi.load"]);
  });
});
