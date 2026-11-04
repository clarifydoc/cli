import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { fileTestVerdict } from "../../../core/test-functions.js";
import type { FileAnalysis, ProjectAnalysis } from "../../../types/analysis.js";

/** A spec reaches the class it describes through `described_class` and the `let`s built from it (real-repo FP). */
const FILES: Record<string, string> = {
  "Gemfile": `gem "rails"\ngem "rspec-rails"\n`,
  "app/services/league/transfer_service.rb": `class League::TransferService
  def initialize(club, fee)
    @club = club
    @fee = fee
  end

  def perform
    settle
  end

  private

  def settle
    @club
  end
end
`,
  "app/services/league/fixture_builder.rb": `class League::FixtureBuilder
  def generate_rounds
    []
  end
end
`,
  "app/services/league/ledger_service.rb": `class League::LedgerService
  def perform
    true
  end
end
`,
  "app/services/league/untouched_service.rb": `class League::UntouchedService
  def perform
    true
  end
end
`,
  "app/jobs/league/close_window_job.rb": `class League::CloseWindowJob < ApplicationJob
  def perform(league)
    league
  end
end
`,
  "spec/services/league/transfer_service_spec.rb": `require 'rails_helper'

RSpec.describe League::TransferService do
  let(:club) { create(:club) }
  let(:service) { described_class.new(club, 3) }

  describe '#perform' do
    it 'settles' do
      expect(service.perform).to eq(club)
    end

    it 'posts the ledger too' do
      described_class.new(club, 1).perform
      League::LedgerService.new.perform
    end
  end
end
`,
  "spec/services/league/fixture_builder_spec.rb": `require 'rails_helper'

describe League::FixtureBuilder do
  subject(:builder) do
    described_class.new
  end

  it 'builds rounds' do
    rounds = builder.generate_rounds
    expect(rounds).to eq([])
  end

  context 'with a record built in a block' do
    let(:builder) do
      Struct.new(:id) do
        def generate_rounds = [1]
      end.new(1)
    end

    it 'reaches no class it names' do
      expect(builder.generate_rounds).to eq([1])
    end
  end

  context 'with a stand-in' do
    let(:builder) { instance_double(League::FixtureBuilder) }

    it 'never reaches the class' do
      expect(builder.generate_rounds).to be_nil
    end
  end
end
`,
  "spec/jobs/league/close_window_job_spec.rb": `require 'rails_helper'

RSpec.describe League::CloseWindowJob, type: :job do
  subject(:job) { described_class.perform_later(league) }

  let(:league) { create(:league) }

  it 'runs' do
    perform_enqueued_jobs { job }
  end
end
`,
};

describe("RSpec: the described class is the spec's subject", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rspec-subject-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linksFrom = (file: string) =>
    (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === file && !l.navigational)
      .map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}`)
      .sort();

  it("links described_class.new to the constructor and a let built from it to the class's methods", () => {
    expect(linksFrom("spec/services/league/transfer_service_spec.rb")).toEqual([
      "League:TransferService -> League::TransferService.initialize",
      "League:TransferService › #perform › posts the ledger too -> League::LedgerService",
      "League:TransferService › #perform › posts the ledger too -> League::LedgerService.perform",
      "League:TransferService › #perform › posts the ledger too -> League::TransferService.initialize",
      "League:TransferService › #perform › posts the ledger too -> League::TransferService.perform",
      "League:TransferService › #perform › settles -> League::TransferService.perform",
    ]);
  });

  it("types a named subject, and a nested group's stand-in rebinding it links nothing", () => {
    // A class declaring no constructor is itself what `described_class.new` constructs.
    expect(linksFrom("spec/services/league/fixture_builder_spec.rb")).toEqual([
      "League:FixtureBuilder -> League::FixtureBuilder",
      "League:FixtureBuilder › builds rounds -> League::FixtureBuilder.generate_rounds",
    ]);
  });

  it("runs the described job's perform when the spec enqueues it", () => {
    expect(linksFrom("spec/jobs/league/close_window_job_spec.rb")).toContain("League:CloseWindowJob -> League::CloseWindowJob.perform");
  });

  it("calls the described classes tested and leaves the others untested", async () => {
    const file = async (path: string) => JSON.parse(await readFile(join(dir, "out", `${path}.json`), "utf-8")) as FileAnalysis;
    const state = async (path: string) => fileTestVerdict(summary, path, await file(path)).state;
    expect(await state("app/services/league/transfer_service.rb")).toBe("tested");
    expect(await state("app/services/league/fixture_builder.rb")).toBe("tested");
    expect(await state("app/jobs/league/close_window_job.rb")).toBe("tested");
    expect(await state("app/services/league/untouched_service.rb")).toBe("untested");
  });
});
