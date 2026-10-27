import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { detectSubProjects } from "./project-detector.js";

describe("detectSubProjects — an Elixir project", () => {
  it("makes the directory of a mix.exs a sub-project of its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-mix-"));
    try {
      await mkdir(join(root, "src/league-ui/lib"), { recursive: true });
      await writeFile(join(root, "src/league-ui/mix.exs"), "defmodule LeagueUi.MixProject do\nend\n");
      await writeFile(join(root, "package.json"), "{}");
      const projects = await detectSubProjects(root);
      expect(projects.map((p) => `${p.root}:${p.kind}`).sort()).toEqual([":node", "src/league-ui:elixir"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
