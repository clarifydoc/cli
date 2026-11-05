import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { readC } from "./antlr.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["c", "cpp"]);
});

const readAs = (src: string, rel: string, project = "root"): FileAnalysis => {
  const language = rel.endsWith(".h") ? "cpp" : "c";
  return { ...extractWithRegex(src, rel, language, undefined, language === "c" ? readC(src) : undefined), projectId: project };
};

const clubH = `#ifndef CLUB_H
#define CLUB_H
#define MAX_CLUBS 20
#define for_each_club(c, list) \\
    for (c = (list)->head; c; c = c->next)
#define ghost(x) ((x) + 1)
#undef ghost
/* #define commented(x) x */
#if 0
#define dead_arm(x) x
#endif
void club_add(int id);
#endif
`;
const leagueC = `#include "club.h"

#define local_each(p) for (p = 0; p < 3; p++)

int count_clubs(struct list *list) {
#define inside_body(x) (x)
    struct club *c;
    int n = 0;
    for_each_club(c, list) {
        n++;
    }
    local_each(n) { n++; }
    inside_body(n);
    return n;
}
`;

describe("function-like #define symbols", () => {
  it("records function-like macros outside bodies only", () => {
    const h = readAs(clubH, "src/club.h");
    expect(h.macros?.map((m) => [m.name, m.line, m.endLine])).toEqual([["for_each_club", 4, 5], ["ghost", 6, 6]]);
    expect(h.macros?.find((m) => m.name === "ghost")?.fileScoped).toBe(true);
    expect(h.macros?.find((m) => m.name === "for_each_club")?.params).toEqual(["c", "list"]);
    expect(h.functions.some((f) => f.name === "for_each_club")).toBe(false);
    const c = readAs(leagueC, "src/league.c");
    expect(c.macros?.map((m) => m.name)).toEqual(["local_each"]);
  });

  it("links a call to the macro of an included header and of its own file", () => {
    const links = buildSymbolLinks([readAs(clubH, "src/club.h"), readAs(leagueC, "src/league.c")]);
    const hop = links.find((l) => l.callName === "for_each_club");
    expect(hop).toMatchObject({ targetFile: "src/club.h", targetSymbol: "for_each_club", targetLine: 4, strategy: "import-file" });
    expect(links.find((l) => l.callName === "local_each")).toMatchObject({ targetFile: "src/league.c", targetLine: 3, strategy: "direct" });
    expect(links.some((l) => l.callName === "inside_body" && l.targetFile)).toBe(false);
  });

  it("never reaches a macro its header #undef'd, or one no include reaches", () => {
    const user = readAs(`#include "club.h"\nint f(void) { return ghost(1); }\n`, "src/a.c");
    const stranger = readAs(`int g(void) { return for_each_club(1); }\n`, "src/b.c");
    const links = buildSymbolLinks([readAs(clubH, "src/club.h"), user, stranger]);
    expect(links.filter((l) => l.callName === "ghost" || l.sourceFile === "src/b.c")).toEqual([]);
  });

  it("lets a real function win and refuses two headers defining the name", () => {
    const fnH = `int for_each_club(int c);\n`;
    const fnC = `#include "fn.h"\nint for_each_club(int c) { return c; }\n`;
    const user = readAs(`#include "club.h"\n#include "fn.h"\nint f(void) { return for_each_club(1); }\n`, "src/u.c");
    const links = buildSymbolLinks([readAs(clubH, "src/club.h"), readAs(fnH, "src/fn.h"), readAs(fnC, "src/fn.c"), user]);
    expect(links.find((l) => l.callName === "for_each_club")?.targetFile).toBe("src/fn.c");

    const other = readAs(`#define for_each_club(c) while (c)\n`, "src/other.h");
    const both = readAs(`#include "club.h"\n#include "other.h"\nint f(void) { for_each_club(1) {} return 0; }\n`, "src/both.c");
    expect(buildSymbolLinks([readAs(clubH, "src/club.h"), other, both]).filter((l) => l.callName === "for_each_club")).toEqual([]);
  });

  it("stays inside its sub-project", () => {
    const h = readAs(clubH, "other/club.h", "other");
    const c = readAs(`#include "../other/club.h"\nint f(void) { for_each_club(1) {} return 0; }\n`, "src/x.c", "app");
    expect(buildSymbolLinks([h, c]).filter((l) => l.callName === "for_each_club")).toEqual([]);
    // The same layout in one project links: the include resolves, only the sub-project differs.
    const same = buildSymbolLinks([{ ...h, projectId: "app" }, c]).filter((l) => l.callName === "for_each_club");
    expect(same.map((l) => l.targetFile)).toEqual(["other/club.h"]);
  });
});
