import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** Real-repo FP: models whose base is a project model were no entities, or had no columns (31 of 200 with columns). */
const FILES: Record<string, string> = {
  "requirements.txt": "django==5.0\n",
  "league/models/base.py": `from django.db import models


class OwnedModel(models.Model):
    owner = models.ForeignKey("auth.User", on_delete=models.CASCADE)

    class Meta:
        abstract = True


class NamedModel(OwnedModel):
    name = models.CharField(max_length=100)

    class Meta:
        abstract = True
`,
  "league/models/clubs.py": `from django.db import models
from .base import NamedModel, OwnedModel


class Club(NamedModel):
    pass


class Fixture(OwnedModel):
    home = models.ForeignKey(Club, on_delete=models.CASCADE, related_name="home_fixtures")
    kickoff = models.DateTimeField()
`,
};

describe("Django models with project bases", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-django-bases-"));
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

  it("are entities with the columns they declare and inherit", () => {
    const node = (name: string) => summary.entityGraph!.nodes.find((n) => n.name === name);
    // Columns (foreign keys are the graph's edges): declared, and inherited through two bases.
    expect(node("Club")?.columns.map((c) => c.name).sort()).toEqual(["name"]);
    expect(node("Fixture")?.columns.map((c) => c.name).sort()).toEqual(["kickoff"]);
    expect(summary.entityGraph!.edges.some((e) => e.source.endsWith("::Club") && e.target.endsWith("::Fixture") || e.source.endsWith("::Fixture") && e.target.endsWith("::Club"))).toBe(true);
  });
});
