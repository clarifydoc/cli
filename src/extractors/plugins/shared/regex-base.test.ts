import { describe, it, expect } from "vitest";
import {
  extractFunctionsWithSpec,
  extractClassesWithSpec,
  extractCallsFromBody,
  findEndLine,
  isControlFlowKeyword,
} from "./regex-base.js";
import { cppSpec } from "../cpp/index.js";

const fns = (src: string) => extractFunctionsWithSpec(src.split("\n"), cppSpec);
const fnNames = (src: string) => fns(src).map((f) => f.name);

describe("control-flow keyword guard (function extraction)", () => {
  it("does not extract indented control-flow statements as functions", () => {
    // Backtracking defeats the cpp pattern's `(?!if\b|…)` lookahead: `^\s*`
    // gives back a tab, the optional type-part absorbs it, and `if` lands in
    // the name capture. The name-level guard must reject these.
    const names = fnNames(`
void CAStreamBasicDescription::Print() {
\tif (fmt.mFormatID != kAudioFormatLinearPCM) {
\t\tfprintf(stderr, "oops");
\t}
\tfor (int i = 0; i < n; ++i) {
\t\tprocess(i);
\t}
\twhile (isdigit(*p)) {
\t\t++p;
\t}
\tswitch (mode) {
\t\tcase 1: break;
\t}
\tforeach (Item* item, list) {
\t\titem->update();
\t}
}
    `);
    expect(names).toEqual(["Print"]);
  });

  it("keeps real functions whose names merely contain a keyword", () => {
    const names = fnNames(`
bool ifNeeded(int x) {
\treturn x > 0;
}
void doSwitch(Mode m) {
\tapply(m);
}
    `);
    expect(names).toEqual(["ifNeeded", "doSwitch"]);
  });

  it("does not extract control-flow statements as class methods", () => {
    const classes = extractClassesWithSpec(
      `
class TrackDAO {
\tvoid addTrack(Track* t) {
\t\tif (t->isValid()) {
\t\t\tstore(t);
\t\t}
\t}
};
      `.split("\n"),
      cppSpec,
    );
    expect(classes).toHaveLength(1);
    expect(classes[0]!.methods.map((m) => m.name)).toEqual(["addTrack"]);
  });

  it("is case-insensitive (VB `If (...)`)", () => {
    expect(isControlFlowKeyword("If")).toBe(true);
    expect(isControlFlowKeyword("FOREACH")).toBe(true);
    expect(isControlFlowKeyword("ifNeeded")).toBe(false);
  });
});

describe("control-flow keyword guard (call extraction)", () => {
  it("does not record if/for/while/switch as calls", () => {
    const body = `
\tif (isValid(x)) {
\t\tfor (int i = 0; i < n; ++i) {
\t\t\tquery.bindValue(i, x);
\t\t}
\t} else if (check(y)) {
\t\twhile (hasNext()) { advance(); }
\t\tswitch (mode) { default: break; }
\t}
    `.split("\n");
    const calls = extractCallsFromBody(body, 0, body.length, ["//"]);
    const names = calls.map((c) => c.name);
    expect(names).toContain("isValid");
    expect(names).toContain("query.bindValue");
    expect(names).toContain("check");
    expect(names).toContain("hasNext");
    expect(names).toContain("advance");
    for (const kw of ["if", "for", "while", "switch", "foreach"]) {
      expect(names).not.toContain(kw);
    }
  });
});

describe("brace block end — declarations with no body", () => {
  const end = (src: string, at = 0) => findEndLine(src.split("\n"), at, "brace");

  it("does not let a bodyless declaration adopt the next block", () => {
    // Before the `head`/`declarationComplete` guard the scanner kept going
    // until SOME block closed, so a prototype took the NEXT routine's range —
    // and with it that routine's calls (seen as cross-routine call bleed in
    // the SQL fixture, and as a `case class` owning the next class's methods
    // in Scala).
    const src = ["int find(int id);", "", "int helper(int id) {", "  return compute(id);", "}"].join("\n");
    expect(end(src)).toBe(1);
    expect(end(src, 2)).toBe(5);
  });

  it("still finds an Allman-style body on the following line", () => {
    expect(end(["int find(int id)", "{", "  return compute(id);", "}"].join("\n"))).toBe(4);
  });

  it("looks past blank lines and comments for an Allman brace", () => {
    expect(end(["int find(int id)", "", "// why", "{", "  return 1;", "}"].join("\n"))).toBe(6);
  });

  it("keeps a multi-line parameter list attached to its body", () => {
    expect(end(["int find(", "    int id,", "    int tenant) {", "  return 1;", "}"].join("\n"))).toBe(5);
  });

  it("treats a wrapped inheritance clause as a continuation", () => {
    expect(end(["class Foo", "    extends Bar {", "  int x;", "}"].join("\n"))).toBe(4);
  });

  it("ends a declaration that trails off into an expression body", () => {
    // Scala `def apply(): X = new X(...)` — complete on one line, no block.
    expect(end(["def apply(): X = new X(y)", "", "class Other {", "  val z = 1", "}"].join("\n"))).toBe(1);
  });
});
