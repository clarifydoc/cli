import { describe, it, expect } from "vitest";
import { mdCode, mdText } from "./markdown-escape.js";
import { renderImpactMarkdown, renderImpactBrief, type ImpactDiffResult, type ReviewPriority } from "./impact-diff.js";
import { renderSurfaceMarkdown, type SurfaceDiff } from "./surface-diff.js";

const ZWJ = "‍";
const HOSTILE = [
  "@club",
  "](https://example.invalid)",
  "![x](y)",
  "a`b",
  "`edge`",
  "a|b",
  "<img src=x onerror=1>",
  "line one\nline two",
  "https://example.invalid/x",
  "www.example.invalid",
  "x".repeat(10_000),
];

/** The markdown parser is optional: the suite asserts on the text, and also on parsed output when one is installed. */
async function parser(): Promise<((md: string) => string) | undefined> {
  try {
    const name = "marked";
    const m = (await import(/* @vite-ignore */ name)) as { marked: { parse(s: string, o?: object): string } };
    return (md) => m.marked.parse(md, { gfm: true, async: false });
  } catch {
    return undefined;
  }
}

describe("mdCode / mdText", () => {
  it("leaves ordinary names byte-identical in a code span", () => {
    for (const s of ["src/club.ts", "GET /api/clubs/:id", "Club.signPlayer", "a b"]) expect(mdCode(s)).toBe(`\`${s}\``);
  });

  it("leaves ordinary words, numbers and punctuation of a sentence unchanged in text", () => {
    for (const s of ["ClubList", "Match Report (3 files)", "origin/main", "parameter id binds from query, was body"]) expect(mdText(s)).toBe(s);
  });

  it("fences a code span longer than any backtick run inside, padding a edge backtick", () => {
    expect(mdCode("a`b")).toBe("``a`b``");
    expect(mdCode("`edge`")).toBe("`` `edge` ``");
    expect(mdCode("a``b")).toBe("```a``b```");
  });

  it("writes a pipe as \\| in a table cell code span only when asked", () => {
    expect(mdCode("a|b")).toBe("`a|b`");
    expect(mdCode("a|b", true)).toBe("`a\\|b`");
  });

  it("flattens newlines and caps length", () => {
    expect(mdCode("one\ntwo\r\nthree")).toBe("`one two three`");
    expect(mdText("one\ntwo")).toBe("one two");
    expect(mdCode("x".repeat(10_000)).length).toBeLessThan(600);
    expect(mdText("x".repeat(10_000)).length).toBeLessThan(600);
  });

  it("escapes markup in text and defuses mentions and bare links", () => {
    expect(mdText("@club")).toBe(`@${ZWJ}club`);
    expect(mdText("](https://example.invalid)")).toBe(`\\]\\(https${ZWJ}://example.invalid)`.replace("\\(", "("));
    expect(mdText("![x](y)")).toBe("\\!\\[x\\](y)");
    expect(mdText("<img src=x>")).toBe("\\<img src=x\\>");
    expect(mdText("a|b")).toBe("a\\|b");
    expect(mdText("www.example.invalid")).toBe(`www${ZWJ}.example.invalid`);
  });

  it("produces no link, image, mention, html or extra cell when parsed", async () => {
    const parse = await parser();
    for (const h of HOSTILE) {
      const html = parse?.(`| a | b |\n|---|---|\n| ${mdText(h)} | ${mdCode(h, true)} |\n`);
      if (!html) continue;
      expect(html, h).not.toMatch(/<a |<img |<script/);
      expect((html.match(/<td/g) ?? []).length, h).toBe(2);
    }
  });
});

