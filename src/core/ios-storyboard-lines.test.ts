import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A storyboard segue and the code that performs it name one class twice: the scene's row stands at its class, the
 * code's at the call. The link to that class carries the line of the call, not the line of the class declaration; a
 * segue no code performs keeps the class line.
 */
const FILES: Record<string, string> = {
  "Club.storyboard": `<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0" initialViewController="vc-list">
    <scenes>
        <scene sceneID="s-list">
            <objects>
                <viewController id="vc-list" customClass="SquadListViewController" sceneMemberID="viewController">
                    <connections>
                        <segue destination="vc-player" kind="show" identifier="showPlayer" id="seg-player"/>
                        <segue destination="vc-coach" kind="show" id="seg-coach"/>
                    </connections>
                </viewController>
            </objects>
        </scene>
        <scene sceneID="s-player">
            <objects>
                <viewController id="vc-player" customClass="PlayerViewController" sceneMemberID="viewController"/>
            </objects>
        </scene>
        <scene sceneID="s-coach">
            <objects>
                <viewController id="vc-coach" customClass="CoachViewController" sceneMemberID="viewController"/>
            </objects>
        </scene>
    </scenes>
</document>
`,
  "Squad.swift": `import UIKit

final class SquadListViewController: UIViewController {
    func open() {
        performSegue(withIdentifier: "showPlayer", sender: nil)
    }
}

final class PlayerViewController: UIViewController {}

final class CoachViewController: UIViewController {}
`,
};

describe("iOS storyboard segues and the code that performs them", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ios-storyboard-"));
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

  const lineOf = (target: string) => summary.symbolLinks.filter((l) => l.sourceSymbol === `route:USE ${target}` && l.callName === target).map((l) => l.sourceLine);

  it("points a performed segue at the call, not at the scene's class", () => {
    expect(lineOf("PlayerViewController")).toEqual([5]);
  });

  it("keeps the class line for a segue no code performs", () => {
    expect(lineOf("CoachViewController")).toEqual([3]);
  });
});
