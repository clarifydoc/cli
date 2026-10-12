import { describe, it, expect } from "vitest";
import { computeRegexComplexity } from "./complexity-regex.js";
import type { FileAnalysis } from "../types/analysis.js";
import type { RegexLangSpec } from "../extractors/plugins/shared/regex-base.js";
import { ensureLanguagesLoaded } from "../extractors/registry.js";

const spec = { lineCommentPrefixes: ["//"] } as unknown as RegexLangSpec;
const analysis = (functions: any[], classes: any[] = []): FileAnalysis => ({ functions, classes } as unknown as FileAnalysis);
const fn = (name: string, line: number, endLine: number): any => ({ name, line, endLine, params: [{ name: "x" }] });

describe("regex-path complexity", () => {
  it("counts branch keywords and logical operators, not those in strings or comments", () => {
    const src = `func Handle(x int) int {
	if x > 1 && x < 10 { // if this comment counted, it would be wrong
		return 1
	}
	for i := 0; i < x; i++ {
		s := "if for while"
		_ = s
	}
	switch x { case 1: return 2 }
	return 0
}`.split("\n");
    const [row] = computeRegexComplexity(src, analysis([fn("Handle", 1, 11)]), spec, false);
    // if, &&, for, case → 1 + 4
    expect(row).toMatchObject({ functionName: "Handle", complexity: 5, line: 1, endLine: 11, paramCount: 1 });
  });

  it("names a method by its class and matches case-insensitively when asked", () => {
    const src = `Class Svc
  Sub Run()
    If a Then
    ElseIf b OrElse c Then
    End If
  End Sub
End Class`.split("\n");
    const rows = computeRegexComplexity(src, analysis([], [{ name: "Svc", methods: [fn("Run", 2, 6)] }]), spec, true);
    expect(rows).toEqual([expect.objectContaining({ functionName: "Svc.Run", complexity: 4 })]);
  });

  it("reads cognitive complexity and nesting depth off the regex control-flow structure", async () => {
    await ensureLanguagesLoaded(["ruby"]);
    const src = `def sync(items)
  return if items.empty?
  items.each do |i|
    if i.ok? && i.fresh?
      save(i)
    elsif i.stale?
      drop(i)
    end
  end
end`.split("\n");
    const a = { ...analysis([fn("sync", 1, 10)]), language: "ruby" } as FileAnalysis;
    const [row] = computeRegexComplexity(src, a, spec, false);
    // modifier if: 1; inside the block (nesting 1): if 1+1, && 1, elsif 1 → 5; deepest: block + if = 2
    expect(row).toMatchObject({ functionName: "sync", cognitive: 5, nestingDepth: 2, approximate: true });
  });
});

