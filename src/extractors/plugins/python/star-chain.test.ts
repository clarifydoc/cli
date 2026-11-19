import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";

/** Python receivers typed through a star import chain and a class variable's construction. */
describe("Python star re-export chain", () => {
  let dir: string;
  const files: Record<string, string> = {
    "app/__init__.py": "",
    "app/club.py": "def park(n):\n    return n\n",
    "app/car.py": "def park(n):\n    return -n\n",
    "app/hub.py": "from app.club import *\n",
    "main.py": "from app.hub import *\n\n\ndef run():\n    park(1)\n",
    "app/boat.py": "class Boat:\n    def sign(self):\n        pass\n",
    "app/vehicle.py": "class Vehicle:\n    def sign(self):\n        pass\n",
    "app/holder.py": "from app.vehicle import Vehicle\n\n\nclass Holder:\n    car = Vehicle()\n\n    def go(self):\n        self.car.sign()\n",
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-py-star-"));
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "proj", f)), { recursive: true });
      await writeFile(join(dir, "proj", f), text);
    }
    await analyze({ projectRoot: join(dir, "proj"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links the call to the module the chain ends in, never a namesake", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const links = summary.symbolLinks
      .filter((l) => l.callName === "park")
      .map((l) => `${l.sourceFile} -> ${l.targetFile}::${l.targetSymbol} ${l.strategy}`);
    expect(links).toEqual(["main.py -> app/club.py::park import-file"]);
  });

  it("types a class variable by the class it constructs, never a namesake member", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const links = summary.symbolLinks
      .filter((l) => l.callName === "self.car.sign")
      .map((l) => `${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol}`);
    expect(links).toEqual(["Holder.go -> app/vehicle.py::Vehicle.sign"]);
  });
});
