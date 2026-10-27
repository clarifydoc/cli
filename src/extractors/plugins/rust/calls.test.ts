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

describe("rust associated functions", () => {
  it("keeps a noise-named associated function, its type as the receiver (`Invoice::open`, `Club::new`)", () => {
    const lines = ["    let i = Invoice::open(3);", "    let c = Club::new();"];
    const out = extractCallsFromBody(lines, 0, lines.length, rustSpec.lineCommentPrefixes, rustSpec.callPatterns);
    expect(out.map((c) => [c.name, c.receiverType])).toEqual([["Invoice.open", "Invoice"], ["Club.new", "Club"]]);
  });
});

describe("Rust methods on a struct literal written over lines", () => {
  it("names the struct type's method, receiver typed (real-repo FP)", async () => {
    const { extractWithRegex } = await import("../../../core/regex-extractor.js");
    const src = `pub async fn list_reports(pool: &mut DbPool<'_>) -> LeagueResult<Json<Vec<Report>>> {
  let reports = MatchReportQuery {
    club_id,
    unresolved_only,
  }
  .list(&mut pool, &view)
  .await?;
  Ok(Json(reports))
}`;
    const a = extractWithRegex(src, "src/reports/list.rs", "rust");
    const call = a.functions.find((f) => f.name === "list_reports")!.calls.find((c) => c.name.endsWith("list"));
    expect(call).toMatchObject({ name: "MatchReportQuery.list", receiverType: "MatchReportQuery" });
  });
});
