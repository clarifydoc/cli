import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { extractCallsFromBody } from "../shared/regex-base.js";
import { rubySpec } from "./index.js";
import { declaredParamTypes, extractRubyDiBindings, extractRubyLocalTypes, parseRubyParam, rubyTypeText } from "./di.js";

const analyze = (src: string, filePath = "app/services/svc.rb") => extractWithRegex(src.replace(/^\n/, ""), filePath, "ruby");
const cls = (src: string, name?: string) => {
  const classes = analyze(src).classes;
  return name ? classes.find((c) => c.name === name)! : classes[0]!;
};
const props = (c: { properties: Array<{ name: string; type: string | null; qualifier?: string }> }) =>
  c.properties.map((p) => (p.qualifier ? { name: p.name, type: p.type, qualifier: p.qualifier } : { name: p.name, type: p.type }));
const callsOf = (src: string) => {
  const lines = src.split("\n");
  return extractCallsFromBody(lines, 0, lines.length, rubySpec.lineCommentPrefixes, rubySpec.callPatterns);
};
const bindings = (src: string) => extractRubyDiBindings(src.replace(/^\n/, "").split("\n")).map(({ line: _l, ...b }) => b);

describe("Ruby parameters", () => {
  it("types a parameter by its constructing default and keeps the old names", () => {
    expect(parseRubyParam("repo: PlayerRepo.new")).toEqual({ name: "repo", type: "PlayerRepo", defaultValue: "PlayerRepo.new" });
    expect(parseRubyParam("repo = ::Repos::SqlPlayerRepo.new(db)")).toEqual({ name: "repo", type: "Repos::SqlPlayerRepo", defaultValue: "::Repos::SqlPlayerRepo.new(db)" });
    expect(parseRubyParam("repo:")).toEqual({ name: "repo", type: null, defaultValue: null });
    expect(parseRubyParam("repo = build_repo")).toEqual({ name: "repo", type: null, defaultValue: "build_repo" });
    expect(parseRubyParam("opts = {}")).toEqual({ name: "opts", type: null, defaultValue: "{}" });
    expect(parseRubyParam("*args")?.name).toBe("*args");
    expect(parseRubyParam("&block")?.name).toBe("&block");
    expect(parseRubyParam("...")?.name).toBe("...");
  });

  it("reads YARD tags and Sorbet sigs above a def (Sorbet wins)", () => {
    const lines = `
# Builds it.
# @param repo [PlayerRepo, nil] the repository
# @param [Integer] id
# @param cb [#call] a duck type
sig do
  params(
    repo: T.nilable(SqlPlayerRepo),
    logger: T.any(Logger, NullLogger)
  ).void
end
def initialize(repo, id, logger, cb)
`.split("\n");
    const types = declaredParamTypes(lines, lines.length - 2);
    expect([...types.entries()]).toEqual([
      ["repo", "SqlPlayerRepo | nil"],
      ["logger", "Logger | NullLogger"],
      ["id", "Integer"],
    ]);
  });

  it("does not read the tags of an earlier method", () => {
    const lines = `
# @param repo [PlayerRepo]
def prev(repo)
end
def call(repo)
`.split("\n");
    expect(declaredParamTypes(lines, 4).size).toBe(0);
  });

  it("normalizes YARD and Sorbet type spellings", () => {
    expect(rubyTypeText("T.nilable(PlayerRepo)")).toBe("PlayerRepo | nil");
    expect(rubyTypeText("PlayerRepo, nil")).toBe("PlayerRepo | nil");
    expect(rubyTypeText("T::Array[Player]")).toBe("T::Array[Player]");
    expect(rubyTypeText("#find")).toBeNull();
  });
});

