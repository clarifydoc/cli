import { describe, it, expect } from "vitest";
import { conventionRoots, analyzeUnusedCode, analyzeReachability, type ReachabilityInput } from "./dead-code.js";
import type { ExportInfo, FileAnalysis } from "../types/analysis.js";
import type { ReachabilityModel } from "../types/language-plugin.js";

describe("conventionRoots", () => {
  it("marks generated/vendored dirs by path convention (pit-stop FPs)", () => {
    const roots = conventionRoots([
      "dsps-server/src/main/java/dk/innobeat/dsps/jooq/generated/sps/tables/Student.java",
      "dsps-web/LEGACY/vendor/laravel/framework/src/Foo.php",
      "web/node_modules/lodash/index.js",
      "api/third_party/grpc/client.py",
    ]);
    expect(roots).toContain("dsps-server/src/main/java/dk/innobeat/dsps/jooq/generated");
    expect(roots).toContain("dsps-web/LEGACY/vendor");
    expect(roots).toContain("web/node_modules");
    expect(roots).toContain("api/third_party");
  });

  it("marks plugins/lib dirs only under static-asset containers", () => {
    const roots = conventionRoots([
      "dsps-web/public/js/plugins/ckeditor/ckeditor.js",
      "site/wwwroot/lib/bootstrap/bootstrap.js",
      // authored code named plugins/lib — NOT vendored
      "src/extractors/plugins/csharp/index.ts",
      "dsps_app/lib/util/ApiConnection.dart",
    ]);
    expect(roots).toContain("dsps-web/public/js/plugins");
    expect(roots).toContain("site/wwwroot/lib");
    expect(roots).not.toContain("src/extractors/plugins");
    expect(roots).not.toContain("dsps_app/lib");
  });

  it("never marks a root from the file segment itself", () => {
    expect(conventionRoots(["src/vendor.ts", "src/generated.py"])).toHaveLength(0);
  });
});

describe("analyzeUnusedCode — convention merge", () => {
  const analysis = (filePath: string): FileAnalysis =>
    ({ filePath, exports: [], imports: [] }) as unknown as FileAnalysis;

  it("returns convention roots even with no barrels present", () => {
    const { generatedRoots } = analyzeUnusedCode(
      [analysis("app/jooq/generated/Tables.java"), analysis("app/src/Main.java")],
      {},
    );
    expect(generatedRoots).toEqual(["app/jooq/generated"]);
  });

  it("keeps only the shallowest root when nested", () => {
    const { generatedRoots } = analyzeUnusedCode(
      [
        analysis("web/node_modules/pkg/index.js"),
        analysis("web/node_modules/pkg/vendor/dep.js"),
      ],
      {},
    );
    expect(generatedRoots).toEqual(["web/node_modules"]);
  });
});

