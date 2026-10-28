import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A name bound inside a function — a block's `let`, a destructured parameter,
 * a Python assignment, loop or `with` target, a `nonlocal`, a Go `range`
 * variable — is what the calls there use, not the parameter, receiver or
 * import of the same name; and the outer binding comes back outside the block.
 */
const FILES: Record<string, string> = {
  "web/package.json": `{ "name": "garage-web", "version": "1.0.0" }`,
  "web/src/vehicles.ts": `export class Car { drive(): number { return 1; } }
export class Truck { drive(): number { return 2; } }
`,
  "web/src/tune.ts": `export function boost(x: number): number { return x; }
`,
  "web/src/main.ts": `import { Car, Truck } from './vehicles';
import { boost } from './tune';

export function g(v: Car, x: boolean) {
  if (x) {
    let v = new Truck();
    v.drive();
  }
  v.drive();
}

export function k({ boost }: { boost: (n: number) => number }) {
  return boost(1);
}

export function m(n: number) {
  return boost(n);
}
`,
  "py/pyproject.toml": `[project]\nname = "league"\n`,
  "py/league/__init__.py": "",
  "py/league/drills.py": `def sprint(n):
    return n
`,
  "py/league/coach.py": `from league.drills import sprint


def a(xs):
    sprint = len
    return sprint(xs)


def b(xs):
    for sprint in xs:
        sprint()


def c(path):
    with open(path) as sprint:
        sprint(1)


def d():
    sprint = None

    def inner():
        nonlocal sprint
        sprint(2)
    return inner


def f(xs):
    return sprint(xs)
`,
  "go/go.mod": "module example.com/garage\n\ngo 1.21\n",
  "go/garage/car.go": `package garage

type Car struct{ Name string }

func (c *Car) Wash() {}

func (c *Car) Park() {}

type Part struct{}

func (p Part) Fit() {}

func (c *Car) Service(parts []Part) {
	c.Wash()
	for _, c := range parts {
		c.Fit()
	}
	c.Park()
}
`,
};

describe("shadowing bindings", () => {
  let dir: string;
  let links: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-shadowing-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary: ProjectAnalysis = await loadReportSummary(join(dir, "out"));
    links = summary.symbolLinks.filter((l) => l.strategy !== "reference").map((l) => `${l.sourceSymbol}:${l.sourceLine} ${l.callName} -> ${l.targetFile.split("/").pop()}::${l.targetSymbol}`);
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("TypeScript: a block's `let` types the calls in the block, the parameter the ones after it", () => {
    expect(links).toContain("g:7 v.drive -> vehicles.ts::Truck.drive");
    expect(links).toContain("g:9 v.drive -> vehicles.ts::Car.drive");
    expect(links).not.toContain("g:7 v.drive -> vehicles.ts::Car.drive");
  });

  it("TypeScript: a destructured parameter shadows the import of its name", () => {
    expect(links.filter((l) => l.startsWith("k:"))).toEqual([]);
    expect(links).toContain("m:17 boost -> tune.ts::boost");
  });

  it("Python: an assignment, a loop or `with` target and a nonlocal shadow the import; elsewhere it is the import", () => {
    expect(links.filter((l) => /^(a|b|c|inner):/.test(l))).toEqual([]);
    expect(links).toContain("f:29 sprint -> drills.py::sprint");
  });

  it("Go: a `range` variable of the receiver's name is the element inside the loop, the receiver outside", () => {
    expect(links).toEqual(expect.arrayContaining([
      "Car.Service:14 c.Wash -> car.go::Car.Wash",
      "Car.Service:16 c.Fit -> car.go::Part.Fit",
      "Car.Service:18 c.Park -> car.go::Car.Park",
    ]));
  });
});
