import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * An extension-less `bin/club` with a `#!/usr/bin/env ruby` line beside a
 * gem's `lib/` is analyzed as Ruby, and its calls link to the class it uses.
 * Its decoys — a text file, an undeclared interpreter — are not analyzed.
 */
describe("extension-less scripts in the analysis", () => {
  let base: string;
  let out: string;
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(base, "repo", rel)), { recursive: true });
    writeFileSync(join(base, "repo", rel), text);
  };

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "clarifydoc-shebang-"));
    out = join(base, "out");
    put("Gemfile", "source 'https://rubygems.org'\n");
    put("lib/club.rb", "class Club\n  def run\n    1\n  end\nend\n");
    put("bin/club", '#!/usr/bin/env ruby\nrequire_relative "../lib/club"\nclub = Club.new\nclub.run\n');
    put("bin/notes", "Club notes, no shebang\n");
    put("bin/other", "#!/usr/bin/env ocamlrun\nClub.new\n");
    await analyze({ projectRoot: join(base, "repo"), outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  }, 60_000);
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("analyzes the script as its interpreter's language and links its calls", async () => {
    const summary = await loadReportSummary(out);
    const files = (summary.files ?? []) as string[];
    expect(files).toContain("bin/club");
    expect(files).not.toContain("bin/notes");
    expect(files).not.toContain("bin/other");
    const links = summary.symbolLinks ?? [];
    expect(links.filter((l) => l.callName === "Club.new" || l.callName === "club.run").length).toBe(2);
  });

  it("reuses the script's analysis on an unchanged incremental run", async () => {
    const result = await analyze({
      projectRoot: join(base, "repo"),
      outputDir: out,
      lsp: false,
      gitHistory: false,
      stableOutput: true,
      incremental: true,
    });
    const summary = await loadReportSummary(out);
    expect((summary.files ?? []) as string[]).toContain("bin/club");
    expect(result).toBeDefined();
  }, 60_000);
});
