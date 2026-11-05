import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";
import { dbtPreprocess, dbtSql, dbtStamp, isDbtModel, parseDbtProperties } from "./dbt.js";
import { sqlSpec } from "./index.js";

const MODEL = `{{ config(materialized='table') }}
with c as (
  select * from {{ ref('stg_clubs') }}
),
t as (
  select club_id, sum(amount) as total from {{ source('raw','transfers') }} group by club_id
)
{% if var('full', true) %}
select c.id, t.total from c join t on t.club_id = c.id
{% endif %}
`;

describe("dbt models", () => {
  it("recognises a model by the models and sources it names, never a macro or a test", () => {
    expect(isDbtModel(MODEL, "models/marts/club_fees.sql")).toBe(true);
    expect(isDbtModel(MODEL, "macros/club_fees.sql")).toBe(false);
    expect(isDbtModel("select * from clubs", "models/clubs.sql")).toBe(false);
    expect(isDbtModel("select '{{ ds }}' as day from clubs", "dags/clubs.sql")).toBe(false);
  });

  it("turns the Jinja into SQL on the same lines", () => {
    const sql = dbtSql(MODEL, "club_fees").split("\n");
    expect(sql).toHaveLength(MODEL.split("\n").length);
    expect(sql[2]).toContain("from stg_clubs");
    expect(sql[5]).toContain("from raw.transfers");
    expect(sql[0]!.trim()).toBe("");
    expect(sql[7]!.trim()).toBe("");
    expect(sql[8]).toContain("from c join t");
  });

  it("reads the SQL's tables at the lines they are on, and a model that builds its table from them", () => {
    const pre = dbtPreprocess(MODEL, "models/marts/club_fees.sql")!;
    const analysis = {
      classes: [],
      dataSources: sqlSpec.extractDataSources!(pre.sourceText.split("\n"), []),
    } as unknown as FileAnalysis;
    pre.postExtract!(analysis, MODEL);
    expect(analysis.classes[0]).toMatchObject({ name: "club_fees", decorators: ["table", "dbt"], implements: ["stg_clubs", "raw.transfers"] });
    const rows = analysis.dataSources.filter((d) => d.entity).map((d) => `${d.name} ${d.entity} ${d.access}@${d.line}`);
    expect(rows).toContain("SELECT stg_clubs read@3");
    expect(rows).toContain("SELECT transfers read@6");
    expect(rows).toContain("dbt model club_fees write@1");
  });

  it("names no table for a Jinja expression it does not know", () => {
    const pre = dbtPreprocess("select * from {{ my_macro() }} m join {{ ref('stg_clubs') }} c on c.id = m.id", "models/x.sql")!;
    const analysis = { classes: [], dataSources: sqlSpec.extractDataSources!(pre.sourceText.split("\n"), []) } as unknown as FileAnalysis;
    pre.postExtract!(analysis, "");
    expect(analysis.dataSources.map((d) => d.entity).filter(Boolean).sort()).toEqual(["stg_clubs", "x"]);
  });
});

describe("dbt project files", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-dbt-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (rel: string, text: string) => { mkdirSync(join(dir, rel, ".."), { recursive: true }); writeFileSync(join(dir, rel), text); };
  write("league/dbt_project.yml", "name: league\nmodel-paths: [\"models\"]\n");
  write("league/models/club_totals.sql", "select c.id, count(*) as n from raw_clubs c join raw_players p on p.club_id = c.id group by 1\n");
  write("league/models/schema.yml", `version: 2
models:
  - name: club_totals
    description: totals
    columns:
      - name: id
        data_type: int
        description: club id
      - name: n
  - name: other_model
    columns:
      - name: z
`);
  write("league/macros/helper.sql", "select 1 from decoy_macro\n");
  write("plain/models/clubs.sql", "select * from decoy_table\n");

  const run = (rel: string) => {
    const abs = join(dir, rel);
    const text = "select * from raw_clubs";
    return dbtPreprocess(text, rel.split("/").slice(1).join("/"), { absolutePath: abs, projectRoot: dir });
  };

  it("recognises a model by dbt_project.yml at its root, though it names no ref or source", () => {
    const pre = run("league/models/club_totals.sql");
    expect(pre).not.toBeNull();
    const analysis = { classes: [], dataSources: [] } as unknown as FileAnalysis;
    pre!.postExtract!(analysis, "");
    expect(analysis.classes[0]).toMatchObject({ name: "club_totals", decorators: ["table", "dbt"] });
  });

  it("reads the model's columns from its schema.yml onto the dbt entity", () => {
    const pre = run("league/models/club_totals.sql")!;
    const analysis = { classes: [], dataSources: [] } as unknown as FileAnalysis;
    pre.postExtract!(analysis, "");
    expect(analysis.classes[0]!.properties.map((p) => [p.name, p.type])).toEqual([["id", "INT"], ["n", null]]);
  });

  it("leaves a macro, and a models folder without a dbt project, alone", () => {
    expect(run("league/macros/helper.sql")).toBeNull();
    expect(run("plain/models/clubs.sql")).toBeNull();
  });

  it("fingerprints the project files for the incremental cache, and only inside a dbt project", () => {
    const a = dbtStamp(join(dir, "league/models/club_totals.sql"), dir);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(dbtStamp(join(dir, "plain/models/clubs.sql"), dir)).toBeUndefined();
  });

  it("parses a properties file's models and columns by indentation, ignoring other sections", () => {
    const m = parseDbtProperties(`sources:
  - name: raw
    tables:
      - name: decoy
models:
  - name: a
    columns:
      - name: x
  - name: b
`);
    expect([...m.keys()]).toEqual(["a", "b"]);
    expect(m.get("a")!.map((c) => c.name)).toEqual(["x"]);
  });
});