describe("Ruby locals", () => {
  it("types constructed, container-fetched and T.let locals", () => {
    const body = [
      "  a = PlayerRepo.new",
      "  b = Repos::SqlPlayerRepo.new(db) # comment",
      '  c = AppContainer["repos.player"]',
      "  d = AppContainer.resolve(:player_repo)",
      "  e = T.let(x, PlayerRepo)",
      "  f = PlayerRepo.new.tap { |r| r.warm }",
      "  g = CONFIG[:repo]",
      "  h = build",
    ];
    expect(extractRubyLocalTypes(body, { params: [] })).toEqual([
      { name: "a", type: "PlayerRepo" },
      { name: "b", type: "Repos::SqlPlayerRepo" },
      { name: "c", type: "", qualifier: "repos.player" },
      { name: "d", type: "", qualifier: "player_repo" },
      { name: "e", type: "PlayerRepo" },
    ]);
  });

  it("types a local whose construction spans several lines", () => {
    const body = ["  builder = PlayerBuilder.new(", "    name: params[:name],", "    club: Current.club", "  )", "  @player = builder.perform"];
    expect(extractRubyLocalTypes(body, { params: [] })).toEqual([{ name: "builder", type: "PlayerBuilder" }]);
  });

  it("drops a local reassigned untyped or rebound as a block parameter, and never re-types a parameter", () => {
    const body = [
      "  a = PlayerRepo.new",
      "  a = other",
      "  b = PlayerRepo.new",
      "  items.each { |b| b.go }",
      "  repo = PlayerRepo.new",
      "  c = PlayerRepo.new",
      "  c ||= PlayerRepo.new",
    ];
    expect(extractRubyLocalTypes(body, { params: [{ name: "repo", type: null, defaultValue: null }] })).toEqual([
      { name: "c", type: "PlayerRepo" },
    ]);
  });
});

describe("Ruby instance variables and injected readers", () => {
  it("types ivars from typed parameters, constructions, memoization, T.let and parallel assignment", () => {
    const c = cls(`
class Svc
  attr_reader :repo

  # @param mailer [Mailer]
  def initialize(repo: SqlPlayerRepo.new, mailer, log: nil, raw)
    @repo = repo
    @mailer, @log = mailer, log
    @clock = Clock.new
    @typed = T.let(raw, Store)
    @raw = raw
  end

  def cache
    @cache ||= Cache.new
  end
end
`);
    expect(props(c)).toEqual([
      { name: "repo", type: "SqlPlayerRepo" },
      { name: "mailer", type: "Mailer" },
      { name: "clock", type: "Clock" },
      { name: "typed", type: "Store" },
      { name: "cache", type: "Cache" },
    ]);
  });

  it("leaves an ivar untyped when another method assigns it something untyped, and skips singleton methods", () => {
    const c = cls(`
class Svc
  def initialize
    @repo = SqlPlayerRepo.new
    @other = SqlPlayerRepo.new
  end

  def swap(x)
    @repo = x
  end

  def self.instance
    @instance ||= new
  end
end
`);
    expect(props(c)).toEqual([{ name: "other", type: "SqlPlayerRepo" }]);
  });

  it("turns dry-auto_inject imports into keyed readers, not implemented modules", () => {
    const c = cls(`
class Svc
  include Comparable
  include Import["player_repo", "repos.club_repo"]
  include Deps[repo: "repos.player", :mailer => "mail.smtp"]
  include MyApp::Import.kwargs[
    "logger",
  ]

  def call; end
end
`);
    expect(c.implements).toEqual(["Comparable"]);
    expect(props(c)).toEqual([
      { name: "player_repo", type: null, qualifier: "player_repo" },
      { name: "club_repo", type: null, qualifier: "repos.club_repo" },
      { name: "repo", type: null, qualifier: "repos.player" },
      { name: "mailer", type: null, qualifier: "mail.smtp" },
      { name: "logger", type: null, qualifier: "logger" },
    ]);
  });

  it("keeps a nested class's ivars out of the enclosing module", () => {
    const classes = analyze(`
module Billing
  class Charge
    def initialize
      @gateway = StripeGateway.new
    end
  end
end
`).classes;
    expect(props(classes.find((c) => c.name === "Billing")!)).toEqual([]);
    expect(props(classes.find((c) => c.name === "Charge")!)).toEqual([{ name: "gateway", type: "StripeGateway" }]);
  });
});

describe("Ruby singleton methods", () => {
  it("names a singleton method that collides with an instance method `self.x`, and types `new(...).x`", () => {
    const c = cls(`
class CreatePlayer
  def self.call(...)
    new(...).call
  end

  def self.build
    new
  end

  class << self
    def run(x)
      new.run(x)
    end
  end

  def call
    1
  end

  def run(x)
    x
  end
end
`);
    expect(c.methods.map((m) => m.name)).toEqual(["self.call", "build", "self.run", "call", "run"]);
    const typed = c.methods.flatMap((m) => m.calls.filter((k) => k.receiverType).map((k) => [m.name, k.name, k.receiverType]));
    expect(typed).toEqual([
      ["self.call", "new.call", "CreatePlayer"],
      ["self.run", "new.run", "CreatePlayer"],
    ]);
  });
});

