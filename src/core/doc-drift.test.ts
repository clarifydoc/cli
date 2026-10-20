import { describe, expect, it } from "vitest";
import { checkDocReferences, docReferences, type DocDriftContext } from "./doc-drift.js";

const tree = new Set(["src", "src/app.ts", "src/routes", "src/routes/orders.ts", "docs", "docs/guide.md", "README.md"]);
const ctx = (over: Partial<DocDriftContext> = {}): DocDriftContext => ({
  exists: (p) => tree.has(p),
  topLevel: new Set(["src", "docs", "README.md"]),
  routes: new Set(["GET /api/orders/{}", "POST /api/orders"]),
  routeHeads: new Set(["api"]),
  normalize: (p) => p.replace(/:\w+|\{\w+\}/g, "{}").toLowerCase(),
  classMembers: new Map([["OrderService", new Set(["create", "cancel"])], ["Unread", null]]),
  ...over,
});
const findings = (doc: string, text: string, c = ctx()) => checkDocReferences(docReferences(doc, text), c).map((f) => `${f.kind} ${f.text} — ${f.reason} (${f.confidence})`);

describe("doc drift", () => {
  it("skips a generated block between markers — ours and BEGIN/END — but nothing after it", () => {
    expect(findings("AGENTS.md", [
      "<!-- clarifydoc:start -->",
      "Hub files: `src/gone.ts`.",
      "<!-- clarifydoc:end -->",
      "<!-- BEGIN generated toc -->",
      "- `src/also-gone.ts`",
      "<!-- END generated toc -->",
      "```",
      "<!-- other:start -->",
      "```",
      "Real prose: `src/missing.ts`.",
    ].join("\n"))).toEqual(["path src/missing.ts — no such path (INFERRED)"]);
  });

  it("reports paths into the tree that are gone, links that break, routes and members that no longer exist", () => {
    expect(findings("docs/guide.md", [
      "Start in `src/app.ts` and `src/routes/legacy.ts`.",
      "See [the guide](../README.md) and [old notes](./notes.md).",
      "`GET /api/orders/:id` and `DELETE /api/orders/:id` and `GET /v1/charges` (Stripe's).",
      "Call `OrderService.create()` or `OrderService.refund()`; `Unread.anything` is not judged.",
    ].join("\n"))).toEqual([
      "path src/routes/legacy.ts — no such path (INFERRED)",
      "path ./notes.md — no such link target (INFERRED)",
      "route DELETE /api/orders/:id — no route serves it (INFERRED)",
      "member OrderService.refund — OrderService has no member refund (INFERRED)",
    ]);
  });

  it("leaves alone fenced examples, build output, other repositories, invented names and history", () => {
    expect(findings("docs/guide.md", [
      "```sh", "node dist/cli.js src/missing.ts", "```",
      "Build writes `dist/index.js`; see `vendor/x.js` and `other-repo/src/x.ts`.",
      "Create `src/my-analyzer.ts` for your own pass.",
      "[sibling](../../other/x.md) and [wiki](<https://en.wikipedia.org/wiki/Nehalem_(microarchitecture)>)",
      "- Removed field `OrderService.refund` and the file `src/old.ts`.",
    ].join("\n"))).toEqual([]);
  });

  it("is sure of a path git saw deleted or renamed", () => {
    const c = ctx({ history: (p) => (p === "src/routes/legacy.ts" ? { renamedTo: "src/routes/orders.ts" } : p === "src/gone.ts" ? { deletedIn: "abc1234" } : null) });
    expect(findings("README.md", "`src/routes/legacy.ts` and `src/gone.ts` and `src/never.ts`", c)).toEqual([
      "path src/routes/legacy.ts — renamed to src/routes/orders.ts (EXTRACTED)",
      "path src/gone.ts — deleted in abc1234 (EXTRACTED)",
      "path src/never.ts — no such path (INFERRED)",
    ]);
  });
});
