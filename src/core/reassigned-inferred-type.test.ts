import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { analyzeFiles } from "./conditional-arms-fixture.js";

/** A PHP local typed only by a construction (`$c = new Club()`) is untyped once another assignment of it is a call the analysis cannot type. */
describe("PHP local typed by an assignment and assigned from a call elsewhere", () => {
  let fx: Awaited<ReturnType<typeof analyzeFiles>>;
  beforeAll(async () => {
    fx = await analyzeFiles({
      "Types.php": [
        "<?php",
        "class Club { public function save() { return 1; } }",
        "class Player { public function save() { return 2; } }",
        "class Factory {",
        "  public function club(): Club { return new Club(); }",
        "  public function player(): Player { return new Player(); }",
        "}",
        "class Lib { public function make() { return ext(); } }",
        "",
      ].join("\n"),
      "Svc.php": [
        "<?php",
        "function lone($x) { $c = new Club(); return $c->save(); }",
        "function unknownElse($x) { if ($x) { $c = new Club(); } else { $c = ext(); } return $c->save(); }",
        "function unknownFirst($x) { if ($x) { $c = ext(); } else { $c = new Club(); } return $c->save(); }",
        "function noReturn(Lib $l, $x) { if ($x) { $c = new Club(); } else { $c = $l->make(); } return $c->save(); }",
        "function sameType(Factory $f, $x) { if ($x) { $c = new Club(); } else { $c = $f->club(); } return $c->save(); }",
        "function otherType(Factory $f, $x) { if ($x) { $c = new Club(); } else { $c = $f->player(); } return $c->save(); }",
        "function guardNull($g, $x) { $c = $g->first(); if (null === $c) { $c = new Club(); } return $c->save(); }",
        "function guardBang($g, $x) { $c = $g->first(); if (!$c) { $c = new Club(); } return $c->save(); }",
        "function guardYoda($g, $x) { $c = $g->first(); if ($c === null) { $c = new Club(); } return $c->save(); }",
        "function guardIsNull($g, $x) { $c = $g->first(); if (is_null($c)) { $c = new Club(); } return $c->save(); }",
        "function guardEmpty($g, $x) { $c = $g->first(); if (empty($c)) { $c = new Club(); } return $c->save(); }",
        "function guardIsset($g, $x) { $c = $g->first(); if (!isset($c)) { $c = new Club(); } return $c->save(); }",
        "function guardOther($g, $x) { $c = $g->first(); if (!$x) { $c = new Club(); } return $c->save(); }",
        "function written($x) { /** @var Club $c */ $c = ext(); return $c->save(); }",
        "function writtenThenNew($x) { /** @var Club $c */ if ($x) { $c = new Club(); } else { $c = ext(); } return $c->save(); }",
        "",
      ].join("\n"),
    });
  });
  afterAll(() => fx.cleanup());
  const links = (fn: string) => fx.linksOf("Svc.php", fn, "c.save");
  it("keeps a lone construction", async () => expect(await links("lone")).toEqual(["Club.save:INFERRED"]));
  it("leaves a name untyped when another assignment is an untypable call", async () => {
    expect(await links("unknownElse")).toEqual([]);
    expect(await links("unknownFirst")).toEqual([]);
    expect(await links("noReturn")).toEqual([]);
  });
  it("keeps the type when the other assignment types the same class", async () => expect(await links("sameType")).toEqual(["Club.save:INFERRED"]));
  it("leaves it untyped when the other assignment is another class, without inventing a fan-out", async () => expect(await links("otherType")).toEqual([]));
  it("keeps the type of a find-or-create default, every spelling of the null check", async () => {
    for (const fn of ["guardNull", "guardBang", "guardYoda", "guardIsNull", "guardEmpty", "guardIsset"]) expect(await links(fn)).toEqual(["Club.save:INFERRED"]);
  });
  it("still untypes when the guard tests another variable", async () => expect(await links("guardOther")).toEqual([]));
  it("keeps a written docblock type", async () => {
    expect(await links("written")).toEqual(["Club.save:INFERRED"]);
    expect(await links("writtenThenNew")).toEqual(["Club.save:INFERRED"]);
  });
});
