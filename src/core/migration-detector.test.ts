import { describe, it, expect } from "vitest";
import { detectMigrations } from "./migration-detector.js";

describe("detectMigrations — EF Core dedup", () => {
  it("counts an EF migration once, ignoring its .Designer companion and the ModelSnapshot", () => {
    const files = [
      "TicketRights.Account.Infrastructure/Migrations/20250129102551_Initial.cs",
      "TicketRights.Account.Infrastructure/Migrations/20250129102551_Initial.Designer.cs",
      "TicketRights.Account.Infrastructure/Migrations/20251027120000_AddOwnerChildView.cs",
      "TicketRights.Account.Infrastructure/Migrations/20251027120000_AddOwnerChildView.Designer.cs",
      "TicketRights.Account.Infrastructure/Migrations/AppDbContextModelSnapshot.cs",
    ];
    const migrations = detectMigrations(files);
    expect(migrations.map((m) => m.name)).toEqual([
      "20250129102551_Initial",
      "20251027120000_AddOwnerChildView",
    ]);
    expect(migrations.every((m) => m.ecosystem === "ef-core")).toBe(true);
  });

  it("still detects other ecosystems unaffected", () => {
    const files = [
      "prisma/migrations/20240101_init/migration.sql",
      "db/migrate/20240101120000_create_players.rb",
    ];
    expect(detectMigrations(files).map((m) => m.ecosystem).sort()).toEqual(["prisma", "rails"]);
  });
});

describe("detectMigrations — Go", () => {
  it("counts only versioned files under a migrations directory (real-repo FP)", () => {
    const files = [
      "modelmigration/v1_20/v250.go",
      "modelmigration/v1_20/v250_test.go",
      "modelmigration/migrations.go",
      "db/migrations/20240101120000_create_clubs.go",
      "services/migrations/league_importer.go",
      "services/migrations/migrate.go",
    ];
    expect(detectMigrations(files).map((m) => m.filePath).sort()).toEqual(["db/migrations/20240101120000_create_clubs.go", "modelmigration/v1_20/v250.go"]);
  });
});

describe("detectMigrations — version order", () => {
  it("orders Flyway versions numerically, segment by segment", () => {
    const files = ["db/migration/V10__add_index.sql", "db/migration/V2__players.sql", "db/migration/V1_10__b.sql", "db/migration/V1_2__a.sql", "db/migration/V1__init.sql"];
    expect(detectMigrations(files).map((m) => m.name)).toEqual(["V1__init", "V1_2__a", "V1_10__b", "V2__players", "V10__add_index"]);
  });
});

describe("detectMigrations — Liquibase", () => {
  it("recognises changelogs by their directory or name", () => {
    const found = detectMigrations([
      "league-service/src/main/resources/META-INF/liquibase/changelog/db.changelog-1.0.xml",
      "db/changelog/fixtures.yaml",
      "src/main/resources/changelog-cup-master.xml",
      "src/main/resources/applicationContext.xml",
    ]).map((m) => `${m.ecosystem} ${m.name}`);
    expect(found).toEqual(["liquibase changelog-cup-master", "liquibase db.changelog-1.0", "liquibase fixtures"]);
  });
});
