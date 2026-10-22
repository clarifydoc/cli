import { describe, it, expect } from "vitest";
import { CSharpEntityExtractor } from "./entities.js";
import type { ClassInfo, EntityRelation, FileAnalysis } from "../../../types/analysis.js";

/**
 * Run the C# entity extractor over `src`. The `IEntityTypeConfiguration<T>`
 * path walks `analysis.classes` (it needs each config class's line range to
 * slice its body), so by default we register ONE class spanning the whole
 * source — enough for these single-class fixtures.
 */
function relationsOf(src: string, classes?: Partial<ClassInfo>[]): EntityRelation[] {
  const lines = src.split("\n");
  const cls: ClassInfo[] = (
    classes ?? [{ name: "Config", line: 1, endLine: lines.length }]
  ).map((c) => ({
    name: c.name ?? "Config",
    extends: c.extends ?? null,
    implements: c.implements ?? [],
    decorators: c.decorators ?? [],
    methods: [],
    properties: [],
    isExported: true,
    line: c.line ?? 1,
    endLine: c.endLine ?? lines.length,
  }));
  const analysis = { filePath: "Config.cs", classes: cls } as unknown as FileAnalysis;
  return new CSharpEntityExtractor().extract({ analysis, sourceText: src, lines }).relations;
}

describe("EF Core IEntityTypeConfiguration<T> relations", () => {
  it("derives many-to-one from builder.HasOne(...).WithMany()", () => {
    const rels = relationsOf(
      `public class InstitutionSquadEntityTypeConfiguration : IEntityTypeConfiguration<InstitutionSquad>
       {
         public void Configure(EntityTypeBuilder<InstitutionSquad> builder)
         {
           builder.ToTable("InstitutionSquad");
           builder.HasKey(a => a.Id);
           builder.Property(a => a.InstitutionId);
           builder.HasOne(a => a.Institution).WithMany().OnDelete(DeleteBehavior.Restrict);
         }
       }`,
    );
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      fromEntity: "InstitutionSquad",
      toEntity: "Institution",
      fromField: "Institution",
      cardinality: "many-to-one",
      confidence: "EXTRACTED",
      orm: "ef-core",
    });
  });

  it("captures the foreign key + inverse field across a multi-line chain", () => {
    const rels = relationsOf(
      `public class LicenseConfig : IEntityTypeConfiguration<License>
       {
         public void Configure(EntityTypeBuilder<License> builder)
         {
           builder
             .HasOne(d => d.Part)
             .WithMany(p => p.Licenses)
             .HasForeignKey(d => d.PartId);
         }
       }`,
    );
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      fromEntity: "License",
      toEntity: "Part",
      cardinality: "many-to-one",
      foreignKey: "PartId",
      inverseField: "Licenses",
    });
  });

  it("derives one-to-many from HasMany(...).WithOne()", () => {
    const rels = relationsOf(
      `public class PartConfig : IEntityTypeConfiguration<Part>
       {
         public void Configure(EntityTypeBuilder<Part> builder)
         {
           builder.HasMany(p => p.Licenses).WithOne(l => l.Part).HasForeignKey(l => l.PartId);
         }
       }`,
    );
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      fromEntity: "Part",
      toEntity: "License", // "Licenses" → "License"
      cardinality: "one-to-many",
      foreignKey: "PartId",
    });
  });

  it("emits nothing for a property-only configuration", () => {
    const rels = relationsOf(
      `public class FlexBadgeEntityConfiguration : IEntityTypeConfiguration<TFLEX_BADGE>
       {
         public void Configure(EntityTypeBuilder<TFLEX_BADGE> builder)
         {
           builder.Property(ap => ap.KICKOFF).IsRequired();
           builder.HasKey(a => a.Id);
           builder.HasIndex(b => b.ExternalId).IsUnique();
         }
       }`,
    );
    expect(rels).toHaveLength(0);
  });

  it("resolves the source entity from the EntityTypeBuilder<T> parameter when no interface is present", () => {
    // Some codebases extend a base configuration without re-declaring the
    // interface; the EntityTypeBuilder<T> parameter still names the entity.
    const rels = relationsOf(
      `public static class CarMapping
       {
         public static void Configure(EntityTypeBuilder<Car> builder)
         {
           builder.HasOne(o => o.Driver).WithMany(c => c.Cars);
         }
       }`,
    );
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ fromEntity: "Car", toEntity: "Driver", cardinality: "many-to-one" });
  });

  it("still parses the modelBuilder.Entity<T>() fluent path (regression)", () => {
    const rels = relationsOf(
      `public class AppDbContext : DbContext
       {
         protected override void OnModelCreating(ModelBuilder modelBuilder)
         {
           modelBuilder.Entity<League>().HasMany(b => b.Games).WithOne(p => p.League).HasForeignKey(p => p.LeagueId);
         }
       }`,
      [{ name: "AppDbContext", line: 1, endLine: 999, extends: "DbContext" }],
    );
    const leagueGame = rels.find((r) => r.fromEntity === "League");
    expect(leagueGame).toMatchObject({ toEntity: "Game", cardinality: "one-to-many", foreignKey: "LeagueId" });
  });
});

