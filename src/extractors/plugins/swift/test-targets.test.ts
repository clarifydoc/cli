import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { swiftTestTargets } from "./test-targets.js";
import { swiftTestCommand } from "./test-command.js";

const MANIFEST = `// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "League",
    targets: [
        .target(name: "League"),
        .testTarget(name: "LeagueTests", dependencies: ["League"], path: "Tests/Custom"),
        .testTarget(name: "GarageTests", dependencies: ["League"], resources: [.process("Fixtures")]),
    ]
)
`;

describe("swiftTestTargets", () => {
  it("reads the directory a test target declares, and leaves a default one out", () => {
    expect(swiftTestTargets(MANIFEST.split("\n"), "Package.swift")).toEqual([{ name: "LeagueTests", dir: "Tests/Custom" }]);
    expect(swiftTestTargets(MANIFEST.split("\n"), "packages/league/Package.swift")).toEqual([{ name: "LeagueTests", dir: "packages/league/Tests/Custom" }]);
  });
  it("ignores a regular target's path and any other file", () => {
    expect(swiftTestTargets(['.target(name: "Club", path: "Sources/Custom"),'], "Package.swift")).toEqual([]);
    expect(swiftTestTargets(MANIFEST.split("\n"), "Sources/League/Garage.swift")).toEqual([]);
  });
});

describe("swiftTestCommand with a declared target directory", () => {
  const ctx = { packages: new Set<string>(), manifests: new Set<string>(), testTargets: [{ name: "LeagueTests", dir: "Tests/Custom" }] };
  it("filters by the target that owns the file's path", () => {
    expect(swiftTestCommand([{ file: "Tests/Custom/ClubTests.swift", names: ["ClubTests.testBuilds"] }], ctx)).toBe("swift test --filter '^LeagueTests\\.ClubTests/testBuilds$'");
    expect(swiftTestCommand([{ file: "Tests/Custom/Sub/ClubTests.swift", names: [] }], ctx)).toBe("swift test --filter '^LeagueTests\\.'");
  });
  it("keeps the folder-name target outside it (decoy: a sibling folder, a namesake prefix)", () => {
    expect(swiftTestCommand([{ file: "Tests/GarageTests/CarTests.swift", names: ["CarTests.testStarts"] }], ctx)).toBe("swift test --filter '^GarageTests\\.CarTests/testStarts$'");
    expect(swiftTestCommand([{ file: "Tests/CustomLegacy/CarTests.swift", names: [] }], ctx)).toBe("swift test --filter '^CustomLegacy\\.'");
  });
});

describe("test targets in an analysis", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "swift-targets-"));
    await mkdir(join(dir, "Tests/Custom"), { recursive: true });
    await writeFile(join(dir, "Package.swift"), MANIFEST);
    await writeFile(join(dir, "Tests/Custom/ClubTests.swift"), "import XCTest\n\nfinal class ClubTests: XCTestCase {\n  func testBuilds() {}\n}\n");
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  it("records the declared directory on the summary", () => {
    expect(summary.testTargets).toEqual([{ name: "LeagueTests", dir: "Tests/Custom" }]);
  });
});
