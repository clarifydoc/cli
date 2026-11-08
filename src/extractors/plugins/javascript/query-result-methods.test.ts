import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractJsVariableAliases } from "./variable-aliases.js";
import type { ImportInfo } from "../../../types/analysis.js";

const imp = (source: string, ...specifiers: string[]): ImportInfo => ({ source, specifiers, isDefault: false, isNamespace: false, isType: false, line: 1 });

/**
 * A query hook's result runs its request again through `refetch()` / `fetchNextPage()`: the receiver is
 * bound to the project's query factory the hook was given, not to the library's module.
 */
const SRC = `const inbox = useInfiniteQuery(computed(() => inboxQuery(page.value)));
const { data, refetch } = useQuery({ ...squadQuery(), enabled: open });
const both = useQuery(() => ({ a: aQuery(), b: bQuery() }));
const none = useQuery({ queryKey: ['x'], queryFn: load });`;

describe("query hook results", () => {
  it("bind to the one project factory the hook calls, and nothing else", async () => {
    const tree = await parseSource(SRC, "typescript" as never, "Inbox.ts");
    const aliases = extractJsVariableAliases(tree, [
      imp("@tanstack/vue-query", "useInfiniteQuery", "useQuery"),
      imp("@/client/queries", "inboxQuery", "squadQuery", "aQuery", "bQuery"),
    ]);
    expect(aliases.get("inbox")).toMatchObject({ source: "@/client/queries", factory: "inboxQuery" });
    // A destructured result: only the members that run the request again.
    expect(aliases.get("refetch")).toMatchObject({ source: "@/client/queries", factory: "squadQuery", member: "refetch" });
    expect(aliases.has("data")).toBe(false);
    // Two factories, or none: the library's own binding stays.
    expect(aliases.get("both")).toMatchObject({ source: "@tanstack/vue-query", factory: "useQuery" });
    // A source already resolved to the project's own path is as much the project's as `@/…`.
    const resolved = extractJsVariableAliases(tree, [imp("@tanstack/vue-query", "useInfiniteQuery", "useQuery"), imp("app/client/queries/inbox", "inboxQuery")]);
    expect(resolved.get("inbox")).toMatchObject({ source: "app/client/queries/inbox", factory: "inboxQuery" });
    expect(aliases.get("none")).toMatchObject({ source: "@tanstack/vue-query", factory: "useQuery" });
  });
});