// ── EF Core ModelSnapshot (generated, authoritative model) ───────────────────

function snapshotRelationsOf(src: string, filePath: string): EntityRelation[] {
  const lines = src.split("\n");
  const analysis = { filePath, classes: [] } as unknown as FileAnalysis;
  return new CSharpEntityExtractor().extract({ analysis, sourceText: src, lines }).relations;
}

describe("EF Core ModelSnapshot relations", () => {
  const SNAPSHOT = `
    modelBuilder.Entity("LeagueData.Domain.Models.InstitutionSquad", b =>
        {
            b.Property<int>("Id");
            b.HasOne("LeagueData.Domain.Models.Institution", "Institution")
                .WithMany()
                .HasForeignKey("InstitutionId")
                .OnDelete(DeleteBehavior.Restrict);
            b.Navigation("Institution");
        });`;

  it("extracts the string-arg HasOne relationship with its exact FK", () => {
    const rels = snapshotRelationsOf(SNAPSHOT, "Migrations/LeagueDataDbContextModelSnapshot.cs");
    expect(rels).toContainEqual(expect.objectContaining({
      fromEntity: "InstitutionSquad", toEntity: "Institution",
      fromField: "Institution", cardinality: "many-to-one", foreignKey: "InstitutionId",
    }));
  });

  it("only parses *ModelSnapshot.cs, never per-migration *.Designer.cs", () => {
    // Designer files embed a full historical snapshot; parsing them would
    // multiply every relation by the migration count.
    expect(snapshotRelationsOf(SNAPSHOT, "Migrations/20190101_Init.Designer.cs")).toHaveLength(0);
  });

  it("treats WithOne as one-to-one", () => {
    const rels = snapshotRelationsOf(
      `modelBuilder.Entity("N.Profile", b =>
         {
             b.HasOne("N.Player", "Player").WithOne().HasForeignKey("N.Profile", "PlayerId");
         });`,
      "Migrations/AppDbContextModelSnapshot.cs",
    );
    expect(rels[0]).toMatchObject({ fromEntity: "Profile", toEntity: "Player", cardinality: "one-to-one" });
  });
});

// ── Project-level cross-file reconciliation ──────────────────────────────────

interface ClsOpts {
  extends?: string | null;
  implements?: string[];
  decorators?: string[];
  properties?: Array<{ name: string; type: string }>;
  line?: number;
  endLine?: number;
}

function cls(name: string, opts: ClsOpts = {}): ClassInfo {
  return {
    name,
    extends: opts.extends ?? null,
    implements: opts.implements ?? [],
    decorators: opts.decorators ?? [],
    methods: [],
    properties: (opts.properties ?? []).map((p) => ({
      name: p.name, type: p.type, visibility: "public", isStatic: false, isReadonly: false,
    })),
    isExported: true,
    line: opts.line ?? 1,
    endLine: opts.endLine ?? 1,
  };
}

function analysis(filePath: string, classes: ClassInfo[]): FileAnalysis {
  return { filePath, classes } as unknown as FileAnalysis;
}

