import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";

/**
 * The cached analysis of a file stores its imports as rewritten through the
 * path aliases. An incremental run that keys reuse on the file's own bytes
 * alone kept an import pointing where the OLD tsconfig said after the alias
 * moved; it must agree with a cold run instead.
 */
describe("incremental runs after an alias-config change", () => {
  const root = mkdtempSync(join(tmpdir(), "clarifydoc-alias-src-"));
  const out = mkdtempSync(join(tmpdir(), "clarifydoc-alias-out-"));
  const cold = mkdtempSync(join(tmpdir(), "clarifydoc-alias-cold-"));
  afterAll(() => {
    for (const dir of [root, out, cold]) rmSync(dir, { recursive: true, force: true });
  });

  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("package.json", JSON.stringify({ name: "garage", dependencies: {} }));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@parking/*": ["src/*"] } } }));
  write("src/parking.ts", "export function park(car: string) {\n  return car;\n}\n");
  write("lib/parking.ts", "export function park(car: string) {\n  return car.trim();\n}\n");
  write("app/main.ts", 'import { park } from "@parking/parking";\n\nexport function arrive() {\n  return park("car");\n}\n');

  const importOf = (dir: string): string => {
    const main = JSON.parse(readFileSync(join(dir, "app/main.ts.json"), "utf-8")) as { imports: Array<{ source: string }> };
    return main.imports[0]!.source;
  };
  const run = (outputDir: string, incremental: boolean) =>
    analyze({ projectRoot: root, outputDir, lsp: false, gitHistory: false, incremental, stableOutput: true });

  it("re-reads the files whose aliases moved, and agrees with a cold run", async () => {
    await run(out, true);
    expect(importOf(out)).toBe("src/parking");
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf-8")) as { entries: Record<string, { resolver?: string }> };
    expect(manifest.entries["app/main.ts"]!.resolver).toMatch(/^[0-9a-f]{16}$/);

    write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@parking/*": ["lib/*"] } } }));
    await run(out, true);
    await run(cold, false);
    expect(importOf(cold)).toBe("lib/parking");
    expect(importOf(out)).toBe("lib/parking");
  });

  it("still reuses a file when nothing it depends on changed", async () => {
    const result = await run(out, true);
    expect(result).toBeDefined();
    const again = JSON.parse(readFileSync(join(out, "manifest.json"), "utf-8")) as { entries: Record<string, { resolver?: string }> };
    write("src/parking.ts", "export function park(car: string) {\n  return car + '!';\n}\n");
    const before = readFileSync(join(out, "app/main.ts.json"), "utf-8");
    await run(out, true);
    // main.ts was not re-parsed: its cached JSON is byte-identical, analyzedAt included.
    expect(readFileSync(join(out, "app/main.ts.json"), "utf-8")).toBe(before);
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf-8")).entries["app/main.ts"].resolver).toBe(again.entries["app/main.ts"]!.resolver);
  });
});
