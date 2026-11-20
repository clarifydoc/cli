import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { readC } from "./antlr.js";
import { readCpp } from "../cpp/antlr.js";
import { normalizeProject, denormalizeProject } from "../../../core/element-registry.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { macroBodyCalls } from "../shared/c-family-macros.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["c", "cpp"]);
});

const readAs = (src: string, rel: string, project = "root"): FileAnalysis => {
  const language = rel.endsWith(".h") || rel.endsWith(".cpp") ? "cpp" : "c";
  return { ...extractWithRegex(src, rel, language, undefined, language === "c" ? readC(src) : readCpp(src)), projectId: project };
};

const storeH = `#ifndef STORE_H
#define STORE_H
#define SAVE_CLUB(c) club_store_save(c)
#define SAVE_BOTH(a, b) do { club_store_save(a); player_store_save(b); } while (0)
#define LOG_CLUB(c) club_log(c)
#define SAVE_VIA(c) LOG_CLUB(c)
#define APPLY(f, x) f(x)
#define PASTE(x) club_##x()
#define SHOW(x) puts(#x)
#define OWN_CALL(x) OWN_CALL(x)
#define MEMBER(p) (p)->save(p)
void club_store_save(int c);
void club_log(int c);
void player_store_save(int p);
#endif
`;
const storeC = `#include "store.h"\nvoid club_store_save(int c) {}\nvoid club_log(int c) {}\nvoid player_store_save(int c) {}\n`;

const links = (files: FileAnalysis[], from: string) =>
  buildSymbolLinks(files).filter((l) => l.sourceFile === from).map((l) => [l.sourceLine, l.callName, l.targetFile, l.viaMacro ?? null]);

describe.each([["c", "c"], ["cpp", "cpp"]])("a macro body's calls (%s)", (_name, ext) => {
  const user = `#include "store.h"\nvoid transfer(int x, int y) {\n    SAVE_CLUB(x);\n    SAVE_BOTH(x, y);\n    SAVE_VIA(x);\n    APPLY(player_store_save, y);\n}\n`;

  it("reaches what the body calls, through the header the file includes", () => {
    const got = links([readAs(storeH, "src/store.h"), readAs(storeC, `src/store.${ext}`), readAs(user, `src/league.${ext}`)], `src/league.${ext}`);
    expect(got).toContainEqual([3, "club_store_save", `src/store.${ext}`, "SAVE_CLUB"]);
    // One link per target (the linker's own dedupe), so SAVE_BOTH's second call is the one new target.
    expect(got).toContainEqual([4, "player_store_save", `src/store.${ext}`, "SAVE_BOTH"]);
    // A macro the body uses is followed in turn.
    expect(got).toContainEqual([5, "club_log", `src/store.${ext}`, "LOG_CLUB"]);
    // The macro's own link stays; bodies that paste, stringize or call a parameter add nothing.
    expect(got).toContainEqual([3, "SAVE_CLUB", "src/store.h", null]);
    expect(got.filter((r) => r[0] === 6 && r[3])).toEqual([]);
  });

  it("yields the one link per target to a line that spells the call, at that line", () => {
    const spelled = `#include "store.h"\nvoid promote(int x) {\n    SAVE_CLUB(x);\n    club_store_save(x);\n}\nvoid relegate(int x) {\n    club_store_save(x);\n    SAVE_CLUB(x);\n}\n`;
    const got = links([readAs(storeH, "src/store.h"), readAs(storeC, `src/store.${ext}`), readAs(spelled, `src/league.${ext}`)], `src/league.${ext}`);
    expect(got.filter((r) => r[1] === "club_store_save")).toEqual([
      [4, "club_store_save", `src/store.${ext}`, null],
      [7, "club_store_save", `src/store.${ext}`, null],
    ]);
  });

  it("is INFERRED and marked, so a rename plan refuses it", () => {
    const all = buildSymbolLinks([readAs(storeH, "src/store.h"), readAs(storeC, `src/store.${ext}`), readAs(user, `src/league.${ext}`)]);
    const body = all.find((l) => l.viaMacro === "SAVE_CLUB" && l.sourceLine === 3);
    expect(body?.confidence).toBe("INFERRED");
  });

  it("never lends the body of a same-named macro of another translation unit", () => {
    const decoy = readAs(`#define SAVE_CLUB(c) garage_park(c)\nvoid garage_park(int c) {}\nvoid decoy_user(int x) {\n    SAVE_CLUB(x);\n}\n`, `src/decoy.${ext}`);
    const stranger = readAs(`void stranger(int x) {\n    SAVE_CLUB(x);\n}\n`, `src/stranger.${ext}`);
    const files = [readAs(storeH, "src/store.h"), readAs(storeC, `src/store.${ext}`), readAs(user, `src/league.${ext}`), decoy, stranger];
    // The decoy's own definition wins in its file, and only there.
    expect(links(files, `src/decoy.${ext}`).filter((r) => r[3])).toEqual([[4, "garage_park", `src/decoy.${ext}`, "SAVE_CLUB"]]);
    expect(links(files, `src/stranger.${ext}`)).toEqual([]);
    expect(links(files, `src/league.${ext}`).some((r) => r[1] === "garage_park")).toBe(false);
  });

  it("refuses a name two included headers define differently", () => {
    const other = `#define SAVE_CLUB(c) garage_park(c)\n`;
    const both = `#include "store.h"\n#include "other.h"\nvoid f(int x) {\n    SAVE_CLUB(x);\n}\n`;
    const got = links([readAs(storeH, "src/store.h"), readAs(other, "src/other.h"), readAs(both, `src/both.${ext}`)], `src/both.${ext}`);
    expect(got).toEqual([]);
  });
});

