import { describe, it, expect, beforeAll } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis, SymbolLink } from "../../../types/analysis.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["ruby"]);
});

const read = (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "ruby"), projectId: "root" });

const targetsOf = (links: SymbolLink[], file: string, callName: string) =>
  [...new Set(links.filter((l) => l.sourceFile === file && l.callName === callName).map((l) => `${l.targetFile}::${l.targetSymbol}`))];

describe("Ruby: a call on a constant", () => {
  it("never lands on a project method of the name when the project declares no class or module of the constant (real-repo FP)", () => {
    const links = buildSymbolLinks([
      read(`class Club < ApplicationRecord\n  def default_locale\n    'en'\n  end\nend\n`, "app/models/club.rb"),
      read(
        `module SwitchLocale\n  def locale_for(code)\n    return Translations.default_locale.to_s if code.blank?\n\n    code\n  end\n\n  def club_locale(domain)\n    @club = Club.find_by(domain: domain)\n    @club.default_locale\n  end\nend\n`,
        "app/controllers/concerns/switch_locale.rb",
      ),
    ]);
    expect(targetsOf(links, "app/controllers/concerns/switch_locale.rb", "Translations.default_locale")).toEqual([]);
    expect(targetsOf(links, "app/controllers/concerns/switch_locale.rb", "club.default_locale")).toEqual(["app/models/club.rb::Club.default_locale"]);
  });

  it("still reaches a class the project declares under a namespace, and a method a class gets from a module it includes", () => {
    const files = [
      read(`module Transfers::ImportJob\n  def perform(id)\n    id\n  end\nend\n`, "app/jobs/transfers/import_job.rb"),
      read(`class Transfers::BaseJob < ApplicationJob\nend\n`, "app/jobs/transfers/base_job.rb"),
      read(`class Transfers::Scout::BaseJob < Transfers::BaseJob\nend\n`, "app/jobs/transfers/scout/base_job.rb"),
      read(`class Transfers::Scout::ImportJob < Transfers::Scout::BaseJob\n  include Transfers::ImportJob\nend\n`, "app/jobs/transfers/scout/import_job.rb"),
      read(`class Transfers::Scout::RenewalJob < Transfers::Scout::BaseJob\nend\n`, "app/jobs/transfers/scout/renewal_job.rb"),
      read(`module Scouting\n  class Report\n    def self.tally\n      1\n    end\n  end\nend\n`, "app/services/scouting/report.rb"),
      read(
        `class ClubsController\n  def create\n    Transfers::Scout::ImportJob.perform_later(1)\n    Transfers::Scout::RenewalJob.perform_later(1)\n    Scouting::Report.tally\n  end\nend\n`,
        "app/controllers/clubs_controller.rb",
      ),
    ];
    const links = buildSymbolLinks(files);
    const from = "app/controllers/clubs_controller.rb";
    expect(targetsOf(links, from, "Transfers::Scout::ImportJob.perform")).toEqual(["app/jobs/transfers/import_job.rb::Transfers::ImportJob.perform"]);
    // No class of its chain declares or includes `perform` (the framework's): the namesake module is not it.
    expect(targetsOf(links, from, "Transfers::Scout::RenewalJob.perform")).toEqual([]);
    expect(targetsOf(links, from, "Scouting::Report.tally")).toEqual(["app/services/scouting/report.rb::Report.tally"]);
  });
});