const impact = (name: string): ImpactDiffResult =>
  ({
    changedFiles: [`src/${name}.ts`],
    unknownFiles: [name],
    removedFiles: [],
    addedFiles: [],
    baseLabel: name,
    risk: { level: "high", reasons: [`touches ${name}`] },
    screens: [{ name, route: name, file: name }],
    screenCount: 1,
    routes: [{ method: "GET", path: name, file: name }],
    routeCount: 1,
    entities: [name],
    entityCount: 1,
    queues: [],
    queueCount: 0,
    tests: [name],
    testCount: 1,
    testCommands: [{ command: name }],
    reviewers: [{ name, commits: 2, files: 1 }],
    owners: [{ owner: name, files: 1 }],
    dependentCount: 0,
    chains: [{ path: [name, "src/club.ts"], endsAt: name }],
    limitations: [`not judged: ${name}`],
  }) as unknown as ImpactDiffResult;

describe("renderImpactMarkdown with hostile analyzed text", () => {
  it("keeps each row at two cells and writes no live mention, link or image", async () => {
    const parse = await parser();
    for (const h of HOSTILE) {
      const md = renderImpactMarkdown(impact(h));
      expect(md.split("\n").filter((l) => l.startsWith("| ")).every((l) => !/\n/.test(l)), h).toBe(true);
      const html = parse?.(md);
      if (html) {
        expect(html, h).not.toMatch(/<a |<img |<script/);
        for (const row of html.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) expect((row.match(/<t[dh]/g) ?? []).length, h).toBe(2);
      }
    }
  });

  it("breaks a mention outside code spans", () => {
    const md = renderImpactMarkdown(impact("@club")).replace(/`[^`\n]*`/g, "");
    expect(md).not.toMatch(/@club/);
  });

  it("writes the same markdown for ordinary names as before", () => {
    const md = renderImpactMarkdown(impact("src/club.ts"));
    expect(md).toContain("| Changed | `src/src/club.ts.ts` |");
    expect(md).toContain("| Unknown | `src/club.ts` |");
    expect(md).toContain("(base: src/club.ts)");
    expect(md).toContain("| Suggested reviewers | src/club.ts (2 commits) |");
    expect(md).toContain("- src/club.ts → src/club.ts  [src/club.ts]");
  });

  it("escapes the review-first brief", () => {
    const p: ReviewPriority = { symbol: "@club|x", file: "a`b.ts", line: 3, risk: "high", why: ["@team"], callers: 1, routes: 0, tests: [], testCount: 0 };
    const md = renderImpactBrief(impact("x"), [p], true);
    expect(md).toContain("``a`b.ts:3`` `@club|x`");
    expect(md).toContain(`@${ZWJ}team`);
  });
});

describe("renderSurfaceMarkdown with hostile analyzed text", () => {
  const diff = (h: string): SurfaceDiff => ({
    changes: [{ kind: "guard-lost", breaking: false, risky: true, route: `GET ${h}`, file: h, line: 4, reasons: [`no longer guarded by ${h}`] }],
    counts: { total: 1, breaking: 0, risky: 1, routesAdded: 0, routesRemoved: 0 },
    cycles: { introduced: [[h, "src/b.ts"]], grown: [] },
  });

  it("keeps the change row at five cells with no live link, image or mention", async () => {
    const parse = await parser();
    for (const h of HOSTILE) {
      const md = renderSurfaceMarkdown(diff(h), { base: h, head: "head" });
      const row = md.split("\n").find((l) => l.startsWith("| 🟠"))!;
      expect(row, h).toBeDefined();
      const html = parse?.(md);
      if (html) {
        expect(html, h).not.toMatch(/<a |<img |<script/);
        expect((html.match(/<td/g) ?? []).length, h).toBe(5);
      }
    }
  });

  it("writes the same markdown for ordinary names as before", () => {
    const md = renderSurfaceMarkdown(diff("src/club.ts"), { base: "origin/main", head: "HEAD" });
    expect(md).toContain("### API surface diff — origin/main → HEAD");
    expect(md).toContain("| 🟠 | guard lost | `GET src/club.ts` | `src/club.ts:4` | no longer guarded by src/club.ts |");
    expect(md).toContain("- 🟠 new: `src/club.ts` ↔ `src/b.ts`");
  });
});
