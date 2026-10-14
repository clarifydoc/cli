import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadIgnorePatterns, isIgnored, fnmatch, ignoredDirectories } from "./clarifydoc-ignore.js";
import { discoverFiles } from "./file-discovery.js";
import { glob } from "./glob.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clarifydoc-ignore-"));
  mkdirSync(join(root, ".git")); // VCS ceiling, so the walk stops here
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Write `<root>/.clarifydoc/ignore`. */
function outputIgnore(body: string): void {
  mkdirSync(join(root, ".clarifydoc"), { recursive: true });
  writeFileSync(join(root, ".clarifydoc", "ignore"), body);
}

const ignored = (rel: string) => isIgnored(join(root, rel), root, loadIgnorePatterns(root));

describe(".clarifydoc/ignore", () => {
  it("ignores a vendored subtree, at any depth", () => {
    // The pattern as a user would write it for a Delphi app.
    outputIgnore("/Library/mORMot-master/*\n");
    expect(ignored("Library/mORMot-master/SynCommons.pas")).toBe(true);
    expect(ignored("Library/mORMot-master/SQLite3/Samples/04/Unit2.pas")).toBe(true);
    // Siblings and the project's own code are untouched.
    expect(ignored("Library/FIBPlus/pFIBQuery.pas")).toBe(false);
    expect(ignored("Players.pas")).toBe(false);
  });

  it("resolves patterns against the project root, not against .clarifydoc/", () => {
    outputIgnore("/Library/\n");
    expect(ignored("Library/x.pas")).toBe(true);
    // `/Library` is the one at the root. A second `Library/` nested anywhere
    // else is a different directory and stays in the analysis.
    expect(ignored(".clarifydoc/Library/x.pas")).toBe(false);
  });

  it("re-includes named directories from a wholesale exclusion", () => {
    // The shape a user reaches for: drop a vendored tree, keep the few
    // directories in it that are actually the project's own code.
    outputIgnore(["/Library/*", "!Library/Garage", "!Library/MatchCalendar"].join("\n"));
    expect(ignored("Library/Garage/PlayerNumber.pas")).toBe(false);
    expect(ignored("Library/Garage/ufgarageCSVImport.dfm")).toBe(false);
    expect(ignored("Library/MatchCalendar/TimeFunc.pas")).toBe(false);
    // Everything else in the tree stays out, at any depth.
    expect(ignored("Library/Jedi/jvcl/run/JvToolEdit.pas")).toBe(true);
    expect(ignored("Library/mORMot-master/SQLite3/Samples/04/Unit2.pas")).toBe(true);
  });

  it("supports negation, comments and blank lines", () => {
    outputIgnore(["# vendored components", "Library/", "", "!Library/OurFork/**"].join("\n"));
    expect(ignored("Library/mORMot-master/SynCommons.pas")).toBe(true);
    expect(ignored("Library/OurFork/Patched.pas")).toBe(false);
  });

  it("is read after .clarifydocignore, so it has the final say", () => {
    writeFileSync(join(root, ".clarifydocignore"), "Library/\n");
    outputIgnore("!Library/Keep/**\n");
    expect(ignored("Library/mORMot-master/SynCommons.pas")).toBe(true);
    expect(ignored("Library/Keep/Wanted.pas")).toBe(false);
  });

  it("still honours a root .clarifydocignore when no output ignore exists", () => {
    writeFileSync(join(root, ".clarifydocignore"), "/Library/mORMot-master/*\n");
    expect(ignored("Library/mORMot-master/SynCommons.pas")).toBe(true);
  });

  it("keeps ignored code out of framework detection too", async () => {
    // A vendored library's demos drag in stacks the project never uses.
    const lib = join(root, "Library", "mORMot-master");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "Demo.lpi"), "<CONFIG/>");
    writeFileSync(join(lib, "Demo.pas"), "uses FMX.Forms;\n");
    writeFileSync(join(root, "App.pas"), "uses Forms, Controls;\n");

    const { gatherProjectInfo, detectFrameworks } = await import("./framework-detector.js");
    const before = detectFrameworks(await gatherProjectInfo(root)).map((f) => f.id);
    expect(before).toEqual(expect.arrayContaining(["fmx", "lazarus"]));

    outputIgnore("/Library/*\n");
    const after = detectFrameworks(await gatherProjectInfo(root)).map((f) => f.id);
    expect(after).not.toContain("fmx");
    expect(after).not.toContain("lazarus");
    expect(after).toContain("vcl"); // the project's own stack survives
  });

  it("is inherited by a sub-root scan in a tree with no VCS directory", () => {
    // A Delphi checkout exported from source control has no .git — without a
    // ceiling marker the walk-up stops dead and inheritance silently fails.
    rmSync(join(root, ".git"), { recursive: true, force: true });
    outputIgnore("/Library/*\n");
    const sub = join(root, "Library", "DCPcrypt");
    mkdirSync(sub, { recursive: true });
    expect(isIgnored(join(sub, "DCPsha1.pas"), sub, loadIgnorePatterns(sub, root))).toBe(true);
  });

  it("is inherited by a scan rooted below it", () => {
    // Sub-project roots are scanned separately; without inheritance a sub-root
    // INSIDE an ignored directory re-detects everything the root excluded.
    outputIgnore("/Library/*\n");
    const sub = join(root, "Library", "mORMot-master");
    mkdirSync(sub, { recursive: true });
    const patterns = loadIgnorePatterns(sub, root);
    expect(isIgnored(join(sub, "SynCommons.pas"), sub, patterns)).toBe(true);
  });

  it("keeps ignored directories from becoming sub-projects", async () => {
    // A vendored component library is full of project files; each would
    // otherwise become its own scanned root.
    const lib = join(root, "Library", "DCPcrypt");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, "DCPcrypt.dpr"), "program DCPcrypt;\nbegin\nend.\n");
    mkdirSync(join(root, "Tools"), { recursive: true });
    writeFileSync(join(root, "Tools", "Gen.dpr"), "program Gen;\nbegin\nend.\n");

    const { detectSubProjects } = await import("./project-detector.js");
    expect((await detectSubProjects(root)).map((p) => p.root).sort()).toEqual(["", "Library/DCPcrypt", "Tools"]);

    outputIgnore("/Library/*\n");
    expect((await detectSubProjects(root)).map((p) => p.root).sort()).toEqual(["", "Tools"]);
  });

  it("ignores nothing when neither file exists", () => {
    expect(loadIgnorePatterns(root)).toEqual([]);
    expect(ignored("Library/mORMot-master/SynCommons.pas")).toBe(false);
  });

  it("re-includes a file even though its parent directory is excluded", () => {
    // gitignore proper refuses this: once `src/` is out, nothing inside it can
    // be brought back. ClarifyDoc is pure last-match-wins on file paths
    // instead, because for a documentation tool "drop this tree except the two
    // files I care about" is the request people actually make. Deliberate
    // divergence, pinned here so it cannot drift back by accident.
    outputIgnore(["src/**", "!src/important.ts"].join("\n"));
    expect(ignored("src/other.ts")).toBe(true);
    expect(ignored("src/important.ts")).toBe(false);
  });
});

