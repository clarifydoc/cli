import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function build(files: Record<string, string>): Promise<{ dir: string; summary: ProjectAnalysis }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-py-sessions-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { dir, summary: await loadReportSummary(join(dir, "out")) };
}

describe("SQLAlchemy sessions name the model they are handed", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    "pyproject.toml": '[project]\nname = "league"\n',
    "app/db.py": "from flask_sqlalchemy import SQLAlchemy\ndb = SQLAlchemy()\n",
    "app/models.py": `from sqlalchemy import Column, Integer, String, ForeignKey
from sqlalchemy.orm import relationship
from app.db import db


class Club(db.Model):
    __tablename__ = "clubs"
    id = Column(Integer, primary_key=True)
    name = Column(String)


class MatchReport(db.Model):
    id = Column(Integer, primary_key=True)
    club_id = Column(Integer, ForeignKey("clubs.id"))
    club = relationship("Club", backref="reports")

    @classmethod
    def latest(cls):
        return cls.query.filter_by(id=1).first()


class Decoy:
    def add(self, x): ...
`,
    "app/api.py": `from flask import Flask, request
from app.db import db
from app.models import Club, MatchReport, Decoy

app = Flask(__name__)
decoy = Decoy()


@app.route("/clubs", methods=["POST"])
def create_club():
    club = Club(name=request.json["name"])
    db.session.add(club)
    db.session.commit()
    return "ok"


@app.route("/clubs/<int:id>")
def get_club(id):
    c = db.session.get(Club, id)
    return c.name


@app.route("/clubs/<int:id>", methods=["DELETE"])
def del_club(id):
    c = Club.query.filter_by(id=id).first()
    db.session.delete(c)
    return "ok"


@app.route("/reports", methods=["POST"])
def make_report():
    db.session.add(MatchReport(club_id=1))
    return "ok"


@app.route("/decoy")
def touch_decoy():
    decoy.add(1)
    return "ok"


def typed(session, club: Club):
    session.delete(club)
`,
  };
  beforeAll(async () => {
    ({ dir, summary } = await build(files));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const access = (symbol: string) => summary.symbolDataAccess?.filter((a) => a.symbol === symbol).map((a) => a.entity).sort();

  it("writes the model built in the function (session.add(club), session.add(Model(...)))", () => {
    expect(access("create_club")).toContain("Club");
    expect(access("make_report")).toEqual(["MatchReport"]);
  });
  it("reads the model session.get(Model, id) names, and deletes the one a local holds", () => {
    expect(access("get_club")).toEqual(["Club"]);
    expect(access("del_club")).toContain("Club");
  });
  it("types a parameter by its annotation", () => {
    expect(access("typed")).toEqual(["Club"]);
  });
  it("reaches no table through a namesake add()", () => {
    expect(access("touch_decoy")).toEqual([]);
  });
  it("reads cls.query in a classmethod as the class's own table", () => {
    expect(access("MatchReport.latest")).toEqual(["MatchReport"]);
  });
  it("names a Flask-SQLAlchemy table after its class and makes the FK side many-to-one", () => {
    const nodes = summary.entityGraph?.nodes ?? [];
    expect(nodes.find((n) => n.name === "MatchReport")?.table).toBe("match_report");
    expect(nodes.find((n) => n.name === "Club")?.table).toBe("clubs");
    const edge = summary.entityGraph?.edges.find((e) => e.foreignKey === "club_id");
    expect(edge?.sourceCardinality).toBe("one");
    expect(edge?.targetCardinality).toBe("many");
  });
});

describe("Spark SQL reads its tables", () => {
  let dir = "";
  beforeAll(async () => {
    ({ dir } = await build({
      "pyproject.toml": '[project]\nname = "jobs"\n',
      "job.py": `from pyspark.sql import SparkSession

spark = SparkSession.builder.getOrCreate()


def standings():
    return spark.sql("SELECT c.name FROM league.matches m JOIN league.clubs c ON c.id = m.club_id")


def archive():
    spark.sql("INSERT INTO league.archive SELECT * FROM league.matches")
    spark.table("league.cars")


def plain(db):
    return db.sql("SELECT * FROM league.decoys")
`,
      "nb.py": `# Databricks notebook source
# MAGIC %sql
# MAGIC SELECT * FROM league.fixtures WHERE season = 2024

# COMMAND ----------

# MAGIC %sql
# MAGIC INSERT INTO league.garage_log SELECT * FROM league.garages
`,
    }));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it("reads and writes the tables spark.sql and the table readers name", async () => {
    const a = await import("fs/promises").then((f) => f.readFile(join(dir, "out", "job.py.json"), "utf8")).then(JSON.parse);
    const rows = (a.dataSources as Array<{ target: string; access: string }>).map((d) => `${d.target}:${d.access}`).sort();
    expect(rows).toEqual([
      "league.archive:write", "league.cars:read", "league.clubs:read", "league.matches:read", "league.matches:read",
    ]);
  });
  it("reads the %sql cells of a Databricks notebook", async () => {
    const a = await import("fs/promises").then((f) => f.readFile(join(dir, "out", "nb.py.json"), "utf8")).then(JSON.parse);
    const rows = (a.dataSources as Array<{ target: string; access: string }>).map((d) => `${d.target}:${d.access}`).sort();
    expect(rows).toEqual(["league.fixtures:read", "league.garage_log:write", "league.garages:read"]);
  });
});
