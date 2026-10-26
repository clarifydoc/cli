import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** Real-repo FP: related managers (`trigger.filter_has_tags.all()`) were read as tables named after their field. */
const FILES: Record<string, string> = {
  "requirements.txt": "django==5.0\n",
  "league/models.py": `from django.db import models


class Tag(models.Model):
    name = models.CharField(max_length=50)


class Club(models.Model):
    name = models.CharField(max_length=100)
    tags = models.ManyToManyField(Tag, related_name="clubs")
    staff = models.ManyToManyField("auth.Group")

    def tag_names(self):
        return [t.name for t in self.tags.all()]


class Player(models.Model):
    club = models.ForeignKey(Club, on_delete=models.CASCADE)
    name = models.CharField(max_length=100)


class Rule(models.Model):
    filter_has_tags = models.ManyToManyField(Tag, related_name="+")
`,
  "league/services.py": `from .models import Club, Rule


def squad(club: Club):
    return list(club.player_set.all())


def matches(rule: Rule, club):
    wanted = set(rule.filter_has_tags.all())
    return wanted, club.tags.filter(name="cup"), club.staff.all(), club.socialaccount_set.first()


def tagged(tag):
    return tag.clubs.all()
`,
};

describe("Django related managers", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-django-related-"));
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

  it("read the model their field relates to, or name no table", () => {
    const rows = (summary.symbolDataAccess ?? [])
      .filter((r) => !r.access)
      .flatMap((r) => r.sites.map((s) => `${s.name} → ${r.entity || "(none)"}`))
      .sort();
    expect(rows).toEqual([
      // A reverse accessor by default name, a forward field on a typed receiver, the model's own field,
      // a field one model declares, and a related_name.
      "club.player_set.all → Player",
      "club.tags.filter → Tag",
      "rule.filter_has_tags.all → Tag",
      "self.tags.all → Tag",
      "tag.clubs.all → Club",
    ]);
    // A model from a dependency (`auth.Group`) and an accessor no model declares name no table.
    const names = (summary.dataAccessGraph?.nodes ?? []).map((n) => n.name);
    expect(names).not.toContain("staff");
    expect(names).not.toContain("socialaccount_set");
  });
});
