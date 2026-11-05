import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCompileCommands, splitCommand } from "../extractors/plugins/shared/compile-commands.js";
import { loadCompilationDatabase, macrosOf, placeIncludes } from "./compilation-database.js";
import type { FileAnalysis, SubProject } from "../types/analysis.js";
import "../extractors/registry.js";

describe("compile_commands.json reader", () => {
  it("reads the command form and the arguments form, glued and separate flags", () => {
    const units = parseCompileCommands(JSON.stringify([
      { directory: "/ci/league", command: "cc -Iinc -I ../vendor -isystem /usr/include/x -iquote q -DUSE_VAR -DLIMIT=20 -UOLD -c src/a.c", file: "src/a.c" },
      { directory: "/ci/league", arguments: ["c++", "-I", "inc", "-D", "FAST", "-isystem", "sys", "src/b.cpp"], file: "src/b.cpp" },
    ]));
    expect(units[0]).toMatchObject({ file: "src/a.c", directory: "/ci/league", includeDirs: ["inc", "../vendor"], systemDirs: ["/usr/include/x"], quoteDirs: ["q"] });
    expect(units[0]!.macros).toEqual([{ name: "USE_VAR", value: "1" }, { name: "LIMIT", value: "20" }, { name: "OLD", undefined: true }]);
    expect(units[1]).toMatchObject({ includeDirs: ["inc"], systemDirs: ["sys"], macros: [{ name: "FAST", value: "1" }] });
  });

  it("resolves quotes and escapes in a command", () => {
    expect(splitCommand(`cc -DNAME="Club \\"A\\"" -I'my dir' a.c`)).toEqual(["cc", '-DNAME=Club "A"', "-Imy dir", "a.c"]);
  });

  it("yields nothing for malformed input", () => {
    expect(parseCompileCommands("not json")).toEqual([]);
    expect(parseCompileCommands('{"a":1}')).toEqual([]);
  });
});

const imp = (source: string) => ({ source, specifiers: [], isDefault: false, isNamespace: false, isType: false, line: 1 });
const analysis = (filePath: string, sources: string[]): FileAnalysis => ({ filePath, imports: sources.map(imp) } as unknown as FileAnalysis);

describe("placeIncludes", () => {
  const files = new Set(["a/config.h", "b/config.h", "src/main.c", "src/own.h", "src/local/own.h"]);
  const unit = (angle: string[], quote: string[] = []) => ({ quote, angle, macros: [] });

  it("takes the -I directory the compiler searches first, not the namesake in another folder", () => {
    const main = analysis("src/main.c", ["config.h"]);
    expect(placeIncludes([main], new Map([["src/main.c", [unit(["b", "a"])]]]), files)).toBe(1);
    expect(main.imports[0]!.source).toBe("../b/config.h");
    const other = analysis("src/main.c", ["config.h"]);
    placeIncludes([other], new Map([["src/main.c", [unit(["a", "b"])]]]), files);
    expect(other.imports[0]!.source).toBe("../a/config.h");
  });

  it("searches the includer's own directory first", () => {
    const main = analysis("src/main.c", ["own.h"]);
    placeIncludes([main], new Map([["src/main.c", [unit(["src/local"])]]]), files);
    expect(main.imports[0]!.source).toBe("./own.h");
  });

  it("leaves an include the units resolve differently, or none finds", () => {
    const main = analysis("src/main.c", ["config.h", "stdio.h"]);
    placeIncludes([main], new Map([["src/main.c", [unit(["a"]), unit(["b"])]]]), files);
    expect(main.imports.map((i) => i.source)).toEqual(["config.h", "stdio.h"]);
  });

  it("gives a header no search path of its own", () => {
    const header = analysis("src/own.h", ["config.h"]);
    expect(placeIncludes([header], new Map([["src/main.c", [unit(["b"])]]]), files)).toBe(0);
  });
});

describe("macrosOf", () => {
  it("keeps only the macros every unit of a file sets alike", () => {
    const u = (macros: Array<{ name: string; value?: string; undefined?: boolean }>) => ({ quote: [], angle: [], macros });
    expect(macrosOf([u([{ name: "A", value: "1" }, { name: "B", value: "2" }]), u([{ name: "A", value: "1" }, { name: "B", value: "3" }])])).toEqual([{ name: "A", value: "1" }]);
    expect(macrosOf(undefined)).toBeUndefined();
  });
});

describe("loadCompilationDatabase", () => {
  let dir = "";
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("maps a database written on another machine onto the discovered files", async () => {
    dir = await mkdtemp(join(tmpdir(), "cdb-"));
    await mkdir(join(dir, "build"), { recursive: true });
    await writeFile(join(dir, "build", "compile_commands.json"), JSON.stringify([
      { directory: "/home/ci/league/build", command: "cc -I/home/ci/league/b -I../a -DUSE_VAR -c /home/ci/league/src/main.c", file: "/home/ci/league/src/main.c" },
      { directory: "/home/ci/league/build", command: "cc -c ../elsewhere/other.c", file: "../elsewhere/other.c" },
    ]));
    const sub = [{ id: "root", root: "" }] as unknown as SubProject[];
    const db = await loadCompilationDatabase(dir, sub, ["a/config.h", "b/config.h", "src/main.c"]);
    expect([...db.keys()]).toEqual(["src/main.c"]);
    const [u] = db.get("src/main.c")!;
    expect(u!.angle).toEqual(["b", "a"]);
    expect(u!.macros).toEqual([{ name: "USE_VAR", value: "1" }]);
  });
});
