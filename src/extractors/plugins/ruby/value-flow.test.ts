/**
 * Ruby value flow: `method(:save)` and the values built from it, through locals, parameters, instance variables,
 * returns and handler hashes to the `.call` that runs them — through the real per-file pipeline and the linker.
 * Every case keeps a same-named decoy.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyzeAll(files: Record<string, string>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "rb-vf-"));
  const out = await mkdtemp(join(tmpdir(), "rb-vf-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "ruby" },
      frameworkIds: [], projectId: "root", outputOpts: { outputDir: out, pretty: false }, verbose: false, projectRoot: root, tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

async function links(files: Record<string, string>): Promise<{ flow: string[]; all: string[] }> {
  const analyses = await analyzeAll(files);
  const found = buildSymbolLinks(analyses);
  const show = (l: (typeof found)[number]): string => `${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`;
  return { flow: found.filter((l) => l.strategy === "value-flow").map(show).sort(), all: found.map((l) => `${show(l)} [${l.strategy}]`).sort() };
}

const rb = (...lines: string[]): string => lines.join("\n") + "\n";
// Decoys: a namesake class with its own `call`, and namesake methods in another file.
const decoy = rb("class Handler", "  def call(x); end", "  def persist; end", "  def save; end", "end");

describe("Ruby value flow: the matrix", () => {
  it("a method value in a local, copied, handed to a wrapper and invoked there", async () => {
    const { flow } = await links({
      "decoy.rb": decoy,
      "club.rb": rb(
        "class Club",
        "  def persist; end",
        "  def boot",
        "    f = method(:persist)",
        "    g = f",
        "    run(g)",
        "  end",
        "  def run(cb)",
        "    cb.call(1)",
        "  end",
        "end",
      ),
    });
    expect(flow).toEqual(["Club.run@9 cb.call -> club.rb::Club.persist"]);
  });

  it("an instance variable holding the value, run in another method", async () => {
    const { flow } = await links({
      "decoy.rb": decoy,
      "club.rb": rb(
        "class Club",
        "  def persist; end",
        "  def setup",
        "    @on_save = method(:persist)",
        "  end",
        "  def fire",
        "    @on_save.call",
        "  end",
        "end",
      ),
    });
    expect(flow).toEqual(["Club.fire@7 on_save.call -> club.rb::Club.persist"]);
  });

  it("a value returned from a factory (explicitly and as the last expression)", async () => {
    const { flow } = await links({
      "decoy.rb": decoy,
      "club.rb": rb(
        "class Club",
        "  def persist; end",
        "  def retire; end",
        "  def make_one",
        "    return method(:persist)",
        "  end",
        "  def make_two",
        "    method(:retire)",
        "  end",
        "  def boot",
        "    a = Club.make_one",
        "    b = Club.make_two",
        "    a.call",
        "    b.call",
        "  end",
        "end",
      ),
    });
    expect(flow).toEqual(["Club.boot@13 a.call -> club.rb::Club.persist", "Club.boot@14 b.call -> club.rb::Club.retire"]);
  });

  it("a hash of handlers read by key, by element and by block variable", async () => {
    const { flow } = await links({
      "decoy.rb": decoy,
      "club.rb": rb(
        "class Club",
        "  def persist; end",
        "  def retire; end",
        "  def boot(k)",
        "    handlers = { save: method(:persist), drop: method(:retire) }",
        "    handlers[:save].call",
        "    handlers[k].call",
        "    handlers.each do |name, h|",
        "      h.call",
        "    end",
        "  end",
        "end",
      ),
    });
    expect(flow).toEqual([
      "Club.boot@6 handlers[:save].call -> club.rb::Club.persist",
      "Club.boot@7 handlers[k].call -> club.rb::Club.persist",
      "Club.boot@7 handlers[k].call -> club.rb::Club.retire",
      "Club.boot@9 h.call -> club.rb::Club.persist",
      "Club.boot@9 h.call -> club.rb::Club.retire",
    ]);
  });

  it("a constant holding handlers, read from a method", async () => {
    const { flow } = await links({
      "decoy.rb": decoy,
      "club.rb": rb(
        "class Club",
        "  def self.persist; end",
        "  HANDLERS = { save: method(:persist) }",
        "  def fire",
        "    HANDLERS[:save].call(1)",
        "  end",
        "end",
      ),
    });
    expect(flow).toEqual(["Club.fire@5 HANDLERS[:save].call -> club.rb::Club.persist"]);
  });
});

describe("Ruby value flow: blocks, objects and decoys", () => {
  it("a block argument (&m) binds no positional formal: `run(&m)` never reaches `cb.call` of `def run(cb, &blk)`", async () => {
    const { flow } = await links({
      "decoy.rb": decoy,
      "club.rb": rb(
        "class Club",
        "  def persist; end",
        "  def run(cb, &blk)",
        "    cb.call(1)",
        "  end",
        "  def boot",
        "    m = method(:persist)",
        "    run(&m)",
        "    run(&method(:persist))",
        "  end",
        "end",
      ),
    });
    expect(flow).toEqual([]);
  });

  it("a block captured with &block is run by block.call, but a value handed as &x is not followed into it", async () => {
    const { flow } = await links({
      "decoy.rb": decoy,
      "club.rb": rb(
        "class Club",
        "  def persist; end",
        "  def each_player(&block)",
        "    block.call(1)",
        "  end",
        "  def boot",
        "    each_player(&method(:persist))",
        "  end",
        "end",
      ),
    });
    expect(flow).toEqual([]);
  });

  it("`.call` on an object of a stated type is its own method, never an invoke", async () => {
    const { flow, all } = await links({
      "decoy.rb": decoy,
      "club.rb": rb(
        "class Club",
        "  def persist; end",
        "  def boot",
        "    h = Handler.new",
        "    h.call(1)",
        "    f = method(:persist)",
        "    f.call",
        "  end",
        "end",
      ),
    });
    expect(flow).toEqual(["Club.boot@7 f.call -> club.rb::Club.persist"]);
    expect(all.some((l) => l.includes("h.call -> decoy.rb::Handler.call"))).toBe(true);
  });

  it("a bare identifier is a call, never a value", async () => {
    const { flow } = await links({
      "decoy.rb": decoy,
      "club.rb": rb(
        "class Club",
        "  def persist; end",
        "  def boot",
        "    f = persist",
        "    f.call",
        "  end",
        "end",
      ),
    });
    expect(flow).toEqual([]);
  });

  it("a value nobody stores links nothing", async () => {
    const { flow } = await links({
      "decoy.rb": decoy,
      "club.rb": rb("class Club", "  def persist; end", "  def boot(cb)", "    cb.call", "  end", "end"),
    });
    expect(flow).toEqual([]);
  });
});
