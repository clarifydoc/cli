import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A file that declares `Garage::Table` and `League::Table` holds two classes of one name: the symbol index keeps
 * the later one's members, so a constant path must pick the declaration at THAT path (real-repo FP).
 */
const FILES: Record<string, string> = {
  "table.rb": `class Table
  def initialize; end
end
`,
  "league_table.rb": `class League::Table
  def initialize; end
  def standings; end
end
`,
  "tables.rb": `module Garage
  class Table
    def initialize; end
    def self.build; end
  end
end

module League
  class Table
    def initialize; end
    def self.build; end
  end
end

class Runner
  def go
    League::Table.new
    Garage::Table.new
    Garage::Table.build
    League::Table.build
  end
end

module Garage
  class Shop
    def open
      Table.new
    end
  end
end
`,
  "twins.rb": `module Stadium
  class Seat
    def rank; end
  end
end

module Fans
  class Seat
    def rank; end
  end
end

class Dispatcher
  def go
    stadium_seat = Stadium::Seat.new
    stadium_seat.rank
    fans_seat = Fans::Seat.new
    fans_seat.rank
  end
end
`,
};

describe("a constant path in a file declaring two classes of one name", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-dup-"));
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

  const at = (callName: string, line: number) => {
    const link = summary.symbolLinks.find((l) => l.sourceFile === "tables.rb" && l.callName === callName && l.sourceLine === line);
    return link ? `${link.targetFile}:${link.targetLine}` : null;
  };

  it("builds a class's object from the declaration at the path written", () => {
    expect(at("Garage::Table.new", 18)).toBe("tables.rb:3");
  });

  it("calls a class method of the declaration at the path written", () => {
    expect(at("Garage::Table.build", 19)).toBe("tables.rb:4");
    // `League::Table` is also declared in another file: the reopened class decides nothing here, but never Garage's.
    expect(at("League::Table.build", 20)).not.toBe("tables.rb:4");
  });

  it("finds a bare name through the namespace the caller opens", () => {
    expect(at("Table.new", 27)).toBe("tables.rb:3");
  });

  it("lands a typed receiver's member on the twin the constructor names", () => {
    const rank = (line: number) => summary.symbolLinks.find((l) => l.sourceFile === "twins.rb" && l.sourceLine === line && l.callName.endsWith(".rank"));
    expect(rank(16)).toMatchObject({ targetFile: "twins.rb", targetSymbol: "Stadium.Seat.rank", targetLine: 3 });
    expect(rank(18)).toMatchObject({ targetFile: "twins.rb", targetSymbol: "Fans.Seat.rank", targetLine: 9 });
  });

  it("never lets a top-level or compact-path namesake stand for either", () => {
    for (const l of summary.symbolLinks.filter((x) => x.sourceFile === "tables.rb" && x.sourceSymbol.startsWith("Runner"))) {
      expect(l.targetFile === "table.rb").toBe(false);
    }
  });
});
