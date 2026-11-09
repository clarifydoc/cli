import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis, SymbolLink } from "../types/analysis.js";

/**
 * A name guess (one class in the project declares the method, the file is in scope) never overrides what
 * the linker knows of the receiver: on a chain the receiver is the segment before the method, not the
 * first one (`club.league.relegated?` is called on a League, whatever `club` is named), and a receiver
 * typed by the call initializing it (`season_ticket = SeasonTicket.find_by(…)`) or by a chain through
 * declared members refuses another class's member of the name — the decoys `Club.relegated?` and
 * `Contract.player_id` (real-repo FP).
 */
const PROJECTS: Record<string, Record<string, string>> = {
  ruby: {
    "Gemfile": "source 'https://rubygems.org'\ngem 'rails'\n",
    "app/models/application_record.rb": "class ApplicationRecord < ActiveRecord::Base\n  self.abstract_class = true\nend\n",
    "app/models/club.rb": `class Club < ApplicationRecord
  belongs_to :league

  def relegated?
    points < 30
  end
end
`,
    "app/models/league.rb": `class League < ApplicationRecord
  has_many :clubs

  def standings
    clubs.order(:points)
  end
end
`,
    "app/models/season_ticket.rb": `class SeasonTicket < ApplicationRecord
  belongs_to :player

  def renew
    update!(renewed: true)
  end
end
`,
    "app/models/contract.rb": `class Contract
  def initialize(player)
    @player = player
  end

  def player_id
    @player.id
  end
end
`,
    "app/services/table_service.rb": `class TableService
  def check
    @club = Club.find(1)
    @club.league.relegated?
  end

  def own_check
    @club = Club.find(1)
    @club.relegated?
  end
end
`,
    // An overlay module named like the model, mixed in by a namespace list read at load time.
    "app/models/concerns/season_ticket.rb": `module Overlay::Concerns::SeasonTicket
  extend ActiveSupport::Concern

  def seat_label
    "North Stand"
  end
end
`,
    "app/services/ticket_desk.rb": `class TicketDesk
  def renew(fan)
    season_ticket = SeasonTicket.find_by(fan: fan)
    season_ticket.renew
    season_ticket.player_id
    season_ticket.seat_label
  end

  def sign(player)
    Contract.new(player).player_id
  end
end
`,
  },
  typescript: {
    "package.json": JSON.stringify({ name: "league", dependencies: { typescript: "5.0.0" } }),
    "src/club.ts": `import { League } from "./league";
export class Club {
  league: League = new League();
  isRelegated(): boolean { return true; }
}
`,
    "src/league.ts": "export class League {\n  standings(): string[] { return []; }\n}\n",
    "src/season-ticket.ts": `export class SeasonTicket {
  renew(): void {}
}
export class TicketOffice {
  issue(): SeasonTicket { return new SeasonTicket(); }
}
`,
    "src/contract.ts": "export class Contract {\n  playerId(): number { return 7; }\n}\n",
    "src/desk.ts": `import { Club } from "./club";
import { TicketOffice } from "./season-ticket";
import { Contract } from "./contract";

export function check(club: Club) {
  return club.league.isRelegated();
}

export function ownCheck(club: Club) {
  return club.isRelegated();
}

export function renew(office: TicketOffice) {
  const ticket = office.issue();
  ticket.renew();
  return ticket.playerId();
}

export function sign() {
  return new Contract().playerId();
}
`,
  },
  python: {
    "pyproject.toml": '[project]\nname = "league"\n',
    "league/__init__.py": "",
    "league/club.py": `from league.table import League


class Club:
    def __init__(self) -> None:
        self.league: League = League()

    def is_relegated(self) -> bool:
        return True
`,
    "league/table.py": "class League:\n    def standings(self) -> list:\n        return []\n",
    "league/tickets.py": `class SeasonTicket:
    def renew(self) -> None:
        pass


class TicketOffice:
    def issue(self) -> SeasonTicket:
        return SeasonTicket()
`,
    "league/contract.py": "class Contract:\n    def player_id(self) -> int:\n        return 7\n",
    "league/desk.py": `from league.club import Club
from league.tickets import TicketOffice
from league.contract import Contract


def check(club: Club) -> bool:
    return club.league.is_relegated()


def check_untyped(club) -> bool:
    return club.league.is_relegated()


def own_check(club: Club) -> bool:
    return club.is_relegated()


def renew(office: TicketOffice) -> int:
    ticket = office.issue()
    ticket.renew()
    return ticket.player_id()


def sign() -> int:
    return Contract().player_id()
`,
  },
};

const results: Record<string, ProjectAnalysis> = {};
const roots: string[] = [];

beforeAll(async () => {
  for (const [lang, files] of Object.entries(PROJECTS)) {
    const root = await mkdtemp(join(tmpdir(), `typed-receiver-${lang}-`));
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

describe("symbol-linker — name guesses respect the receiver", () => {
  describe("Ruby", () => {
    it("never takes the first segment's name as evidence on a chain", () => {
      expect(linksOf("ruby", "TableService.check", "club.league.relegated?")).toEqual([]);
    });

    it("refuses another class's member on a local typed by its initializer", () => {
      expect(linksOf("ruby", "TicketDesk.renew", "season_ticket.player_id")).toEqual([]);
    });

    it("still links the typed receiver's own members (control)", () => {
      expect(linksOf("ruby", "TicketDesk.renew", "season_ticket.renew")[0]).toMatchObject({ targetSymbol: "SeasonTicket.renew" });
      expect(linksOf("ruby", "TableService.own_check", "club.relegated?")[0]).toMatchObject({ targetSymbol: "Club.relegated?" });
    });

    it("leaves a namesake overlay module's member to the guess — it may be mixed in unseen", () => {
      expect(linksOf("ruby", "TicketDesk.renew", "season_ticket.seat_label")[0]).toMatchObject({ targetSymbol: "Overlay::Concerns::SeasonTicket.seat_label" });
    });
  });

  describe("TypeScript", () => {
    it("refuses a namesake member on a chain the field types (`club.league` is a League)", () => {
      expect(linksOf("typescript", "check", "club.league.isRelegated")).toEqual([]);
      expect(linksOf("typescript", "ownCheck", "club.isRelegated")[0]).toMatchObject({ targetSymbol: "Club.isRelegated" });
    });

    it("refuses another class's member on a local typed by its initializer", () => {
      expect(linksOf("typescript", "renew", "ticket.playerId")).toEqual([]);
      expect(linksOf("typescript", "renew", "ticket.renew")[0]).toMatchObject({ targetSymbol: "SeasonTicket.renew" });
    });
  });

  describe("Python", () => {
    it("never matches a chain's leaf on the class its first segment is named for", () => {
      expect(linksOf("python", "check", "club.league.is_relegated")).toEqual([]);
      expect(linksOf("python", "check_untyped", "club.league.is_relegated")).toEqual([]);
      expect(linksOf("python", "own_check", "club.is_relegated")[0]).toMatchObject({ targetSymbol: "Club.is_relegated" });
    });

    it("refuses another class's member on a local typed by its initializer", () => {
      expect(linksOf("python", "renew", "ticket.player_id")).toEqual([]);
      expect(linksOf("python", "renew", "ticket.renew")[0]).toMatchObject({ targetSymbol: "SeasonTicket.renew" });
    });
  });
});
