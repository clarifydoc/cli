import { describe, it, expect } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { pascalDirectivePreprocess } from "./directives.js";

const UNIT = `unit League;
interface
const
  Division = {$IFDEF PREMIER}1 {$ELSE}2 {$ENDIF};
function Points(const Wins: Integer): Integer; {$IFDEF SUPPORTS_INLINE}inline; {$ENDIF SUPPORTS_INLINE}
implementation
function Points(const Wins: Integer): Integer; {$IFDEF SUPPORTS_INLINE}inline; {$ENDIF}
begin
  Result := Wins * 3;
end;
function GoalDifference(Scored, Conceded: Integer): Integer;
begin
  {$IFDEF DEBUG}
  Result := 0;
  {$ELSE}
  Result := Scored - Conceded;
  {$ENDIF}
end;
end.`;

const errors = async (src: string) => {
  const tree = await parseSource(src, "pascal" as never, "league.pas");
  let n = 0;
  const walk = (node: { type: string; isMissing: boolean; children: unknown[] }) => {
    if (node.type === "ERROR" || node.isMissing) n++;
    for (const c of node.children) walk(c as never);
  };
  walk(tree.rootNode as never);
  return { n, procs: tree.rootNode.descendantsOfType("defProc").length };
};

describe("Pascal conditional directives the grammar cannot place (real-repo FP shape)", () => {
  it("keeps a guarded routine directive and a one-line group's first branch, line for line", async () => {
    const out = pascalDirectivePreprocess(UNIT, "src/league.pas")!.sourceText;
    expect(out.split("\n").length).toBe(UNIT.split("\n").length);
    expect(out.split("\n").map((l) => l.length)).toEqual(UNIT.split("\n").map((l) => l.length));
    expect(out.split("\n")[3]!.trim().replace(/\s+/g, " ")).toBe("Division = 1 ;");
    expect(out.split("\n")[6]).toContain("Integer; ");
    expect(out.split("\n")[6]).toContain("inline;");
    expect(out.split("\n")[6]).not.toContain("{$");
    // A multi-line group with an {$ELSE}: its first branch kept, the other blanked.
    expect(out).not.toContain("{$IFDEF DEBUG}");
    expect(out).toContain("Result := 0;");
    expect(out).not.toContain("Result := Scored - Conceded;");
    expect(await errors(UNIT)).toMatchObject({ procs: 0 });
    expect(await errors(out)).toEqual({ n: 0, procs: 2 });
  });

  it("leaves a file with no such group, and a form file, untouched", () => {
    expect(pascalDirectivePreprocess("unit Club;\ninterface\nimplementation\nend.", "club.pas")).toBeNull();
    expect(pascalDirectivePreprocess("{$IFDEF X}inline;{$ENDIF}", "club.dfm")).toBeNull();
  });
});

describe("Pascal conditional groups around a routine's declarations and platform guards (real-repo FP)", () => {
  const SRC = `unit Fixtures;
interface
implementation
{$IFNDEF MSWINDOWS}
  'This unit is only meant for the Windows league client.'
  'Use the portable fixtures unit elsewhere.'
{$ENDIF}
function KickOff(const Venue: string): string;
{$IFDEF MSWINDOWS}
var
  Gate: Integer;
{$ENDIF}
begin
  Result := Venue;
end;
function FinalWhistle(Minute: Integer): Boolean;
begin
  Result := Minute >= 90;
end;
end.`;

  it("blanks a strings-only group and the directives around declaration sections, keeping the declarations", async () => {
    const out = pascalDirectivePreprocess(SRC, "src/fixtures.pas")!.sourceText;
    expect(out.split("\n").map((l) => l.length)).toEqual(SRC.split("\n").map((l) => l.length));
    expect(out).not.toContain("This unit is only meant");
    expect(out).toContain("Gate: Integer;");
    expect(out).not.toContain("{$IFDEF MSWINDOWS}");
    expect((await errors(SRC)).n).toBeGreaterThan(0);
    expect(await errors(out)).toEqual({ n: 0, procs: 2 });
  });
});

describe("Pascal multi-line {$ELSE} groups (real-repo FP)", () => {
  it("keeps the first branch where both side by side are no Pascal: two statements in one case arm, a type declared twice", async () => {
    const SRC = `unit Standings;
interface
type
{$IFDEF UNICODE}
  TTeamName = string;
{$ELSE}
  TTeamName = AnsiString;
{$ENDIF}
function Count(Kind: Integer): Integer;
implementation
function Count(Kind: Integer): Integer;
begin
  Result := 0;
  case Kind of
    1:
      {$IFDEF UNICODEEX}
      begin
        Inc(Result, 2);
      end;
      {$ELSE}
      while Result < 3 do
      begin
        Inc(Result);
      end;
      {$ENDIF}
    2: Result := 1;
  end;
end;
function Points(Wins: Integer): Integer;
begin
  Result := Wins * 3;
end;
end.`;
    const out = pascalDirectivePreprocess(SRC, "src/standings.pas")!.sourceText;
    expect(out.split("\n").map((l) => l.length)).toEqual(SRC.split("\n").map((l) => l.length));
    expect(out).toContain("TTeamName = string;");
    expect(out).not.toContain("AnsiString");
    expect(out).not.toContain("while Result < 3");
    expect((await errors(SRC)).n).toBeGreaterThan(0);
    expect(await errors(out)).toEqual({ n: 0, procs: 2 });
  });
});
