import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../core/analyzer.js";
import { buildMcpServer } from "./server.js";

/**
 * "The definition named by this name": `Car` is the class, before a test's
 * helper `car()` — in clarifydoc_search, clarifydoc_extract and
 * clarifydoc_explain alike — and `FleetCar`, a name the class is only
 * imported under, finds the class in search as it does in trace.
 */
describe("the definition a name names", () => {
  let dir: string;
  let call: (tool: string, args: Record<string, unknown>) => Promise<string>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-named-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("package.json", '{"name":"garage","version":"1.0.0"}');
    await file("src/garage/car.ts", 'export class Car {\n  constructor(public plate: string) {}\n  drive(): void {}\n}\nexport const CAR = "car";\n');
    await file(
      "src/garage/fleet.ts",
      'import { Car as FleetCar } from "./car";\nexport const car = new FleetCar("x");\nexport function carCount(): number { return 1; }\nexport function carWash(c: FleetCar): void { c.drive(); }\nexport function carPark(): void {}\n',
    );
    await file(
      "src/tests/car.test.ts",
      'import { Car } from "../garage/car";\nfunction car(): Car { return new Car("t"); }\nfunction car2(): Car { return car(); }\ntest("drives", () => { car().drive(); car2(); });\n',
    );
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

  const bullets = (text: string) => text.split("\n").filter((l) => l.startsWith("- "));

  it("search ranks the class spelled like the query before the test helper", async () => {
    const rows = bullets(await call("clarifydoc_search", { query: "Car", kinds: ["symbol"] }));
    expect(rows[0]).toMatch(/^- \[symbol\] Car \(class\) \(src\/garage\/car\.ts\)/);
    expect(rows.findIndex((r) => r.includes("src/tests/car.test.ts"))).toBeGreaterThan(0);
  });

  it("search still puts the test helper first when the query spells it", async () => {
    const rows = bullets(await call("clarifydoc_search", { query: "car", kinds: ["symbol"] }));
    expect(rows[0]).toMatch(/^- \[symbol\] car\(\) \(src\/tests\/car\.test\.ts:2\)/);
  });

  it("search finds a class by the name it is imported under", async () => {
    const rows = bullets(await call("clarifydoc_search", { query: "FleetCar" }));
    expect(rows[0]).toMatch(/^- \[symbol\] Car \(class\) \(src\/garage\/car\.ts\).* · imported as FleetCar$/);
  });

  it("extract returns the class, not the test helper", async () => {
    const text = await call("clarifydoc_extract", { symbol: "Car", depth: 0 });
    expect(text).toMatch(/^## Car\(\) — src\/garage\/car\.ts:1-4/m);
    expect(text).not.toContain("car.test.ts");
  });

  it("explain packs the class's source", async () => {
    const text = await call("clarifydoc_explain", { subject: "Car" });
    expect(text.split("\n")[0]).toBe("# Car (src/garage/car.ts)");
    expect(text).toContain("export class Car {");
    expect(text).not.toContain('return new Car("t")');
  });
});
