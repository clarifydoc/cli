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
    // A multi-line group is the grammar's to read: left alone.
    expect(out).toContain("{$IFDEF DEBUG}");
    expect(await errors(UNIT)).toMatchObject({ procs: 0 });
    expect(await errors(out)).toEqual({ n: 0, procs: 2 });
  });

  it("leaves a file with no such group, and a form file, untouched", () => {
    expect(pascalDirectivePreprocess("unit Club;\ninterface\nimplementation\nend.", "club.pas")).toBeNull();
    expect(pascalDirectivePreprocess("{$IFDEF X}inline;{$ENDIF}", "club.dfm")).toBeNull();
  });
});
