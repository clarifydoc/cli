import { describe, expect, it } from "vitest";
import { perlTestCommand } from "./test-command.js";
import { perlProjectCommands } from "./project-commands.js";
import type { ProjectRootView } from "../../../types/language-plugin.js";

const root = (files: Record<string, string>): ProjectRootView => ({ entries: Object.keys(files), read: (r) => files[r], exists: (r) => r in files });

describe("Perl test command", () => {
  it("proves the .t files, once each", () => {
    expect(perlTestCommand([{ file: "t/player.t", names: [] }, { file: "t/club.t", names: [] }, { file: "t/club.t", names: ["x"] }])).toBe("prove -l t/club.t t/player.t");
  });

  it("a test outside a .t file runs the whole tree", () => {
    expect(perlTestCommand([{ file: "xt/Club.pm", names: [] }])).toBe("prove -lr t");
  });

  it("a distribution with a t/ directory is tested by prove", () => {
    expect(perlProjectCommands(root({ "Makefile.PL": "", t: "" }))).toEqual([{ kind: "test", command: "prove -lr t", source: "Makefile.PL" }]);
    expect(perlProjectCommands(root({ "Makefile.PL": "" }))).toEqual([]);
    expect(perlProjectCommands(root({}))).toEqual([]);
  });
});