describe("anchoring — a leading `/` confines the pattern to the root", () => {
  // A single-segment anchored pattern used to lose its anchor at match time:
  // `/dist` also excluded `src/dist/`, and those files left the analysis with
  // no warning. Anchoring is now decided when the pattern is parsed.
  const cases: Array<[pattern: string, path: string, expected: boolean]> = [
    // Anchored, one segment — the common case, and the one that was broken.
    ["/dist", "dist/a.js", true],
    ["/dist", "dist/nested/a.js", true],
    ["/dist", "src/dist/a.js", false],
    ["/dist", "src/dist", false],
    // The same name unanchored still matches at any depth.
    ["dist", "dist/a.js", true],
    ["dist", "src/dist/a.js", true],
    // An interior slash anchors too, with or without the leading one.
    ["/src/gen", "src/gen/x.ts", true],
    ["/src/gen", "lib/gen/x.ts", false],
    ["/src/gen", "lib/src/gen/x.ts", false],
    ["src/gen", "src/gen/x.ts", true],
    ["src/gen", "lib/src/gen/x.ts", false],
    // A trailing slash marks a directory; it is not the slash that anchors.
    ["build/", "src/build/a.js", true],
    ["/build/", "build/a.js", true],
    ["/build/", "src/build/a.js", false],
    // Wildcards inherit the same rule.
    ["/*.log", "debug.log", true],
    ["/*.log", "src/debug.log", false],
    ["*.log", "src/debug.log", true],
    ["/vendor/**", "vendor/x/y.c", true],
    ["/vendor/**", "third/vendor/x.c", false],
  ];
  for (const [pattern, path, expected] of cases) {
    it(`${pattern} ${expected ? "excludes" : "keeps"} ${path}`, () => {
      outputIgnore(pattern + "\n");
      expect(ignored(path)).toBe(expected);
    });
  }
});

