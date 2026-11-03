import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { analyze } from "../core/analyzer.js";
import { buildMcpServer } from "./server.js";

/**
 * `clarifydoc_trace direction=overrides` names what a method overrides and what
 * overrides it; `clarifydoc_impact` judges a changed method by its overrides as
 * well as its callers.
 */
describe("overrides", () => {
  let dir: string;
  let call: (tool: string, args: Record<string, unknown>) => Promise<string>;
  const file = async (path: string, text: string) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  };
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", ...args], { cwd: dir, stdio: "pipe" });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-overrides-"));
    await file("package.json", '{"name":"garage","version":"1.0.0"}');
    await file("src/vehicle.ts", "export interface Vehicle {\n  start(gear: number): void;\n}\n");
    await file("src/car.ts", 'import { Vehicle } from "./vehicle";\nexport class Car implements Vehicle {\n  start(gear: number): void {}\n  honk(): void {}\n}\n');
    await file("src/sports-car.ts", 'import { Car } from "./car";\nexport class SportsCar extends Car {\n  start(gear: number): void {}\n}\n');
    await file("src/truck.ts", 'import { Car } from "./car";\nexport class Truck extends Car {\n  start(gear: number): void {}\n}\n');
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "garage");
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
    const { server } = buildMcpServer({ projectRoot: dir, analysisDir: join(dir, ".clarifydoc"), allowAnalyze: false, allowColdStart: false });
    call = async (name, args) => {
      const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return (res?.result as { content: Array<{ text: string }> }).content[0]!.text;
    };
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the declaration a method implements and the overrides below it, with path:line", async () => {
    const text = await call("clarifydoc_trace", { symbol: "Car.start", direction: "overrides" });
    expect(text).toContain("# Overrides — Car.start() src/car.ts:3");
    expect(text).toMatch(/## Overrides or implements \(1\)\n- Vehicle\.start\(\) src\/vehicle\.ts:2 \(abstract\)/);
    expect(text).toMatch(/## Overridden below by \(2\)\n- SportsCar\.start\(\) src\/sports-car\.ts:3\n- Truck\.start\(\) src\/truck\.ts:3/);
  });

  it("lists a class's bases and subclasses", async () => {
    const text = await call("clarifydoc_trace", { symbol: "Car", direction: "overrides" });
    expect(text).toContain("- Vehicle src/vehicle.ts:1 (interface)");
    expect(text).toContain("- SportsCar src/sports-car.ts:2");
  });

  it("offers near names on a miss", async () => {
    const text = await call("clarifydoc_trace", { symbol: "Car.strat", direction: "overrides" });
    expect(text).toContain("No method or class named `Car.strat`");
    expect(text).toMatch(/^Near names: `Car\.start`/m);
  });

  it("impact lists the overrides a changed signature leaves on the old one, and skips a deleted file", async () => {
    await file("src/car.ts", 'import { Vehicle } from "./vehicle";\nexport class Car implements Vehicle {\n  start(gear: number, driver: string): void {}\n  honk(): void {}\n}\n');
    await file("src/sports-car.ts", 'import { Car } from "./car";\nexport class SportsCar extends Car {\n  start(gear: number, driver: string): void {}\n}\n');
    git("rm", "-q", "src/vehicle.ts");
    const text = await call("clarifydoc_impact", {});
    expect(text).toMatch(/\*\*breaking\*\* `Car\.start`[^\n]*overridden by Truck\.start \(src\/truck\.ts:3\), still on the old signature/);
    expect(text).not.toContain("SportsCar.start (src/sports-car.ts");
    expect(text).not.toMatch(/ENOENT|Error analyzing/);
  });
});
