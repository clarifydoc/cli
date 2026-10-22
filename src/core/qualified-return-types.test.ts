import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** Real-repo FP: `m, err := query.ClubByUID(id)` returns `entity.Club`, and `Club` is a struct in three packages — `m.Save()` linked nowhere. */
const FILES: Record<string, string> = {
  "go.mod": "module example.com/league\n\ngo 1.22\n",
  "internal/entity/club.go": `package entity

type Club struct {
	ClubUID  string
	ClubName string
}

func (m *Club) Save() error {
	return nil
}
`,
  // The same type over several files of its package, and a subpackage with a struct of the same name.
  "internal/entity/club_yaml.go": `package entity

func (m *Club) SaveYaml() error {
	return nil
}
`,
  "internal/entity/club_new.go": `package entity

func NewUserClub(name string) *Club {
	return &Club{ClubName: name}
}
`,
  "internal/entity/search/club.go": `package search

type Club struct {
	ClubUID string
}

func (c *Club) Save() error {
	return nil
}
`,
  "internal/form/club.go": `package form

type Club struct {
	ClubName string
}

func (f *Club) Save() error {
	return nil
}
`,
  "internal/search/club.go": `package search

type Club struct {
	ClubUID string
}

func (c *Club) Save() error {
	return nil
}
`,
  "internal/query/clubs.go": `package query

import "example.com/league/internal/entity"

func ClubByUID(uid string) (result entity.Club, err error) {
	return result, nil
}
`,
  "internal/api/clubs.go": `package api

import (
	"example.com/league/internal/entity"
	"example.com/league/internal/query"
)

func UpdateClub(id string, f string) error {
	m, err := query.ClubByUID(id)
	if err != nil {
		return err
	}
	return m.Save()
}

func CreateClub(name string) error {
	club := entity.NewUserClub(name)
	return club.Save()
}
`,
};

describe("a return type written with its package", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-qualified-return-"));
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

  it("types the local by the class in that package, though two more packages declare the name", () => {
    const link = summary.symbolLinks.find((l) => l.sourceSymbol === "UpdateClub" && l.callName === "m.Save");
    expect(link && `${link.targetFile} ${link.targetSymbol}`).toBe("internal/entity/club.go Club.Save");
  });

  it("types a local by an unqualified return type the package declares in another file", () => {
    const link = summary.symbolLinks.find((l) => l.sourceSymbol === "CreateClub" && l.callName === "club.Save");
    expect(link && `${link.targetFile} ${link.targetSymbol}`).toBe("internal/entity/club.go Club.Save");
  });
});
