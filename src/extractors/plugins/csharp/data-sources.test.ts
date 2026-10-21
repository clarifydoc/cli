import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { CSharpDataSourceExtractor, extractCsharpPathArgCalls } from "./data-sources.js";
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

  it("follows a local holding a query on a set, and reads each set of a LINQ query expression (real-repo FP)", async () => {
    const rows = await dbSourcesOf(`    var q = _db.Set<Entities.Fixture>().AsQueryable();
    var rows = await q.OrderByDescending(e => e.KickOff).ToListAsync(ct);
    var squads = from p in _db.Set<Entities.Player>()
                 join c in _db.Clubs on p.ClubId equals c.Id
                 select p;`);
    expect(rows.map((r) => `${r.name} ${r.entity} ${r.access}`)).toEqual([
      "EF: ToListAsync Fixture read",
      "EF: from Player read",
      "EF: join Clubs read",
    ]);
  });

  it("never reads a framework context's collections as entity sets (real-repo FP)", async () => {
    const src = `namespace X;
public class LeagueValueProviderFactory : IValueProviderFactory {
  public Task CreateValueProviderAsync(ValueProviderFactoryContext context) {
    context.ValueProviders.Add(new LeagueValueProvider());
    return Task.CompletedTask;
  }
}`;
    const tree = await parseSource(src, "csharp" as any, "F.cs");
    expect(new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database")).toEqual([]);
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

/**
 * Desktop/GUI I/O sinks. A Blazor Hybrid / WinUI tool app (DevToys) has no HTTP
 * or DB tier — its "data" is the settings store, clipboard, and picked files.
 * Surfacing these as `database` data sources (with a distinguishing `target`
 * label + a synthetic entity) lights up the screen→data-access→entity trace +
 * Data Model — the desktop analogue of screen→route→DB.
 */
describe("C# HTTP-client URLs a client builds from its own fields and helpers", () => {
  it("substitutes literal string fields and same-file path helpers into the URL", async () => {
    const src = `namespace X;
public class PlanClient {
  private readonly HttpClient _httpClient;
  protected readonly string _basePath = "internal/api";
  private static readonly string _versionThree = "v3";
  private readonly string _apiVersion;
  private string GetBasePath(Guid institutionId)
  {
    return $"{_basePath}/{_versionThree}/institution/{institutionId}";
  }
  private string GetTrainingPath(Guid institutionId) => $"{GetBasePath(institutionId)}/trainings";
  public async Task M(Guid institutionId, Guid trainingId) {
    await _httpClient.PutAsJsonAsync($"{GetTrainingPath(institutionId)}/{trainingId}/updateallowed", x);
    await _httpClient.PostAsJsonAsync(GetTrainingPath(institutionId), x);
    var path = GetTrainingPath(institutionId) + "/substitutions";
    await _httpClient.GetAsync(path);
    await _httpClient.PostAsJsonAsync($"{_basePath}/{_apiVersion}/institution/{institutionId}/wagecodes", x);
    await _httpClient.GetAsync(SomeOtherClass.Url());
  }
}`;
    const tree = await parseSource(src, "csharp" as any, "PlanClient.cs");
    const calls = new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => c.target)).toEqual([
      "internal/api/v3/institution/{institutionId}/trainings/{trainingId}/updateallowed",
      "internal/api/v3/institution/{institutionId}/trainings",
      "internal/api/v3/institution/{institutionId}/trainings/substitutions",
      "internal/api/${this._apiVersion}/institution/{institutionId}/wagecodes",
      null,
    ]);
  });
});

async function ioSourcesOf(body: string): Promise<DataSourceInfo[]> {
  const src = `namespace X;
public class T {
  private readonly ISettingsProvider _settingsProvider;
  private readonly IClipboard _clipboard;
  private readonly IFileStorage _fileStorage;
  public async Task M() {
${body}
  }
}`;
  const tree = await parseSource(src, "csharp" as any, "T.cs");
  return new CSharpDataSourceExtractor()
    .extract(tree, src)
    .filter((d) => d.kind === "database");
}

describe("C# desktop I/O sinks — settings / clipboard / file storage", () => {
  it("maps GetSetting/SetSetting to the Settings resource", async () => {
    const s = await ioSourcesOf(
      `    var lang = _settingsProvider.GetSetting(PredefinedSettings.Language);\n    _settingsProvider.SetSetting(PredefinedSettings.Language, "en");`,
    );
    expect(s.map((x) => x.entity)).toEqual(["Settings", "Settings"]);
    expect(s.every((x) => x.target === "settings")).toBe(true);
  });

  it("maps (Get|Set)Clipboard* to the Clipboard resource", async () => {
    const s = await ioSourcesOf(`    await _clipboard.SetClipboardTextAsync("hi");`);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ entity: "Clipboard", target: "clipboard" });
  });

  it("maps distinctive file-storage verbs on name, generic verbs only on a file-storage receiver", async () => {
    const s = await ioSourcesOf(
      `    await _fileStorage.PickOpenFileAsync("*.json");\n    using var w = _fileStorage.OpenWriteFile("out.txt", true);`,
    );
    expect(s.map((x) => x.entity)).toEqual(["FileStorage", "FileStorage"]);
  });

  it("does NOT treat a non-file-storage receiver's OpenWriteFile as I/O", async () => {
    // `OpenWriteFile` is generic enough to require a file-storage-shaped receiver.
    const s = await ioSourcesOf(`    var x = _helper.OpenWriteFile("out.txt");`);
    expect(s).toHaveLength(0);
  });
});

