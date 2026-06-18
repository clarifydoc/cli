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
      "db/migrate/20240101120000_create_users.rb",
    ];
    expect(detectMigrations(files).map((m) => m.ecosystem).sort()).toEqual(["prisma", "rails"]);
  });
});
