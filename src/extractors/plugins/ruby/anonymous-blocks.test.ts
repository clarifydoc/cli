import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function analyzeRuby(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-ruby-anon-"));
  for (const [rel, text] of Object.entries({ Gemfile: 'source "https://rubygems.org"\n', ...files })) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), dir };
}

const targetsOf = (summary: ProjectAnalysis, symbol: string, line: number) =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.sourceLine === line && l.relation === "calls").map((l) => `${l.targetFile}::${l.targetSymbol}`);

describe("Class.new blocks and let-built classes", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    ({ summary, dir } = await analyzeRuby({
      "lib/club.rb": "class Club\n  def close\n    1\n  end\nend\n\nStriker = Class.new(Club) do\n  def kick\n    close\n  end\nend\n",
      "lib/garage.rb": "class Garage\n  def close\n    2\n  end\nend\n",
      "spec/club_spec.rb": `RSpec.describe Club do
  let(:klass) { Class.new(Club) }
  let(:other) { Class.new(Garage) }

  it "closes" do
    klass.new.close
  end

  context "nested" do
    let(:klass) { Class.new(Garage) }

    it "closes the garage" do
      klass.new.close
    end
  end

  it "closes the other" do
    other.new.close
  end
end

RSpec.describe Garage do
  it "has no klass" do
    klass.new.close
  end
end
`,
    }));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("makes a constant's Class.new block a class extending its base", () => {
    const club = summary.classGraph?.nodes?.find((n) => n.name === "Striker");
    expect(club).toBeDefined();
    expect(targetsOf(summary, "Striker.kick", 9)).toEqual(["lib/club.rb::Club.close"]);
  });

  it("types a group's let-built class in its examples, the nearest let winning", () => {
    expect(targetsOf(summary, "Club › closes", 6).filter((t) => t.endsWith("close"))).toEqual(["lib/club.rb::Club.close"]);
    expect(targetsOf(summary, "Club › nested › closes the garage", 13).filter((t) => t.endsWith("close"))).toEqual(["lib/garage.rb::Garage.close"]);
    expect(targetsOf(summary, "Club › closes the other", 18).filter((t) => t.endsWith("close"))).toEqual(["lib/garage.rb::Garage.close"]);
  });

  it("does not leak a let into another group", () => {
    expect(targetsOf(summary, "Garage › has no klass", 24)).toEqual([]);
  });
});
