import { describe, expect, it } from "vitest";
import { jsTestCommand } from "../extractors/plugins/javascript/test-command.js";
import { pythonTestCommand } from "../extractors/plugins/python/test-command.js";
import { goTestCommand } from "../extractors/plugins/go/test-command.js";
import { jvmTestCommand } from "../extractors/plugins/java-kotlin/test-command.js";
import { dotnetTestCommand } from "../extractors/plugins/csharp/test-command.js";
import { rubyTestCommand } from "../extractors/plugins/ruby/test-command.js";
import { phpTestCommand } from "../extractors/plugins/php/test-command.js";
import { rustTestCommand } from "../extractors/plugins/rust/test-command.js";
import { computeImpactDiff } from "./impact-diff.js";
import type { ProjectAnalysis } from "../types/analysis.js";

const ctx = (packages: string[] = [], manifests: string[] = []) => ({ packages: new Set(packages), manifests: new Set(manifests) });

describe("test commands per language", () => {
  it("names the runner the project declares, and filters by test name where the runner can", () => {
    expect(jsTestCommand([{ file: "src/a.test.ts", names: ["<setup>"] }], ctx(["vitest"]))).toBe("npx vitest run src/a.test.ts");
    expect(jsTestCommand([{ file: "a.spec.js", names: [] }], ctx())).toBe("npm test -- a.spec.js");
    expect(pythonTestCommand([{ file: "tests/test_cars.py", names: ["test_total", "TestGarage.test_add", "helper"] }])).toBe(
      "pytest tests/test_cars.py::test_total tests/test_cars.py::TestGarage::test_add",
    );
    expect(goTestCommand([{ file: "pkg/cars/cars_test.go", names: ["TestTotal", "helper"] }, { file: "pkg/x/x_test.go", names: [] }])).toBe(
      "go test ./pkg/cars ./pkg/x -run '^(TestTotal)$'",
    );
    expect(jvmTestCommand([{ file: "src/test/java/CarsTest.java", names: ["CarsTest.createsCar", "CarsTest.totals"] }], ctx([], ["pom.xml"]))).toBe(
      "mvn test -Dtest='CarsTest#createsCar+totals'",
    );
    expect(jvmTestCommand([{ file: "src/test/kotlin/CarsTest.kt", names: ["CarsTest.totals"] }], ctx([], ["build.gradle.kts"]))).toBe(
      "./gradlew test --tests 'CarsTest.totals'",
    );
    expect(dotnetTestCommand([{ file: "tests/CarsTests.cs", names: ["CarsTests.Creates"] }])).toBe('dotnet test --filter "FullyQualifiedName~CarsTests.Creates"');
    expect(rubyTestCommand([{ file: "spec/cars_spec.rb", names: [] }], ctx())).toBe("bundle exec rspec spec/cars_spec.rb");
    expect(rubyTestCommand([{ file: "test/cars_test.rb", names: [] }], ctx())).toBe("bin/rails test test/cars_test.rb");
    expect(phpTestCommand([{ file: "tests/CarsTest.php", names: ["CarsTest.testTotal"] }], ctx())).toBe("vendor/bin/phpunit --filter 'testTotal'");
    expect(rustTestCommand([{ file: "src/lib.rs", names: ["tests::totals"] }])).toBe("cargo test -- totals");
  });
});

describe("impact: the tests that call the change", () => {
  it("follows callers into test functions and builds their command", () => {
    const summary = {
      files: ["src/cars.py", "tests/test_cars.py"],
      componentGraph: { "tests/test_cars.py": ["src/cars.py"] },
      symbolLinks: [
        { sourceFile: "src/cars.py", sourceSymbol: "checkout", sourceLine: 10, targetFile: "src/cars.py", targetSymbol: "total", targetLine: 1, callName: "total", confidence: "EXTRACTED" },
        { sourceFile: "tests/test_cars.py", sourceSymbol: "test_checkout", sourceLine: 5, targetFile: "src/cars.py", targetSymbol: "checkout", targetLine: 10, callName: "checkout", confidence: "EXTRACTED" },
      ],
      externalPackages: [{ name: "pytest", ecosystem: "pypi", category: "testing", declaredIn: "pyproject.toml" }],
      blastRadius: [],
      routeMap: [],
      screens: [],
    } as unknown as ProjectAnalysis;
    const r = computeImpactDiff(summary, ["src/cars.py"], { symbols: { changed: [{ file: "src/cars.py", symbol: "total", line: 1, endLine: 3 }], moduleLevel: [] } });
    expect(r.testCallers).toEqual([{ file: "tests/test_cars.py", symbol: "test_checkout", line: 5, depth: 2 }]);
    expect(r.testCommands).toEqual([{ language: "python", command: "pytest tests/test_cars.py::test_checkout" }]);
  });
});

