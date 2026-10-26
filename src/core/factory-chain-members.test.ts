import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { FileAnalysis, ProjectAnalysis } from "../types/analysis.js";
import { readFile } from "fs/promises";

/**
 * A member assigned a chain on an unannotated factory's result
 * (`self.group_clubs = get_repositories(session).clubs`, where the factory
 * only `return AllRepositories(session)`), set in a base class's `__init__` and
 * used by a subclass (real-repo FP: recipe update/delete routes reached no model).
 */
const FILES: Record<string, string> = {
  "pyproject.toml": `[project]\nname = "league"\ndependencies = ["sqlalchemy"]\n`,
  "league/models.py": `from sqlalchemy import Column, Integer, String
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class ClubModel(Base):
    __tablename__ = "clubs"
    id = Column(Integer, primary_key=True)
    name = Column(String)
`,
  "league/repos.py": `from functools import cached_property
from typing import Generic, TypeVar

from league.models import ClubModel
from league.schema import ClubSchema

Schema = TypeVar("Schema")
Model = TypeVar("Model")


class RepositoryGeneric(Generic[Schema, Model]):
    def __init__(self, session):
        self.session = session

    def update(self, match_id, data):
        return self.session.merge(data)


class RepositoryClubs(RepositoryGeneric[ClubSchema, ClubModel]):
    pass


class AllRepositories:
    def __init__(self, session):
        self.session = session

    @cached_property
    def clubs(self) -> RepositoryClubs:
        return RepositoryClubs(self.session)


def get_repositories(session):
    return AllRepositories(session)
`,
  "league/schema.py": `class ClubSchema:
    name: str
`,
  "league/service.py": `from league.repos import AllRepositories, get_repositories


class ClubServiceBase:
    def __init__(self, repos: AllRepositories):
        self.repos = repos
        self.group_clubs = get_repositories(repos.session).clubs


class ClubService(ClubServiceBase):
    def rename(self, club_id, name):
        return self.group_clubs.update(club_id, {"name": name})
`,
};

describe("members typed by a chain on a factory's result", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  let repos: FileAnalysis;
  let service: FileAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-factory-chain-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
    repos = JSON.parse(await readFile(join(dir, "out", "league", "repos.py.json"), "utf8"));
    service = JSON.parse(await readFile(join(dir, "out", "league", "service.py.json"), "utf8"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types an unannotated factory by the one class it returns", () => {
    expect(repos.functions.find((f) => f.name === "get_repositories")?.returnType).toBe("AllRepositories");
  });

  it("records the member's chain for the project pass", () => {
    const prop = service.classes.find((c) => c.name === "ClubServiceBase")?.properties.find((p) => p.name === "group_clubs");
    expect(prop?.from).toBe("get_repositories().clubs");
  });

  it("follows a subclass's call through the member to the repository and its model", () => {
    const link = (summary.symbolLinks ?? []).find((l) => l.sourceSymbol === "ClubService.rename" && l.callName === "self.group_clubs.update");
    expect(link?.targetSymbol).toBe("RepositoryGeneric.update");
    const reach = (summary.symbolReach ?? []).find((r) => r.symbol === "ClubService.rename");
    expect(reach?.effects.map((e) => `${e.kind} ${e.resource}`)).toEqual(["db-write ClubModel"]);
  });
});
