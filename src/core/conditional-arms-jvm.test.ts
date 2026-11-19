import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { analyzeFiles } from "./conditional-arms-fixture.js";

/** A Java `x ? clubs() : players()` and a Kotlin `if (x) clubs() else players()` initializer link each arm (AMBIGUOUS). */
describe("Java and Kotlin conditional initializer arms", () => {
  let fx: Awaited<ReturnType<typeof analyzeFiles>>;
  beforeAll(async () => {
    const cls = (pkg: string, name: string, extra = "") => `package ${pkg};\npublic class ${name} { public String load() { return "x"; }${extra} }\n`;
    fx = await analyzeFiles({
      "java/ClubApi.java": cls("com.example.league", "ClubApi", " public String reset() { return \"r\"; }"),
      "java/PlayerApi.java": cls("com.example.league", "PlayerApi"),
      "java/Player.java": cls("com.example.league", "Player", " public String reset() { return \"decoy\"; }"),
      "java/Svc.java": [
        "package com.example.league;",
        "public class Svc {",
        "  static ClubApi clubs() { return new ClubApi(); }",
        "  static PlayerApi players() { return new PlayerApi(); }",
        "  public String single() { var api = clubs(); return api.load(); }",
        "  public String armed(boolean x) { var api = x ? clubs() : players(); return api.load(); }",
        "  public String nested(int k) { var api = k > 1 ? clubs() : (k > 0 ? players() : clubs()); return api.load(); }",
        "  public String oneDeclares(boolean x) { var api = x ? clubs() : players(); return api.reset(); }",
        "  public String unknown(boolean x, Svc other) { var api = x ? clubs() : other.make(); return api.load(); }",
        "  public String separate(boolean x) {",
        "    if (x) { var w = clubs(); return w.load(); } else { var w = players(); return w.load(); }",
        "  }",
        "}",
        "",
      ].join("\n"),
      "kt/Types.kt": [
        "package com.example.league",
        'class ClubApi { fun load() = "c"; fun reset() = "r" }',
        'class PlayerApi { fun load() = "p" }',
        'class Player { fun load() = "decoy"; fun reset() = "decoy" }',
        "enum class Kind { Club, League }",
        "class Factory {",
        "  fun clubs(): ClubApi = ClubApi()",
        "  fun players(): PlayerApi = PlayerApi()",
        "}",
        "",
      ].join("\n"),
      "kt/Svc.kt": [
        "package com.example.league",
        "class Svc(val f: Factory) {",
        "  fun single(): String { val api = f.clubs(); return api.load() }",
        "  fun armed(x: Boolean): String { val api = if (x) f.clubs() else f.players(); return api.load() }",
        "  fun chained(k: Int): String { val api = if (k > 1) f.clubs() else if (k > 0) f.players() else f.clubs(); return api.load() }",
        "  fun oneDeclares(x: Boolean): String { val api = if (x) f.clubs() else f.players(); return api.reset() }",
        "  fun whenArms(k: Kind): String { val api = when (k) { Kind.Club -> f.clubs()\n Kind.League -> f.players()\n else -> f.clubs() }; return api.load() }",
        "  fun whenOneDeclares(k: Kind): String { val api = when (k) { Kind.Club -> f.clubs()\n else -> f.players() }; return api.reset() }",
        "  fun whenNoElse(k: Kind): String { val api = when (k) { Kind.Club -> f.clubs()\n Kind.League -> f.players() }; return api.load() }",
        "  fun whenBlock(k: Kind): String { val api = when (k) { Kind.Club -> { log(); f.clubs() }\n else -> f.players() }; return api.load() }",
        "  fun whenNotCall(k: Kind): String { val api = when (k) { Kind.Club -> f.clubs()\n else -> null }; return api.load() }",
        "  fun separate(x: Boolean): String {",
        "    if (x) { val w = f.clubs(); return w.load() } else { val w = f.players(); return w.load() }",
        "  }",
        "}",
        "",
      ].join("\n"),
    });
  }, 60_000);
  afterAll(() => fx.cleanup());

  describe("Java", () => {
    const links = (fn: string, call: string) => fx.linksOf("java/Svc.java", fn, call);
    it("links the lone initializer (control)", async () => {
      expect(await links("Svc.single", "api.load")).toEqual(["ClubApi.load:INFERRED"]);
    });
    it("links each arm, AMBIGUOUS, never the decoy", async () => {
      expect(await links("Svc.armed", "api.load")).toEqual(["ClubApi.load:AMBIGUOUS", "PlayerApi.load:AMBIGUOUS"]);
      expect(await links("Svc.nested", "api.load")).toEqual(["ClubApi.load:AMBIGUOUS", "PlayerApi.load:AMBIGUOUS"]);
      expect(await links("Svc.oneDeclares", "api.reset")).toEqual(["ClubApi.reset:INFERRED"]);
    });
    it("leaves an unresolved arm untyped", async () => {
      expect(await links("Svc.unknown", "api.load")).toEqual([]);
    });
    it("never fans separate declarations of one name", async () => {
      expect(await links("Svc.separate", "w.load")).toEqual([]);
    });
  });

  describe("Kotlin", () => {
    const links = (fn: string, call: string) => fx.linksOf("kt/Svc.kt", fn, call);
    it("links the lone initializer (control)", async () => {
      expect(await links("Svc.single", "api.load")).toEqual(["ClubApi.load:INFERRED"]);
    });
    it("links each arm of if / else if / else, AMBIGUOUS", async () => {
      expect(await links("Svc.armed", "api.load")).toEqual(["ClubApi.load:AMBIGUOUS", "PlayerApi.load:AMBIGUOUS"]);
      expect(await links("Svc.chained", "api.load")).toEqual(["ClubApi.load:AMBIGUOUS", "PlayerApi.load:AMBIGUOUS"]);
      expect(await links("Svc.oneDeclares", "api.reset")).toEqual(["ClubApi.reset:INFERRED"]);
    });
    it("never fans separate declarations of one name", async () => {
      expect(await links("Svc.separate", "w.load")).toEqual([]);
    });
    it("links each arm of a when with an else", async () => {
      expect(await links("Svc.whenArms", "api.load")).toEqual(["ClubApi.load:AMBIGUOUS", "PlayerApi.load:AMBIGUOUS"]);
      expect(await links("Svc.whenOneDeclares", "api.reset")).toEqual(["ClubApi.reset:INFERRED"]);
    });
    it("leaves a when without else, with a block arm or a non-call arm untyped", async () => {
      expect(await links("Svc.whenNoElse", "api.load")).toEqual([]);
      expect(await links("Svc.whenBlock", "api.load")).toEqual([]);
      expect(await links("Svc.whenNotCall", "api.load")).toEqual([]);
    });
  });
});
