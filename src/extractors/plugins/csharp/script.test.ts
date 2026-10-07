import { describe, it, expect } from "vitest";
import { createEmptyAnalysis } from "../../../types/analysis.js";
import { preprocessCsharpScript } from "./script.js";

const SCRIPT = [
  '#r "nuget: Dapper, 2.1.35"',
  '#r "lib/Legacy.dll"',
  '#load "helpers.csx"',
  '#load "../shared/db.csx"',
  "using Dapper;",
  "",
  "Console.WriteLine(Run());",
].join("\n");

describe("preprocessCsharpScript", () => {
  it("leaves .cs files alone", () => {
    expect(preprocessCsharpScript(SCRIPT, "Program.cs")).toBeNull();
  });

  it("returns null for a script without directives", () => {
    expect(preprocessCsharpScript("Console.WriteLine(1);", "x.csx")).toBeNull();
  });

  it("blanks the directives without moving any line", () => {
    const out = preprocessCsharpScript(SCRIPT, "jobs/report.csx")!;
    const lines = out.sourceText.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines.slice(0, 4)).toEqual(["", "", "", ""]);
    expect(lines[4]).toBe("using Dapper;");
    expect(out.language).toBe("csharp");
  });

  it("keeps CRLF line endings on blanked lines", () => {
    const out = preprocessCsharpScript('#load "a.csx"\r\nusing System;\r\n', "x.csx")!;
    expect(out.sourceText).toBe("\r\nusing System;\r\n");
  });

  it("gives #load back as a relative import and #r nuget as the package", () => {
    const out = preprocessCsharpScript(SCRIPT, "jobs/report.csx")!;
    const analysis = createEmptyAnalysis("jobs/report.csx", "csharp");
    analysis.imports = [{ source: "Dapper", specifiers: [], isDefault: false, isNamespace: true, isType: false, line: 5 }];
    out.postExtract!(analysis, SCRIPT);
    expect(analysis.imports.map((i) => [i.source, i.line])).toEqual([
      ["Dapper", 1],
      ["./helpers.csx", 3],
      ["../shared/db.csx", 4],
      ["Dapper", 5],
    ]);
  });
});
