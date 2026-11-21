import { describe, it, expect } from "vitest";
import { dropYieldedClasses } from "./yielded-classes.js";
import type { ClassInfo, FileAnalysis } from "../types/analysis.js";

const cls = (name: string, extra: Partial<ClassInfo> = {}): ClassInfo => ({
  name, extends: null, implements: [], decorators: [], methods: [], properties: [], isExported: true, line: 1, endLine: 1, kind: "class", ...extra,
});
const file = (filePath: string, projectId: string, classes: ClassInfo[]): FileAnalysis => ({ filePath, projectId, language: "java", classes } as unknown as FileAnalysis);

describe("dropYieldedClasses", () => {
  it("keeps a generated class unless the same sub-project writes one of that name", () => {
    const generated = () => [cls("ImmutableClub", { synthetic: true, yieldsTo: "ImmutableClub" }), cls("ImmutableClub_Builder", { synthetic: true, yieldsTo: "ImmutableClub" })];
    const a = file("league/Club.java", "league", generated());
    const written = file("league/gen/ImmutableClub.java", "league", [cls("ImmutableClub")]);
    const other = file("garage/Car.java", "garage", generated());
    const elsewhere = file("garage-other/ImmutableClub.java", "other", [cls("ImmutableClub")]);
    dropYieldedClasses([a, written, other, elsewhere]);
    expect(a.classes).toEqual([]);
    expect(other.classes.map((c) => c.name)).toEqual(["ImmutableClub", "ImmutableClub_Builder"]);
  });

  it("leaves classes with no yieldsTo alone", () => {
    const a = file("a.java", "p", [cls("CarBuilder", { synthetic: true }), cls("CarBuilder")]);
    dropYieldedClasses([a]);
    expect(a.classes).toHaveLength(2);
  });
});
