import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { conventionReachability, typeLeaf, withPassive } from "./reachability-kit.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import type { ReachabilityModel } from "../../../types/language-plugin.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function project(disk: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "clarifydoc-kit-"));
  dirs.push(root);
  for (const [path, body] of Object.entries(disk)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

type Spec = Parameters<typeof conventionReachability>[0];
const load = (spec: Spec, files: string[], disk: Record<string, string> = {}): Promise<ReachabilityModel> =>
  conventionReachability(spec).load({ projectRoot: project(disk), roots: [], files: new Set(files) });

const analysis = (filePath: string, extra: Partial<FileAnalysis> = {}): FileAnalysis =>
  ({ filePath, classes: [], functions: [], routes: [], ...extra }) as unknown as FileAnalysis;
const cls = (name: string, extra: Record<string, unknown> = {}) => ({ name, extends: null, implements: [], decorators: [], methods: [], ...extra });
const fn = (name: string, extra: Record<string, unknown> = {}) => ({ name, decorators: [], calls: [], ...extra });
const none = new Set<string>();

describe("reachability kit — imports", () => {
  it("resolves beside the importer, then by path suffix anywhere, else external", async () => {
    const m = await load(
      { extensions: [".java"], importPath: (s) => s.replace(/\./g, "/") },
      ["src/main/java/com/x/Foo.java", "src/main/java/com/x/Bar.java", "lib/com/x/Foo.java"],
    );
    expect(m.resolve("src/main/java/com/y/App.java", "com.x.Bar")).toEqual(["src/main/java/com/x/Bar.java"]);
    // Two source roots both end that way: both are reached.
    expect(m.resolve("src/main/java/com/y/App.java", "com.x.Foo")).toEqual(["lib/com/x/Foo.java", "src/main/java/com/x/Foo.java"]);
    expect(m.resolve("src/main/java/com/y/App.java", "java.util.List")).toEqual([]);
  });

  it("probes extensions and index files, case-insensitively when asked", async () => {
    const lua = await load({ extensions: [".lua"], importPath: (s) => s.replace(/\./g, "/"), indexFiles: ["init.lua"] }, ["lua/app/util/init.lua"]);
    expect(lua.resolve("main.lua", "app.util")).toEqual(["lua/app/util/init.lua"]);
    const php = await load({ extensions: [".php"], caseInsensitive: true, importPath: (s) => s.replace(/\\/g, "/") }, ["app/Services/Invoice.php"]);
    expect(php.resolve("routes/web.php", "App\\Services\\Invoice")).toEqual(["app/Services/Invoice.php"]);
  });
});

describe("reachability kit — names", () => {
  it("declares types, functions, the stem, extension-class methods and raw declarations", async () => {
    const m = await load(
      { extensions: [".cs"], names: { types: true, functions: true, stem: true, methodsOf: /Extensions$/, declaration: /\bclass\s+(\w+)/g } },
      [],
    );
    const a = analysis("src/StringExtensions.cs", {
      classes: [cls("Shop.StringExtensions", { methods: [fn("Slugify")] })],
      functions: [fn("<setup>"), fn("Helper")],
    } as never);
    expect(m.declaredNames!(a, "class Missed {}")).toEqual(["StringExtensions", "Helper", "Slugify", "StringExtensions", "Missed"]);
  });

  it("strips namespaces and generics from type names", () => {
    expect(typeLeaf("Microsoft.AspNetCore.Mvc.ControllerBase")).toBe("ControllerBase");
    expect(typeLeaf("IRequestHandler<GetUser, User>")).toBe("IRequestHandler");
    expect(typeLeaf("App\\Http\\Kernel")).toBe("Kernel");
    expect(typeLeaf("MyApp.Accounts.User")).toBe("User");
  });
});

describe("reachability kit — entries vs framework-discovered", () => {
  const spec: Spec = {
    extensions: [".cs"],
    names: { types: true, declaration: /\bclass\s+(\w+)/g },
    mainFunctions: /^Main$/,
    entryFiles: [[/(?:^|\/)Program\.cs$/, "conventional entry"]],
    entryDecorators: /^ApiController\b/,
    entryBaseTypes: /^IRequestHandler$/,
    routesAreEntries: true,
    entrySource: [[/@main/, "program entry (@main)"]],
    passiveFiles: [[/(?:^|\/)Migrations\//, "migration"]],
  };

  it("anchors on program starts only", async () => {
    const m = await load(spec, []);
    expect(m.entryReason(analysis("Program.cs"), "Program.cs", none)).toBe("conventional entry");
    expect(m.entryReason(analysis("Tool.cs", { classes: [cls("Tool", { methods: [fn("Main")] })] } as never), "Tool.cs", none)).toBe("program entry (Main)");
    expect(m.entryReason(analysis("App.cs"), "App.cs", none, () => "@main struct App {}")).toBe("program entry (@main)");
    // Discovered by a framework: alive, but no program starts there.
    const controller = analysis("Api.cs", { classes: [cls("Api", { decorators: ['ApiController', 'Route("x")'] })] } as never);
    expect(m.entryReason(controller, "Api.cs", none)).toBeNull();
    expect(m.passiveReason!(controller, "Api.cs", none)).toBe("framework-managed (@ApiController)");
  });

  it("keeps framework-discovered, tool-run and name-less files alive without judging them", async () => {
    const m = await load(spec, []);
    const handler = analysis("H.cs", { classes: [cls("H", { implements: ["IRequestHandler<Q, R>"] })] } as never);
    expect(m.passiveReason!(handler, "H.cs", none)).toBe("framework base type (IRequestHandler)");
    expect(m.passiveReason!(analysis("C.cs", { routes: [{}] } as never), "C.cs", none)).toMatch(/routes/);
    expect(m.passiveReason!(analysis("Migrations/001.cs", { classes: [cls("M")] } as never), "Migrations/001.cs", none)).toBe("migration");
    // Assembly attributes / global usings: nothing to mention by name.
    expect(m.passiveReason!(analysis("AssemblyAttrs.cs"), "AssemblyAttrs.cs", none, () => "[assembly: X]")).toMatch(/no type/);
    expect(m.passiveReason!(analysis("Plain.cs", { classes: [cls("Plain")] } as never), "Plain.cs", none)).toBeNull();
  });

  it("lets an extension add passive rules without losing the spec's", async () => {
    const base = await load(spec, []);
    const extended = withPassive(base, (a) => (a.filePath.startsWith("lib/") ? "library API" : null));
    expect(extended.passiveReason!(analysis("lib/x.cs", { classes: [cls("X")] } as never), "lib/x.cs", none)).toBe("library API");
    expect(extended.passiveReason!(analysis("Migrations/1.cs", { classes: [cls("M")] } as never), "Migrations/1.cs", none)).toBe("migration");
  });
});

describe("reachability kit — configuration and units", () => {
  it("collects identifiers from configuration files and #! scripts", async () => {
    const m = await load(
      { extensions: [".java"], names: { types: true }, configFiles: /AndroidManifest\.xml$/, shebang: /\bphp\b/ },
      ["app/src/main/java/com/x/MainActivity.java"],
      {
        "app/src/main/AndroidManifest.xml": '<activity android:name=".ui.MainActivity" />',
        "bin/console": "#!/usr/bin/env php\n<?php (new ConsoleKernel())->run();",
        "node_modules/x/AndroidManifest.xml": "<activity android:name=\"Ignored\" />",
      },
    );
    expect(m.configMentions?.has("MainActivity")).toBe(true);
    expect(m.configMentions?.has("ConsoleKernel")).toBe(true);
    // Dependency directories are never read.
    expect(m.configMentions?.has("Ignored")).toBe(false);
  });

  it("puts a directory's files in one unit when asked", async () => {
    const m = await load({ extensions: [".go"], unit: "directory" }, ["pkg/a.go", "pkg/b.go"]);
    expect(m.unitOf!("pkg/a.go")).toBe("pkg");
    expect(m.unitOf!("pkg/readme.md")).toBeNull();
  });
});
