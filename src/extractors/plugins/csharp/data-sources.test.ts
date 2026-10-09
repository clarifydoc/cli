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
  private string GetAktivitetPath(Guid institutionId) => $"{GetBasePath(institutionId)}/aktiviteter";
  public async Task M(Guid institutionId, Guid aktivitetId) {
    await _httpClient.PutAsJsonAsync($"{GetAktivitetPath(institutionId)}/{aktivitetId}/opdateringtilladt", x);
    await _httpClient.PostAsJsonAsync(GetAktivitetPath(institutionId), x);
    var path = GetAktivitetPath(institutionId) + "/vikardaekninger";
    await _httpClient.GetAsync(path);
    await _httpClient.PostAsJsonAsync($"{_basePath}/{_apiVersion}/institution/{institutionId}/loenkoder", x);
    await _httpClient.GetAsync(SomeOtherClass.Url());
  }
}`;
    const tree = await parseSource(src, "csharp" as any, "PlanClient.cs");
    const calls = new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => c.target)).toEqual([
      "internal/api/v3/institution/{institutionId}/aktiviteter/{aktivitetId}/opdateringtilladt",
      "internal/api/v3/institution/{institutionId}/aktiviteter",
      "internal/api/v3/institution/{institutionId}/aktiviteter/vikardaekninger",
      "internal/api/{_apiVersion}/institution/{institutionId}/loenkoder",
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
