import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { checkPatch, renderPatchCheck } from "./patch-check.js";

describe("checking a patch before it is made", () => {
  let dir: string;
  const service = `package shop;
public class CarService {
  public void place(Car car) {}
  public void place(Car car, boolean express) {}
  public void cancel(String id) {}
}`;
  const controller = `package shop;
public class CarController {
  private CarService service;
  public void create(Car o) { service.place(o); }
  public void drop(String id) { service.cancel(id); }
}`;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-patch-"));
    await mkdir(join(dir, "app", "src", "shop"), { recursive: true });
    await writeFile(join(dir, "app", "pom.xml"), "<project><artifactId>shop</artifactId></project>");
    await writeFile(join(dir, "app", "src", "shop", "CarService.java"), service);
    await writeFile(join(dir, "app", "src", "shop", "CarController.java"), controller);
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the syntax it breaks and a call no overload accepts, and nothing for what is fine", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const broken = controller
      .replace("service.cancel(id);", "service.cancel(id, true);")
      .replace("service.place(o);", "service.place(o, false); helper(1, 2, 3);")
      .replace("public void drop(String id) {", "public void drop(String id) { if (id == null {");
    const got = await checkPatch(join(dir, "app"), join(dir, "out"), summary.symbolLinks, new Map([["src/shop/CarController.java", broken]]));
    expect(got.syntax.map((s) => [s.file, s.before, s.errors > 0, s.lines.includes(5)])).toEqual([["src/shop/CarController.java", 0, true, true]]);
    // place(o, false) matches an overload; cancel(id, true) matches none; helper(…) is not the project's.
    expect(got.arity.map((a) => `${a.call} ${a.passed} → ${a.accepts}`)).toEqual(["service.cancel 2 → 1"]);
    expect(renderPatchCheck(got)).toContain("**arguments** `src/shop/CarController.java:5` `service.cancel` passes 2; it takes 1");
    // The file as it is: nothing to report.
    expect(await checkPatch(join(dir, "app"), join(dir, "out"), summary.symbolLinks, new Map([["src/shop/CarController.java", controller]]))).toEqual({ syntax: [], arity: [] });
  });

  describe("in languages without overloading", () => {
    let dir2: string;
    const files: Record<string, string> = {
      "package.json": `{ "name": "garage" }`,
      "src/garage.ts": `export function park(car: string, level?: number, ...notes: string[]) { return car; }
export function wash(car: string, rinse = true) { return car; }`,
      "src/main.ts": `import { park, wash } from "./garage";
export function run() { park("a"); wash("a"); }`,
      "pit/stop.py": `class Garage:
    def park(self, car, level=1):
        pass
    def log(self, *events):
        pass
    @inject
    def fetch(self, car, repo):
        pass

def run():
    g = Garage()
    g.park(1)
    g.log(1)
    g.fetch(1)
`,
      "web/Garage.php": `<?php
class Garage {
  public function park($car, $level = 1) {}
}
function run() { $g = new Garage(); $g->park(1); }
`,
    };
    beforeAll(async () => {
      dir2 = await mkdtemp(join(tmpdir(), "clarifydoc-patch-"));
      for (const [f, text] of Object.entries(files)) {
        await mkdir(join(dir2, "app", f, ".."), { recursive: true });
        await writeFile(join(dir2, "app", f), text);
      }
      await analyze({ projectRoot: join(dir2, "app"), outputDir: join(dir2, "out"), lsp: false, gitHistory: false });
    });
    afterAll(async () => {
      await rm(dir2, { recursive: true, force: true });
    });

    it("checks TypeScript, Python and PHP calls against optional, rest and default parameters", async () => {
      const summary = await loadReportSummary(join(dir2, "out"));
      const check = async (file: string, text: string) =>
        (await checkPatch(join(dir2, "app"), join(dir2, "out"), summary.symbolLinks, new Map([[file, text]]))).arity.map((a) => `${a.call} ${a.passed} → ${a.accepts}`);
      // TypeScript: `level?` and `...notes` may be left out or filled; `wash` takes one or two.
      expect(await check("src/main.ts", files["src/main.ts"]!.replace(`park("a");`, `park();`).replace(`wash("a");`, `wash("a", false, 3);`))).toEqual(["park 0 → 1+", "wash 3 → 1-2"]);
      expect(await check("src/main.ts", files["src/main.ts"]!.replace(`park("a");`, `park("a", 1, "x", "y");`))).toEqual([]);
      // Python: self is not passed, *events takes any number, a decorator that may inject is not judged.
      expect(await check("pit/stop.py", files["pit/stop.py"]!.replace("g.park(1)", "g.park(1, 2, 3)").replace("g.log(1)", "g.log(1, 2, 3)").replace("g.fetch(1)", "g.fetch()"))).toEqual(["g.park 3 → 1-2"]);
      // PHP: extra arguments are ignored, too few is the error.
      expect(await check("web/Garage.php", files["web/Garage.php"]!.replace("$g->park(1);", "$g->park(1, 2, 3);"))).toEqual([]);
      expect(await check("web/Garage.php", files["web/Garage.php"]!.replace("$g->park(1);", "$g->park();"))).toEqual(["g.park 0 → 1+"]);
      expect(await check("src/main.ts", files["src/main.ts"]!)).toEqual([]);
    });
  });
});