describe("EF through a member holding the context", () => {
  it("reads `services.Context.CatalogItems…` as the CatalogItems DbSet", async () => {
    const { parseSource } = await import("../../../parsers/parser-manager.js");
    const { CSharpDataSourceExtractor } = await import("./data-sources.js");
    const src = `public static class CatalogApi {
  public static async Task<CatalogItem?> GetItemById([AsParameters] CatalogServices services, int id)
  {
    return await services.Context.CatalogItems.Include(ci => ci.CatalogBrand).SingleOrDefaultAsync(ci => ci.Id == id);
  }
}`;
    const tree = await parseSource(src, "csharp" as never, "CatalogApi.cs");
    const rows = new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database");
    expect(rows.map((d) => `${d.name} ${d.entity ?? "-"}`)).toEqual(expect.arrayContaining(["EF: SingleOrDefaultAsync CatalogItems"]));
  });
});

describe("C# raw SQL — the table a command runs against", () => {
  it("reads an ADO.NET command's text, set or constructed, and Dapper's SQL argument", async () => {
    const rows = (await dbSourcesOf(`    using var cmd = conn.CreateCommand();
    cmd.CommandText = "SELECT body FROM notes WHERE id = $id";
    var body = cmd.ExecuteScalar();
    cmd.CommandText = @"UPDATE notes SET body = ""x""";
    cmd.ExecuteNonQuery();
    var deleteCommand = new SqlCommand("DELETE FROM audit_log", conn);
    deleteCommand.ExecuteNonQuery();
    var builtCommand = new SqlCommand(sql, conn);
    builtCommand.ExecuteReader();
    var n = await connection.QueryAsync<Car>("SELECT * FROM cars");`)).map((d) => `${d.name} ${d.entity ?? "-"} ${d.access ?? "-"}`);
    expect(rows).toEqual([
      "ADO.NET: ExecuteScalar notes read",
      "ADO.NET: ExecuteNonQuery notes write",
      "ADO.NET: ExecuteNonQuery audit_log write",
      "ADO.NET: ExecuteReader - read",
      "Dapper: QueryAsync cars read",
    ]);
  });
});

describe("C# HttpClient JSON bodies", () => {
  it("states the body an anonymous object, an object initializer or a local sends, in the camelCase the JSON helpers write", async () => {
    const src = `namespace X;
public class H {
  private readonly HttpClient _http;
  public async Task M(string name, string email) {
    await _http.PostAsJsonAsync("/api/players", new { Name = name, Age = 3, Tags = new[] { "a" }, Address = new { City = "x" }, email });
    await _http.PutAsJsonAsync("/api/players/1", new UpdatePlayer { Name = "n", Active = true, Score = 1.5 });
    var dto = new { Title = $"t{name}" };
    await _http.PatchAsJsonAsync("/api/x", dto);
    await _http.PostAsJsonAsync("/api/y", someDto);
  }
}`;
    const tree = await parseSource(src, "csharp" as any, "H.cs");
    const calls = new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call").map((d) => [d.name, d.requestBody ?? null]);
    expect(calls).toEqual([
      ["PostAsJsonAsync", { type: "object", properties: { name: {}, age: { type: "integer" }, tags: { type: "array", items: { type: "string" } }, address: { type: "object", properties: { city: { type: "string" } } }, email: {} } }],
      ["PutAsJsonAsync", { type: "object", properties: { name: { type: "string" }, active: { type: "boolean" }, score: { type: "number" } } }],
      ["PatchAsJsonAsync", { type: "object", properties: { title: { type: "string" } } }],
      ["PostAsJsonAsync", null],
    ]);
  });
});

