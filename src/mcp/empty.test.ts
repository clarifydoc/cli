import { describe, it, expect } from "vitest";
import { STATUS_HINT, filterToDrop, missHeadline, noResults, termDiagnosis } from "./empty.js";
import type { Candidate } from "./search-rank.js";

function candidate(name: string, path: string | null = null): Candidate {
  return { kind: "symbol", name, path, line: null, weight: 0, text: name };
}

describe("noResults", () => {
  it("renders miss, denominator and next call as three parts", () => {
    const text = noResults({
      headline: "No routes match (method: TRACE).",
      holds: "The analysis holds 12 routes.",
      next: ["clarifydoc_routes without `method` (12 matches)"],
    });
    expect(text.split("\n")).toEqual([
      "No routes match (method: TRACE).",
      "The analysis holds 12 routes.",
      "Next: clarifydoc_routes without `method` (12 matches)",
    ]);
  });

  it("drops absent suggestions and caps the rest at two", () => {
    const text = noResults({
      headline: "No screens match.",
      holds: ["one", undefined, "two"],
      next: [false, undefined, "first", "second", "third"],
    });
    expect(text).toContain("one\ntwo\n");
    expect(text).toContain("Next: first · second");
    expect(text).not.toContain("third");
  });

  it("never dead-ends: with nothing suggestible it still names a tool", () => {
    const text = noResults({ headline: "No screens match.", next: [undefined, false] });
    expect(text).toContain(`Next: ${STATUS_HINT}`);
    expect(text).toContain("clarifydoc_status");
  });
});

describe("missHeadline", () => {
  it("echoes the filters that produced the miss", () => {
    expect(missHeadline("routes", [["method", "TRACE"], ["kind", undefined]])).toBe(
      "No routes match (method: TRACE).",
    );
  });

  it("says so plainly when no filter was passed at all", () => {
    expect(missHeadline("screens", [["query", undefined]])).toBe("No screens in this analysis.");
  });
});

describe("filterToDrop", () => {
  const rows = [
    { method: "GET", kind: "api" },
    { method: "GET", kind: "frontend" },
    { method: "POST", kind: "api" },
  ];
  const byMethod = (method: string) => ({ label: "method", keep: (r: (typeof rows)[number]) => r.method === method });
  const byKind = (kind: string) => ({ label: "kind", keep: (r: (typeof rows)[number]) => r.kind === kind });

  it("names the filter whose removal yields the most rows, with the count", () => {
    // method=TRACE matches nothing; dropping it leaves the two api routes.
    expect(filterToDrop(rows, [byMethod("TRACE"), byKind("api")])).toEqual({ label: "method", count: 2 });
  });

  it("stays silent when there is only one filter to drop", () => {
    // Dropping the only filter leaves the whole dimension, which the
    // denominator line already reports — repeating it is noise.
    expect(filterToDrop(rows, [byMethod("TRACE")])).toBeUndefined();
  });

  it("stays silent when no single removal helps", () => {
    expect(filterToDrop(rows, [byMethod("TRACE"), byKind("mobile")])).toBeUndefined();
  });
});

describe("termDiagnosis", () => {
  const candidates = [
    candidate("UserProfile"),
    candidate("UserSettings"),
    candidate("UserList"),
    candidate("ProfileCard"),
  ];

  it("names the term worth keeping and the terms that match nothing", () => {
    const d = termDiagnosis(candidates, "user profile widget");
    expect(d?.best).toBe("user");
    expect(d?.text).toBe("`user` alone has 3 hits, `profile` 2; `widget` matches nothing.");
  });

  it("is silent for a single term — there is nothing to drop", () => {
    expect(termDiagnosis(candidates, "widget")).toBeUndefined();
  });

  it("is silent when no term matches anything, so status is the only honest hint", () => {
    expect(termDiagnosis(candidates, "zzz qqq")).toBeUndefined();
  });

  it("scores at most four terms, however long the query", () => {
    const d = termDiagnosis(candidates, "user aaa bbb ccc ddd profile");
    expect(d?.text).not.toContain("profile");
  });
});
