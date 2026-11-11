import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const setupOf = (path: string) => extractWithRegex("Club.recalculate\nLeague.refresh!\n", path, "ruby").functions.some((f) => f.name === "<setup>");

describe("a class-less Ruby file's <setup>", () => {
  it("covers scripts, tasks and seeds", () => {
    for (const p of ["bin/club.rb", "lib/tasks/league.rake", "db/seeds.rb", "tools/refresh.rb"]) expect(setupOf(p), p).toBe(true);
  });

  it("leaves out specs, tests and framework configuration, but keeps config.ru", () => {
    for (const p of ["spec/club_spec.rb", "spec/support/helpers.rb", "test/club_test.rb", "lib/club_spec.rb", "config/initializers/league.rb", "config/environments/production.rb"]) {
      expect(setupOf(p), p).toBe(false);
    }
    expect(setupOf("config.ru")).toBe(true);
  });
});