describe("EF through a name declared as a DbSet", () => {
  async function rowsOf(src: string): Promise<DataSourceInfo[]> {
    const tree = await parseSource(src, "csharp" as any, "R.cs");
    return new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database");
  }

  it("reads a field typed DbSet<T> as that entity's set, one row per chain", async () => {
    const rows = await rowsOf(`namespace X;
public class NoteRepository {
  private readonly DbSet<Note> _repository;
  public async Task<Note> Insert(Note n, CancellationToken ct) => (await _repository.AddAsync(n, ct)).Entity;
  public Task<Note[]> List(Guid id, CancellationToken ct) =>
    _repository.TagWith("x").Where(n => n.Id == id).Include(n => n.Owner).ToArrayAsync(ct);
  public void Drop(Note n) { this._repository.Remove(n); }
}`);
    expect(rows.map((d) => `${d.name} ${d.entity} ${d.access ?? "-"}`)).toEqual([
      "EF: AddAsync Note write",
      "EF: ToArrayAsync Note read",
      "EF: Remove Note write",
    ]);
  });

  it("keeps the inner access when the operator after it is no EF access of its own", async () => {
    const rows = await rowsOf(`namespace X;
public class LeagueDbContext : DbContext {
  public async Task<int> Version(CancellationToken ct) {
    var v = await Set<LeagueDbVersionInfo>().FromSqlRaw(_getVersion).FirstAsync(ct);
    return v.Version;
  }
}`);
    expect(rows.map((d) => d.name)).toEqual(["EF: FromSqlRaw"]);
  });

  it("names no entity for a method's own type parameter", async () => {
    const rows = await rowsOf(`namespace X;
public class DatabaseFixture {
  private void CleanDbSet<T>(DbSet<T> dbSet) where T : class { dbSet.RemoveRange(dbSet); }
}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity).toBeUndefined();
  });

  it("records a generic base repository's set without naming its type parameter", async () => {
    const rows = await rowsOf(`namespace X;
public abstract class BaseRepository<TContext, TClass> where TClass : class {
  protected readonly DbSet<TClass> _dbSet;
  public void Track(TClass dto) { _dbSet.Attach(dto); }
}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "EF: Attach", target: "_dbSet", access: "write" });
    expect(rows[0]!.entity).toBeUndefined();
  });
});

describe("C# HTTP-client URLs — scope of a name", () => {
  async function targetsOf(src: string): Promise<Array<string | null>> {
    const tree = await parseSource(src, "csharp" as any, "C.cs");
    return new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call").map((d) => d.target);
  }

  it("keeps a method's own const to that method", async () => {
    expect(await targetsOf(`namespace X;
public class WageClient {
  private readonly HttpClient _httpClient;
  public async Task Create(Guid institutionId) {
    string url = $"api/v2/{institutionId}/report/";
    await _httpClient.PostAsync(url, null);
  }
  public async Task Failed() {
    const string url = "api/v2/report/injury/failed";
    await _httpClient.GetAsync(url);
  }
  public async Task Later(Guid institutionId) {
    string url = $"api/v2/{institutionId}/injury";
    await _httpClient.PutAsync(url, null);
  }
}`)).toEqual(["api/v2/{institutionId}/report/", "api/v2/report/injury/failed", "api/v2/{institutionId}/injury"]);
  });

  it("writes a hole the method does not declare as a member of the class", async () => {
    expect(await targetsOf(`namespace X;
public class LeagueDataV2HttpClient : BaseLeagueDataHttpClient {
  public async Task Create(Guid institutionId, CancellationToken ct) {
    var uriBase = $"{BasePath}/{BaseVersion}/institution/{institutionId}/person";
    await _httpClient.PostAsync(uriBase, null, ct);
  }
}`)).toEqual(["${this.BasePath}/${this.BaseVersion}/institution/{institutionId}/person"]);
  });
});

describe("C# message routing keys", () => {
  async function queueRowsOf(src: string): Promise<string[]> {
    const tree = await parseSource(src, "csharp" as any, "Q.cs");
    return new CSharpDataSourceExtractor().extract(tree, src)
      .filter((d) => d.kind === "queue-publish" || d.kind === "queue-consume")
      .map((d) => `${d.kind} ${d.target} ${d.line}`);
  }

  it("reads the routing key an outbox writer decides on as what it publishes", async () => {
    expect(await queueRowsOf(`namespace X;
public class PlanContext : DbContext {
  public override async Task<int> SaveChangesAsync(CancellationToken ct) {
    string routingKey = null;
    switch (entry.State) {
      case EntityState.Added: routingKey = PlanRouting.TrainingCreated; break;
      case EntityState.Deleted: routingKey = Core.Routing.PlanRouting.TrainingDeleted; break;
    }
    var key = message.RoutingKey;
    events.Add(new EventLogEntry(eventObject, routingKey, correlationId));
    return 0;
  }
}`)).toEqual(["queue-publish PlanRouting.TrainingCreated 6", "queue-publish PlanRouting.TrainingDeleted 7"]);
  });

  it("reads each constant case of a switch on a delivered message's routing key as what it consumes", async () => {
    expect(await queueRowsOf(`namespace X;
public class DefaultConsumer {
  public async Task<bool> ConsumeMessageAsync(EventMessage message) {
    switch (message.RoutingKey) {
      case PlanRouting.TrainingCreated:
        await Handle(message); break;
      case "Substitute.Injury.Created":
      case SubstituteRouting.InjuryDeleted:
        break;
    }
    switch (entry.State) { case EntityState.Added: break; }
    return true;
  }
}`)).toEqual([
      "queue-consume PlanRouting.TrainingCreated 5",
      "queue-consume Substitute.Injury.Created 7",
      "queue-consume SubstituteRouting.InjuryDeleted 8",
    ]);
  });
});

