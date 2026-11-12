import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Two shapes whose chain stopped at an unstated step (real-repo FP): `self.class.x` where the class method is
 * declared by a base class or an extended module, and `@x = bare_method` where the method's last statement is a
 * model call (an implicit return). Each has a same-named decoy on an unrelated class or model.
 */
const FILES: Record<string, string> = {
  "app/models/application_record.rb": `class ApplicationRecord < ActiveRecord::Base
  primary_abstract_class
end
`,
  "app/models/standings.rb": `module Standings
  def table_size
    count
  end
end
`,
  "app/models/base_club.rb": `class BaseClub < ApplicationRecord
  def self.empty_table
    where(id: nil)
  end
end
`,
  "app/models/club.rb": `class Club < BaseClub
  extend Standings

  def reset_table
    self.class.empty_table
  end

  def size
    self.class.table_size
  end

  def wipe
    self.class.empty_table.destroy_all
  end

  def library
    self.class.fetch_remote
  end

  # An instance method only: self.class.fetch_local is the class's, not this one (a library's class method).
  def fetch_local
    self.class.fetch_local
  end

  # An instance reader: a self.class.name is the class's own (Module#name), never this method.
  def name
    "club"
  end

  def label
    self.class.name
  end
end
`,
  "app/models/match.rb": `class Match < ApplicationRecord
  # Decoys: the same class methods on an unrelated class.
  def self.empty_table
    where(id: -1)
  end

  def self.table_size
    count
  end

  def self.fetch_remote
    nil
  end
end
`,
  "app/models/car.rb": `class Car < ApplicationRecord
  def rename(name)
    update!(name: name)
  end
end
`,
  "app/models/garage.rb": `class Garage < ApplicationRecord
  def rename(name)
    update!(name: name)
  end
end
`,
  "app/controllers/application_controller.rb": `class ApplicationController < ActionController::Base
end
`,
  "app/controllers/cars_controller.rb": `class CarsController < ApplicationController
  before_action :set_car, only: [:update]

  def update
    @car.rename(params[:name])
  end

  def create
    # set_car does not run for create.
    @car.rename(params[:name])
  end

  private

  def set_car
    @car = build_car
  end

  def build_car
    Car.find_by(name: params[:name])
  end
end
`,
  "app/controllers/garages_controller.rb": `class GaragesController < ApplicationController
  before_action :set_garage

  def update
    @garage.rename(params[:name])
  end

  private

  def set_garage
    @garage = build_garage
  end

  # The last statement is no model call: nothing is typed.
  def build_garage
    log_lookup
    params[:garage]
  end
end
`,
  "app/controllers/trucks_controller.rb": `class TrucksController < ApplicationController
  before_action :set_truck

  def update
    @truck.rename(params[:name])
  end

  private

  def set_truck
    @truck = build_truck
  end

  # The last line is the rescue outcome, not the return value.
  def build_truck
    Car.find_by(name: params[:name])
  rescue ActiveRecord::RecordNotFound
    Garage.find_by(name: params[:name])
  end
end
`,
};

describe("Ruby self.class and implicit-return typing", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-class-calls-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await writeFile(join(dir, "app", "Gemfile"), 'source "https://rubygems.org"\ngem "rails"\n');
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linksOf = (symbol: string, callName: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.callName === callName).map((l) => l.targetSymbol);

  it("self.class.x reaches the class method of a base class, never the namesake of another class", () => {
    expect(linksOf("Club.reset_table", "Club.empty_table")).toEqual(["BaseClub.empty_table"]);
    expect(linksOf("Club.wipe", "Club.empty_table")).toEqual(["BaseClub.empty_table"]);
  });

  it("self.class.x reaches the method of an extended module", () => {
    expect(linksOf("Club.size", "Club.table_size")).toEqual(["Standings.table_size"]);
  });

  it("self.class.x of a method nothing in the class's ancestry declares stays unlinked", () => {
    expect(linksOf("Club.library", "Club.fetch_remote")).toEqual([]);
  });

  it("self.class.name (a library method) never reaches an instance method of the name", () => {
    expect(linksOf("Club.label", "Club.name")).toEqual([]);
  });

  it("self.class.x where the class declares only an instance method x is no call of it", () => {
    expect(linksOf("Club.fetch_local", "Club.fetch_local")).toEqual([]);
  });

  it("types `@car = build_car` through the last statement of build_car", () => {
    expect(linksOf("CarsController.update", "car.rename")).toEqual(["Car.rename"]);
    // The filter does not run before `create`.
    expect(linksOf("CarsController.create", "car.rename")).toEqual([]);
  });

  it("types nothing when the method's last statement is no model call", () => {
    expect(linksOf("GaragesController.update", "garage.rename")).toEqual([]);
  });

  it("types nothing when the last line sits in a rescue clause", () => {
    expect(linksOf("TrucksController.update", "truck.rename")).toEqual([]);
  });
});
