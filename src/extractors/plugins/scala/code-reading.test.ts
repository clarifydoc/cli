import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const analyze = (src: string) => extractWithRegex(src, "league/Club.scala", "scala");
const methods = (src: string) => analyze(src).classes.flatMap((c) => c.methods.map((m) => ({ owner: c.name, ...m })));
const fn = (src: string, name: string) => methods(src).find((m) => m.name === name)!;

describe("Scala blocks end where Scala nests them", () => {
  const scala3 = [
    "object Club:", // 1
    "", // 2
    "  def roster(id: Int): List[Player] =", // 3
    "    val all = load(id)", // 4
    "    all.drop(1)", // 5
    "", // 6
    "  def name = \"club\"", // 7
    "", // 8
    "  def table(", // 9
    "      season: Int", // 10
    "  ): Table =", // 11
    "    standings(season)", // 12
    "  end table", // 13
    "", // 14
    "final class Match(id: Int):", // 15
    "  def kickOff() = whistle(id)", // 16
  ].join("\n");

  it("ends an indented body at its last deeper line or its `end` marker", () => {
    expect(fn(scala3, "roster").endLine).toBe(5);
    expect(fn(scala3, "name").endLine).toBe(7);
    expect(fn(scala3, "table").endLine).toBe(13);
    expect(fn(scala3, "roster").calls.map((c) => c.name)).toEqual(expect.arrayContaining(["load", "all.drop"]));
  });

  it("keeps each method on the object or class that holds it", () => {
    expect(methods(scala3).map((m) => `${m.owner}.${m.name}`)).toEqual(expect.arrayContaining(["Club.roster", "Club.name", "Club.table", "Match.kickOff"]));
    expect(methods(scala3).find((m) => m.name === "kickOff")!.owner).toBe("Match");
  });

  it("ends a braced body at its brace, past braces in strings", () => {
    const src = ["class League {", "  def report(): String = {", '    val open = "{"', "    render(open)", "  }", "  def size = 3", "}"].join("\n");
    expect(fn(src, "report").endLine).toBe(5);
    expect(fn(src, "size").endLine).toBe(6);
    expect(analyze(src).classes[0]!.endLine).toBe(7);
  });

  it("reads a call taking a block or an indented argument", () => {
    const src = ["object Clubs:", "  def show(id: Int) = Open:", "    Auth { ctx =>", "      render(id)", "    }", "  def list = clubs.foreach: club =>", "    club.name"].join("\n");
    expect(fn(src, "show").calls.map((c) => c.name)).toEqual(expect.arrayContaining(["Open", "Auth", "render"]));
    expect(fn(src, "list").calls.map((c) => c.name)).toContain("clubs.foreach");
  });

  it("finds no method in a comment or a triple-quoted template", () => {
    const src = ["object Gen:", "  /*", "  def retired() = 1", "  */", '  val tpl = """', "  def generated() = 2", '  """', "  def active() = 3"].join("\n");
    expect(methods(src).map((m) => m.name)).toEqual(["active"]);
  });
});