describe("Ruby calls", () => {
  it("types a call on a fresh construction or a container lookup", () => {
    const view = (src: string) => callsOf(src).map((c) => [c.name, c.receiverType, c.receiverQualifier]);
    expect(view("    PlayerRepo.new.find(id)")).toContainEqual(["new.find", "PlayerRepo", undefined]);
    expect(view("    Repos::PlayerRepo.new(db).save")).toContainEqual(["new.save", "Repos::PlayerRepo", undefined]);
    expect(view("    AppContainer[:player_repo].find(id)")).toContainEqual(["AppContainer[:player_repo].find", undefined, "player_repo"]);
    expect(view("    MyApp::Container.resolve(:repo).find(id)")).toContainEqual(["MyApp::Container.resolve(:repo).find", undefined, "repo"]);
    // A Hash constant is no container.
    expect(view("    CONFIG[:repo].fetch(id)").filter((c) => c[1] !== undefined)).toEqual([]);
  });

  it("records `self.repo.m(` and `repo&.m(` once, as a call on the reader `repo`", () => {
    expect(callsOf("    self.repo.find_player(id)").map((c) => c.name)).toEqual(["repo.find_player"]);
    const c = cls(`
class Svc
  def call(id)
    @repo&.find_player(id)
  end
end
`);
    expect(c.methods[0]!.calls.map((k) => k.name)).toEqual(["repo.find_player"]);
  });

  it("drops the bare reading of a member call on an unnamed receiver", () => {
    const c = cls(`
class Svc
  def call(id)
    AppContainer["repos.player"].find_player(id)
    params[:player].permit(:name)
    find_player(id)
  end

  def find_player(id); end
end
`);
    // The member calls' bare readings are gone; the real `find_player(id)` on
    // line 5 stays (moved off the first, detached occurrence it was deduped into).
    expect(c.methods[0]!.calls.map((k) => [k.name, k.line])).toEqual([["find_player", 5]]);
    expect(cls(`
class Svc
  def call(id)
    AppContainer["repos.player"].find_player(id)
  end

  def find_player(id); end
end
`).methods[0]!.calls).toEqual([]);
  });
});

describe("Ruby dry-container registrations", () => {
  it("binds blocks, values and do-blocks under namespaced keys", () => {
    expect(bindings(`
class AppContainer
  extend Dry::Container::Mixin

  register(:player_repo) { SqlPlayerRepo.new }
  register("repos.player", memoize: true) { |c| Repos::SqlPlayerRepo.new(c[:db]) }
  register :mailer, SmtpMailer.new
  register(:clock, -> { SystemClock.new })
  register(:klass, SqlPlayerRepo)
  register(:proc, call: false) { SqlPlayerRepo.new }
  register(:built) { build_repo }

  namespace(:repos) do
    register(:club) do |c|
      ClubRepo.new(
        c[:db]
      )
    end
    register "audit" do
      x = 1
      AuditRepo.new
    end
  end

  register(:after) { AfterRepo.new }
end
`)).toEqual([
      { service: "player_repo", implementation: "SqlPlayerRepo", via: "register", keyedOnly: true },
      { service: "repos.player", implementation: "SqlPlayerRepo", via: "register", keyedOnly: true },
      { service: "mailer", implementation: "SmtpMailer", via: "register", keyedOnly: true },
      { service: "clock", implementation: "SystemClock", via: "register", keyedOnly: true },
      { service: "repos.club", implementation: "ClubRepo", via: "register", keyedOnly: true },
      { service: "after", implementation: "AfterRepo", via: "register", keyedOnly: true },
    ]);
  });

  it("binds registrations on container receivers, conditional ones included, and nothing else", () => {
    expect(bindings(`
Container = Dry::Container.new
Container.register(:repo) { SqlPlayerRepo.new }
AppContainer.register(:mailer) { SesMailer.new } if ENV["SES"]
Mime::Type.register "text/csv", :csv
ActiveAdmin.register Player do
end
register(:loose) { LooseRepo.new }
`)).toEqual([
      { service: "repo", implementation: "SqlPlayerRepo", via: "register", keyedOnly: true },
      { service: "mailer", implementation: "SesMailer", via: "register", keyedOnly: true },
    ]);
  });

  it("lands on FileAnalysis.diBindings through the spec", () => {
    const a = analyze(`
class AppContainer
  extend Dry::Container::Mixin
  register(:player_repo) { SqlPlayerRepo.new }
end
`, "config/initializers/container.rb");
    expect(a.diBindings).toEqual([{ service: "player_repo", implementation: "SqlPlayerRepo", line: 3, via: "register", keyedOnly: true }]);
  });
});
