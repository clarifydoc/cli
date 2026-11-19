import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { analyzeFiles } from "./conditional-arms-fixture.js";

/** A Ruby local initialised by `c ? A.new : B.new` or an `if … else … end` expression links each arm (AMBIGUOUS). */
describe("Ruby conditional initializer arms", () => {
  let fx: Awaited<ReturnType<typeof analyzeFiles>>;
  beforeAll(async () => {
    fx = await analyzeFiles({
      "app/club_api.rb": ["class ClubApi", "  def load; 'c'; end", "  def reset; 'r'; end", "end", ""].join("\n"),
      "app/player_api.rb": ["class PlayerApi", "  def load; 'p'; end", "end", ""].join("\n"),
      "app/player.rb": ["class Player", "  def load; 'decoy'; end", "  def reset; 'decoy'; end", "end", ""].join("\n"),
      "app/apis.rb": ["module Apis", "  def self.clubs; ClubApi.new; end", "  def self.players; PlayerApi.new; end", "end", ""].join("\n"),
      "app/svc.rb": [
        "class Svc",
        "  def single",
        "    api = ClubApi.new",
        "    api.load",
        "  end",
        "  def ternary(admin)",
        "    api = admin ? ClubApi.new : PlayerApi.new",
        "    api.load",
        "  end",
        "  def nested(k)",
        "    api = k > 1 ? ClubApi.new : (k > 0 ? PlayerApi.new : ClubApi.new)",
        "    api.load",
        "  end",
        "  def predicate(user)",
        "    api = user.admin? ? ClubApi.new(user) : PlayerApi.new",
        "    api.load",
        "  end",
        "  def one_line(admin)",
        "    api = if admin then ClubApi.new else PlayerApi.new end",
        "    api.load",
        "  end",
        "  def multi_line(k)",
        "    api = if k > 1",
        "      ClubApi.new",
        "    elsif k > 0",
        "      PlayerApi.new",
        "    else",
        "      ClubApi.new",
        "    end",
        "    api.load",
        "  end",
        "  def factories(admin)",
        "    api = admin ? Apis.clubs : Apis.players",
        "    api.load",
        "  end",
        "  def factory_single",
        "    api = Apis.clubs",
        "    api.load",
        "  end",
        "  def one_declares(admin)",
        "    api = admin ? ClubApi.new : PlayerApi.new",
        "    api.reset",
        "  end",
        "  def not_a_call(admin)",
        "    api = admin ? ClubApi.new : nil",
        "    api.load",
        "  end",
        "  def no_else(admin)",
        "    api = if admin",
        "      ClubApi.new",
        "    end",
        "    api.load",
        "  end",
        "  def block_arm(admin)",
        "    api = if admin",
        "      log",
        "      ClubApi.new",
        "    else",
        "      PlayerApi.new",
        "    end",
        "    api.load",
        "  end",
        "  def reassigned(admin)",
        "    api = admin ? ClubApi.new : PlayerApi.new",
        "    api = Player.new",
        "    api.load",
        "  end",
        "  def separate(admin)",
        "    if admin",
        "      w = ClubApi.new",
        "      w.load",
        "    else",
        "      w = PlayerApi.new",
        "      w.load",
        "    end",
        "  end",
        "  def twice(admin)",
        "    w = admin ? ClubApi.new : PlayerApi.new",
        "    w.load",
        "    w = admin ? PlayerApi.new : ClubApi.new",
        "    w.load",
        "  end",
        "end",
        "",
      ].join("\n"),
    });
  }, 60_000);
  afterAll(() => fx.cleanup());

  const links = (fn: string, call: string) => fx.linksOf("app/svc.rb", fn, call);
  const both = ["ClubApi.load:AMBIGUOUS", "PlayerApi.load:AMBIGUOUS"];

  it("links the lone construction (control)", async () => {
    expect(await links("Svc.single", "api.load")).toEqual(["ClubApi.load:INFERRED"]);
  });
  it("types a factory's result only where Ruby states it (control)", async () => {
    expect(await links("Svc.factory_single", "api.load")).toEqual([]);
  });
  it("links each arm of a ternary, nested ternary and predicate condition", async () => {
    expect(await links("Svc.ternary", "api.load")).toEqual(both);
    expect(await links("Svc.nested", "api.load")).toEqual(both);
    expect(await links("Svc.predicate", "api.load")).toEqual(both);
  });
  it("links each arm of an if expression, one line or several; arms that are unresolved factories stay untyped", async () => {
    expect(await links("Svc.one_line", "api.load")).toEqual(both);
    expect(await links("Svc.multi_line", "api.load")).toEqual(both);
    expect(await links("Svc.factories", "api.load")).toEqual([]);
  });
  it("links only the arm whose class declares the member", async () => {
    expect(await links("Svc.one_declares", "api.reset")).toEqual(["ClubApi.reset:INFERRED"]);
  });
  it("leaves a non-call arm, a missing else, a block arm and a reassigned name untyped", async () => {
    expect(await links("Svc.not_a_call", "api.load")).toEqual([]);
    expect(await links("Svc.no_else", "api.load")).toEqual([]);
    expect(await links("Svc.block_arm", "api.load")).toEqual([]);
    expect(await links("Svc.reassigned", "api.load")).toEqual([]);
  });
  it("never fans separate assignments of one name", async () => {
    expect(await links("Svc.separate", "w.load")).toEqual([]);
    expect(await links("Svc.twice", "w.load")).toEqual([]);
  });
});
