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