describe("macroBodyCalls", () => {
  it("reads only bare calls of a body that is calls", () => {
    expect(macroBodyCalls("M", ["c"], ["club_store_save(c)"])).toEqual(["club_store_save"]);
    expect(macroBodyCalls("M", ["c"], ["do { a(c); b(c); } while (0)"])).toEqual(["a", "b"]);
    expect(macroBodyCalls("M", ["f"], ["f(1)"])).toEqual([]);
    expect(macroBodyCalls("M", ["c"], ["(c)->save(c)", "obj.go(c)", "ns::f(c)"])).toEqual([]);
    expect(macroBodyCalls("M", ["c"], ["club_##c()"])).toEqual([]);
    expect(macroBodyCalls("M", ["c"], ['puts("a(b)")'])).toEqual(["puts"]);
    expect(macroBodyCalls("M", ["c"], ["int f(c)"])).toEqual([]);
    expect(macroBodyCalls("M", ["c"], ["if (c) return run(c);"])).toEqual(["run"]);
    expect(macroBodyCalls("M", ["c"], ["M(c)"])).toEqual([]);
    expect(macroBodyCalls("M", ["c"], ["((c) ? club_a(c) : club_b(c))"])).toEqual(["club_a", "club_b"]);
    expect(macroBodyCalls("M", ["c"], ["do club_run(c); while (0)"])).toEqual(["club_run"]);
    expect(macroBodyCalls("M", ["c"], ['club_log(c, "/*"); club_flush(c)'])).toEqual(["club_log", "club_flush"]);
  });
});

describe("viaMacro survives the summary", () => {
  it("round-trips through the normalized form", () => {
    const user = `#include "store.h"\nvoid transfer(int x) {\n    SAVE_CLUB(x);\n}\n`;
    const symbolLinks = buildSymbolLinks([readAs(storeH, "src/store.h"), readAs(storeC, "src/store.c"), readAs(user, "src/league.c")]);
    const project = { symbolLinks, fileProjects: {}, subProjects: [] } as unknown as ProjectAnalysis;
    const back = denormalizeProject(JSON.parse(JSON.stringify(normalizeProject(project))));
    expect(back.symbolLinks.filter((l) => l.viaMacro).map((l) => [l.callName, l.viaMacro])).toEqual([["club_store_save", "SAVE_CLUB"]]);
  });
});
