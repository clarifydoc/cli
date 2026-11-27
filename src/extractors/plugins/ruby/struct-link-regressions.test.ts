import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

describe("links around Struct classes and constant-holding locals", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-struct-links-"));
    const files: Record<string, string> = {
      Gemfile: "source 'https://rubygems.org'\n",
      "app/services/score_store.rb": [
        "class League::ScoreStore",
        "  Snapshot = Struct.new(:status, :payload, keyword_init: true) do",
        "    def fresh? = status == :fresh",
        "    def stale? = status == :stale",
        "  end",
        "end",
        "",
      ].join("\n"),
      "app/services/resolver.rb": "class League::Resolver\n  def resolve(scope:, state:, lock_key:, &)\n    return 1 if state.fresh?\n    state.stale?\n  end\nend\n",
      "lib/tasks/export.rake": [
        "class Export",
        "  Account = Struct.new(:id, keyword_init: true) do",
        "    def conversations",
        "      Relation.new",
        "    end",
        "  end",
        "",
        "  Tally = Struct.new(:count, keyword_init: true) do",
        "    def size",
        "      count",
        "    end",
        "  end",
        "",
        "  class Relation",
        "    def find_by(*)",
        "      1",
        "    end",
        "  end",
        "end",
        "",
      ].join("\n"),
      "app/models/columns.rb": "module League::Stats::Resources::Columns\n  def self.names(model, types = KIT_TYPES)\n    model\n  end\nend\n",
      "app/services/builder.rb": "class League::Stats::Builder\n  def initialize(model)\n    columns = League::Stats::Resources::Columns\n    @names = columns.names(model)\n  end\nend\n",
      "spec/stats/table_spec.rb": [
        "RSpec.describe League::Stats::Table do",
        "  it 'reads the names' do",
        "    columns = League::Stats::Resources::Columns",
        "    expect(columns.names(1)).to include('name')",
        "  end",
        "",
        "  it 'reads the names again' do",
        "    columns = League::Stats::Resources::Columns",
        "    expect(columns.names(2)).to include('name')",
        "  end",
        "",
        "  it 'takes a block parameter of the same name' do",
        "    [1].each do |columns|",
        "      columns.names(3)",
        "    end",
        "  end",
        "end",
        "",
      ].join("\n"),
      // The namesake: a Struct field reader of the same name, which broke the unique-name guess.
      "app/services/roster.rb": "class League::Roster\n  Entry = Struct.new(:names, :size) do\n    def label = names\n  end\nend\n",
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

  const links = (file: string) => (summary.symbolLinks ?? []).filter((l) => l.sourceFile === file);

  it("links calls on an untyped parameter to the Struct class's endless methods", () => {
    const got = links("app/services/resolver.rb").map((l) => `${l.callName} -> ${l.targetSymbol}`).sort();
    expect(got).toEqual(["state.fresh? -> League.ScoreStore.Snapshot.fresh?", "state.stale? -> League.ScoreStore.Snapshot.stale?"]);
  });

  it("links a call inside a Struct block to the class that follows the block", () => {
    const got = links("lib/tasks/export.rake").filter((l) => l.callName === "Relation.new");
    expect(got.map((l) => l.targetSymbol)).toEqual(["Export.Relation"]);
  });

  it("resolves the same local inside an RSpec example, but not a block parameter", () => {
    const got = links("spec/stats/table_spec.rb").filter((l) => l.callName.endsWith(".names")).map((l) => `${l.sourceLine} ${l.targetSymbol}`).sort();
    expect(got).toEqual(["4 League.Stats.Resources.Columns.names", "9 League.Stats.Resources.Columns.names"]);
  });

  it("resolves a local holding a module constant to that module's singleton method, whatever shares the name", () => {
    const got = links("app/services/builder.rb").map((l) => l.targetSymbol);
    expect(got).toEqual(["League.Stats.Resources.Columns.names"]);
  });
});
