/**
 * A spec that describes a type the file declares (`RSpec.describe Club`, with cases) is a test of that file even
 * where no call is written: a mixin a spec prepends onto an anonymous class, a class a base class's callbacks run.
 * A spec describing another type, or one without cases, does not count, and a namesake in another namespace is no match.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { fileTestVerdict, testVerdictContext } from "./test-functions.js";
import type { FileAnalysis, ProjectAnalysis } from "../types/analysis.js";

let dir = "";
const files: Record<string, string> = {
  "Gemfile": "source 'https://rubygems.org'\ngem 'rails'\ngem 'rspec-rails'\n",
  "app/services/onboarding/club_creation_service.rb": [
    "class Onboarding::ClubCreationService",
    "  def perform",
    "    tagline",
    "  end",
    "",
    "  private",
    "",
    "  def tagline",
    "    'plain'",
    "  end",
    "end",
    "",
  ].join("\n"),
  "enterprise/app/services/enterprise/onboarding/club_creation_service.rb": [
    "module Enterprise::Onboarding::ClubCreationService",
    "  private",
    "",
    "  def tagline",
    "    super + ' premium'",
    "  end",
    "end",
    "",
  ].join("\n"),
  "spec/enterprise/services/enterprise/onboarding/club_creation_service_spec.rb": [
    "require 'rails_helper'",
    "",
    "host = Class.new(Onboarding::ClubCreationService) do",
    "  prepend Enterprise::Onboarding::ClubCreationService",
    "end",
    "",
    "RSpec.describe Enterprise::Onboarding::ClubCreationService do",
    "  it 'adds the suffix' do",
    "    expect(host.new.perform).to include('premium')",
    "  end",
    "end",
    "",
  ].join("\n"),
  // The decoy: a module nothing describes, beside a namesake of a described one in another namespace.
  "enterprise/app/services/enterprise/onboarding/player_service.rb": [
    "module Enterprise::Onboarding::PlayerService",
    "  def sign",
    "    1",
    "  end",
    "end",
    "",
  ].join("\n"),
  "app/services/onboarding/player_service.rb": [
    "class Onboarding::PlayerService",
    "  def sign",
    "    2",
    "  end",
    "end",
    "",
  ].join("\n"),
  "spec/services/onboarding/player_service_spec.rb": [
    "require 'rails_helper'",
    "",
    "RSpec.describe Onboarding::PlayerService do",
    "  it 'signs' do",
    "    expect(described_class.new.sign).to eq(2)",
    "  end",
    "end",
    "",
  ].join("\n"),
  // A described type whose spec holds no case: a placeholder runs nothing.
  "app/services/onboarding/staff_service.rb": [
    "class Onboarding::StaffService",
    "  def hire",
    "    1",
    "  end",
    "end",
    "",
  ].join("\n"),
  "spec/services/onboarding/staff_service_spec.rb": [
    "require 'rails_helper'",
    "",
    "RSpec.describe Onboarding::StaffService do",
    "end",
    "",
  ].join("\n"),
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clarifydoc-verdict-described-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
    await writeFile(join(dir, "app", rel), text);
  }
  await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
}, 180_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function verdictOf(path: string): Promise<{ state: string; basis: string[]; subject?: string }> {
  const summary: ProjectAnalysis = await loadReportSummary(join(dir, "out"));
  const file = JSON.parse(await readFile(join(dir, "out", `${path}.json`), "utf-8")) as FileAnalysis;
  const v = fileTestVerdict(summary, path, file, testVerdictContext(summary));
  return { state: v.state, basis: v.basis, ...(v.described ? { subject: v.described.subject } : {}) };
}

describe("test verdict: a spec describing the type", () => {
  it("counts the mixin the spec describes although it is prepended onto an anonymous class", async () => {
    expect(await verdictOf("enterprise/app/services/enterprise/onboarding/club_creation_service.rb")).toEqual({
      state: "tested",
      basis: ["described"],
      subject: "Enterprise::Onboarding::ClubCreationService",
    });
  });

  it("does not count a namesake in another namespace, nor a spec without cases", async () => {
    expect((await verdictOf("enterprise/app/services/enterprise/onboarding/player_service.rb")).state).toBe("untested");
    expect((await verdictOf("app/services/onboarding/staff_service.rb")).state).toBe("untested");
    // The class its spec describes and calls rests on the call as well.
    expect((await verdictOf("app/services/onboarding/player_service.rb")).basis).toEqual(["importer", "reached-function", "described"]);
  });
});
