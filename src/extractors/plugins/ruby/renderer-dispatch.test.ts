import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

describe("a markdown renderer's node methods", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-render-"));
    const files: Record<string, string> = {
      Gemfile: 'source "https://rubygems.org"\n',
      "lib/match_renderer.rb": "class MatchRenderer < CommonMarker::HtmlRenderer\n  def initialize(club)\n    super()\n  end\n\n  def link(node)\n    out(node.url)\n  end\n\n  def text(node)\n    out(node.string_content)\n  end\n\n  def helper\n    1\n  end\nend\n",
      // The decoy: a plain class with the same method names, never dispatched by a library.
      "lib/plain_view.rb": "class PlainView\n  def link(node)\n    node\n  end\n\n  def render(doc)\n    doc\n  end\nend\n",
      "lib/report.rb": "class Report\n  def html(doc)\n    MatchRenderer.new(1).render(doc)\n  end\n\n  def plain(doc)\n    PlainView.new.render(doc)\n  end\nend\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("are reached from the method that renders with the subclass", () => {
    const from = summary.symbolLinks.filter((l) => l.sourceSymbol === "Report.html" && l.relation === "dispatch").map((l) => l.targetSymbol).sort();
    expect(from).toEqual(["MatchRenderer.link", "MatchRenderer.text"]);
  });

  it("are not reached from a render on an unrelated class", () => {
    expect(summary.symbolLinks.filter((l) => l.sourceSymbol === "Report.plain" && l.relation === "dispatch")).toEqual([]);
    expect(summary.symbolLinks.some((l) => l.targetFile === "lib/plain_view.rb" && l.relation === "dispatch")).toBe(false);
  });
});
