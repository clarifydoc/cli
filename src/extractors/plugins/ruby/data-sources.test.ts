import { describe, it, expect } from "vitest";
import { rubySpec } from "./index.js";

/** Run the spec's ActiveRecord data-source extractor over a Ruby snippet. */
function dbSources(src: string) {
  const lines = src.split("\n");
  return (rubySpec.extractDataSources?.(lines, []) ?? []).filter((d) => d.kind === "database");
}

describe("rubySpec.extractDataSources — ActiveRecord", () => {
  it("captures finders/queries and resolves the entity from the model receiver", () => {
    const ds = dbSources(`
      class AbsencesController < ApplicationController
        def show
          @absence = Absence.find_authorized params[:id], current_institution_id
          @others  = Absence.where(employee_id: @absence.employee_id).order(:date)
          inst     = Institution.find(current_institution_id)
        end
      end
    `);
    const byName = Object.fromEntries(ds.map((d) => [d.name, d]));
    expect(byName["Absence.find_authorized"]).toMatchObject({ kind: "database", entity: "Absence" });
    expect(byName["Absence.where"]).toMatchObject({ entity: "Absence" });
    expect(byName["Institution.find"]).toMatchObject({ entity: "Institution" });
    // The chained `.order(:date)` shares the line but has a lowercase relation
    // receiver — it must NOT produce a second source.
    expect(ds.filter((d) => d.name.endsWith(".order"))).toHaveLength(0);
  });

  it("captures writes (create!/update/destroy) the same way", () => {
    const ds = dbSources(`
      Absence.create!(create_params)
      Duty.update_all(active: false)
      DepartmentEmployee.destroy_all
    `).map((d) => d.name);
    expect(ds).toEqual(
      expect.arrayContaining(["Absence.create!", "Duty.update_all", "DepartmentEmployee.destroy_all"]),
    );
  });

  it("resolves namespaced models to their bare entity name", () => {
    const ds = dbSources(`x = League::MatchReport.where(year: 2026).first`);
    expect(ds.find((d) => d.name === "League::MatchReport.where")).toMatchObject({
      entity: "MatchReport",
    });
  });

  it("ignores stdlib constants and non-query methods", () => {
    const ds = dbSources(`
      now   = Time.now
      blob  = File.delete(path)
      cfg   = JSON.parse(body)
      total = Reports.generate_pdf(data)   # capitalised, but not an AR method
      log   = Rails.logger.info("hi")
    `);
    expect(ds).toHaveLength(0);
  });

  it("does not treat a method on an instance/relation as model access", () => {
    // Lowercase / @ivar receivers carry no model name and must be skipped.
    const ds = dbSources(`
      @absence.update(params)
      absences.each { |a| a.save }
      self.scope.where(x: 1)
    `);
    expect(ds).toHaveLength(0);
  });

  it("does not match inside comments", () => {
    expect(dbSources(`# Absence.where(foo) is just documentation`)).toHaveLength(0);
  });
});