describe("analyzeReachability", () => {
  type Spec = Partial<FileAnalysis> & { filePath: string };
  const file = (s: Spec): FileAnalysis =>
    ({
      language: "typescript", projectId: "root", imports: [], exports: [], functions: [], classes: [],
      routes: [], subComponents: [], templateTree: [], ...s,
    }) as unknown as FileAnalysis;
  const imp = (source: string, specifiers: string[] = [], extra: Record<string, unknown> = {}) =>
    ({ source, specifiers, isDefault: false, isNamespace: false, isType: false, line: 1, ...extra });
  const exp = (name: string, extra: Partial<ExportInfo> = {}): ExportInfo => ({ name, kind: "function", line: 1, ...extra });

  /** A stub model: "./x" → "x.ts"; entries by name; `?alias` is an unknown. */
  const stubModel = (entries: string[] = [], manifest: string[] = []): ReachabilityModel => ({
    manifestEntries: manifest.map((f) => ({ file: f, reason: "package.json main" })),
    entryReason: (a) => (entries.includes(a.filePath) ? "convention" : null),
    resolve: (_from, src) => (src.startsWith("?") ? null : src.startsWith("./") ? [`${src.slice(2)}.ts`] : []),
    resolvePath: (_from, ref) => [ref.replace(/^\//, "")],
  });

  const run = (analyses: FileAnalysis[], model: ReachabilityModel, extra: Partial<ReachabilityInput> = {}) =>
    analyzeReachability({
      analyses,
      componentGraph: {},
      symbolLinks: [],
      models: new Map([["typescript", model]]),
      frameworks: new Set(),
      projectRoots: new Map([["root", ""], ["lib", "lib"]]),
      isTest: (f) => f.endsWith(".test.ts"),
      isUnauthored: () => false,
      readSource: () => undefined,
      ...extra,
    })!;

  it("does not judge a project nothing anchors, even if tests reach into it", () => {
    const r = run(
      [
        file({ filePath: "main.ts", imports: [imp("./used", ["a"])] }),
        file({ filePath: "used.ts", exports: [exp("a")] }),
        file({ filePath: "lib/x.ts", projectId: "lib" }),
        file({ filePath: "lib/x.test.ts", projectId: "lib", imports: [imp("./lib/x", ["x"])] }),
      ],
      stubModel(["main.ts"]),
    );
    expect(r.skippedProjects).toEqual([{ root: "lib", files: 1, languages: ["typescript"], reason: "no entry point found" }]);
    expect(r.files).toEqual([]);
    expect(r.judgedFiles).toBe(2);
  });

  it("keeps test-only code alive, but reports what nothing reaches", () => {
    const r = run(
      [
        file({ filePath: "main.ts" }),
        file({ filePath: "tested.ts" }),
        file({ filePath: "tested.test.ts", imports: [imp("./tested", ["t"])] }),
        file({ filePath: "orphan.ts", imports: [imp("./orphan-dep", ["d"])] }),
        file({ filePath: "orphan-dep.ts" }),
      ],
      stubModel(["main.ts"]),
    );
    expect(r.files.map((f) => [f.filePath, f.deadImporters, f.confidence])).toEqual([
      ["orphan-dep.ts", 1, "INFERRED"],
      ["orphan.ts", 0, "INFERRED"],
    ]);
  });

  it("marks findings AMBIGUOUS behind an unresolved local import or a matching name", () => {
    const r = run(
      [
        file({ filePath: "main.ts", imports: [imp("?alias/thing", ["x"])] }),
        file({ filePath: "dead.ts" }),
      ],
      stubModel(["main.ts"]),
    );
    expect(r.unresolvedImports).toBe(1);
    expect(r.files[0]).toMatchObject({ filePath: "dead.ts", confidence: "AMBIGUOUS" });

    const named = run(
      [
        file({ filePath: "main.ts", functions: [{ name: "go", calls: [{ name: "formatPrice" }] }] as never }),
        file({ filePath: "utils/formatPrice.ts" }),
      ],
      stubModel(["main.ts"]),
    );
    expect(named.files[0]).toMatchObject({ filePath: "utils/formatPrice.ts", confidence: "AMBIGUOUS" });
  });

  it("follows names through re-exports; `export *` never forwards default", () => {
    const r = run(
      [
        file({ filePath: "main.ts", imports: [imp("./barrel", ["renamed", "fromStar", "default"], { isDefault: true })] }),
        file({
          filePath: "barrel.ts",
          exports: [
            exp("renamed", { kind: "re-export", source: "./impl", sourceName: "original" }),
            exp("*", { kind: "re-export", source: "./star" }),
            exp("default", { kind: "default" }),
          ],
        }),
        file({ filePath: "impl.ts", exports: [exp("original"), exp("other")] }),
        file({ filePath: "star.ts", exports: [exp("fromStar"), exp("default", { kind: "default" }), exp("spare")] }),
      ],
      stubModel(["main.ts"]),
    );
    expect(r.exports.map((e) => `${e.filePath} ${e.name}`)).toEqual([
      "impl.ts other",
      "star.ts default",
      "star.ts spare",
    ]);
  });

  it("never judges exports behind a namespace import, a page script, or an edge it cannot name", () => {
    const r = run(
      [
        file({ filePath: "main.ts", imports: [imp("./ns", ["ns"], { isNamespace: true })] }),
        file({ filePath: "ns.ts", exports: [exp("a")] }),
        file({ filePath: "index.html", language: "html" as never, imports: [imp("/page.ts")] }),
        file({ filePath: "page.ts", exports: [exp("b")] }),
        file({ filePath: "heuristic.ts", exports: [exp("c"), exp("d")] }),
        file({ filePath: "linked.ts", exports: [exp("e"), exp("f")] }),
      ],
      stubModel(["main.ts"]),
      {
        componentGraph: { "main.ts": ["heuristic.ts", "linked.ts"] },
        symbolLinks: [{ sourceFile: "main.ts", targetFile: "linked.ts", targetSymbol: "e" }] as never,
      },
    );
    // page.ts is anchored by the page that loads it.
    expect(r.files).toEqual([]);
    // linked.ts: the link names `e`, so only `f` is unused.
    expect(r.exports.map((e) => `${e.filePath} ${e.name}`)).toEqual(["linked.ts f"]);
  });

  it("treats a package entry's re-exports as used and never judges its own exports", () => {
    const r = run(
      [
        file({ filePath: "index.ts", exports: [exp("api", { kind: "re-export", source: "./api" }), exp("VERSION")] }),
        file({ filePath: "api.ts", exports: [exp("api"), exp("internal")] }),
      ],
      stubModel([], ["index.ts"]),
    );
    expect(r.entryFiles).toBe(1);
    expect(r.exports.map((e) => `${e.filePath} ${e.name}`)).toEqual(["api.ts internal"]);
  });

  it("never reports what an unreadable file may load, nor test fixture data", () => {
    const r = run(
      [
        file({ filePath: "main.ts", imports: [imp("./security/scanner", ["scan"])] }),
        // scanner.ts was skipped as credential-looking: its imports are unknown.
        file({ filePath: "security/entropy.ts", exports: [exp("entropy")] }),
        file({ filePath: "elsewhere/dead.ts" }),
        file({ filePath: "test-fixtures/mini-repo/src/foo.ts" }),
      ],
      {
        ...stubModel(["main.ts"]),
        resolve: (_from, src) => (src === "./security/scanner" ? ["security/scanner.ts"] : []),
      },
      { opaqueFiles: ["security/scanner.ts"] },
    );
    expect(r.files.map((f) => f.filePath)).toEqual(["elsewhere/dead.ts"]);
    expect(r.exports).toEqual([]);
    expect(r.judgedFiles).toBe(3);
  });

  it("anchors per language: one language's entry points do not judge another's files", () => {
    const py = { ...stubModel(["app.py"]), judgeExports: false };
    const r = run(
      [
        file({ filePath: "app.py", language: "python" as never }),
        file({ filePath: "stale.py", language: "python" as never }),
        file({ filePath: "generated/types.ts" }),
      ],
      stubModel(),
      { models: new Map([["typescript", stubModel()], ["python", py]]) as never },
    );
    expect(r.files.map((f) => f.filePath)).toEqual(["stale.py"]);
    expect(r.skippedProjects).toEqual([{ root: "", files: 1, languages: ["typescript"], reason: "no entry point found" }]);
  });

  it("reaches by name from any reachable text, and anchors what configuration names", () => {
    const named: ReachabilityModel = {
      ...stubModel(["Program.cs"]),
      judgeExports: false,
      declaredNames: (a) => a.classes.map((c) => c.name),
      configMentions: new Set(["AuditPlugin"]),
    };
    const sources: Record<string, string> = {
      "Program.cs": "builder.Services.AddScoped<OrderService>();",
      "OrderService.cs": "class OrderService { }",
      "LegacyPricing.cs": "class LegacyPricing { PricingRules r; }",
      "PricingRules.cs": "class PricingRules { }",
      "AuditPlugin.cs": "class AuditPlugin { }",
    };
    const cs = (filePath: string, name?: string) =>
      file({ filePath, language: "csharp" as never, classes: name ? ([{ name, methods: [] }] as never) : [] });
    const r = run(
      [cs("Program.cs"), cs("OrderService.cs", "OrderService"), cs("LegacyPricing.cs", "LegacyPricing"), cs("PricingRules.cs", "PricingRules"), cs("AuditPlugin.cs", "AuditPlugin")],
      named,
      { models: new Map([["csharp", named]]) as never, readSource: (f) => sources[f] },
    );
    expect(r.files.map((f) => [f.filePath, f.deadImporters])).toEqual([
      ["LegacyPricing.cs", 0],
      ["PricingRules.cs", 1],
    ]);
    expect(r.entryFiles).toBe(2); // Program.cs + AuditPlugin (named in configuration)
  });

  it("reaches a whole compilation unit through any of its files", () => {
    const go: ReachabilityModel = {
      ...stubModel(["main.go"]),
      judgeExports: false,
      resolve: (_f, src) => (src === "store" ? ["store/a.go"] : []),
      unitOf: (f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ""),
    };
    const g = (filePath: string, imports: ReturnType<typeof imp>[] = []) => file({ filePath, language: "go" as never, imports });
    const r = run([g("main.go", [imp("store", ["store"])]), g("store/a.go"), g("store/b.go"), g("legacy/x.go"), g("legacy/y.go")], go, {
      models: new Map([["go", go]]) as never,
    });
    expect(r.files.map((f) => [f.filePath, f.deadImporters])).toEqual([
      ["legacy/x.go", 0],
      ["legacy/y.go", 0],
    ]);
  });

  it("treats the project root's directory as a unit too", () => {
    const go: ReachabilityModel = {
      ...stubModel(["main.go"]),
      judgeExports: false,
      resolve: () => [],
      unitOf: (f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ""),
    };
    const g = (filePath: string) => file({ filePath, language: "go" as never });
    // `helpers.go` sits beside `main.go` in the root package: compiled with it, never imported.
    const r = run([g("main.go"), g("helpers.go"), g("legacy/x.go")], go, { models: new Map([["go", go]]) as never });
    expect(r.files.map((f) => f.filePath)).toEqual(["legacy/x.go"]);
  });

  it("returns nothing when no language declares a model", () => {
    expect(
      analyzeReachability({
        analyses: [file({ filePath: "a.ts" })],
        componentGraph: {},
        symbolLinks: [],
        models: new Map(),
        frameworks: new Set(),
        projectRoots: new Map(),
        isTest: () => false,
        isUnauthored: () => false,
        readSource: () => undefined,
      }),
    ).toBeUndefined();
  });
});

describe("analyzeUnusedCode — barrels that are not codegen", () => {
  const barrel = (dir: string): FileAnalysis =>
    ({
      filePath: `${dir}/index.ts`,
      imports: [],
      exports: ["a", "b", "c", "d", "e"].map((n) => ({ name: n, kind: "re-export", line: 1, source: `./${n}` })),
    }) as unknown as FileAnalysis;
  const leaf = (filePath: string): FileAnalysis => ({ filePath, imports: [], exports: [] }) as unknown as FileAnalysis;

  it("keeps a package's public entry barrel and a project-wired feature folder authored", () => {
    const analyses = [barrel("src"), barrel("src/feature"), leaf("src/feature/a.ts"), barrel("src/gen"), { ...leaf("src/gen/a.ts"), generated: true } as FileAnalysis];
    const graph = {
      // The feature folder reaches across the project; the generated tree only
      // into its own files and one custom client.
      "src/feature/a.ts": ["src/core/x.ts", "src/core/y.ts", "src/types.ts"],
      "src/gen/a.ts": ["src/gen/b.ts", "src/http/client.ts"],
    };
    const { generatedRoots } = analyzeUnusedCode(analyses, graph, new Set(["src/index.ts"]));
    expect(generatedRoots).toEqual(["src/gen"]);
  });

  it("does not take a self-contained authored barrel for codegen", () => {
    // `src/shared` re-exports its own utilities and depends on nothing else —
    // shaped like codegen output, but no file under it says it was generated.
    const analyses = [barrel("src/shared"), leaf("src/shared/a.ts"), leaf("src/app.ts")];
    const graph = { "src/shared/a.ts": ["src/shared/b.ts"], "src/app.ts": ["src/shared/index.ts"] };
    expect(analyzeUnusedCode(analyses, graph).generatedRoots).toEqual([]);
  });
});
