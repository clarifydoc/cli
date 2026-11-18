import { describe, it, expect } from "vitest";
import { alembicSchemaOf } from "./alembic-schema.js";

describe("alembicSchemaOf", () => {
  it("qualifies create_table with schema=, keeps a bare decoy bare, and ignores downgrade drops", () => {
    const { tables, ops } = alembicSchemaOf(`
from alembic import op
import sqlalchemy as sa

revision = "a1b2c3d4e5f6"
down_revision = None

def upgrade():
    op.create_table(
        "clubs",
        sa.Column("id", sa.Integer()),
        sa.Column("name", sa.String(80)),
        schema="league",
    )
    op.create_table("clubs", sa.Column("id", sa.Integer()))

def downgrade():
    op.drop_table("clubs", schema="league")
    op.drop_table("clubs")
`);
    expect(tables.map((t) => t.name).sort()).toEqual(["clubs", "league.clubs"]);
    expect(ops.map((o) => `${o.op}:${o.table}`).sort()).toEqual([
      "create-table:clubs",
      "create-table:league.clubs",
    ]);
  });
});
