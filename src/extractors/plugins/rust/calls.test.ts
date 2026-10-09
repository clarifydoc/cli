import { describe, it, expect } from "vitest";
import { extractCallsFromBody } from "../shared/regex-base.js";
import { rustSpec } from "./index.js";

const calls = (src: string) => {
  const lines = src.split("\n");
  return extractCallsFromBody(lines, 0, lines.length, rustSpec.lineCommentPrefixes, rustSpec.callPatterns).map((c) => c.name);
};

describe("rust path calls", () => {
  it("records `Type::f(` once, qualified — never a bare twin of its member", () => {
    const names = calls(`    let orig = CommentView::read(&mut context.pool(), id).await?;`);
    expect(names).toContain("CommentView.read");
    expect(names).not.toContain("read");
  });

  it("still records a plain call on the same line", () => {
    expect(calls(`    let n = count(items) + Foo::bar(x);`)).toEqual(expect.arrayContaining(["count", "Foo.bar"]));
  });
});
