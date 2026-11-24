import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import "./meta.js";

/**
 * `club.name = x`, `club + other`, `club == other` and `club[1]` run methods the body never names. Each links to the
 * member the receiver's class declares — and only that: a namesake class reached through an untyped receiver, a class
 * with no such operator, and plain arithmetic, strings and hashes draw no edge.
 */
const FILES: Record<string, string> = {
  "app/club.rb": `class Club
  attr_accessor :nickname
  attr_writer :motto

  def name=(value)
    @name = value
  end

  def +(other)
    Club.new
  end

  def ==(other)
    true
  end

  def [](key)
    key
  end

  def []=(key, value)
    value
  end

  def <=>(other)
    0
  end

  def reset(other)
    self.name = "z"
    self == other
    self[1]
  end
end

class League < Club
end

class Plain
  def total
    3
  end
end
`,
  "app/rival.rb": `class Rival
  def name=(value)
    @name = value
  end

  def +(other)
    self
  end

  def [](key)
    key
  end
end
`,
  "app/board.rb": `class Board
  def rename
    club = Club.new
    club.name = "x"
  end

  def nickname
    club = Club.new
    club.nickname = "x"
    club.motto = "m"
  end

  def combine
    club = Club.new
    other = Club.new
    club + other
  end

  def same
    club = Club.new
    club == Club.new
    club != Club.new
  end

  def indexed
    club = Club.new
    club[1]
    club[1] = 2
  end

  def sorted
    club = Club.new
    club <=> Club.new
  end

  def inherited
    league = League.new
    league.name = "l"
    league + league
  end

  def untyped(thing)
    thing.name = "x"
    thing + thing
    thing[1]
  end

  def noOperator
    plain = Plain.new
    plain + plain
    plain.total = 1
  end

  def plainValues(params)
    total = 0
    total = total + 1
    label = "a"
    label << "b"
    rows = []
    rows[0] = total
    params[:id] = 3
  end
end
`,
};

const root = mkdtemp(join(tmpdir(), "cd-ruby-syntax-"));
afterAll(async () => rm(await root, { recursive: true, force: true }));

async function links(): Promise<Map<string, string[]>> {
  const dir = await mkdtemp(join(await root, "run-"));
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  const summary = await loadReportSummary(join(dir, "out"));
  const byCaller = new Map<string, string[]>();
  for (const l of summary.symbolLinks ?? []) {
    if (l.sourceFile !== "app/board.rb" && l.sourceFile !== "app/club.rb") continue;
    const list = byCaller.get(l.sourceSymbol) ?? [];
    list.push(`${l.targetFile}:${l.targetSymbol}`);
    byCaller.set(l.sourceSymbol, list);
  }
  return byCaller;
}

describe("Ruby calls the syntax hides", () => {
  it("links an attribute assignment to the setter, a def or an attr_writer's", async () => {
    const r = await links();
    expect(r.get("Board.rename")).toContain("app/club.rb:Club.name=");
    expect(r.get("Board.nickname")).toEqual(expect.arrayContaining(["app/club.rb:Club.nickname=", "app/club.rb:Club.motto="]));
  });

  it("links an operator, an index and a comparison to the class's own method", async () => {
    const r = await links();
    expect(r.get("Board.combine")).toContain("app/club.rb:Club.+");
    expect(r.get("Board.same")).toContain("app/club.rb:Club.==");
    expect(r.get("Board.indexed")).toEqual(expect.arrayContaining(["app/club.rb:Club.[]", "app/club.rb:Club.[]="]));
    expect(r.get("Board.sorted")).toContain("app/club.rb:Club.<=>");
    expect(r.get("Board.inherited")).toEqual(expect.arrayContaining(["app/club.rb:Club.name=", "app/club.rb:Club.+"]));
  });

  it("links a write or an operator on self to the enclosing class", async () => {
    const r = await links();
    expect(r.get("Club.reset")).toEqual(expect.arrayContaining(["app/club.rb:Club.name=", "app/club.rb:Club.==", "app/club.rb:Club.[]"]));
  });

  it("leaves an untyped receiver, a class with no such member and plain values alone", async () => {
    const r = await links();
    const toRival = (name: string) => (r.get(`Board.${name}`) ?? []).filter((t) => t.startsWith("app/rival.rb"));
    expect(toRival("untyped")).toEqual([]);
    expect(r.get("Board.untyped")).toBeUndefined();
    expect(r.get("Board.noOperator")?.filter((t) => /[+=\[]/.test(t.split(":")[1]!.split(".")[1]!)) ?? []).toEqual([]);
    expect(r.get("Board.plainValues")).toBeUndefined();
  });
});
