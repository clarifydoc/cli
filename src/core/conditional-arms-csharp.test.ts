import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { analyzeFiles } from "./conditional-arms-fixture.js";

/** A C# local initialised by `x ? Clubs() : Players()` links each arm (AMBIGUOUS); separate declarations of one name do not. */
describe("C# conditional initializer arms", () => {
  let fx: Awaited<ReturnType<typeof analyzeFiles>>;
  beforeAll(async () => {
    fx = await analyzeFiles({
      "Types.cs": [
        "namespace League {",
        '  public class ClubApi { public string Load() => "c"; public string Reset() => "r"; }',
        '  public class PlayerApi { public string Load() => "p"; }',
        '  public class Player { public string Load() => "decoy"; public string Reset() => "decoy"; }',
        "}",
        "",
      ].join("\n"),
      "Svc.cs": [
        "namespace League {",
        "  public class Svc {",
        "    static ClubApi Clubs() => new ClubApi();",
        "    static PlayerApi Players() => new PlayerApi();",
        "    public string Single() { var api = Clubs(); return api.Load(); }",
        "    public string Armed(bool x) { var api = x ? Clubs() : Players(); return api.Load(); }",
        "    public string Nested(int k) { var api = k > 1 ? Clubs() : (k > 0 ? Players() : Clubs()); return api.Load(); }",
        "    public string OneDeclares(bool x) { var api = x ? Clubs() : Players(); return api.Reset(); }",
        "    public string Unknown(bool x, Svc other) { var api = x ? Clubs() : other.Make(); return api.Load(); }",
        "    public string Built(bool x) { var api = x ? Clubs() : new Player(); return api.Load(); }",
        "    public string Separate(bool x) {",
        "      if (x) { var w = Clubs(); return w.Load(); } else { var w = Players(); return w.Load(); }",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    });
  }, 60_000);
  afterAll(() => fx.cleanup());
  const links = (fn: string, call: string) => fx.linksOf("Svc.cs", fn, call);

  it("links the lone initializer (control)", async () => {
    expect(await links("Svc.Single", "api.Load")).toEqual(["ClubApi.Load:INFERRED"]);
  });
  it("links each arm, AMBIGUOUS, never the decoy", async () => {
    expect(await links("Svc.Armed", "api.Load")).toEqual(["ClubApi.Load:AMBIGUOUS", "PlayerApi.Load:AMBIGUOUS"]);
    expect(await links("Svc.Nested", "api.Load")).toEqual(["ClubApi.Load:AMBIGUOUS", "PlayerApi.Load:AMBIGUOUS"]);
  });
  it("links only the arm that declares the member", async () => {
    expect(await links("Svc.OneDeclares", "api.Reset")).toEqual(["ClubApi.Reset:INFERRED"]);
  });
  it("leaves an arm that is no call untyped", async () => {
    expect(await links("Svc.Unknown", "api.Load")).toEqual([]);
  });
  it("types an arm that constructs a class as that class", async () => {
    expect(await links("Svc.Built", "api.Load")).toEqual(["ClubApi.Load:AMBIGUOUS", "Player.Load:AMBIGUOUS"]);
  });
  it("never fans separate declarations of one name", async () => {
    expect(await links("Svc.Separate", "w.Load")).toEqual([]);
  });
});
