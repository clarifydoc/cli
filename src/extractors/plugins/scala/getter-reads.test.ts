import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import "./meta.js";

/**
 * A parameterless `def` is called without parentheses — `club.total`, a bare `total` in the class, a read inside an
 * interpolated string — so the read joins the def's own calls to the reader's chain. Never a `val`, a field, a
 * parameter or local of the name, a def with a parameter list, or a getter of a class the receiver is not.
 */
const FILES: Record<string, string> = {
  "build.sbt": 'name := "league"\nscalaVersion := "2.13.12"\n',
  "app/Club.scala": `package league

class Squad {
  def size: Int = Http.get("/api/squads/size")
}

class Club extends Squad {
  val name: String = "club"
  def total: Int = Http.get("/api/clubs/total")
  def rank(season: Int): Int = season
}
`,
  "app/Rival.scala": `package league

class Rival {
  def total: Int = 3
  def size: Int = 4
}
`,
  "app/Repo.scala": `package league

class Repo {
  def find(id: Int): Club = new Club
  def findRival(id: Int): Rival = new Rival
  def count(id: Int): Int = id
}
`,
  "app/Board.scala": `package league

class Board(club: Club, rival: Rival, repo: Repo) extends Club {
  def onResult: Int = repo.find(1).total
  def onNested: Int = repo.find(Seq(1).head).total
  def onNamesake: Int = repo.findRival(1).total
  def onValue: Int = repo.find(1).name.length
  def onPlain: Int = repo.count(1).toInt
  def onBlock = repo.find(1).map { c =>
    c
  }
  def onForeach = repo.find(1).foreach(c => c)
  def onInfix = repo.find(1) map identity
  def onUnderscore = repo.find(1).map _
  def onUnknown(other: Any): Int = other.find(1).total
  def viaField: Int = club.total
  def viaParam(c: Club): Int = c.total
  def viaRival(r: Rival): Int = r.total
  def viaVal: String = club.name
  def withArgs: Int = club.rank(2)
  def bare: Int = total + 1
  def inherited: Int = size
  def viaThis: Int = this.total
  def interpolated: String = s"total \${club.total} and $size"
  def shadowed(total: Int): Int = total
  def localVal: Int = { val total = 1; total }
  def lambda: Seq[Int] = Seq(1).map(total => total)
  def commented: Int = {
    // club.total
    val s = "club.total"
    1
  }
}
`,
};

const root = mkdtemp(join(tmpdir(), "cd-scala-getter-"));
afterAll(async () => rm(await root, { recursive: true, force: true }));

async function links(feature?: string): Promise<Map<string, string[]>> {
  const dir = await mkdtemp(join(await root, "run-"));
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  const out = join(dir, "out");
  const previous = process.env.CLARIFYDOC_FEATURES;
  if (feature) process.env.CLARIFYDOC_FEATURES = feature;
  try {
    await analyze({ projectRoot: dir, outputDir: out, lsp: false, gitHistory: false });
  } finally {
    if (previous === undefined) delete process.env.CLARIFYDOC_FEATURES;
    else process.env.CLARIFYDOC_FEATURES = previous;
  }
  const summary = await loadReportSummary(out);
  const byCaller = new Map<string, string[]>();
  for (const l of summary.symbolLinks ?? []) {
    if (l.sourceFile !== "app/Board.scala") continue;
    const list = byCaller.get(l.sourceSymbol) ?? [];
    list.push(`${l.targetFile}:${l.targetSymbol}`);
    byCaller.set(l.sourceSymbol, list);
  }
  // The reads each function states, whatever they link to: a call with a block or an infix operand is no getter read.
  const file = JSON.parse(await readFile(join(out, "app/Board.scala.json"), "utf8")) as { classes: Array<{ methods: Array<{ name: string; calls: Array<{ name: string; read?: string }> }> }> };
  for (const m of file.classes.flatMap((c) => c.methods)) byCaller.set(`reads:${m.name}`, m.calls.filter((c) => c.read).map((c) => c.name));
  return byCaller;
}

describe.each([["tree-sitter", undefined], ["regex", "no-tree-sitter:scala"]])("Scala parameterless defs (%s)", (_name, feature) => {
  it("link a member read, through the receiver's type and the class's bases", async () => {
    const r = await links(feature);
    expect(r.get("Board.viaField")).toContain("app/Club.scala:Club.total");
    expect(r.get("Board.viaParam")).toContain("app/Club.scala:Club.total");
    expect(r.get("Board.bare")).toContain("app/Club.scala:Club.total");
    expect(r.get("Board.viaThis")).toContain("app/Club.scala:Club.total");
    expect(r.get("Board.inherited")).toContain("app/Club.scala:Squad.size");
    expect(r.get("Board.interpolated")).toEqual(expect.arrayContaining(["app/Club.scala:Club.total", "app/Club.scala:Squad.size"]));
  });

  it("link a read off a call's result, through the call's declared return type", async () => {
    const r = await links(feature);
    expect(r.get("Board.onResult")).toContain("app/Club.scala:Club.total");
    expect(r.get("Board.onNested")).toContain("app/Club.scala:Club.total");
  });

  it("leave a namesake result, a val, an untyped receiver and a result that is no getter alone", async () => {
    const r = await links(feature);
    for (const name of ["onBlock", "onForeach", "onInfix", "onUnderscore"]) expect(r.get(`reads:${name}`)?.filter((n) => /map|foreach/.test(n))).toEqual([]);
    expect(r.get("reads:onResult")).toContain("repo.find().total");
    expect(r.get("Board.onNamesake")).toContain("app/Rival.scala:Rival.total");
    expect(r.get("Board.onNamesake")).not.toContain("app/Club.scala:Club.total");
    for (const name of ["onValue", "onPlain", "onUnknown", "onBlock", "onForeach", "onInfix", "onUnderscore"]) expect((r.get(`Board.${name}`) ?? []).filter((t) => t.endsWith(".total"))).toEqual([]);
  });

  it("leave a namesake class, a val, a def with parameters, a binder and a comment alone", async () => {
    const r = await links(feature);
    expect(r.get("Board.viaRival")).toEqual(["app/Rival.scala:Rival.total"]);
    expect(r.get("Board.viaVal")).toBeUndefined();
    expect(r.get("Board.withArgs")).toEqual(["app/Club.scala:Club.rank"]);
    for (const name of ["shadowed", "localVal", "lambda", "commented"]) expect(r.get(`Board.${name}`)).toBeUndefined();
  });
});
