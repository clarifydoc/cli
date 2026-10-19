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
    expect(pythonTestCommand([{ file: "tests/test_orders.py", names: ["test_total", "TestCart.test_add", "helper"] }])).toBe(
      "pytest tests/test_orders.py::test_total tests/test_orders.py::TestCart::test_add",
    );
    expect(goTestCommand([{ file: "pkg/orders/orders_test.go", names: ["TestTotal", "helper"] }, { file: "pkg/x/x_test.go", names: [] }])).toBe(
      "go test ./pkg/orders ./pkg/x -run '^(TestTotal)$'",
    );
    expect(jvmTestCommand([{ file: "src/test/java/OrdersTest.java", names: ["OrdersTest.createsOrder", "OrdersTest.totals"] }], ctx([], ["pom.xml"]))).toBe(
      "mvn test -Dtest='OrdersTest#createsOrder+totals'",
    );
    expect(jvmTestCommand([{ file: "src/test/kotlin/OrdersTest.kt", names: ["OrdersTest.totals"] }], ctx([], ["build.gradle.kts"]))).toBe(
      "./gradlew test --tests 'OrdersTest.totals'",
    );
    expect(dotnetTestCommand([{ file: "tests/OrdersTests.cs", names: ["OrdersTests.Creates"] }])).toBe('dotnet test --filter "FullyQualifiedName~OrdersTests.Creates"');
    expect(rubyTestCommand([{ file: "spec/orders_spec.rb", names: [] }], ctx())).toBe("bundle exec rspec spec/orders_spec.rb");
    expect(rubyTestCommand([{ file: "test/orders_test.rb", names: [] }], ctx())).toBe("bin/rails test test/orders_test.rb");
    expect(phpTestCommand([{ file: "tests/OrdersTest.php", names: ["OrdersTest.testTotal"] }], ctx())).toBe("vendor/bin/phpunit --filter 'testTotal'");
    expect(rustTestCommand([{ file: "src/lib.rs", names: ["tests::totals"] }])).toBe("cargo test -- totals");
  });
});

describe("impact: the tests that call the change", () => {
  it("follows callers into test functions and builds their command", () => {
    const summary = {
      files: ["src/orders.py", "tests/test_orders.py"],
      componentGraph: { "tests/test_orders.py": ["src/orders.py"] },
      symbolLinks: [
        { sourceFile: "src/orders.py", sourceSymbol: "checkout", sourceLine: 10, targetFile: "src/orders.py", targetSymbol: "total", targetLine: 1, callName: "total", confidence: "EXTRACTED" },
        { sourceFile: "tests/test_orders.py", sourceSymbol: "test_checkout", sourceLine: 5, targetFile: "src/orders.py", targetSymbol: "checkout", targetLine: 10, callName: "checkout", confidence: "EXTRACTED" },
      ],
      externalPackages: [{ name: "pytest", ecosystem: "pypi", category: "testing", declaredIn: "pyproject.toml" }],
      blastRadius: [],
      routeMap: [],
      screens: [],
    } as unknown as ProjectAnalysis;
    const r = computeImpactDiff(summary, ["src/orders.py"], { symbols: { changed: [{ file: "src/orders.py", symbol: "total", line: 1, endLine: 3 }], moduleLevel: [] } });
    expect(r.testCallers).toEqual([{ file: "tests/test_orders.py", symbol: "test_checkout", line: 5, depth: 2 }]);
    expect(r.testCommands).toEqual([{ language: "python", command: "pytest tests/test_orders.py::test_checkout" }]);
  });
});
