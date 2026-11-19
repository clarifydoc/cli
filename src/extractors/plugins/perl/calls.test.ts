import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { perlSpec } from "./index.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

const FILES: Record<string, string> = {
  "lib/League/Club.pm": `package League::Club;
sub new { my ($class, %a) = @_; return bless {%a}, $class; }
sub sign { my $self = shift; $self->scout(); return 1; }
sub scout { return 1; }
sub release { return 1; }
1;
`,
  "lib/Garage/Club.pm": `package Garage::Club;
sub new { return bless {}, shift; }
sub sign { return 2; }
sub release { return 2; }
1;
`,
  "lib/League/Academy.pm": `package League::Academy;
use parent -norequire, 'League::Club';
sub train { my $self = shift; $self->sign(); __PACKAGE__->helper(); }
sub helper { 1 }
1;
`,
  "main.pl": `use League::Club;
use League::Academy;
my $club = League::Club->new(name => 'x');
$club->sign();
League::Club::release();
my $a = League::Academy->new();
$a->sign();
$other->sign();
`,
};

describe("Perl package-qualified and method calls", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-perl-calls-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const links = () =>
    (summary.symbolLinks ?? []).map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetFile}#${l.targetSymbol}`).sort();

  it("links constructors, typed locals, inherited subs and qualified subs to the right package", () => {
    const all = links();
    expect(all).toContain("<setup> League::Club.new -> lib/League/Club.pm#League::Club.new");
    expect(all).toContain("<setup> club.sign -> lib/League/Club.pm#League::Club.sign");
    expect(all).toContain("<setup> League::Club.release -> lib/League/Club.pm#League::Club.release");
    expect(all).toContain("<setup> a.sign -> lib/League/Club.pm#League::Club.sign");
    expect(all).toContain("League::Academy.train self.sign -> lib/League/Club.pm#League::Club.sign");
    expect(all).toContain("League::Academy.train self.helper -> lib/League/Academy.pm#League::Academy.helper");
  });

  it("never reaches the namesake package, and leaves an untyped receiver alone", () => {
    expect(links().filter((l) => l.includes("Garage"))).toEqual([]);
    expect(links().filter((l) => l.includes("other.sign"))).toEqual([]);
  });
});

describe("Perl parents", () => {
  const extend = (src: string) => perlSpec.extractClasses!(src.split("\n"), [])[0]!;
  it("reads the options and list forms of use parent / use base", () => {
    expect(extend("package A;\nuse parent -norequire, 'League::Club';").extends).toBe("League::Club");
    const multi = extend("package A;\nuse base qw(League::Club League::Fan);");
    expect(multi.extends).toBe("League::Club");
    expect(multi.implements).toEqual(["League::Fan"]);
    expect(extend("package A;\nuse parent -norequire, qw(League::Club);").extends).toBe("League::Club");
  });
});
