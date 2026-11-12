import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis, SymbolLink } from "../types/analysis.js";

/**
 * A call whose name keeps only the receiver's last names (`items[0].league.markTable(` read as `league.markTable`)
 * has no head the caller binds: its own `league` field is not the receiver, so it neither types the call nor
 * contradicts a name guess (real-repo FP, renamed). And a module-level binding a Python function reads without
 * rebinding it — a typed `ticket: SeasonTicket = …` — types the receiver for the call and for the veto.
 */
const PROJECTS: Record<string, Record<string, string>> = {
  typescript: {
    "package.json": JSON.stringify({ name: "league", dependencies: { typescript: "5.0.0" } }),
    "src/tickets.ts": "export class SeasonTicket {\n  renew(): void {}\n}\n",
    "src/fixture.ts": "export class Fixture {\n  renew(): void {}\n  settle(): void {}\n}\n",
    "src/desk.ts": `import { SeasonTicket } from "./tickets";
import { Fixture } from "./fixture";

let ticket: SeasonTicket;

export function setUp(given: SeasonTicket) {
  ticket = given;
}

export function renew() {
  ticket.renew();
  ticket.settle();
}

export const fixture = Fixture;
`,
  },
  kotlin: {
    "build.gradle.kts": 'plugins { kotlin("jvm") version "1.9.0" }\n',
    "src/main/kotlin/league/SeasonTicket.kt": "package league\n\nclass SeasonTicket {\n  fun renew() {}\n}\n",
    "src/main/kotlin/league/Fixture.kt": "package league\n\nclass Fixture {\n  fun renew() {}\n  fun settle() {}\n}\n",
    "src/main/kotlin/league/Desk.kt": `package league

val ticket: SeasonTicket = SeasonTicket()
val built = SeasonTicket()
private val spare: SeasonTicket? = null

fun renewAll() {
  ticket.renew()
  ticket.settle()
}

fun renewBuilt() {
  built.renew()
  built.settle()
}

fun renewSpare() {
  spare?.renew()
  spare?.settle()
}
`,
  },
  dart: {
    "pubspec.yaml": "name: league_app\n",
    "lib/club.dart": "class Club {\n  void markTable() {}\n}\n",
    "lib/season.dart": "class Season {\n  void markTable() {}\n  void settle() {}\n}\n",
    "lib/fixture.dart": "import 'season.dart';\n\nclass Fixture {\n  Season league = Season();\n}\n",
    "lib/desk.dart": `import 'club.dart';
import 'season.dart';
import 'fixture.dart';

class Desk {
  Club league = Club();

  void tidy(List<Fixture> items) {
    items[0].league.markTable();
  }

  void close(List<Fixture> items) {
    items[0].league.settle();
  }

  void own() {
    league.markTable();
  }
}
`,
  },
  python: {
    "pyproject.toml": "[project]\nname = \"league\"\n",
    "models.py": "class SeasonTicket:\n    def renew(self):\n        return 1\n",
    "fixture.py": "class Fixture:\n    def renew(self):\n        return 3\n\n    def settle(self):\n        return 4\n",
    "service.py": `from models import SeasonTicket
from fixture import Fixture

ticket: SeasonTicket = SeasonTicket()


def renew_all():
    ticket.renew()
    ticket.settle()


def renew_rebound(make):
    ticket = make()
    ticket.renew()


def renew_each(tickets):
    for ticket in tickets:
        ticket.renew()


def renew_given(ticket):
    ticket.renew()


def renew_global():
    global ticket
    ticket = Fixture()
    ticket.renew()


def renew_caught(make):
    try:
        make()
    except ValueError as ticket:
        ticket.renew()


def renew_opened(make):
    with make() as ticket:
        ticket.renew()


def renew_nested(make):
    ticket = make()

    def inner():
        ticket.renew()

    return inner


class Desk:
    def run(self):
        ticket.renew()
`,
  },
};

const results: Record<string, ProjectAnalysis> = {};
const roots: string[] = [];

beforeAll(async () => {
  for (const [lang, files] of Object.entries(PROJECTS)) {
    const root = await mkdtemp(join(tmpdir(), `receiver-cut-${lang}-`));
    roots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), content);
    }
    const out = join(root, ".out");
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false });
    results[lang] = await loadReportSummary(out);
  }
}, 120_000);

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const linksOf = (lang: string, sourceSymbol: string, callName: string): SymbolLink[] =>
  (results[lang]!.symbolLinks ?? []).filter((l) => l.sourceSymbol === sourceSymbol && l.callName === callName && l.relation === "calls");

describe("symbol-linker — a cut receiver name is typed by no binding of the caller", () => {
  describe("TypeScript", () => {
    it("types a call on a module's `let` declared with a type and no initializer, and refuses another class's member", () => {
      expect(linksOf("typescript", "renew", "ticket.renew")[0]).toMatchObject({ targetSymbol: "SeasonTicket.renew" });
      expect(linksOf("typescript", "renew", "ticket.settle")).toEqual([]);
    });
  });

  describe("Kotlin", () => {
    it("types a call on a top-level `val`, declared or constructed, and refuses another class's member", () => {
      expect(linksOf("kotlin", "renewAll", "ticket.renew")[0]).toMatchObject({ targetSymbol: "SeasonTicket.renew" });
      expect(linksOf("kotlin", "renewAll", "ticket.settle")).toEqual([]);
      expect(linksOf("kotlin", "renewBuilt", "built.renew")[0]).toMatchObject({ targetSymbol: "SeasonTicket.renew" });
      expect(linksOf("kotlin", "renewBuilt", "built.settle")).toEqual([]);
      expect(linksOf("kotlin", "renewSpare", "spare?.renew")[0]).toMatchObject({ targetSymbol: "SeasonTicket.renew" });
    });
  });

  describe("Dart", () => {
    it("never types `items[0].league.markTable` by the caller's own `league` field", () => {
      expect(linksOf("dart", "Desk.tidy", "league.markTable")).toEqual([]);
    });

    it("does not let the caller's `league` field contradict the one definition of the name", () => {
      expect(linksOf("dart", "Desk.close", "league.settle")[0]).toMatchObject({ targetSymbol: "Season.settle" });
    });

    it("still types a call on the field itself", () => {
      expect(linksOf("dart", "Desk.own", "league.markTable")[0]).toMatchObject({ targetSymbol: "Club.markTable" });
    });
  });

  describe("Python", () => {
    it("types a call on a module's typed binding, past a namesake method", () => {
      expect(linksOf("python", "renew_all", "ticket.renew")[0]).toMatchObject({ targetSymbol: "SeasonTicket.renew" });
      expect(linksOf("python", "Desk.run", "ticket.renew")[0]).toMatchObject({ targetSymbol: "SeasonTicket.renew" });
    });

    it("refuses another class's member on a module's typed binding", () => {
      expect(linksOf("python", "renew_all", "ticket.settle")).toEqual([]);
    });

    it("leaves a function that rebinds the name alone — by assignment, loop, parameter, global or an enclosing function", () => {
      for (const fn of ["renew_rebound", "renew_each", "renew_given", "renew_global", "renew_caught", "renew_opened", "renew_nested.inner", "inner"]) {
        expect(linksOf("python", fn, "ticket.renew").filter((l) => l.targetSymbol === "SeasonTicket.renew")).toEqual([]);
      }
    });
  });
});
