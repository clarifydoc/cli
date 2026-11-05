import { describe, it, expect } from "vitest";
import type { FileAnalysis } from "../../../types/analysis.js";
import { dbtPreprocess, dbtSql, isDbtModel } from "./dbt.js";
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
