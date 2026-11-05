import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import "./meta.js";

const FILES: Record<string, string> = {
  "mix.exs": "defmodule League.MixProject do\n  use Mix.Project\nend\n",
  "lib/club.ex": "defmodule Club do\n  def kick(x) do\n    x\n  end\n\n  def pass(x) do\n    x\n  end\nend\n",
  "lib/team.ex": "defmodule Team do\n  import Club, except: [kick: 1]\n\n  def go do\n    pass(1)\n  end\n\n  def go2 do\n    kick(1)\n  end\nend\n",
  "lib/fwd.ex": "defmodule Fwd do\n  defdelegate [pass: 1, kick: 1], to: Club\nend\n",
};

describe("Elixir `import … except:`", () => {
  let dir: string;
  let links: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-elixir-except-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    links = (await loadReportSummary(join(dir, "out"))).symbolLinks.map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("binds every name but the excepted ones", () => {
    expect(links).toContain("Team.go pass -> lib/club.ex::Club.pass");
    expect(links.filter((l) => l.startsWith("Team.go2"))).toEqual([]);
  });

  it("links the functions a list-form defdelegate declares to their namesakes", () => {
    expect(links).toContain("Fwd.pass Club.pass -> lib/club.ex::Club.pass");
    expect(links).toContain("Fwd.kick Club.kick -> lib/club.ex::Club.kick");
  });
});
