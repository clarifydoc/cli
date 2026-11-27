import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { impactOfContents } from "./impact-proposed.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A class named by its path (a compact Ruby `Transfers::PlayerService`, a nested Ruby class, a Perl package, a
 * C++ `Left::Builder`) is spelled by its owner path in the links (`Transfers.PlayerService.perform`): the impact of
 * an edit to its method names the same symbol, so the caller and the route are found. A top-level class of the same
 * leaf name is a decoy no edit reaches.
 */
const RUBY_COMPACT = `class Transfers::PlayerService
  def perform(fee)
    fee
  end
end
`;
const RUBY_NESTED = `module Loans
  class PlayerService
    def perform(fee)
      fee
    end
  end
end
`;
const PERL = `package League::Table;
sub new { my ($c) = @_; return bless {}, $c; }
sub perform {
    my ($self, $fee) = @_;
    return $fee;
}
1;
`;
const CPP_HEADER = `struct Left {
  struct Builder {
    int build(int fee);
  };
};
struct Right {
  struct Builder {
    int build(int fee);
  };
};
`;
const CPP_SOURCE = `#include "builders.h"
int Left::Builder::build(int fee) {
  return fee;
}
int Right::Builder::build(int fee) {
  return fee + 1;
}
`;

const FILES: Record<string, string> = {
  "Gemfile": "source 'https://rubygems.org'\ngem 'rails'\n",
  "config/routes.rb": "Rails.application.routes.draw do\n  resources :clubs, only: [:create]\n  resources :loans, only: [:create]\nend\n",
  "app/controllers/clubs_controller.rb": "class ClubsController < ApplicationController\n  def create\n    Transfers::PlayerService.new.perform(10)\n  end\nend\n",
  "app/controllers/loans_controller.rb": "class LoansController < ApplicationController\n  def create\n    Loans::PlayerService.new.perform(10)\n  end\nend\n",
  "app/services/transfers/player_service.rb": RUBY_COMPACT,
  "app/services/loans/player_service.rb": RUBY_NESTED,
  // The decoy: a top-level class of the leaf name, called from elsewhere.
  "app/services/player_service.rb": "class PlayerService\n  def perform(fee)\n    fee\n  end\nend\n",
  "app/controllers/decoy_controller.rb": "class DecoyController < ApplicationController\n  def index\n    PlayerService.new.perform(1)\n  end\nend\n",
  "lib/League/Table.pm": PERL,
  "lib/Table.pm": "package Table;\nsub new { return bless {}, shift; }\nsub perform { return 0; }\n1;\n",
  "main.pl": "use League::Table;\nuse Table;\nsub run_league {\n    my $t = League::Table->new;\n    return $t->perform(3);\n}\nsub run_decoy {\n    my $t = Table->new;\n    return $t->perform(3);\n}\n",
  "cpp/builders.h": CPP_HEADER,
  "cpp/builders.cpp": CPP_SOURCE,
  "cpp/main.cpp": '#include "builders.h"\nint run_left() {\n  Left::Builder b;\n  return b.build(2);\n}\n',
};

describe("impact names a path-named class's method as the links do", () => {
  let dir: string;
  let root: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-impact-paths-"));
    root = join(dir, "app");
    for (const [f, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, f)), { recursive: true });
      await writeFile(join(root, f), text);
    }
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const run = (file: string, content: string) => impactOfContents(summary, join(dir, "out"), root, new Map([[file, content]]));
  const callers = (r: Awaited<ReturnType<typeof run>>) => r.symbolImpact?.direct.map((c) => c.symbol) ?? [];

  it("a compact Ruby class: the caller and its route", async () => {
    const r = await run("app/services/transfers/player_service.rb", RUBY_COMPACT.replace("perform(fee)", "perform(fee, club)"));
    expect(callers(r)).toEqual(["ClubsController.create"]);
    expect(JSON.stringify(r.symbolImpact?.routes ?? r)).toContain("/clubs");
  });

  it("a nested Ruby class: the caller and its route, never the top-level namesake's", async () => {
    const r = await run("app/services/loans/player_service.rb", RUBY_NESTED.replace("perform(fee)", "perform(fee, club)"));
    expect(callers(r)).toEqual(["LoansController.create"]);
    expect(JSON.stringify(r.symbolImpact?.routes ?? r)).toContain("/loans");
  });

  it("a top-level Ruby namesake reaches only its own caller", async () => {
    const r = await run("app/services/player_service.rb", "class PlayerService\n  def perform(fee, club)\n    fee\n  end\nend\n");
    expect(callers(r)).not.toContain("ClubsController.create");
    expect(callers(r)).not.toContain("LoansController.create");
  });

  it("a Perl package: the caller, not the namesake package's", async () => {
    const r = await run("lib/League/Table.pm", PERL.replace("my ($self, $fee)", "my ($self, $fee, $club)"));
    expect(callers(r)).toEqual(["run_league"]);
  });

  it("a C++ nested class's member: the caller of that class, not the other Builder's", async () => {
    const r = await run("cpp/builders.cpp", CPP_SOURCE.replace("return fee;", "return fee * 2;"));
    expect(callers(r)).toEqual(["run_left"]);
  });
});
