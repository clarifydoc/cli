import { describe, it, expect } from "vitest";
import { join } from "path";
import { BodyIndex, thrownTypes } from "./body-search.js";
import { buildMcpServer } from "./server.js";

const SRC = `// Stores the user's password
// as a salted bcrypt hash.
export async function storePassword(user, plain) {
  const digest = await bcrypt.hash(plain, 12);
  await db.users.update(user.id, { digest });
}

export function retryWithBackoff(fn) {
  let delay = 100;
  for (let i = 0; i < 5; i++) {
    try { return fn(); } catch { delay *= 2; }
  }
  throw new RetryExhaustedError("gave up");
}
`;

describe("BodyIndex", () => {
  const build = () => BodyIndex.build([{ file: "a.ts", functions: [{ name: "storePassword", line: 3, endLine: 6 }, { name: "retryWithBackoff", line: 8, endLine: 14 }] }], async () => SRC);

  it("ranks functions by what their body and doc comment say, with the line that matched", async () => {
    const index = await build();
    const [hit] = index.search("salted hash", 5);
    expect([hit!.doc.name, hit!.best.n]).toEqual(["storePassword", 2]);
    expect(index.search("backoff delay", 5).map((h) => h.doc.name)).toEqual(["retryWithBackoff"]);
    // Keywords alone say nothing.
    expect(index.search("const await return", 5)).toEqual([]);
  });

  it("names the error types a body throws", async () => {
    const index = await build();
    expect(thrownTypes(index.docs[1]!)).toEqual(["RetryExhaustedError"]);
    expect(thrownTypes(index.docs[0]!)).toEqual([]);
  });
});

describe("BodyIndex — Markdown", () => {
  const DOC = `Intro line about the service.

# Payments

Refunds go back to the original card within five days.

## Retries

\`\`\`
# not a heading inside a fence
\`\`\`
A failed capture is retried with backoff before the order is cancelled.
`;
  it("indexes a document by its sections, a fenced # is not a heading, and ranks a section beside the code", async () => {
    const index = await BodyIndex.build(
      [{ file: "a.ts", functions: [{ name: "retryWithBackoff", line: 8, endLine: 14 }] }],
      async (file) => (file === "docs/payments.md" ? DOC : SRC),
      ["docs/payments.md"],
    );
    const sections = index.docs.filter((d) => d.kind === "doc").map((d) => `${d.name}@${d.line}-${d.endLine}`);
    expect(sections).toEqual(["payments.md@1-2", "Payments@3-6", "Retries@7-13"]);
    const hits = index.search("refunds card", 3);
    expect(hits[0]).toMatchObject({ doc: { kind: "doc", name: "Payments", file: "docs/payments.md" }, best: { n: 5 } });
    const both = index.search("retried backoff", 3).map((h) => `${h.doc.kind ?? "fn"} ${h.doc.name}`);
    expect(both).toEqual(expect.arrayContaining(["doc Retries", "fn retryWithBackoff"]));
  });
});

describe("clarifydoc_search — bodies and signatures (sample-backend)", () => {
  const { server } = buildMcpServer({ projectRoot: join("test-fixtures", "sample-backend"), analysisDir: join("test-output", "sample-backend"), allowAnalyze: false, allowColdStart: false });
  const search = async (args: Record<string, unknown>) => {
    const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clarifydoc_search", arguments: args } });
    return (res?.result as { content: Array<{ text: string }> }).content[0]!.text;
  };

  it("finds a function by what its body calls, which no name says", async () => {
    const text = await search({ query: "bcrypt compare", body: true });
    expect(text).toMatch(/\[fn\] verifyPassword\(\) \(services\/authService\.ts:12\) · L13: return bcrypt\.compare/);
  });

  it("narrows to what throws a type, and to a declared signature", async () => {
    expect(await search({ query: "credentials", throws: "Error" })).toMatch(/\[fn\] authenticate\(\)/);
    const typed = await search({ query: "password", signature: "Promise<boolean>" });
    expect(typed).toMatch(/verifyPassword/);
    expect(typed).not.toMatch(/hashPassword/);
  });
});
