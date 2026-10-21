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