describe("EF Core cross-file entity reconciliation", () => {
  it("tags a POCO declared an entity only via DbSet<T>/config in other files, and derives its navigations", () => {
    const ctx = analysis("Persistence/AppDbContext.cs", [
      cls("AppDbContext", {
        extends: "DbContext",
        properties: [
          { name: "Institution", type: "DbSet<Institution>" },
          { name: "Squad", type: "DbSet<InstitutionSquad>" },
        ],
      }),
    ]);
    const squad = cls("InstitutionSquad", {
      extends: "Season",
      properties: [
        { name: "Id", type: "int" },
        { name: "InstitutionId", type: "int" },
        { name: "Institution", type: "Institution" }, // reference nav
        { name: "Children", type: "ICollection<InstitutionSquad>" }, // collection nav (self-ref)
        { name: "Label", type: "string" },
      ],
    });
    const squadFile = analysis("Domain/Models/InstitutionSquad.cs", [squad]);
    const inst = cls("Institution", { properties: [{ name: "Name", type: "string" }] });
    const instFile = analysis("Domain/Models/Institution.cs", [inst]);

    new CSharpEntityExtractor().reconcileProject([ctx, squadFile, instFile]);

    // Both POCOs are now tagged as EF entities.
    expect(squad.decorators).toEqual(expect.arrayContaining(["entity", "ef-core"]));
    expect(inst.decorators).toEqual(expect.arrayContaining(["entity", "ef-core"]));

    const rels = squadFile.entityRelations ?? [];
    // Reference navigation → many-to-one with the convention FK.
    expect(rels).toContainEqual(expect.objectContaining({
      fromEntity: "InstitutionSquad", toEntity: "Institution",
      fromField: "Institution", cardinality: "many-to-one", foreignKey: "InstitutionId",
    }));
    // Collection navigation → one-to-many (self-referential here).
    expect(rels).toContainEqual(expect.objectContaining({
      fromEntity: "InstitutionSquad", toEntity: "InstitutionSquad",
      fromField: "Children", cardinality: "one-to-many",
    }));
    // Navigation columns are pruned; the scalar FK and plain columns remain.
    const cols = squad.properties.map((p) => p.name);
    expect(cols).toEqual(expect.arrayContaining(["Id", "InstitutionId", "Label"]));
    expect(cols).not.toContain("Institution");
    expect(cols).not.toContain("Children");
  });

  it("does NOT tag a same-named class living in a ViewModel/DTO folder", () => {
    const ctx = analysis("Persistence/AppDbContext.cs", [
      cls("Ctx", { extends: "DbContext", properties: [{ name: "X", type: "DbSet<Institution>" }] }),
    ]);
    const vmInst = cls("Institution", { properties: [{ name: "Name", type: "string" }] });
    const vmFile = analysis("Application/ViewModel/Institution.cs", [vmInst]);
    new CSharpEntityExtractor().reconcileProject([ctx, vmFile]);
    expect(vmInst.decorators).not.toContain("entity");
  });

  it("does NOT tag a migration class named after an entity (real-repo FP: 14 phantom nodes)", () => {
    const ctx = analysis("Persistence/AppDbContext.cs", [
      cls("Ctx", { extends: "DbContext", properties: [{ name: "Fixtures", type: "DbSet<FixtureTag>" }] }),
    ]);
    const migration = cls("FixtureTag", { extends: "Migration" });
    const migrationFile = analysis("League.Database/Migrations/20210519215934_FixtureTag.cs", [migration]);
    const model = cls("FixtureTag", { properties: [{ name: "Title", type: "string" }] });
    const modelFile = { ...analysis("League.Models/Entities/FixtureTag.cs", [model]), projectId: "models" } as FileAnalysis;
    new CSharpEntityExtractor().reconcileProject([{ ...ctx, projectId: "database" } as FileAnalysis, { ...migrationFile, projectId: "database" } as FileAnalysis, modelFile]);
    expect(migration.decorators).not.toContain("entity");
    // The model in its own project is still the entity: the migration beside the DbContext is no rival.
    expect(model.decorators).toContain("entity");
  });

  it("establishes entity-ness from IEntityTypeConfiguration<T> alone (no DbSet)", () => {
    const cfg = analysis("Config/FooConfiguration.cs", [
      cls("FooConfiguration", { implements: ["IEntityTypeConfiguration<Foo>"] }),
    ]);
    const foo = cls("Foo", { properties: [{ name: "Name", type: "string" }] });
    const fooFile = analysis("Domain/Foo.cs", [foo]);
    new CSharpEntityExtractor().reconcileProject([cfg, fooFile]);
    expect(foo.decorators).toEqual(expect.arrayContaining(["entity", "ef-core"]));
  });

  it("of same-named classes, tags the ones in a namespace the DbContext's sub-project imports", () => {
    const using = (source: string) => ({ source, specifiers: [], isDefault: false, isNamespace: true, line: 1 });
    const file = (path: string, projectId: string, classes: ClassInfo[], imports: ReturnType<typeof using>[] = []) =>
      ({ ...analysis(path, classes), language: "csharp", projectId, imports }) as unknown as FileAnalysis;
    const ctx = file("src/League.Infrastructure/LeagueContext.cs", "infra", [
      cls("LeagueContext", { extends: "DbContext", properties: [{ name: "Fixtures", type: "DbSet<Fixture>" }] }),
    ]);
    const usings = file("src/League.Infrastructure/GlobalUsings.cs", "infra", [], [using("League.Domain.AggregatesModel.FixtureAggregate")]);
    const domain = cls("Fixture", { properties: [{ name: "Kickoff", type: "DateTime" }] });
    const viewModel = cls("Fixture", { properties: [{ name: "Kickoff", type: "DateTime" }] });
    const clientDto = cls("Fixture", { properties: [{ name: "Kickoff", type: "DateTime" }] });
    new CSharpEntityExtractor().reconcileProject([
      ctx, usings,
      file("src/League.Domain/AggregatesModel/FixtureAggregate/Fixture.cs", "domain", [domain]),
      file("src/League.API/Application/Queries/FixtureViewModel.cs", "api", [viewModel]),
      file("src/MobileApp/Models/Fixtures/Fixture.cs", "mobile", [clientDto]),
    ]);
    expect([domain, viewModel, clientDto].map((c) => c.decorators.includes("entity"))).toEqual([true, false, false]);
  });

  it("names the entity of a set read through a context another file declares", () => {
    const ctx = analysis("Infrastructure/LeagueContext.cs", [
      cls("LeagueContext", { extends: "DbContext", properties: [{ name: "Subscriptions", type: "DbSet<FanSubscription>" }] }),
    ]);
    const api = { ...analysis("Apis/FanApi.cs", []), language: "csharp", dataSources: [
      { kind: "database", name: "EF: ToListAsync", target: "Subscriptions", entity: "Subscriptions", access: "read", calls: [], line: 16 },
    ] } as unknown as FileAnalysis;
    new CSharpEntityExtractor().reconcileProject([{ ...ctx, language: "csharp" } as FileAnalysis, api]);
    expect(api.dataSources.map((d) => `${d.target} ${d.entity}`)).toEqual(["FanSubscription FanSubscription"]);
  });

  it("establishes entity-ness and the table from the fluent API alone (Entity<T>(b => b.ToTable(…)))", () => {
    const call = (name: string, line: number, args?: string[]) => ({ name, kind: "internal", target: null, line, ...(args ? { args } : {}) });
    const ext = cls("TransferLogExtensions");
    ext.methods = [{ name: "UseTransferLog", line: 3, endLine: 12, params: [], calls: [
      call("builder.Entity<TransferLogEntry>", 5), call("builder.ToTable", 7, ['"TransferLog"']), call("builder.HasKey", 8),
      call("builder.Entity<Agent>", 9),
    ] } as never];
    const cfg = cls("KitConfiguration", { implements: ["IEntityTypeConfiguration<Kit>"] });
    cfg.methods = [{ name: "Configure", line: 3, endLine: 6, params: [], calls: [call("builder.ToTable", 4, ['"club_kits"'])] } as never];
    const csharp = (path: string, classes: ClassInfo[]) => ({ ...analysis(path, classes), language: "csharp" }) as FileAnalysis;
    const entry = cls("TransferLogEntry", { properties: [{ name: "EventId", type: "Guid" }] });
    const agent = cls("Agent", { properties: [{ name: "Name", type: "string" }] });
    const kit = cls("Kit", { properties: [{ name: "Colour", type: "string" }] });
    new CSharpEntityExtractor().reconcileProject([
      csharp("Log/TransferLogExtensions.cs", [ext]), csharp("Config/KitConfiguration.cs", [cfg]),
      csharp("Log/TransferLogEntry.cs", [entry]), csharp("Domain/Agent.cs", [agent]), csharp("Domain/Kit.cs", [kit]),
    ]);
    expect([entry, agent, kit].map((c) => `${c.name} ${c.decorators.includes("entity")} ${c.tableName ?? "-"}`)).toEqual([
      "TransferLogEntry true TransferLog",
      "Agent true -",
      "Kit true club_kits",
    ]);
  });

  it("corrects a config relation guessed from a nav lambda NAME to the property's declared TYPE", () => {
    // `builder.HasOne(a => a.Player)` yields toEntity "Player", but Training.Player
    // is of type SquadSyncPlayer — the real entity node. (Gap 2)
    const cfg = analysis("Config/TrainingConfiguration.cs", [
      cls("TrainingConfiguration", { implements: ["IEntityTypeConfiguration<Training>"] }),
    ]);
    cfg.entityRelations = [{
      fromEntity: "Training", toEntity: "Player", fromField: "Player",
      cardinality: "many-to-one", foreignKey: null, optional: false,
      confidence: "EXTRACTED", orm: "ef-core",
    } as EntityRelation];
    const training = cls("Training", { properties: [{ name: "Player", type: "SquadSyncPlayer" }] });
    const aktFile = analysis("Models/Training.cs", [training]);
    const playerCtx = analysis("Persistence/Ctx.cs", [
      cls("Ctx", { extends: "DbContext", properties: [{ name: "Players", type: "DbSet<SquadSyncPlayer>" }] }),
    ]);
    const player = cls("SquadSyncPlayer", { properties: [{ name: "Name", type: "string" }] });
    const playerFile = analysis("Models/SquadSyncPlayer.cs", [player]);

    new CSharpEntityExtractor().reconcileProject([cfg, aktFile, playerCtx, playerFile]);

    expect(cfg.entityRelations).toContainEqual(expect.objectContaining({
      fromEntity: "Training", toEntity: "SquadSyncPlayer", fromField: "Player",
    }));
    expect((cfg.entityRelations ?? []).some((r) => r.toEntity === "Player")).toBe(false);
  });

  it("reports the foreign key with the column's real casing (or none if absent)", () => {
    // All-caps DB columns: the synthesized convention FK must match the actual
    // column case-insensitively and report its REAL casing. (Gap 1)
    const ctx = analysis("Persistence/Ctx.cs", [
      cls("Ctx", { extends: "DbContext", properties: [{ name: "G", type: "DbSet<Squad>" }] }),
    ]);
    const squad = cls("Squad", {
      properties: [
        { name: "INSTITUTIONID", type: "int" }, // FK column, all-caps
        { name: "Institution", type: "Institution" }, // reference nav
      ],
    });
    const squadFile = analysis("Models/Squad.cs", [squad]);
    const instCtx = analysis("Persistence/Ctx2.cs", [
      cls("Ctx2", { extends: "DbContext", properties: [{ name: "I", type: "DbSet<Institution>" }] }),
    ]);
    const inst = cls("Institution", { properties: [{ name: "Name", type: "string" }] });
    const instFile = analysis("Models/Institution.cs", [inst]);

    new CSharpEntityExtractor().reconcileProject([ctx, squadFile, instCtx, instFile]);

    const rel = (squadFile.entityRelations ?? []).find((r) => r.toEntity === "Institution");
    expect(rel?.foreignKey).toBe("INSTITUTIONID");
  });

  it("does not duplicate relations already extracted for a per-file-discovered entity", () => {
    // Bar was discovered in its own file: already tagged, relation present, nav
    // column already pruned. The reconcile must be a no-op for it.
    const bar = cls("Bar", {
      decorators: ["entity", "ef-core"],
      properties: [{ name: "BazId", type: "int" }], // nav column already pruned
    });
    const barFile = analysis("Domain/Bar.cs", [
      cls("Ctx", { extends: "DbContext", properties: [{ name: "Bars", type: "DbSet<Bar>" }] }),
      bar,
    ]);
    barFile.entityRelations = [{
      fromEntity: "Bar", toEntity: "Baz", fromField: "Baz",
      cardinality: "many-to-one", foreignKey: "BazId", optional: false,
      confidence: "INFERRED", orm: "ef-core",
    } as EntityRelation];
    new CSharpEntityExtractor().reconcileProject([barFile]);
    const barRels = (barFile.entityRelations ?? []).filter((r) => r.fromEntity === "Bar");
    expect(barRels).toHaveLength(1);
  });
});

