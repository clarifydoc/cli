import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { readC } from "./antlr.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["c"]);
});

const read = (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "c", undefined, readC(src)), projectId: "root" });

// A header's struct fields as the file analyzer's class pass states them (the bare regex reading lists none).
const withFields = (a: FileAnalysis, fields: Record<string, Array<[string, string, boolean?]>>): FileAnalysis => {
  for (const c of a.classes) {
    c.properties = (fields[c.name] ?? []).map(([name, type, callable]) => ({ name, type, visibility: "public", isStatic: false, isReadonly: false, ...(callable ? { callable } : {}) }));
  }
  return a;
};

// `club_ops.h` declares `struct club_ops`: the include's stem is the struct's name.
const header = `struct club_ops { int (*scout)(int); int (*release)(int); };
struct club_mgr { struct club_ops *ops; };
`;
const impl = `#include "club_ops.h"
static int club_scout(int x) { return x; }
static int club_release(int x) { return x; }
static struct club_ops ops = { .scout = club_scout, .release = club_release };
`;
const caller = `#include "club_ops.h"
int run(struct club_mgr *m, int x) { return m->ops->scout(x); }
`;
// A namesake struct in another folder, which the caller never includes.
const rivalHeader = `struct club_ops { int (*scout)(int); };
struct rival_mgr { struct club_ops *ops; };
`;
const rivalImpl = `#include "club_ops.h"
static int rival_scout(int x) { return x; }
static struct club_ops dops = { .scout = rival_scout };
int rival_run(struct rival_mgr *m, int x) { return m->ops->scout(x); }
`;

describe("a C struct declared in a header named like it", () => {
  let found: string[] = [];
  beforeAll(() => {
    found = buildSymbolLinks([
    withFields(read(header, "src/club_ops.h"), { club_ops: [["scout", "int (*)(int)", true], ["release", "int (*)(int)", true]], club_mgr: [["ops", "struct club_ops"]] }),
    read(impl, "src/impl.c"),
    read(caller, "src/use.c"),
    withFields(read(rivalHeader, "src/rival/club_ops.h"), { club_ops: [["scout", "int (*)(int)", true]], rival_mgr: [["ops", "struct club_ops"]] }),
    read(rivalImpl, "src/rival/rival.c"),
  ])
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();
  });
  it("seeds its fields from a designated initializer", () => {
    expect(found).toContain("run scout -> src/impl.c::club_scout");
  });
  it("never reaches the namesake struct of another folder", () => {
    expect(found).not.toContain("run scout -> src/rival/rival.c::rival_scout");
    expect(found).not.toContain("rival_run scout -> src/impl.c::club_scout");
    expect(found).toContain("rival_run scout -> src/rival/rival.c::rival_scout");
  });
});
