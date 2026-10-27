import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { loadScalaReader } from "./tree-sitter.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { ParsedStructure } from "../../../types/language-plugin.js";

let readScala: (source: string) => ParsedStructure;
beforeAll(async () => {
  readScala = await loadScalaReader();
});

const CLUBS = `package league.controllers

class ClubController @Inject()(cc: ControllerComponents, repo: ClubRepo)(implicit ec: ExecutionContext)
    extends AbstractController(cc) {

  def show(id: Long): Action[AnyContent] = Action.async { implicit request =>
    repo.find(id).map { club => Ok(views.html.club(club)) }
  }

  def size: Int = this.repo.cache.size()

  private def squad(id: Long): Seq[Player] = {
    def fit(p: Player) = medical.check(p)
    val roster = new Roster(id)
    Club(id).players().starters(fit)
  }

  def switch(to: Club): Unit = injector.instanceOf[TransferApi].move(to)
}

trait ClubRepo {
  def find(id: Long): Future[Club]
}
`;

describe("Scala through tree-sitter", () => {
  it("reads every def with its exact span, a local one owning its calls", () => {
    const parsed = readScala(CLUBS);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => [f.name, f.line, f.endLine])).toEqual([
      ["show", 6, 8],
      ["size", 10, 10],
      ["squad", 12, 16],
      ["fit", 13, 13],
      ["switch", 18, 18],
      ["find", 22, 22],
    ]);
    expect(parsed.functions.find((f) => f.name === "fit")!.calls.map((c) => c.name)).toEqual(["medical.check"]);
  });

  it("names calls as the Scala patterns do, and the chains and constructions they cannot read", () => {
    const calls = (name: string) => readScala(CLUBS).functions.find((f) => f.name === name)!.calls.map((c) => c.name);
    // `map` on a chain and `Ok` are stdlib noise, held back as the patterns hold them.
    expect(calls("show")).toEqual(["Action.async", "repo.find", "html.club"]);
    expect(calls("size")).toEqual(["cache.size"]);
    expect(calls("squad")).toEqual(["Roster", "Club.players().starters", "Club.players", "Club"]);
    const move = readScala(CLUBS).functions.find((f) => f.name === "switch")!.calls.find((c) => c.name.endsWith(".move"));
    expect(move).toMatchObject({ name: "injector.instanceOf[TransferApi].move", receiverType: "TransferApi" });
  });

  it("lends an anonymous instance's method calls to the function building it, which never calls them by name", () => {
    const fns = readScala("object Pitch {\n  def handler = new MatchHandler {\n    def onGoal(g: Goal) = Scoreboard.record(g)\n  }\n}\n").functions;
    expect(fns.map((f) => [f.name, f.calls.map((c) => c.name)])).toEqual([
      ["handler", ["Scoreboard.record"]],
      ["onGoal", ["Scoreboard.record"]],
    ]);
  });

  it("names a placeholder lambda's call as the patterns do, and a method on a construction as the type's (real-repo FP)", () => {
    const calls = (body: string) => readScala(`object A {\n  def f() = {\n${body}\n  }\n}\n`).functions[0]!.calls;
    expect(calls("    Fixtures.where(_.byRound(round))").map((c) => c.name)).toEqual(["Fixtures.where", "_.byRound"]);
    expect(calls("    new LeagueTable(season).recompute(points)")).toMatchObject([{ name: "LeagueTable.recompute", receiverType: "LeagueTable" }, { name: "LeagueTable" }]);
  });

  it("names a constructor pattern by its type: it calls the extractor", () => {
    const calls = readScala("object A {\n  def f(e: Event) = e match {\n    case Goal(minute) => 1\n    case Card.Red(player, _) => 2\n    case _: Corner => 3\n  }\n}\n").functions[0]!.calls;
    expect(calls.map((c) => c.name)).toEqual(["Goal", "Card.Red"]);
  });

  it("names no parameterless member or infix call, as the patterns read them", () => {
    const calls = (body: string) => readScala(`object A {\n  def f() = {\n${body}\n  }\n}\n`).functions[0]!.calls.map((c) => c.name);
    expect(calls("    val names = squad.players.toList\n    names map normalize")).toEqual([]);
  });

  it("counts the errors of a file the grammar cannot read, so core keeps the regex reading", () => {
    expect(readScala("object A { def f( = 1 }\n").syntaxErrors).toBeGreaterThan(0);
  });
});

/**
 * Where the two readings of a fixture differ, and why the parser's is the one to keep: `file → function →
 * [calls only the patterns record, calls only the parser records]`. A method on a call's result is named as the
 * chain from it (`toCar().copy`), which the linker types through declared return types; the patterns skip it.
 * Extents differ throughout and are not compared: the patterns end a `def` a line before the `}` closing its body.
 */
const KNOWN: Record<string, Record<string, [string[], string[]]>> = {
  "test-fixtures/sample-scala-play/app/controllers/CarController.scala": {
    "CarController.create": [[], ["validate.fold"]],
    "CarController.update": [[], ["toCar().copy"]],
  },
};

describe("Scala: tree-sitter and the patterns agree on the fixtures", () => {
  const root = resolve(__dirname, "../../../..");
  const files = globSync("test-fixtures/**/*.{scala,sc}", { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} as the patterns do, but where it is listed as better`, () => {
      const src = readFileSync(resolve(root, rel), "utf-8");
      const parsed = readScala(src);
      expect(parsed.syntaxErrors).toBe(0);
      const shape = (a: ReturnType<typeof extractWithRegex>) => [
        ...a.functions.map((f) => ({ name: f.name, line: f.line, calls: f.calls.map((c) => c.name) })),
        ...a.classes.flatMap((c) => c.methods.map((m) => ({ name: `${c.name}.${m.name}`, line: m.line, calls: m.calls.map((x) => x.name) }))),
      ];
      const regex = shape(extractWithRegex(src, rel, "scala"));
      const tree = shape(extractWithRegex(src, rel, "scala", undefined, parsed));
      expect(tree.map(({ calls: _, ...fn }) => fn)).toEqual(regex.map(({ calls: _, ...fn }) => fn));
      const differences: Record<string, [string[], string[]]> = {};
      regex.forEach((fn, i) => {
        const b = tree[i]!.calls;
        const onlyA = fn.calls.filter((c) => !b.includes(c));
        const onlyB = b.filter((c) => !fn.calls.includes(c));
        if (onlyA.length + onlyB.length > 0) differences[fn.name] = [onlyA, onlyB];
      });
      expect(differences).toEqual(KNOWN[rel] ?? {});
    });
  }
});
