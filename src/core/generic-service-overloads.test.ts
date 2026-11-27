import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A generic service over a generic repository (`BaseService<T>` holding `IBaseRepository<T>`, a typed
 * `ClubService : BaseService<Club>`): a route reaches the table through the service's overloaded save and delete
 * methods (real-repo FP: routes calling them reached no table).
 *
 * - a parameter written with a verbatim identifier (`@where`) is typed like any other, so the repository overload
 *   its argument fits is chosen, not left a tie;
 * - an argument typed `Club` fits the overload taking the class's type parameter `T`, not the one taking
 *   `IEnumerable<T>`;
 * - an argument whose type is unknown ties the two overloads: the link is AMBIGUOUS, and the type argument still
 *   closes the table, as an AMBIGUOUS path.
 */
const FILES: Record<string, string> = {
  "League.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"></Project>`,
  "Domain.cs": `using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
namespace League;
public class Club { public int Id { get; set; } public string Name { get; set; } }
public class Match { public int Id { get; set; } }
public class DataContext : DbContext { public DbSet<Club> Clubs { get; set; } public DbSet<Match> Matches { get; set; } }
public interface IBaseRepository<T> where T : class {
  bool DeleteEntity(T t);
  int DeleteEntity(Expression<Func<T, bool>> where);
  T AddOrUpdate<TKey>(Expression<Func<T, TKey>> key, T t);
  void AddOrUpdate<TKey>(Expression<Func<T, TKey>> key, IEnumerable<T> entities);
}
public class BaseRepository<T> : IBaseRepository<T> where T : class {
  public DataContext DataContext { get; set; }
  public bool DeleteEntity(T t) { DataContext.Remove(t); return true; }
  public int DeleteEntity(Expression<Func<T, bool>> where) { return DataContext.Set<T>().Where(where).ExecuteDelete(); }
  public T AddOrUpdate<TKey>(Expression<Func<T, TKey>> key, T t) { DataContext.Set<T>().AddOrUpdate(key, t); return t; }
  public void AddOrUpdate<TKey>(Expression<Func<T, TKey>> key, IEnumerable<T> entities) { DataContext.Set<T>().AddOrUpdate(key, entities); }
}
public interface IBaseService<T> where T : class {
  int DeleteEntitySaved(Expression<Func<T, bool>> where);
  int AddOrUpdateSaved<TKey>(Expression<Func<T, TKey>> key, T t);
  int AddOrUpdateSaved<TKey>(Expression<Func<T, TKey>> key, IEnumerable<T> entities);
}
public class BaseService<T> : IBaseService<T> where T : class {
  public virtual IBaseRepository<T> BaseDal { get; set; }
  public BaseService(IBaseRepository<T> repository) { BaseDal = repository; }
  public virtual int DeleteEntitySaved(Expression<Func<T, bool>> @where) { BaseDal.DeleteEntity(where); return 1; }
  public int AddOrUpdateSaved<TKey>(Expression<Func<T, TKey>> key, T t) { BaseDal.AddOrUpdate(key, t); return 1; }
  public int AddOrUpdateSaved<TKey>(Expression<Func<T, TKey>> key, IEnumerable<T> entities) { BaseDal.AddOrUpdate(key, entities); return 1; }
}
public interface IClubService : IBaseService<Club> { }
public class ClubService : BaseService<Club>, IClubService { public ClubService(IBaseRepository<Club> r) : base(r) { } }
public static class ClubMapper { public static Club ToClub(this ClubDto d) => new Club(); public static List<Club> ToClubs(this ClubDto d) => new List<Club>(); }
public class ClubDto { }
`,
  "ClubController.cs": `using Microsoft.AspNetCore.Mvc;
using System.Collections.Generic;
namespace League;
[Route("clubs")]
public class ClubController : ControllerBase {
  public IClubService ClubService { get; set; }
  [HttpPost("save")] public bool Save(ClubDto dto) { return ClubService.AddOrUpdateSaved(c => c.Id, dto.ToClub()) > 0; }
  [HttpPost("saveall")] public bool SaveAll(ClubDto dto) { return ClubService.AddOrUpdateSaved(c => c.Id, dto.ToClubs()) > 0; }
  [HttpPost("saveone")] public bool SaveOne(Club club) { return ClubService.AddOrUpdateSaved(c => c.Id, club) > 0; }
  [HttpDelete("{id}")] public bool Delete(int id) { return ClubService.DeleteEntitySaved(c => c.Id == id) > 0; }
}
`,
};

describe("a generic service's overloaded calls, bound to the table", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-generic-service-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const flows = () => (summary.dataFlows ?? []).filter((f) => f.entryKind === "route").map((f) => `${f.entryLabel} ${f.effect} ${f.resource} ${f.confidence}`).sort();

  it("reaches the table through a parameter written @where and one typed argument", () => {
    const all = flows();
    expect(all).toContain("DELETE /clubs/{id} db-write Club INFERRED");
    expect(all).toContain("POST /clubs/saveone db-write Club INFERRED");
  });

  it("reaches it AMBIGUOUS when the argument's type is unknown and two overloads tie", () => {
    const all = flows();
    expect(all).toContain("POST /clubs/save db-write Club AMBIGUOUS");
    expect(all).toContain("POST /clubs/saveall db-write Club AMBIGUOUS");
  });

  it("marks an effect closed over a caller's type argument, never one a row states", () => {
    const reach = (symbol: string) => (summary.symbolReach ?? []).find((r) => r.symbol === symbol)?.effects ?? [];
    expect(reach("ClubController.SaveOne").map((e) => `${e.resource} ${e.typeArgument}`)).toEqual(["Club true"]);
    expect(reach("ClubController.Save").map((e) => `${e.resource} ${e.typeArgument}`)).toEqual(["Club true"]);
    // The generic repository's own method has no table until a caller closes it.
    expect(reach("BaseRepository.AddOrUpdate").filter((e) => e.typeArgument)).toEqual([]);
  });
});
