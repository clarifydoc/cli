import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { goTestSuites } from "./test-suites.js";
import { goTestCommand } from "./test-command.js";

const TESTIFY = `package cars

import (
	"testing"

	"github.com/stretchr/testify/suite"
)

type GarageSuite struct{ suite.Suite }

func (s *GarageSuite) TestAdd() {}

func TestGarageSuite(t *testing.T) {
	suite.Run(t, new(GarageSuite))
}
`;

describe("goTestSuites", () => {
  it("names the runner of a suite run through testify", () => {
    expect(goTestSuites(TESTIFY.split("\n"))).toEqual([{ type: "GarageSuite", runner: "TestGarageSuite" }]);
    expect(goTestSuites(TESTIFY.replace("new(GarageSuite)", "&GarageSuite{}").split("\n"))).toEqual([{ type: "GarageSuite", runner: "TestGarageSuite" }]);
    expect(goTestSuites(TESTIFY.replace('"github.com/stretchr/testify/suite"', 'ts "github.com/stretchr/testify/suite"').replace("suite.Run", "ts.Run").split("\n"))).toHaveLength(1);
  });

  it("states nothing without the testify import, outside a test function or for a type two runners run", () => {
    // decoy: a plain struct with a TestSomething method, a Run of another package named suite
    expect(goTestSuites(TESTIFY.replace(/\t"github.com[^\n]*\n/, "").split("\n"))).toEqual([]);
    expect(goTestSuites(TESTIFY.replace("func TestGarageSuite(t *testing.T) {", "func runGarage(t *testing.T) {").split("\n"))).toEqual([]);
    expect(goTestSuites(`${TESTIFY}\nfunc TestGarageAgain(t *testing.T) {\n\tsuite.Run(t, new(GarageSuite))\n}\n`.split("\n"))).toEqual([]);
    expect(goTestSuites(TESTIFY.replace("suite.Run(t,", "mysuite.Run(t,").split("\n"))).toEqual([]);
  });
});

describe("goTestCommand with a stated runner", () => {
  const suites = { GarageSuite: "TestGarageSuite" };
  it("selects the suite's methods with -testify.m under their runner, several in one regex", () => {
    expect(goTestCommand([{ file: "pkg/cars/cars_test.go", names: ["GarageSuite.TestAdd", "GarageSuite.TestRemove", "GarageSuite.SetupTest"], suites }])).toBe(
      "go test ./pkg/cars -run '^TestGarageSuite$' -testify.m '^(TestAdd|TestRemove)$'",
    );
  });
  it("keeps the subtest filter for a suite with no stated runner", () => {
    expect(goTestCommand([{ file: "pkg/cars/cars_test.go", names: ["GarageSuite.TestAdd"] }])).toBe("go test ./pkg/cars -run '/^(TestAdd)$'");
    expect(goTestCommand([{ file: "pkg/cars/cars_test.go", names: ["Plain.TestSomething"], suites }])).toBe("go test ./pkg/cars -run '/^(TestSomething)$'");
  });
});

describe("testify suites in an analysis", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "go-testify-"));
    await writeFile(join(dir, "go.mod"), "module example.com/league\ngo 1.21\n");
    await writeFile(join(dir, "garage_test.go"), TESTIFY);
    await writeFile(join(dir, "plain_test.go"), "package cars\n\ntype Plain struct{}\n\nfunc (p *Plain) TestSomething() {}\n");
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  it("records the runner per file, and none for the decoy", () => {
    expect(summary.testSuites).toEqual({ "garage_test.go": { GarageSuite: "TestGarageSuite" } });
  });
});
