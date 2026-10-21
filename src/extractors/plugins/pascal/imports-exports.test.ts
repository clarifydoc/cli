import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PascalImportExportExtractor } from "./imports-exports.js";

const extractor = new PascalImportExportExtractor();

describe("pascal uses-in-clause file paths", () => {
  it("rewrites dpr imports to their declared .pas paths (grammar ERRORs on `in`)", async () => {
    const code = `program PlayerApp;
uses
  Vcl.Forms,
  MainForm in 'MainForm.pas' {frmMain},
  PlayerService in 'src\\PlayerService.pas',
  Shared.Utils in '..\\shared\\Shared.Utils.pas';
begin
end.`;
    const tree = await parseSource(code, "pascal" as any, "PlayerApp.dpr");
    const imports = extractor.extractImports(tree, code);
    const bySpec = new Map(imports.map((i) => [i.specifiers[0], i.source]));
    expect(bySpec.get("Vcl.Forms")).toBe("Vcl.Forms");
    expect(bySpec.get("MainForm")).toBe("./MainForm.pas");
    expect(bySpec.get("PlayerService")).toBe("./src/PlayerService.pas");
    expect(bySpec.get("Shared.Utils")).toBe("../shared/Shared.Utils.pas");
  });

  it("never invents imports from `for c in '...'` expressions", async () => {
    const code = `unit U;
interface
uses SysUtils;
implementation
procedure P;
var c: Char;
begin
  for c in 'abc' do Write(c);
end;
end.`;
    const tree = await parseSource(code, "pascal" as any, "U.pas");
    const imports = extractor.extractImports(tree, code);
    expect(imports.map((i) => i.source)).toEqual(["SysUtils"]);
  });
});