describe("test commands narrowed to the marked tests", () => {
  it("filters vitest/jest by title path, and rspec by line; a file with an unmarked test runs whole", () => {
    const builds = { path: ["league", "builds"], line: 10 };
    const leader = { path: ["league", "leader (top)"], line: 14 };
    expect(jsTestCommand([{ file: "test/table.test.ts", names: ["league › builds", "league › leader (top)"], cases: [builds, leader] }], ctx(["vitest"]))).toBe(
      "npx vitest run test/table.test.ts -t '(league builds|league leader \\(top\\))'",
    );
    // A suite selects its cases.
    expect(jsTestCommand([{ file: "a.test.ts", names: ["league", "league › builds"], cases: [{ path: ["league"], line: 4 }, builds] }], ctx(["jest"]))).toBe("npx jest a.test.ts -t 'league'");
    // A helper reaching the change is reached by the cases calling it; the module's own statements run with every test.
    expect(jsTestCommand([{ file: "a.test.ts", names: ["seedClubs", "league › builds"], cases: [builds] }], ctx(["vitest"]))).toBe("npx vitest run a.test.ts -t 'league builds'");
    expect(jsTestCommand([{ file: "a.test.ts", names: ["<setup>", "league › builds"], cases: [builds] }], ctx(["vitest"]))).toBe("npx vitest run a.test.ts");
    expect(jsTestCommand([{ file: "a.test.ts", names: ["seedClubs"] }], ctx(["vitest"]))).toBe("npx vitest run a.test.ts");
    // A hook of the whole file runs with every test in it.
    expect(jsTestCommand([{ file: "a.test.ts", names: ["beforeEach"], cases: [{ path: [], line: 2, hook: true }] }], ctx(["vitest"]))).toBe("npx vitest run a.test.ts");
    expect(rubyTestCommand([{ file: "spec/club_spec.rb", names: ["Club › .rank › orders", "Club › leader"], cases: [{ path: ["Club", ".rank", "orders"], line: 12 }, { path: ["Club", "leader"], line: 5 }] }], ctx(["rspec-rails"]))).toBe(
      "bundle exec rspec spec/club_spec.rb:5:12",
    );
    expect(rubyTestCommand([{ file: "spec/club_spec.rb", names: ["Club › before"], cases: [{ path: ["Club"], line: 3, hook: true }] }], ctx(["rspec-rails"]))).toBe("bundle exec rspec spec/club_spec.rb");
  });

  it("impact names the test cases that reach the change and runs just them", () => {
    const summary = {
      files: ["src/table.ts", "test/table.test.ts"],
      componentGraph: { "test/table.test.ts": ["src/table.ts"] },
      symbolLinks: [
        { sourceFile: "src/table.ts", sourceSymbol: "topClub", sourceLine: 12, targetFile: "src/table.ts", targetSymbol: "sortClubs", targetLine: 3, callName: "sortClubs", confidence: "EXTRACTED" },
        { sourceFile: "test/table.test.ts", sourceSymbol: "league › leader › finds the top club", sourceLine: 16, targetFile: "src/table.ts", targetSymbol: "topClub", targetLine: 11, callName: "topClub", confidence: "EXTRACTED" },
      ],
      testFunctions: {
        "test/table.test.ts": [
          { symbol: "league", line: 4, kind: "suite", title: "league" },
          { symbol: "league › leader › finds the top club", line: 15, kind: "case", title: "finds the top club", path: ["league", "leader"] },
        ],
      },
      externalPackages: [{ name: "vitest", ecosystem: "npm", category: "testing", declaredIn: "package.json" }],
      blastRadius: [],
      routeMap: [],
      screens: [],
    } as unknown as ProjectAnalysis;
    const r = computeImpactDiff(summary, ["src/table.ts"], { symbols: { changed: [{ file: "src/table.ts", symbol: "sortClubs", line: 3, endLine: 5 }], moduleLevel: [] } });
    expect(r.testCommands).toEqual([{ language: "typescript", command: "npx vitest run test/table.test.ts -t 'league leader finds the top club'" }]);
    expect(r.symbolImpact!.direct).toMatchObject([{ symbol: "topClub", standing: "covered", coveredBy: { symbol: "league › leader › finds the top club" } }]);
  });
});
