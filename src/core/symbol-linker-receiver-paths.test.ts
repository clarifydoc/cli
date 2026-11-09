import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A call through a path (`club.league.relegate(…)`, `PlayerService.instance.addPlayer(…)`) is named by every name
 * back to its head, so the linker types the receiver from the head. Named by its last two (`league.relegate`,
 * `instance.addPlayer`), the receiver was typed by whatever the caller itself holds under that name: here its own
 * `league` (a Cup) and `instance` (a Squad), the decoys.
 */
const PROJECTS: Record<string, Record<string, string>> = {
  ruby: {
    "Gemfile": "source 'https://rubygems.org'\ngem 'rails'\n",
    "app/models/application_record.rb": "class ApplicationRecord < ActiveRecord::Base\n  self.abstract_class = true\nend\n",
    "app/models/club.rb": "class Club < ApplicationRecord\n  belongs_to :league\n\n  def relegate(season)\n    season\n  end\nend\n",
    "app/models/league.rb": "class League < ApplicationRecord\n  def relegate(club)\n    club\n  end\n\n  def promote(places)\n    places\n  end\n\n  def relegated?\n    false\n  end\nend\n",
    "app/services/cup.rb": "class Cup\n  def relegate(club)\n    club\n  end\n\n  def promote(places)\n    places\n  end\n\n  def relegated?\n    true\n  end\nend\n",
    // Paren-less calls through a path: a predicate, and a command call with an argument. Typed by the head's
    // declared type; off an untyped head, the namesakes in Cup leave nothing to guess.
    "app/services/season.rb": `class Season
  # @param club [Club]
  def close(club)
    club.league.promote 1
    return if club.league.relegated?
    club.league.name
  end

  def close_untyped(club)
    club.league.promote 1
    club.league.relegated?
  end
end
`,
    "app/services/counter.rb": `class Counter
  def self.empty_counts
    { all: 0 }
  end

  def totals
    self.class.empty_counts.except(:all)
  end
end
`,
    "app/services/scout_client.rb": `class ScoutClient
  include HTTParty

  def get(path)
    self.class.get(path)
  end
end
`,
    "app/services/transfer.rb": `class Transfer
  def initialize
    @league = Cup.new
  end

  def run(id)
    club = Club.find(id)
    club.league.relegate(club)
  end
end
`,
  },
  dart: {
    "pubspec.yaml": "name: league\n",
    "lib/league.dart": `class League {
  void relegate(Club club) {}
}

class Club {
  League league = League();
  void relegate(int season) {}
}

class PlayerService {
  static final PlayerService instance = PlayerService();
  void addPlayer(String name) {}
}

class Squad {
  void addPlayer(String name) {}
}

extension Bench on PlayerService {
  void rest(String name) {}
}
`,
    "lib/transfer.dart": `import 'league.dart';

class Cup {
  void relegate(Club club) {}
}

class Transfer {
  Cup league = Cup();
  Squad instance = Squad();

  void run(Club club) {
    club.league.relegate(club);
  }

  void sign() {
    PlayerService.instance.addPlayer('Striker');
  }

  void rotate() {
    PlayerService.instance.rest('Keeper');
  }
}
`,
  },
  swift: {
    "Package.swift": '// swift-tools-version:5.5\nimport PackageDescription\nlet package = Package(name: "App", targets: [.target(name: "App")])\n',
    "Sources/App/League.swift": `class League {
    func relegate(club: Club) {}
}

class Club {
    var league: League = League()
    func relegate(season: Int) {}
}

class PlayerService {
    static let instance = PlayerService()
    func addPlayer(name: String) {}
}

class Squad {
    func addPlayer(name: String) {}
}
`,
    "Sources/App/Transfer.swift": `class Cup {
    func relegate(club: Club) {}
}

class Transfer {
    var league: Cup = Cup()
    var instance: Squad = Squad()

    func run(club: Club) {
        club.league.relegate(club: club)
    }

    func sign() {
        PlayerService.instance.addPlayer(name: "Striker")
    }
}
`,
  },
  scala: {
    "build.sbt": 'name := "league"\n',
    "src/main/scala/league/League.scala": `package league

class League {
  def relegate(club: Club): Unit = ()
}

class Club {
  val league: League = new League()
  def relegate(season: Int): Unit = ()
}

object PlayerService {
  val instance: PlayerRegistry = new PlayerRegistry()
}

class PlayerRegistry {
  def addPlayer(name: String): Unit = ()
}

class Squad {
  def addPlayer(name: String): Unit = ()
}
`,
    "src/main/scala/league/Transfer.scala": `package league

class Cup {
  def relegate(club: Club): Unit = ()
}

class Transfer {
  val league: Cup = new Cup()
  val instance: Squad = new Squad()

  def run(club: Club): Unit = {
    club.league.relegate(club)
  }

  def sign(): Unit = {
    PlayerService.instance.addPlayer("Striker")
  }
}
`,
  },
};

const results: Record<string, ProjectAnalysis> = {};
const roots: string[] = [];

beforeAll(async () => {
  for (const [lang, files] of Object.entries(PROJECTS)) {
    const root = await mkdtemp(join(tmpdir(), `receiver-paths-${lang}-`));
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

const targetsOf = (lang: string, sourceSymbol: string): string[] =>
  (results[lang]!.symbolLinks ?? []).filter((l) => l.sourceSymbol === sourceSymbol && l.relation === "calls").map((l) => l.targetSymbol).sort();

describe("symbol-linker — a call through a path is typed from its head", () => {
  it("Ruby: `club.league.relegate(…)` is the League's, never the caller's own `@league`", () => {
    const run = targetsOf("ruby", "Transfer.run");
    expect(run).toContain("League.relegate");
    expect(run).not.toContain("Cup.relegate");
  });

  it("Ruby: a paren-less call through a path (`club.league.promote 1`, `club.league.relegated?`) is the League's", () => {
    expect(targetsOf("ruby", "Season.close")).toEqual(["League.promote", "League.relegated?"]);
    // Off a head the method does not type, the namesakes leave the linker nothing to choose.
    expect(targetsOf("ruby", "Season.close_untyped")).toEqual([]);
  });

  it("Ruby: `self.class.empty_counts.except(…)` calls the class method of the class it is written in", () => {
    expect(targetsOf("ruby", "Counter.totals")).toContain("Counter.empty_counts");
    // A class method the class does not declare (HTTParty's `get`) is never its instance method of the name.
    expect(targetsOf("ruby", "ScoutClient.get")).not.toContain("ScoutClient.get");
  });

  it("Dart: an extension member on a static member's type stays reachable (the class names no receiver of it)", () => {
    expect(targetsOf("dart", "Transfer.rotate")).toEqual(["Bench.rest"]);
  });

  for (const lang of ["dart", "swift", "scala"]) {
    it(`${lang}: \`club.league.relegate(…)\` is the League's, never the caller's own \`league\``, () => {
      const run = targetsOf(lang, "Transfer.run");
      expect(run).toContain("League.relegate");
      expect(run).not.toContain("Cup.relegate");
    });

    it(`${lang}: \`PlayerService.instance.addPlayer(…)\` is typed by the static member, never the caller's own \`instance\``, () => {
      const sign = targetsOf(lang, "Transfer.sign");
      expect(sign).toContain(lang === "scala" ? "PlayerRegistry.addPlayer" : "PlayerService.addPlayer");
      expect(sign).not.toContain("Squad.addPlayer");
    });
  }
});
