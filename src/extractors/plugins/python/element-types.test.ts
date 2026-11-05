import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { collectionElement } from "./di.js";

describe("collectionElement (Python annotations)", () => {
  it("reads the element of a list, iterable, set, tuple or mapping annotation", () => {
    expect(collectionElement("list[Club]")).toEqual({ element: "Club", map: false });
    expect(collectionElement("typing.List[Club]")).toEqual({ element: "Club", map: false });
    expect(collectionElement("Iterable['Club']")).toEqual({ element: "Club", map: false });
    expect(collectionElement("Optional[Sequence[Club]]")).toEqual({ element: "Club", map: false });
    expect(collectionElement("set[Club] | None")).toEqual({ element: "Club", map: false });
    expect(collectionElement("tuple[Club, ...]")).toEqual({ element: "Club", map: false });
    expect(collectionElement("dict[str, Club]")).toEqual({ element: "Club", map: true });
    expect(collectionElement("list[str]")).toBeNull();
    expect(collectionElement("list[Any]")).toBeNull();
    expect(collectionElement("tuple[Club, Decoy]")).toBeNull();
    expect(collectionElement("Club")).toBeNull();
  });
});

describe("Python loop targets and comprehension variables take the collection's element type", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    "pyproject.toml": '[project]\nname = "league"\n',
    "league/club.py": `class Club:
    def save(self) -> None: ...
    def rank(self) -> int: ...


class Decoy:
    def save(self) -> None: ...
`,
    "league/service.py": `from typing import Iterable, Optional
from league.club import Club, Decoy


def persist(clubs: list[Club], more: Iterable[Club], by_id: dict[str, Club]):
    for c in clubs:
        c.save()
    for m in more:
        m.rank()


def counted(clubs: list[Club], by_id: dict[str, Club]):
    for i, e in enumerate(clubs):
        e.save()
    for v in by_id.values():
        v.rank()
    for k, w in by_id.items():
        w.save()
    for r in reversed(clubs):
        r.rank()


def local():
    pool: list[Club] = []
    for p in pool:
        p.save()


def comprehensions(clubs: list[Club]):
    names = [c.rank() for c in clubs]
    ok = any(k.save() for k in clubs)
    return names, ok


def mixed(a: list[Club], b: list[Decoy]):
    for z in a:
        z.save()
    for z in b:
        z.save()


def keys(by_id: dict[str, Club]):
    for key in by_id:
        key.save()


def plain(names: list[str]):
    for n in names:
        n.save()
`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-py-elements-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const target = (from: string, callName: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetSymbol}:${l.strategy}`);

  it("types the target of a for loop over a list or an iterable", () => {
    expect(target("persist", "c.save")).toEqual(["Club.save:injection"]);
    expect(target("persist", "m.rank")).toEqual(["Club.rank:injection"]);
  });

  it("types the element through enumerate, reversed, values() and items()", () => {
    expect(target("counted", "e.save")).toEqual(["Club.save:injection"]);
    expect(target("counted", "v.rank")).toEqual(["Club.rank:injection"]);
    expect(target("counted", "w.save")).toEqual(["Club.save:injection"]);
    expect(target("counted", "r.rank")).toEqual(["Club.rank:injection"]);
  });

  it("types a loop over an annotated local and the variables of a comprehension", () => {
    expect(target("local", "p.save")).toEqual(["Club.save:injection"]);
    expect(target("comprehensions", "c.rank")).toEqual(["Club.rank:injection"]);
    expect(target("comprehensions", "k.save")).toEqual(["Club.save:injection"]);
  });

  it("types nothing for a name bound to two element types, a dict's keys, or a list of builtins", () => {
    expect(target("mixed", "z.save")).toEqual([]);
    expect(target("keys", "key.save")).toEqual([]);
    expect(target("plain", "n.save")).toEqual([]);
  });
});
