import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const analyze = (src: string, filePath = "app/services/club_service.rb") => extractWithRegex(src.replace(/^\n/, ""), filePath, "ruby");
const methodsOf = (src: string) => analyze(src).classes.flatMap((c) => c.methods);
const callsOf = (src: string, method: string) => (methodsOf(src).find((m) => m.name === method)?.calls ?? []).map((c) => c.name);

describe("ruby method and class structure", () => {
  it("keeps a method's rescue clause and its calls inside the method", () => {
    const src = `
class Transfer
  def complete
    Ledger.post(fee)
  rescue LedgerError => e
    Tracker.capture(e)
  end

  def fee
    1
  end
end`;
    const complete = methodsOf(src).find((m) => m.name === "complete")!;
    expect(complete.endLine).toBe(6);
    expect(complete.calls.map((c) => c.name)).toContain("Tracker.capture");
  });

  it("keeps every method in its class past a heredoc body at column 0", () => {
    const src = `
class Squad
  def report
    sql = <<~SQL
SELECT * FROM players
SQL
    run(sql)
  end

  def size
    1
  end
end`;
    const [squad] = analyze(src).classes;
    expect(squad!.endLine).toBe(12);
    expect(squad!.methods.map((m) => m.name)).toEqual(["report", "size"]);
  });

  it("reads a top-level `::` in a class name and in its superclass", () => {
    const [cls] = analyze(`
class ::League::Report < ::Base
  def run; end
end`).classes;
    expect(cls!.name).toBe("League::Report");
    expect(cls!.extends).toBe("Base");
  });

  it("names setters, operator methods, keyword-named and `private def` methods as written", () => {
    const names = methodsOf(`
class Score
  def value=(v)
    @value = v
  end
  def <=>(other)
    value <=> other.value
  end
  def self.for(match)
    new
  end
  private def settle(points)
    points
  end
end`).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["value=", "<=>", "for", "settle"]));
    expect(names).not.toContain("value");
  });

  it("gives an endless method no parameters from the call in its body", () => {
    const apple = methodsOf(`
class Garage
  def apple = push_tokens(apple_subscriptions)
  def push_tokens(x) = x
  def apple_subscriptions = []
end`).find((m) => m.name === "apple")!;
    expect(apple.params).toEqual([]);
    expect(apple.calls.map((c) => c.name)).toEqual(expect.arrayContaining(["push_tokens", "apple_subscriptions"]));
  });
});

describe("ruby calls", () => {
  const club = (body: string) => `
class ClubService
${body}

  def eligible?(player)
    true
  end

  def base_uri
    "x"
  end

  def coach
    nil
  end

  def window
    nil
  end
end`;

  it("records a predicate or bang call written with parens and no receiver, negated too", () => {
    const calls = callsOf(club(`
  def sign(player)
    return unless eligible?(player)
    return if !eligible?(player.backup)
    update!(signed: true)
  end`), "sign");
    expect(calls).toEqual(expect.arrayContaining(["eligible?", "update!"]));
    expect(calls).not.toContain("defined?");
  });

  it("reads calls inside string interpolation", () => {
    expect(callsOf(club(`
  def url(id)
    "#{base_uri}/clubs/#{id}"
  end`), "url")).toContain("base_uri");
  });

  it("reads the one-line body of an endless method", () => {
    expect(callsOf(club(`
  def range = window.current`), "range")).toContain("window");
  });

  it("takes names bound by multiple assignment as locals, not calls", () => {
    expect(callsOf(club(`
  def hire
    coach, assistant = load_staff
    coach.pending?
  end`), "hire")).not.toContain("coach");
  });

  it("reads no calls from word arrays or heredoc text", () => {
    const calls = callsOf(club(`
  def events
    skip = %w[coach window]
    note = <<~TEXT
      Ask the coach about the window.
    TEXT
    [skip, note]
  end`), "events");
    expect(calls).not.toContain("coach");
    expect(calls).not.toContain("window");
  });
});
