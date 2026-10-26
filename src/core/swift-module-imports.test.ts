import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A Swift module is a SwiftPM target: `Sources/League/` whatever the
 * subdirectories, and `import League` (`@testable` in its tests) names all of
 * it. A unique-name method in the caller's module or one it imports is
 * evidenced; one in a module it does not import stays unlinked (real-repo shape).
 */
const FILES: Record<string, string> = {
  "Package.swift": `// swift-tools-version:5.9
import PackageDescription
let package = Package(name: "League", targets: [.target(name: "League"), .target(name: "Scoring"), .testTarget(name: "LeagueTests", dependencies: ["League"])])
`,
  "Sources/League/Clubs/Club.swift": `public struct Club {
    public func promoteToTopFlight() {}
}
`,
  "Sources/League/Table/TableService.swift": `import Foundation

final class TableService {
    func promote(club: AnyObject) {
        current.promoteToTopFlight()
    }
}
`,
  "Sources/Scoring/Goals.swift": `public struct Goals {
    public func tallyGoalsScored() {}
}
`,
  "Tests/LeagueTests/ClubTests.swift": `@testable import League
import XCTest

final class ClubTests: XCTestCase {
    func testPromote() {
        fixture.promoteToTopFlight()
        record.tallyGoalsScored()
    }
}
`,
};

describe("Swift module imports", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-swift-modules-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linkOf = (symbol: string, callName: string) => {
    const link = summary.symbolLinks.find((l) => l.sourceSymbol === symbol && l.callName.endsWith(callName));
    return link ? `${link.targetFile} ${link.targetSymbol} ${link.strategy}` : null;
  };

  it("links a unique method in the caller's own module, across its directories", () => {
    expect(linkOf("TableService.promote", "current.promoteToTopFlight")).toBe("Sources/League/Clubs/Club.swift Club.promoteToTopFlight unique-global");
  });

  it("links a unique method of a module a test imports with @testable", () => {
    expect(linkOf("ClubTests.testPromote", "fixture.promoteToTopFlight")).toBe("Sources/League/Clubs/Club.swift Club.promoteToTopFlight unique-global");
  });

  it("leaves a method of a module the caller does not import unlinked", () => {
    expect(linkOf("ClubTests.testPromote", "record.tallyGoalsScored")).toBeNull();
  });
});
