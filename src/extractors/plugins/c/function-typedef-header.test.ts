import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { readC } from "./antlr.js";
import { readCpp } from "../cpp/antlr.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["c", "cpp"]);
});

// A `.h` is read as C++, as the file analyzer does, and a `.c` as C.
const read = (src: string, rel: string): FileAnalysis => {
  const language = rel.endsWith(".h") ? "cpp" : "c";
  return { ...extractWithRegex(src, rel, language, undefined, language === "c" ? readC(src) : readCpp(src)), projectId: "root" };
};

// A header's struct fields as the file analyzer's class pass states them (the bare regex reading lists none).
const withFields = (a: FileAnalysis, fields: Record<string, Array<[string, string]>>): FileAnalysis => {
  for (const c of a.classes) {
    c.properties = (fields[c.name] ?? []).map(([name, type]) => ({ name, type, visibility: "public", isStatic: false, isReadonly: false }));
  }
  return a;
};

const links = (files: FileAnalysis[]): string[] =>
  buildSymbolLinks(files)
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();

// The typedefs sit in one header, the struct in another, the stores and the caller in .c files.
const typedefs = `typedef void Match_dtor(void *);\ntypedef int (*Match_cmp)(const void *, const void *);\n`;
const clubHeader = `#include "match.h"\nstruct club { Match_dtor *release; Match_cmp order; int wins; };\nvoid club_set(struct club *c, Match_dtor *fn);\n`;
const store = `#include "club.h"\nvoid club_set(struct club *c, Match_dtor *fn) { c->release = fn; }\nvoid club_drop(struct club *c, void *x) { c->release(x); }\n`;
const caller = `#include "club.h"\nstatic void player_free(void *x) { (void)x; }\nvoid setup(struct club *c) { club_set(c, player_free); }\n`;

describe("a C function typedef declared in another header", () => {
  it("makes a parameter typed by it a function the field it is stored in then holds", () => {
    const files = [
      read(typedefs, "src/match.h"),
      withFields(read(clubHeader, "src/club.h"), { club: [["release", "Match_dtor"], ["order", "Match_cmp"], ["wins", "int"]] }),
      read(store, "src/club.c"),
      read(caller, "src/setup.c"),
    ];
    expect(links(files)).toContain("club_drop c.release -> src/setup.c::player_free");
  });
  it("is no function type where a namesake typedef sits in a header the file never includes", () => {
    const lonely = [
      read(`typedef void Match_dtor(void *);\n`, "src/elsewhere/match.h"),
      withFields(read(`struct squad { Match_dtor *release; };\nvoid squad_set(struct squad *s, Match_dtor *fn);\n`, "src/squad.h"), { squad: [["release", "Match_dtor"]] }),
      read(`#include "squad.h"\nvoid squad_set(struct squad *s, Match_dtor *fn) { s->release = fn; }\nvoid squad_drop(struct squad *s, void *x) { s->release(x); }\n`, "src/squad.c"),
      read(`#include "squad.h"\nstatic void bench_free(void *x) { (void)x; }\nvoid fill(struct squad *s) { squad_set(s, bench_free); }\n`, "src/fill.c"),
    ];
    expect(links(lonely).filter((l) => l.includes("bench_free"))).toEqual([]);
  });
  it("is no function type where the name is a data typedef", () => {
    const data = [
      read(`typedef int Match_dtor;\n`, "src/match.h"),
      withFields(read(clubHeader, "src/club.h"), { club: [["release", "Match_dtor"]] }),
      read(store, "src/club.c"),
      read(caller, "src/setup.c"),
    ];
    expect(links(data).filter((l) => l.includes("player_free"))).toEqual([]);
  });
});
