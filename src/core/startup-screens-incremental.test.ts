import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * The main form is named by the .dpr (`Application.CreateForm(TMainForm, …)`),
 * which an incremental re-run takes from its cache without reading. The
 * startup marks must survive that run — the viewer lists the main form as the
 * app's page only through them.
 */
describe("Delphi startup forms across an incremental re-run", () => {
  const root = mkdtempSync(join(tmpdir(), "clarifydoc-startup-src-"));
  const out = mkdtempSync(join(tmpdir(), "clarifydoc-startup-out-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  writeFileSync(join(root, "app.dpr"), `program app;
uses Forms, Main in 'Main.pas' {MainForm}, Other in 'Other.pas' {OtherForm};
begin
  Application.Initialize;
  Application.CreateForm(TMainForm, MainForm);
  Application.CreateForm(TOtherForm, OtherForm);
  Application.Run;
end.
`);
  for (const [unit, cls, inst] of [["Main", "TMainForm", "MainForm"], ["Other", "TOtherForm", "OtherForm"]]) {
    writeFileSync(join(root, `${unit}.pas`), `unit ${unit};
interface
uses Forms;
type
  ${cls} = class(TForm)
  end;
var
  ${inst}: ${cls};
implementation
{$R *.dfm}
end.
`);
    writeFileSync(join(root, `${unit}.dfm`), `object ${inst}: ${cls}
  Caption = '${unit}'
end
`);
  }

  const startupMarks = async (): Promise<Record<string, string | undefined>> => {
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, incremental: true, stableOutput: true });
    const summary = await loadReportSummary(out);
    return Object.fromEntries((summary.screens ?? []).map((s) => [s.filePath, s.startup]));
  };

  it("keeps the main and auto-created marks when every file comes from the cache", async () => {
    const first = await startupMarks();
    expect(first).toEqual({ "Main.dfm": "main", "Other.dfm": "auto-created" });
    expect(await startupMarks()).toEqual(first);
  });
});
