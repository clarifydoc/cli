import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { analyzeFiles } from "./conditional-arms-fixture.js";

/** A PHP `$x ? clubs() : players()` and a Python `clubs() if x else players()` initializer link each arm (AMBIGUOUS). */
describe("PHP and Python conditional initializer arms", () => {
  let fx: Awaited<ReturnType<typeof analyzeFiles>>;
  beforeAll(async () => {
    fx = await analyzeFiles({
      "php/Types.php": [
        "<?php",
        "namespace League;",
        'class ClubApi { public function load() { return "c"; } public function reset() { return "r"; } }',
        'class PlayerApi { public function load() { return "p"; } }',
        'class Player { public function load() { return "decoy"; } public function reset() { return "decoy"; } }',
        "class Factory {",
        "  public function clubs(): ClubApi { return new ClubApi(); }",
        "  public function players(): PlayerApi { return new PlayerApi(); }",
        "}",
        "",
      ].join("\n"),
      "php/Svc.php": [
        "<?php",
        "namespace League;",
        "class Svc {",
        "  public function __construct(private Factory $f) {}",
        "  public function single() { $api = $this->f->clubs(); return $api->load(); }",
        "  public function armed($x) { $api = $x ? $this->f->clubs() : $this->f->players(); return $api->load(); }",
        "  public function nested($k) { $api = $k > 1 ? $this->f->clubs() : ($k > 0 ? $this->f->players() : $this->f->clubs()); return $api->load(); }",
        "  public function oneDeclares($x) { $api = $x ? $this->f->clubs() : $this->f->players(); return $api->reset(); }",
        "  public function shortTernary($x) { $api = $x ?: $this->f->players(); return $api->load(); }",
        "  public function unknown($x, $other) { $api = $x ? $this->f->clubs() : $other->make(); return $api->load(); }",
        "  public function separate($x) {",
        "    if ($x) { $w = $this->f->clubs(); return $w->load(); } else { $w = $this->f->players(); return $w->load(); }",
        "  }",
        "}",
        "",
      ].join("\n"),
      "py/api.py": [
        "class ClubApi:",
        '    def load(self): return "c"',
        '    def reset(self): return "r"',
        "class PlayerApi:",
        '    def load(self): return "p"',
        "class Player:",
        '    def load(self): return "decoy"',
        '    def reset(self): return "decoy"',
        "class Factory:",
        "    def clubs(self) -> ClubApi: return ClubApi()",
        "    def players(self) -> PlayerApi: return PlayerApi()",
        "",
      ].join("\n"),
      "py/svc.py": [
        "from api import Factory",
        "",
        "def single(f: Factory):",
        "    api = f.clubs()",
        "    return api.load()",
        "def armed(f: Factory, x):",
        "    api = f.clubs() if x else f.players()",
        "    return api.load()",
        "def nested(f: Factory, k):",
        "    api = f.clubs() if k > 1 else (f.players() if k > 0 else f.clubs())",
        "    return api.load()",
        "def one_declares(f: Factory, x):",
        "    api = f.clubs() if x else f.players()",
        "    return api.reset()",
        "def unknown(f: Factory, other, x):",
        "    api = f.clubs() if x else other.make()",
        "    return api.load()",
        "def separate(f: Factory, x):",
        "    if x:",
        "        w = f.clubs()",
        "        return w.load()",
        "    else:",
        "        w = f.players()",
        "        return w.load()",
        "",
      ].join("\n"),
    });
  }, 60_000);
  afterAll(() => fx.cleanup());

  describe("PHP", () => {
    const links = (fn: string, call: string) => fx.linksOf("php/Svc.php", fn, call);
    it("links the lone initializer (control)", async () => {
      expect(await links("Svc.single", "api.load")).toEqual(["ClubApi.load:INFERRED"]);
    });
    it("links each arm, AMBIGUOUS, never the decoy", async () => {
      expect(await links("Svc.armed", "api.load")).toEqual(["ClubApi.load:AMBIGUOUS", "PlayerApi.load:AMBIGUOUS"]);
      expect(await links("Svc.nested", "api.load")).toEqual(["ClubApi.load:AMBIGUOUS", "PlayerApi.load:AMBIGUOUS"]);
      expect(await links("Svc.oneDeclares", "api.reset")).toEqual(["ClubApi.reset:INFERRED"]);
    });
    it("types nothing from a short ternary or an unresolved arm", async () => {
      expect(await links("Svc.shortTernary", "api.load")).toEqual([]);
      expect(await links("Svc.unknown", "api.load")).toEqual([]);
    });
    it("never fans separate declarations of one name", async () => {
      expect(await links("Svc.separate", "w.load")).toEqual([]);
    });
  });

  describe("Python", () => {
    const links = (fn: string, call: string) => fx.linksOf("py/svc.py", fn, call);
    it("links the lone initializer (control)", async () => {
      expect(await links("single", "api.load")).toEqual(["ClubApi.load:INFERRED"]);
    });
    it("links each arm, AMBIGUOUS, never the decoy", async () => {
      expect(await links("armed", "api.load")).toEqual(["ClubApi.load:AMBIGUOUS", "PlayerApi.load:AMBIGUOUS"]);
      expect(await links("nested", "api.load")).toEqual(["ClubApi.load:AMBIGUOUS", "PlayerApi.load:AMBIGUOUS"]);
      expect(await links("one_declares", "api.reset")).toEqual(["ClubApi.reset:INFERRED"]);
    });
    it("types nothing from an unresolved arm (the name-shape guess at the one class is older and unrelated)", async () => {
      expect((await links("unknown", "api.load")).filter((l) => !l.startsWith("ClubApi.load"))).toEqual([]);
    });
    it("never fans separate declarations of one name", async () => {
      expect(await links("separate", "w.load")).toEqual([]);
    });
  });
});
