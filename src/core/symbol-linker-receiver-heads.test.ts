import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis, SymbolLink } from "../types/analysis.js";

/**
 * The name guesses' receiver veto reads a head the caller's class holds as a typed field, and one the module
 * binds with a stated or constructed type, as it reads a local: `club.league.isRelegated()` through a `Club`
 * field is called on a League, never `Club.isRelegated`, and `ticket.playerId()` on a module's SeasonTicket is
 * never `Contract.playerId`. Where a call's name keeps only the receiver's last names (`items[0].league.markTable(`
 * read as `league.markTable`), the module's `league` is not the receiver: the guess stays.
 */
const PROJECTS: Record<string, Record<string, string>> = {
  typescript: {
    "package.json": JSON.stringify({ name: "league", dependencies: { typescript: "5.0.0" } }),
    "src/league.ts": "export class League {\n  standings(): string[] { return []; }\n}\n",
    "src/club.ts": `import { League } from "./league";
export class Club {
  league: League = new League();
  isRelegated(): boolean { return true; }
}
`,
    "src/tickets.ts": "export class SeasonTicket {\n  renew(): void {}\n}\n",
    "src/contract.ts": "export class Contract {\n  playerId(): number { return 7; }\n}\n",
    "src/desk.ts": `import { Club } from "./club";
import { SeasonTicket } from "./tickets";
import { Contract } from "./contract";

function issue(): SeasonTicket { return new SeasonTicket(); }
function sign(): Club { return new Club(); }
const ticket: SeasonTicket = issue();
const club = sign();

export function renew() {
  ticket.renew();
  return ticket.playerId();
}

export function check() {
  return club.league.isRelegated();
}

export function signNew() {
  return new Contract().playerId();
}
`,
  },
  ruby: {
    "Gemfile": "source 'https://rubygems.org'\ngem 'rails'\n",
    "app/models/club.rb": `class Club
  attr_reader :league

  def initialize
    @league = League.new
  end

  def relegated?
    true
  end
end
`,
    "app/models/league.rb": "class League\n  def standings\n    []\n  end\nend\n",
    "app/services/table_service.rb": `class TableService
  def initialize
    @club = Club.new
  end

  def check
    @club.league.relegated?
  end

  def table
    @club.league.standings()
  end
end
`,
  },
  dart: {
    "pubspec.yaml": "name: league_app\n",
    "lib/league.dart": `class League {
  List<String> standings() => [];
}

extension LeagueBadge on League {
  String badge() => 'top flight';
}
`,
    "lib/club.dart": `import 'league.dart';

class Club {
  final League league = League();
  bool isRelegated() => true;
}
`,
    "lib/tickets.dart": "class SeasonTicket {\n  void renew() {}\n}\n",
    "lib/contract.dart": "class Contract {\n  int playerId() => 7;\n}\n",
    "lib/fixture.dart": `class Season {
  void markTable() {}
}

class Fixture {
  final Season league = Season();
}
`,
    "lib/desk.dart": `import 'club.dart';
import 'league.dart';
import 'tickets.dart';
import 'contract.dart';
import 'fixture.dart';

final SeasonTicket topTicket = SeasonTicket();
final builtTicket = SeasonTicket();
final League league = League();

class Desk {
  final Club club;
  Desk(this.club);

  bool check() {
    return club.league.isRelegated();
  }

  String badge() => club.league.badge();

  int renewTop() {
    topTicket.renew();
    builtTicket.playerId();
    return topTicket.playerId();
  }

  int sign() => Contract().playerId();
}

void markFirst(List<Fixture> items) {
  items[0].league.markTable();
}
`,
  },
  kotlin: {
    "build.gradle.kts": 'plugins { kotlin("jvm") version "1.9.0" }\n',
    "src/main/kotlin/league/League.kt": "package league\n\nclass League {\n  fun standings(): List<String> = listOf()\n}\n",
    "src/main/kotlin/league/Club.kt": "package league\n\nclass Club {\n  val league: League = League()\n  fun isRelegated(): Boolean = true\n}\n",
    "src/main/kotlin/league/Desk.kt": `package league

class Desk(private val club: Club) {
  fun check(): Boolean = club.league.isRelegated()
  fun table(): List<String> = club.league.standings()
}
`,
  },
};

const results: Record<string, ProjectAnalysis> = {};
const roots: string[] = [];

beforeAll(async () => {
  for (const [lang, files] of Object.entries(PROJECTS)) {
    const root = await mkdtemp(join(tmpdir(), `receiver-heads-${lang}-`));
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
  (results[lang]!.symbolLinks ?? []).filter((l) => l.sourceSymbol === sourceSymbol && l.callName === callName);

describe("symbol-linker — the receiver veto reads field and module-binding heads", () => {
  describe("TypeScript", () => {
    it("refuses another class's member on a module binding typed as written or by its initializer", () => {
      expect(linksOf("typescript", "renew", "ticket.playerId")).toEqual([]);
      expect(linksOf("typescript", "check", "club.league.isRelegated")).toEqual([]);
      expect(linksOf("typescript", "renew", "ticket.renew")[0]).toMatchObject({ targetSymbol: "SeasonTicket.renew" });
    });
  });

  describe("Ruby", () => {
    it("refuses another class's member on a chain from a field the constructor types", () => {
      expect(linksOf("ruby", "TableService.check", "club.league.relegated?")).toEqual([]);
      expect(linksOf("ruby", "TableService.table", "club.league.standings")[0]).toMatchObject({ targetSymbol: "League.standings" });
    });
  });

  describe("Dart", () => {
    it("refuses another class's member on a chain from a typed field", () => {
      expect(linksOf("dart", "Desk.check", "club.league.isRelegated")).toEqual([]);
    });

    it("refuses another class's member on a top-level variable, declared or constructed", () => {
      expect(linksOf("dart", "Desk.renewTop", "topTicket.playerId")).toEqual([]);
      expect(linksOf("dart", "Desk.renewTop", "builtTicket.playerId")).toEqual([]);
      expect(linksOf("dart", "Desk.renewTop", "topTicket.renew")[0]).toMatchObject({ targetSymbol: "SeasonTicket.renew" });
    });

    it("keeps an extension member of the field-typed receiver", () => {
      expect(linksOf("dart", "Desk.badge", "club.league.badge")[0]).toMatchObject({ targetSymbol: "LeagueBadge.badge" });
    });

    it("leaves a name that keeps only the receiver's last names to the guess — the module's `league` is not its head", () => {
      expect(linksOf("dart", "markFirst", "league.markTable")[0]).toMatchObject({ targetSymbol: "Season.markTable" });
    });
  });

  describe("Kotlin", () => {
    it("refuses another class's member on a chain from a constructor property", () => {
      expect(linksOf("kotlin", "Desk.check", "club.league.isRelegated")).toEqual([]);
      expect(linksOf("kotlin", "Desk.table", "club.league.standings")[0]).toMatchObject({ targetSymbol: "League.standings" });
    });
  });
});