describe("generic repository access + Marr table mapping (project-level)", () => {
  it("attributes `_movieRepository.Get(id)` to the type argument of the repository's generic base", () => {
    const repo = analysis("Movies/MovieRepository.cs", [
      cls("IMovieRepository", { extends: "IBasicRepository<Movie>" }),
      cls("MovieRepository", { extends: "BasicRepository<Movie>", implements: ["IMovieRepository"] }),
    ]);
    const movie = analysis("Movies/Movie.cs", [cls("Movie", { extends: "ModelBase" })]);
    const mapping = analysis("Datastore/TableMapping.cs", [{
      ...cls("TableMapping"),
      methods: [{ name: "Map", line: 5, endLine: 9, params: [], calls: [{ name: 'Mapper.Entity<Movie>("Movies").RegisterModel', kind: "internal", target: null, line: 6 }] } as any],
    }]);
    const service = analysis("Movies/MovieService.cs", [{
      ...cls("MovieService", { properties: [{ name: "_movieRepository", type: "IMovieRepository" }] }),
      methods: [
        { name: "MovieService", line: 10, endLine: 12, params: [{ name: "movieRepository", type: "IMovieRepository" }], calls: [] } as any,
        { name: "GetMovie", line: 20, endLine: 24, params: [], calls: [
          { name: "_movieRepository.Get", kind: "internal", target: null, line: 21 },
          { name: "_movieRepository.Insert", kind: "internal", target: null, line: 22 },
          { name: "_logger.Info", kind: "internal", target: null, line: 23 },
        ] } as any,
      ],
    }]);
    for (const a of [repo, movie, mapping, service]) { (a as any).language = "csharp"; (a as any).functions = []; (a as any).dataSources = []; }
    new CSharpEntityExtractor().reconcileProject([repo, movie, mapping, service]);
    expect(service.dataSources.map((d) => [d.name, d.entity, d.access])).toEqual([
      ["_movieRepository.Get", "Movie", "read"],
      ["_movieRepository.Insert", "Movie", "write"],
    ]);
    expect(movie.classes[0]!.decorators).toEqual(["entity", "marr", "table:Movies"]);
  });

  it("follows a local the method initializes from a call, typed by what the callee declares it returns", () => {
    const repo = analysis("Repositories/ContractRepository.cs", [
      cls("IContractRepository", { extends: "IIntegerDatabaseRepository<TCONTRACT, ITCONTRACT>" }),
    ]);
    const table = analysis("Tables/TCONTRACT.cs", [cls("TCONTRACT", { extends: "ITCONTRACT" })]);
    const context = analysis("ILeagueDbContext.cs", [
      cls("ILeagueDbContext", { properties: [{ name: "ContractRepository", type: "IContractRepository" }] }),
    ]);
    const service = analysis("FlexibleFixtureService.cs", [{
      ...cls("FlexibleFixtureService"),
      methods: [
        { name: "GetLeagueDbContext", returnType: "Task<ILeagueDbContext>", line: 5, endLine: 8, params: [], calls: [] } as any,
        { name: "MakeBadges", line: 10, endLine: 20, params: [],
          localTypes: [{ name: "leagueDbContext", type: "", from: "GetLeagueDbContext()", awaited: true }],
          calls: [{ name: "leagueDbContext.ContractRepository.GetAllIndexedAsync", kind: "internal", target: null, line: 12 }] } as any,
      ],
    }]);
    for (const a of [repo, table, context, service]) { (a as any).language = "csharp"; (a as any).functions = []; (a as any).dataSources = []; }
    new CSharpEntityExtractor().reconcileProject([repo, table, context, service]);
    expect(service.dataSources.map((d) => [d.name, d.entity, d.access])).toEqual([
      ["leagueDbContext.ContractRepository.GetAllIndexedAsync", "TCONTRACT", "read"],
    ]);
  });
});
