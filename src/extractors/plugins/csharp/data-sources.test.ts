import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { CSharpDataSourceExtractor } from "./data-sources.js";
import type { DataSourceInfo } from "../../../types/analysis.js";

async function dbSourcesOf(body: string): Promise<DataSourceInfo[]> {
  const src = `namespace X;
public class H {
  private readonly AppDbContext _db;
  public async Task M(CancellationToken ct) {
${body}
  }
}`;
  const tree = await parseSource(src, "csharp" as any, "H.cs");
  return new CSharpDataSourceExtractor()
    .extract(tree, src)
    .filter((d) => d.kind === "database");
}

describe("C# EF data-source — fluent chain entity resolution", () => {
  it("resolves the DbSet entity at the END of a fluent chain (not the OrderBy tail)", async () => {
    const sources = await dbSourcesOf(
      `    var x = await _db.Owners.Include(o => o.Licenses).OrderBy(o => o.Name).ToListAsync(ct);`,
    );
    // Every EF op in the chain attributes to the Owners DbSet — no "Name)" garbage.
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(s.entity).toBe("Owners");
      expect(s.target).toBe("Owners");
    }
    expect(sources.some((s) => s.name === "EF: ToListAsync")).toBe(true);
  });

  it("resolves a simple `_db.Owners.Where(..)` access", async () => {
    const [s] = await dbSourcesOf(`    var q = _db.Owners.Where(o => o.Name == "a").FirstOrDefault();`);
    expect(s?.entity).toBe("Owners");
  });

  it("unwraps Set<T>() to its type argument", async () => {
    const sources = await dbSourcesOf(`    var x = await _db.Set<Owner>().ToListAsync(ct);`);
    expect(sources.some((s) => s.entity === "Owner")).toBe(true);
  });

  it("does NOT attribute an entity to SaveChanges / raw SQL", async () => {
    const save = await dbSourcesOf(`    await _db.SaveChangesAsync(ct);`);
    expect(save.find((s) => s.name === "EF: SaveChangesAsync")?.entity).toBeUndefined();

    const raw = await dbSourcesOf(`    _db.Database.ExecuteSqlRaw("DELETE FROM owners");`);
    expect(raw.find((s) => s.name.includes("ExecuteSqlRaw"))?.entity).toBeUndefined();
  });
});

async function apiCallsOf(body: string): Promise<DataSourceInfo[]> {
  const src = `namespace X;
public class S {
  private readonly HttpClient _httpClient;
  private readonly IOwnerRepository _repo;
  public async Task M(Guid id) {
${body}
  }
}`;
  const tree = await parseSource(src, "csharp" as any, "S.cs");
  return new CSharpDataSourceExtractor()
    .extract(tree, src)
    .filter((d) => d.kind === "api-call");
}

describe("C# HTTP-client detection — receiver gating", () => {
  it("treats an ambiguous verb as HTTP only on an HttpClient-shaped receiver", async () => {
    const yes = await apiCallsOf(`    var r = await _httpClient.GetAsync("/external/owners");`);
    expect(yes).toHaveLength(1);
    expect(yes[0]).toMatchObject({ name: "GetAsync", target: "/external/owners" });
  });

  it("does NOT classify a repository's DeleteAsync/GetAsync as an HTTP call", async () => {
    const repo = await apiCallsOf(`    await _repo.DeleteAsync(id);\n    var x = await _repo.GetAsync(id);`);
    expect(repo).toHaveLength(0);
  });

  it("still trusts HttpClient-specific JSON helpers without a receiver check", async () => {
    const json = await apiCallsOf(`    var x = await _client.GetFromJsonAsync<Owner>("/owners/1");`);
    expect(json.some((s) => s.name === "GetFromJsonAsync")).toBe(true);
  });
});
