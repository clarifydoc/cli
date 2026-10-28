import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { rubyInlineBodyColumn } from "./index.js";
import { resolveRubyRequire } from "./require-paths.js";
import type { ImportResolveContext } from "../../../types/language-plugin.js";

const methods = (src: string) =>
  extractWithRegex(src, "app/models/coach.rb", "ruby").classes.flatMap((c) =>
    c.methods.map((m) => `${m.name}(${m.params.map((p) => p.name).join(",")}): ${m.calls.map((k) => k.name).join(" ")}`),
  );

describe("ruby one-line methods", () => {
  it("reads the calls of a body on the def line, after `;`, after the parameter list or after `=`", () => {
    const src = `class Coach
  def train(player) drill(player); stretch(1); end
  def warm_up; jog(1); sprint(2); end
  def cool_down(x); jog(x) end
  def rest(a, b = 2) = recover(a)
  def drill(p); end
end`;
    expect(methods(src)).toEqual([
      "train(player): drill stretch",
      "warm_up(): jog sprint",
      "cool_down(x): jog",
      "rest(a,b): recover",
      "drill(p): ",
    ]);
  });

  it("finds no inline body on a def whose body starts on the next line", () => {
    expect(rubyInlineBodyColumn("  def train(player)", 11)).toBe(-1);
    expect(rubyInlineBodyColumn("  def train(player) # warm up first", 11)).toBe(-1);
    expect(rubyInlineBodyColumn("  def train", 11)).toBe(-1);
    expect(rubyInlineBodyColumn("  def look a, b", 10)).toBe(-1);
  });
});

describe("ruby requires and autoloads", () => {
  it("records `autoload :Club, \"league/club\"` as an import of that file naming the constant", () => {
    const a = extractWithRegex(`module League\n  autoload :Club, "league/club"\n  autoload(:Fixture, 'league/fixture')\nend`, "lib/league.rb", "ruby");
    expect(a.imports.map((i) => `${i.source} ${i.specifiers.join(",")}`)).toEqual(["league/club Club", "league/fixture Fixture"]);
  });

  const ctx = (files: string[]): ImportResolveContext => ({ files: new Set(files), declares: () => false, globImportsOf: () => [] });

  it("loads `league.rb` for `require \"league\"`, never a file of the `league/` directory", () => {
    const files = ["lib/league.rb", "lib/league/club.rb", "lib/runner.rb"];
    expect(resolveRubyRequire("lib/runner.rb", "league", "league", ctx(files))).toBe("lib/league.rb");
    expect(resolveRubyRequire("bin/run.rb", "league/club", "club", ctx([...files, "bin/run.rb"]))).toBe("lib/league/club.rb");
  });

  it("finds the file on the nearest load path, and nothing for a gem", () => {
    const files = ["engines/garage/lib/garage/car.rb", "lib/garage/car.rb", "engines/garage/app/models/bay.rb"];
    expect(resolveRubyRequire("engines/garage/app/models/bay.rb", "garage/car", undefined, ctx(files))).toBe("engines/garage/lib/garage/car.rb");
    expect(resolveRubyRequire("lib/runner.rb", "json", undefined, ctx(files))).toBeNull();
    expect(resolveRubyRequire("lib/runner.rb", "../league", undefined, ctx(files))).toBeNull();
  });
});
