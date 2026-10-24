import { describe, it, expect } from "vitest";
import { blankRubyNonCode, rubyBlockEnds, rubyCodeLinesOf } from "./blocks.js";

/** 1-based start line → 1-based end line, for the blocks starting on the given lines. */
const endsOf = (src: string, ...starts: number[]): Record<number, number | undefined> => {
  const ends = rubyBlockEnds(src.replace(/^\n/, "").split("\n"));
  return Object.fromEntries(starts.map((s) => [s, ends.get(s - 1)]));
};

describe("ruby block ends", () => {
  it("ends a method at its `end`, past a method-level rescue and ensure", () => {
    const src = `
class Transfer
  def complete
    Ledger.post(fee)
  rescue LedgerError => e
    Tracker.capture(e)
  ensure
    release_lock
  end
end`;
    expect(endsOf(src, 1, 2)).toEqual({ 1: 9, 2: 8 });
  });

  it("is not ended by a heredoc body, an `=begin` block or code at column 0", () => {
    const src = `
class Squad
  def report
    sql = <<~SQL
SELECT * FROM players
end
SQL
    run(sql)
  end

=begin
def note
end
=end

  def size
players.count
  end
end`;
    expect(endsOf(src, 1, 2, 15)).toEqual({ 1: 18, 2: 8, 15: 17 });
  });

  it("tells a modifier from an expression opener", () => {
    const src = `
def pick
  return if bench.empty?
  keeper = if fit? then first else second end
  squad << if injured?
    substitute
  else
    starter
  end
  x = "a" if ready?
  count = 1 unless done?
end`;
    expect(endsOf(src, 1)).toEqual({ 1: 11 });
  });

  it("reads a statement continued with a backslash or an operator", () => {
    const src = `
def validate
  raise ArgumentError, 'bad' \\
    unless valid?
  total = first +
    if bonus? then 1 else 0 end
end`;
    expect(endsOf(src, 1)).toEqual({ 1: 6 });
  });

  it("takes method names and symbols that spell keywords or operators as names", () => {
    const src = `
class Range
  undef_method :==, :!=
  alias eql? ==
  alias_method :[]=, :store unless method_defined?(:[]=)
  def end
    @last
  end
  def %(other)
    calculate(:%, other)
  end
  def value=(v)
    @value = v
  end
end`;
    expect(endsOf(src, 1, 5, 8, 11)).toEqual({ 1: 14, 5: 7, 8: 10, 11: 13 });
  });

  it("ends an endless method on its own line and keeps a `private def` open", () => {
    const src = `
class Garage
  def size = cars.count
  def name(car) = car.name
  private def tune(car)
    car.tune!
  end
end`;
    expect(endsOf(src, 1, 2, 3, 4)).toEqual({ 1: 7, 2: 2, 3: 3, 4: 6 });
  });

  it("closes a literal that ends on its own line before the next statement", () => {
    const src = `
ALLOWED = %w[
  car
  van
]

module Fleet
  def self.size = 1
end`;
    expect(endsOf(src, 6)).toEqual({ 6: 8 });
  });

  it("reads `$?` in an interpolation, a multi-line `/x` regex and `class << x` as an expression", () => {
    const src = `
def run(cmd)
  puts "failed: #{$?}"
  pattern = /
    (?<club>\\w+)  # a club
  /x
  meta = class << cmd; self; end
end`;
    expect(endsOf(src, 1)).toEqual({ 1: 7 });
  });
});

describe("ruby non-code blanking", () => {
  it("keeps lines and columns", () => {
    const src = 'x = "a" # note\ny = %w[b c]';
    const out = blankRubyNonCode(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n")).toEqual(["x =           ", "y =        "]);
  });

  it("opens interpolation as code for the call scan and blanks heredoc text", () => {
    const lines = ['url = "#{base_uri}/clubs"', "sql = <<~SQL", "  SELECT name FROM clubs", "SQL", "load(sql)"];
    expect(rubyCodeLinesOf(lines)).toEqual(['url = "" base_uri"/clubs"', "sql =       ", " ".repeat(lines[2]!.length), "   ", "load(sql)"]);
  });
});
