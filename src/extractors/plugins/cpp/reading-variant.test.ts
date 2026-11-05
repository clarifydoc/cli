import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readCpp } from "./antlr.js";
import { readC } from "../c/antlr.js";
import { cppReadingVariant } from "./manifest.js";
import { analyze } from "../../../core/analyzer.js";
import { ensureLanguagesLoaded } from "../../registry.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["c", "cpp"]);
});

describe("cppReadingVariant", () => {
  it("reads a header as C first only in a project with C sources and no C++ ones", () => {
    expect(cppReadingVariant("gate.h", { ".c": 3, ".h": 4 })).toBe("c-first");
    expect(cppReadingVariant("gate.h", { ".c": 3, ".h": 4, ".cpp": 1 })).toBeUndefined();
    expect(cppReadingVariant("gate.h", { ".c": 3, ".hpp": 1 })).toBeUndefined();
    expect(cppReadingVariant("gate.h", { ".h": 4 })).toBeUndefined();
    expect(cppReadingVariant("gate.h", { ".c": 1, ".mm": 1 })).toBeUndefined();
    expect(cppReadingVariant("gate.hpp", { ".c": 3 })).toBeUndefined();
    expect(cppReadingVariant("gate.c", { ".c": 3 })).toBeUndefined();
  });
});

describe("readCpp with the c-first variant", () => {
  const cHeader = "static inline int open_gate(const char *restrict name, int class) { return lift(name, class); }\n";
  const cppHeader = "namespace league { class Club { public: int size() const { return count_; } int count_; }; }\n";

  it("returns C's reading of a header C accepts", () => {
    const parsed = readCpp(cHeader, undefined, "c-first");
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed).toEqual(readC(cHeader));
  });

  it("falls back to C++'s grammar when C refuses the header", () => {
    expect(readC(cppHeader).syntaxErrors).toBeGreaterThan(0);
    const parsed = readCpp(cppHeader, undefined, "c-first");
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed).toEqual(readCpp(cppHeader));
  });

  it("finds the same functions the default reading finds in plain C", () => {
    const header = "typedef struct Car Car;\nint start(Car *c);\n#define HONK(c) beep(c)\nstatic int park(Car *c) { return start(c); }\n";
    const a = readCpp(header);
    const b = readCpp(header, undefined, "c-first");
    expect(a.syntaxErrors).toBe(0);
    expect(b.syntaxErrors).toBe(0);
    expect(b.functions.map((f) => f.name)).toEqual(a.functions.map((f) => f.name));
  });
});

describe("a header's reading follows its project, through the cache", () => {
  const root = mkdtempSync(join(tmpdir(), "clarifydoc-reading-src-"));
  const out = mkdtempSync(join(tmpdir(), "clarifydoc-reading-out-"));
  afterAll(() => {
    for (const dir of [root, out]) rmSync(dir, { recursive: true, force: true });
  });
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const run = () => analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, incremental: true, stableOutput: true });
  const frontEnd = () => {
    const file = [join(out, "gate.h.json"), join(out, "files", "gate.h.json")].find(existsSync);
    return (JSON.parse(readFileSync(file!, "utf-8")) as { frontEnd?: { variant?: string } }).frontEnd;
  };

  write("gate.h", "int open_gate(int bay);\nstatic inline int lift(int bay) { return open_gate(bay); }\n");
  write("garage.c", '#include "gate.h"\nint main(void) { return lift(3); }\n');

  it("reads it as C first in a C project", async () => {
    await run();
    expect(frontEnd()?.variant).toBe("c-first");
  });

  it("re-reads the unchanged header when a C++ source joins the project", async () => {
    write("club.cpp", "int count() { return 1; }\n");
    await run();
    expect(frontEnd()?.variant).toBeUndefined();
  });

  it("and again when the C++ source leaves", async () => {
    rmSync(join(root, "club.cpp"));
    await run();
    expect(frontEnd()?.variant).toBe("c-first");
  });
});