describe("C# EF migration SQL", () => {
  it("reads each data statement of migrationBuilder.Sql as a database access on its table", async () => {
    const src = `namespace X;
public partial class Add_Roles : Migration {
  protected override void Up(MigrationBuilder migrationBuilder) {
    migrationBuilder.Sql(@"INSERT INTO ""Roles"" (""Name"") VALUES ('FixtureManager');
      UPDATE ""Contracts"" SET ""Role"" = 1;");
    migrationBuilder.Sql("UPDATE \\"ContractWageMetadata\\" SET \\"Wagesystem\\" = 3");
    migrationBuilder.Sql("CREATE INDEX ix ON \\"Roles\\" (\\"Name\\")");
    migrationBuilder.Sql(@"DELETE FROM ""public"".""Coaching"" u WHERE u.""TacticId"" IS NULL");
  }
}`;
    const tree = await parseSource(src, "csharp" as any, "Migrations/20260618_Add_Roles.cs");
    const rows = new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "database");
    expect(rows.map((d) => `${d.name} ${d.entity} ${d.access} ${d.line}`)).toEqual([
      "EF migration: INSERT Roles write 4",
      "EF migration: UPDATE Contracts write 4",
      "EF migration: UPDATE ContractWageMetadata write 6",
      "EF migration: DELETE Coaching write 8",
    ]);
  });
});

describe("C# HTTP helpers handed their URL", () => {
  const src = `namespace X;
public abstract class BaseHttpClient {
  protected async Task<T> Get<T>(string uri, CancellationToken ct) {
    using (var response = await _httpClient.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct)) { return default; }
  }
}
public class LeagueDataV2HttpClient : BaseHttpClient {
  public Task<PersonViewModel> GetPerson(Guid institutionId, Guid id, CancellationToken ct) {
    var uri = $"{BasePath}/{BaseVersion}/institution/{institutionId}/person/{id}";
    return Get<PersonViewModel>(uri, ct);
  }
  public void Log(string message) { Write(message); }
}`;

  it("states the helper's URL as its parameter, a hole each call site fills", async () => {
    const tree = await parseSource(src, "csharp" as any, "C.cs");
    const calls = new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => c.target)).toEqual(["${uri}"]);
  });

  it("reports each call that hands a method a path, evaluated as the URL it is", async () => {
    const tree = await parseSource(src, "csharp" as any, "C.cs");
    expect(extractCsharpPathArgCalls(tree, src)).toEqual([
      { callee: "Get", args: ["${this.BasePath}/${this.BaseVersion}/institution/{institutionId}/person/{id}", null], line: 10 },
    ]);
  });
});

describe("C# consumers that filter on the routing key", () => {
  it("consume the key they compare against (real-repo FP)", async () => {
    const src = `namespace League;
public class MatchPlayedConsumer : BaseConsumer {
  protected override async Task Consume(string routingKey, byte[] body) {
    if (routingKey != MatchPlayedMessage.RoutingKey) return;
    if (routingKey == otherKey) return;
    await _handler.Handle(body);
  }
}`;
    const tree = await parseSource(src, "csharp" as any, "C.cs");
    const rows = new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "queue-consume");
    expect(rows.map((r) => `${r.name} ${r.target}`)).toEqual(["MQ: routing key filter MatchPlayedMessage.RoutingKey"]);
  });

  it("and the publish handing over that key names it as its destination", async () => {
    const src = `namespace League;
public class RecordMatch {
  public async Task Handle(Match m, CancellationToken ct) {
    await _producer.ProduceAsync(new MatchPlayedMessage(m.Id), MatchPlayedMessage.RoutingKey, ct);
  }
}`;
    const tree = await parseSource(src, "csharp" as any, "P.cs");
    const rows = new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "queue-publish");
    expect(rows.map((r) => `${r.target} ${r.entity}`)).toEqual(["MatchPlayedMessage.RoutingKey MatchPlayedMessage"]);
  });
});
