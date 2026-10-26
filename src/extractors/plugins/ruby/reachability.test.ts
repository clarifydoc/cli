import { describe, it, expect } from "vitest";
import { rubyReachability } from "./reachability.js";
import type { FileAnalysis } from "../../../types/analysis.js";

describe("Ruby reachability — database tasks", () => {
  it("keeps every database's migrations alive, prefixed directories included", async () => {
    const m = await rubyReachability.load({ projectRoot: "/nonexistent", roots: [], files: new Set<string>() });
    const passive = (path: string) => m.passiveReason!({ filePath: path, classes: [{ name: "ClubImporter", extends: null, implements: [], decorators: [], methods: [], line: 1, endLine: 3 }], functions: [], routes: [] } as unknown as FileAnalysis, path, new Set());
    expect(passive("db/migrate/20260101_create_clubs.rb")).not.toBeNull();
    expect(passive("db/cache_migrate/20260101_create_cache_entries.rb")).not.toBeNull();
    expect(passive("db/queue_migrations/20260101_create_jobs.rb")).not.toBeNull();
    expect(passive("db/seeds.rb")).not.toBeNull();
    expect(passive("db/club_importer.rb")).toBeNull();
  });
});
