/**
 * clarifydoc_extract package=…: the API of a package as installed, read from
 * what it ships — with the declared range beside the installed version when
 * their majors differ, and a miss that says where it is declared.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cp, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildMcpServer } from "./server.js";

let dir = "";
const proj = () => join(dir, "proj");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clarifydoc-package-api-"));
  await cp(resolve("test-fixtures/sample-backend"), proj(), { recursive: true });
  const put = async (path: string, text: string) => {
    await mkdir(join(proj(), path, ".."), { recursive: true });
    await writeFile(join(proj(), path), text);
  };
  await put("node_modules/zod/package.json", JSON.stringify({ name: "zod", version: "4.1.0", types: "index.d.ts" }));
  await put("node_modules/zod/index.d.ts", [
    "/** A schema for a club's object. */",
    "export declare function object<T>(shape: T): ZodObject<T>;",
    "export declare function string(): ZodString;",
    "export declare class ZodObject<T> {",
    "  parse(input: unknown): T;",
    "}",
  ].join("\n"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function extract(args: Record<string, unknown>): Promise<string> {
  const { server } = buildMcpServer({ projectRoot: proj(), analysisDir: resolve("test-output/sample-backend"), allowAnalyze: false, allowColdStart: false, log: () => {} });
  const res = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clarifydoc_extract", arguments: args } })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  expect(res.result.isError ?? false).toBe(false);
  return res.result.content[0]!.text;
}

describe("installed package API", () => {
  it("lists what the installed version exports, and says when it is not the declared major", async () => {
    const text = await extract({ package: "zod" });
    expect(text.split("\n")[0]).toBe("# zod 4.1.0 — 3 exports, from node_modules/zod/index.d.ts");
    expect(text).toContain("Declared ^3.22.0 in package.json; installed 4.1.0 — the installed one is what runs.");
    expect(text).toContain("- function object — `export declare function object<T>(shape: T): ZodObject<T>` (node_modules/zod/index.d.ts:2)");
  });

  it("gives one export's declaration", async () => {
    const text = await extract({ package: "zod", symbol: "ZodObject" });
    expect(text).toMatch(/## ZodObject \(node_modules\/zod\/index\.d\.ts:4\)\n```ts\nexport declare class ZodObject<T> \{\n {2}parse\(input: unknown\): T;\n\}\n```/);
  });

  it("names where a package that is not installed is declared", async () => {
    const text = await extract({ package: "express" });
    expect(text).toMatch(/^express is not installed where its project would read it/);
    expect(text).toContain("The analysis has it declared in package.json at ^4.18.0");
    expect(text).toContain("Next: clarifydoc_health category=dependencies");
  });
});