describe("fnmatch — `**` respects path separators", () => {
  // `**` used to compile to `.*`, which ignores the separator: the glob then
  // claimed files the author never named. Both the ignore file and the
  // config's layers/exempt/generated sections share this dialect.
  const cases: Array<[path: string, pattern: string, expected: boolean]> = [
    ["a/b", "a/**/b", true],
    ["a/x/b", "a/**/b", true],
    ["a/x/y/b", "a/**/b", true],
    ["a/xb", "a/**/b", false],
    ["vendor/x", "**/vendor/**", true],
    ["a/vendor/x", "**/vendor/**", true],
    ["myvendor/x", "**/vendor/**", false],
    ["foo", "**/foo", true],
    ["a/foo", "**/foo", true],
    ["barfoo", "**/foo", false],
    ["tools/a.ts", "tools/**", true],
    ["tools", "tools/**", false],
    ["src/db/x/y.ts", "src/db/**", true],
    ["src/a/foo.ts", "src/**/foo.ts", true],
    ["src/xfoo.ts", "src/**/foo.ts", false],
    ["User.generated.ts", "*.generated.ts", true],
    ["a/b.ts", "*.ts", false],
    ["b.ts", "*.ts", true],
  ];
  for (const [path, pattern, expected] of cases) {
    it(`${pattern} ${expected ? "matches" : "does not match"} ${path}`, () => {
      expect(fnmatch(path, pattern)).toBe(expected);
    });
  }
});

describe("ignore files above the scan root", () => {
  it("never ignores the scan root itself", async () => {
    // A parent folder ignores a tree of other repositories; analyzing one of
    // them directly must still see its files.
    writeFileSync(join(root, ".clarifydocignore"), "/checkouts/\n*.gen.ts\n");
    const sub = join(root, "checkouts", "tool");
    mkdirSync(join(sub, "src"), { recursive: true });
    writeFileSync(join(sub, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(sub, "src", "b.gen.ts"), "export const b = 1;\n");
    const found = (await discoverFiles(sub)).files.map((f) => f.relativePath);
    // `/checkouts/` names the root and is dropped; `*.gen.ts` still applies below it.
    expect(found).toEqual(["src/a.ts"]);
  });
});

describe("ignoredDirectories — what a walk may skip", () => {
  const pruned = (rel: string) => ignoredDirectories(root, loadIgnorePatterns(root))?.(join(root, rel)) ?? false;

  it("prunes anchored and unanchored directories, and only those", () => {
    outputIgnore("/cache/.runs/\nscratch\n");
    expect(pruned("cache/.runs")).toBe(true);
    expect(pruned("cache/.runs/repo/src")).toBe(true);
    expect(pruned("pkg/scratch")).toBe(true);
    expect(pruned("cache")).toBe(false);
    expect(pruned("src/cache/.runs")).toBe(false);
  });

  it("never prunes where a later `!` could re-include a file", () => {
    outputIgnore("src/**\n!src/important.ts\nlogs/\n");
    expect(pruned("src")).toBe(false);
    // After the last negation nothing can re-include, so pruning resumes.
    expect(pruned("logs")).toBe(true);
  });

  it("does not prune on a whole-path `**` match a deeper path would not repeat", () => {
    outputIgnore("a**b\n");
    expect(ignored("a/b")).toBe(true);
    expect(ignored("a/b/f.ts")).toBe(false);
    expect(pruned("a/b")).toBe(false);
  });

  it("is undefined when there is nothing to prune", () => {
    expect(ignoredDirectories(root, loadIgnorePatterns(root))).toBeUndefined();
    outputIgnore("x\n!y\n");
    expect(ignoredDirectories(root, loadIgnorePatterns(root))).toBeUndefined();
  });

  it("discovery finds the same files without listing an ignored tree", async () => {
    for (const rel of ["src/app.ts", "data/scan1/x.ts", "data/scan1/deep/y.ts", "keep/z.ts"]) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), "export const a = 1;\n");
    }
    writeFileSync(join(root, ".clarifydocignore"), "/data/\n");
    const found = (await discoverFiles(root)).files.map((f) => f.relativePath);
    expect(found).toEqual(["keep/z.ts", "src/app.ts"]);

    // The walk asks about `data` once and never lists what is below it.
    const prune = ignoredDirectories(root, loadIgnorePatterns(root))!;
    const asked: string[] = [];
    await glob("**/*.ts", { cwd: root, prune: (d) => (asked.push(d.slice(root.length + 1).split("\\").join("/")), prune(d)) });
    expect(asked).toContain("data");
    expect(asked.filter((d) => d.startsWith("data/"))).toEqual([]);
  });
});
