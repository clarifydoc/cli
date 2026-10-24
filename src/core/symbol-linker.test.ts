import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, FileAnalysis } from "../types/analysis.js";

const call = (name: string, line = 2): CallInfo => ({ name, kind: "internal", target: null, line });

const fn = (name: string, calls: CallInfo[]) =>
  ({ name, line: 1, endLine: 5, params: [], calls } as any);

const cls = (name: string) =>
  ({ name, kind: "class", extends: null, implements: [], methods: [], properties: [], line: 1, endLine: 3 } as any);

const file = (filePath: string, projectId: string, opts: { functions?: any[]; classes?: any[] }): FileAnalysis =>
  ({
    filePath,
    projectId,
    language: "csharp",
    functions: opts.functions ?? [],
    classes: opts.classes ?? [],
    imports: [],
    exports: [],
    routes: [],
    dataSources: [],
  } as unknown as FileAnalysis);

describe("symbol-linker — C# cross-project + generic type-arg resolution", () => {
  it("resolves `new XCommand()` to its record in another sub-project (unique name)", () => {
    const api = file("Api/OwnersController.cs", "Api", {
      classes: [{ ...cls("OwnersController"), methods: [fn("Create", [call("new CreateOwnerCommand")])] }],
    });
    const app = file("Application/CreateOwnerCommand.cs", "Application", { classes: [cls("CreateOwnerCommand")] });
    const links = buildSymbolLinks([api, app]);
    expect(links.some((l) => l.targetFile === "Application/CreateOwnerCommand.cs")).toBe(true);
  });

  it("resolves a generic type argument (`_db.Set<Club>()`) to the unique type's file", () => {
    const repo = file("Infra/ClubRepository.cs", "Infra", {
      classes: [{ ...cls("ClubRepository"), methods: [fn("GetAll", [call("_db.Set<Club>")])] }],
    });
    const domain = file("Domain/Club.cs", "Domain", { classes: [cls("Club")] });
    const links = buildSymbolLinks([repo, domain]);
    expect(links.some((l) => l.targetFile === "Domain/Club.cs")).toBe(true);
  });

  it("resolves a call on a dependency INHERITED from a base handler (`_repository.AddAsync`)", () => {
    // CQRS base-handler pattern: the injected repo lives on the base class.
    const iface = file("Shared/IRepository.cs", "Shared", {
      classes: [{ ...cls("IRepository"), kind: "interface", methods: [{ name: "AddAsync", line: 7, endLine: 7, params: [], calls: [] }] }],
    });
    const base = file("Shared/BaseCommandHandler.cs", "Shared", {
      classes: [{ ...cls("BaseCommandHandler"), properties: [{ name: "_repository", type: "IRepository<TResult>" }] }],
    });
    const handler = file("App/CreateClubCommandHandler.cs", "App", {
      classes: [{
        ...cls("CreateClubCommandHandler"),
        extends: "BaseCommandHandler<CreateClubCommand, Club>",
        methods: [fn("Handle", [call("_repository.AddAsync")])],
      }],
    });
    const links = buildSymbolLinks([iface, base, handler]);
    expect(links.some((l) => l.sourceFile === "App/CreateClubCommandHandler.cs" && l.targetFile === "Shared/IRepository.cs")).toBe(true);
  });

  it("does NOT resolve a generic arg when the type name is not globally unique (avoids false edges)", () => {
    const repo = file("Infra/ClubRepository.cs", "Infra", {
      classes: [{ ...cls("ClubRepository"), methods: [fn("GetAll", [call("_db.Set<Club>")])] }],
    });
    const d1 = file("Domain/Club.cs", "Domain", { classes: [cls("Club")] });
    const d2 = file("Scaffold/Club.cs", "Infra", { classes: [cls("Club")] });
    const links = buildSymbolLinks([repo, d1, d2]);
    expect(links.some((l) => /Club\.cs$/.test(l.targetFile) && l.sourceFile === "Infra/ClubRepository.cs")).toBe(false);
  });
});

describe("symbol-linker — factory fallback via binding provenance (Strategy 3b)", () => {
  it("links mutation.mutateAsync to the FACTORY when the leaf is not in the target module", () => {
    const component = file("spa/CreateLicense.vue", "spa", {
      functions: [fn("submit", [
        { name: "licenseMutation.mutateAsync", kind: "cross-file", target: "./LicenseQueries", via: "useAddLicenseMutation", line: 3 },
      ])],
    });
    const queries = file("spa/LicenseQueries.ts", "spa", {
      functions: [fn("useAddLicenseMutation", [])],
    });
    const links = buildSymbolLinks([component, queries]);
    const hit = links.find((l) => l.targetSymbol === "useAddLicenseMutation");
    expect(hit).toBeDefined();
    expect(hit!.sourceSymbol).toBe("submit");
    expect(hit!.confidence).toBe("INFERRED");
  });

  it("prefers a REAL member over the factory when the leaf exists in the module", () => {
    const component = file("spa/Garage.vue", "spa", {
      functions: [fn("onClick", [
        { name: "garage.updateQuantity", kind: "cross-file", target: "./useGarage", via: "useGarage", line: 3 },
      ])],
    });
    const composable = file("spa/useGarage.ts", "spa", {
      functions: [fn("useGarage", []), fn("updateQuantity", [])],
    });
    const links = buildSymbolLinks([component, composable]);
    expect(links.find((l) => l.sourceSymbol === "onClick")?.targetSymbol).toBe("updateQuantity");
  });
});

describe("symbol-linker — language-family fence on name heuristics", () => {
  it("does NOT bind a JS `new Error()` to a C# class named Error (real-repo FP)", () => {
    const spa = {
      ...file("spa/queries/SubstatusQueries.ts", "spa", {
        functions: [fn("fetchSubstatus", [call("new Error")])],
      }),
      language: "typescript",
    } as unknown as FileAnalysis;
    const backend = file("src/Core/ComonLib.Exceptions/Error.cs", "ComonLib", {
      classes: [cls("Error")],
    });
    const links = buildSymbolLinks([spa, backend]);
    expect(links.some((l) => l.targetFile === "src/Core/ComonLib.Exceptions/Error.cs")).toBe(false);
  });

  it("still resolves same-family constructors cross-project", () => {
    const spa = {
      ...file("spa/pages/Create.vue", "spa", {
        functions: [fn("submit", [call("new LicensePayload")])],
      }),
      language: "vue",
    } as unknown as FileAnalysis;
    const lib = {
      ...file("lib/models/LicensePayload.ts", "lib", { classes: [cls("LicensePayload")] }),
      language: "typescript",
    } as unknown as FileAnalysis;
    const links = buildSymbolLinks([spa, lib]);
    expect(links.some((l) => l.targetFile === "lib/models/LicensePayload.ts")).toBe(true);
  });
});

describe("symbol-linker — route-handler fallback guards (pit-stop FPs)", () => {
  const route = (path: string, handler: string) =>
    ({ path, httpMethod: "GET", handler, kind: "api", line: 3, calls: [] }) as any;

  it("never links a route handler across language families (Laravel #create → Kotlin DAO)", () => {
    const webPhp = {
      ...file("web/LEGACY/routes/web.php", "web", {}),
      language: "php",
      routes: [route("/dashboard", "DashboardController#create")],
    } as unknown as FileAnalysis;
    const dao = {
      ...file("server/dao/BackendChatDAO.kt", "server", {
        classes: [{ ...cls("BackendChatDAO"), methods: [fn("create", [])] }],
      }),
      language: "kotlin",
    } as unknown as FileAnalysis;
    const links = buildSymbolLinks([webPhp, dao]);
    expect(links.some((l) => l.targetFile === "server/dao/BackendChatDAO.kt")).toBe(false);
  });

  it("joins an OpenAPI spec route to its handler by operationId (spec-language file)", () => {
    const spec = {
      ...file("api/openapi.yaml", "api", {}),
      language: "openapi",
      routes: [{ path: "/players", httpMethod: "GET", handler: "listPlayers", kind: "api", line: 7, calls: [] }],
    } as unknown as FileAnalysis;
    const controller = file("src/players.controller.ts", "api", {
      functions: [fn("listPlayers", [])],
    });
    (controller as any).language = "typescript";
    const links = buildSymbolLinks([spec, controller]);
    const specLink = links.find((l) => l.sourceFile === "api/openapi.yaml" && l.callName === "listPlayers");
    expect(specLink?.targetFile).toBe("src/players.controller.ts");
  });

  it("joins a WSDL PascalCase operation to a camelCase Java handler (GetPlayer → getPlayer)", () => {
    const wsdl = {
      ...file("api/players.wsdl", "api", {}),
      language: "wsdl",
      routes: [{ path: "/GetPlayer", httpMethod: null, handler: "GetPlayer", kind: "api", line: 5, calls: [] }],
    } as unknown as FileAnalysis;
    const impl = file("src/PlayerServiceImpl.java", "api", {
      classes: [{ ...cls("PlayerServiceImpl"), methods: [fn("getPlayer", [])] }],
    });
    (impl as any).language = "java";
    const links = buildSymbolLinks([wsdl, impl]);
    expect(links.some((l) => l.sourceFile === "api/players.wsdl" && l.targetFile === "src/PlayerServiceImpl.java")).toBe(true);
  });

  it("requires the qualified handler's class to be evidenced in the target file", () => {
    const webPhp = {
      ...file("web/LEGACY/routes/web.php", "web", {}),
      language: "php",
      routes: [route("/dashboard", "DashboardController#create")],
    } as unknown as FileAnalysis;
    const wrong = {
      ...file("web/LEGACY/app/Models/Car.php", "web", {
        classes: [{ ...cls("Car"), methods: [fn("create", [])] }],
      }),
      language: "php",
    } as unknown as FileAnalysis;
    const right = {
      ...file("web/LEGACY/app/Http/Controllers/DashboardController.php", "web", {
        classes: [{ ...cls("DashboardController"), methods: [fn("create", [])] }],
      }),
      language: "php",
    } as unknown as FileAnalysis;
    const links = buildSymbolLinks([webPhp, wrong, right]);
    const handlerLinks = links.filter((l) => l.sourceSymbol.startsWith("route:") && l.callName === "DashboardController#create");
    expect(handlerLinks.some((l) => l.targetFile === "web/LEGACY/app/Models/Car.php")).toBe(false);
    expect(handlerLinks.some((l) => l.targetFile === "web/LEGACY/app/Http/Controllers/DashboardController.php")).toBe(true);
  });

  it("never binds a `Class.method` handler to another class's method by name alone", () => {
    const groovy = (path: string, opts: Parameters<typeof file>[2]) =>
      ({ ...file(path, "app", opts), language: "groovy" }) as unknown as FileAnalysis;
    // Grails `resources: "stadium"` routes every REST action, `create` included,
    // and `/api/reviews` names a controller the project does not have.
    const mappings = {
      ...groovy("grails-app/controllers/UrlMappings.groovy", {}),
      routes: [route("/api/stadiums/create", "StadiumController.create"), route("/api/reviews", "ReviewController.save")],
    } as unknown as FileAnalysis;
    const controller = groovy("grails-app/controllers/StadiumController.groovy", {
      classes: [{ ...cls("StadiumController"), methods: [fn("save", [])] }],
    });
    const service = groovy("grails-app/services/StadiumService.groovy", {
      classes: [{ ...cls("StadiumService"), methods: [fn("create", [])] }],
    });
    const links = buildSymbolLinks([mappings, controller, service]).filter((l) => l.sourceSymbol.startsWith("route:"));
    expect(links).toEqual([]);
  });

  it("grades a route-scan link by whether the route states its target", () => {
    const php = (path: string, opts: Parameters<typeof file>[2]) =>
      ({ ...file(path, "web", opts), language: "php" }) as unknown as FileAnalysis;
    const routes = {
      ...php("routes/api.php", {}),
      routes: [route("/api/player", "PlayerController#index"), route("/api/health", "ping")],
    } as unknown as FileAnalysis;
    const controller = php("app/Http/Controllers/PlayerController.php", {
      classes: [{ ...cls("PlayerController"), methods: [fn("index", [])] }],
    });
    const helpers = php("app/helpers.php", { functions: [fn("ping", [])] });
    const graded = (files: FileAnalysis[]) =>
      buildSymbolLinks(files).filter((l) => l.sourceSymbol.startsWith("route:")).map((l) => [l.callName, l.confidence]);
    // The one `PlayerController.index`: named by the route, only the import is missing.
    // A bare handler name found by search stays a guess.
    expect(graded([routes, controller, helpers])).toEqual([
      ["PlayerController#index", "INFERRED"],
      ["ping", "AMBIGUOUS"],
    ]);
    // Two controllers of that name: whichever is linked is a guess.
    const other = php("legacy/PlayerController.php", {
      classes: [{ ...cls("PlayerController"), methods: [fn("index", [])] }],
    });
    expect(graded([routes, controller, other])[0]).toEqual(["PlayerController#index", "AMBIGUOUS"]);
  });

  it("keeps a `Class.method` handler whose class is namespaced on the target side (Phoenix)", () => {
    const router = {
      ...file("lib/app_web/router.ex", "app", {}),
      language: "elixir",
      routes: [route("/api/players/:id", "PlayerController.show")],
    } as unknown as FileAnalysis;
    const controller = {
      ...file("lib/app_web/player_controller.ex", "app", {
        classes: [{ ...cls("AppWeb.PlayerController"), methods: [fn("show", [])] }],
      }),
      language: "elixir",
    } as unknown as FileAnalysis;
    const links = buildSymbolLinks([router, controller]).filter((l) => l.sourceSymbol.startsWith("route:"));
    expect(links.map((l) => l.targetSymbol)).toEqual(["AppWeb.PlayerController.show"]);
  });
});

describe("symbol-linker — Strategy 7 evidence gate (stdlib-name magnets)", () => {
  // A repo-unique leaf name must not magnet every qualified call in the repo:
  // require the target to be imported, same-directory, or the source file to
  // be import-blind (no resolvable imports at all).
  const helper = file("b/svc/Helper.cs", "app", { classes: [cls("Helper")] });
  const caller = (imports: Array<{ source: string; specifiers: string[] }>) =>
    ({
      ...file("b/svc/Caller.cs", "app", {
        classes: [{ ...cls("Caller"), methods: [fn("Run", [call("existing.computeOverview")])] }],
      }),
      imports: imports.map((i) => ({ ...i, isDefault: false, isNamespace: false, isType: false, line: 1 })),
    } as unknown as FileAnalysis);
  const target = file("a/api/DriverApiImpl.cs", "app", {
    classes: [{ ...cls("DriverApiImpl"), methods: [fn("computeOverview", [])] }],
  });

  it("does NOT link a unique leaf across directories without import evidence", () => {
    const links = buildSymbolLinks([caller([{ source: "./Helper", specifiers: ["Helper"] }]), helper, target]);
    expect(links.some((l) => l.targetFile === "a/api/DriverApiImpl.cs")).toBe(false);
  });

  it("links when the source file imports the target", () => {
    const links = buildSymbolLinks([
      caller([{ source: "../../a/api/DriverApiImpl", specifiers: ["DriverApiImpl"] }]),
      helper,
      target,
    ]);
    expect(links.some((l) => l.targetFile === "a/api/DriverApiImpl.cs")).toBe(true);
  });

  it("links a same-directory target (same package needs no import)", () => {
    const sameDir = file("b/svc/DriverApiImpl.cs", "app", {
      classes: [{ ...cls("DriverApiImpl"), methods: [fn("computeOverview", [])] }],
    });
    const links = buildSymbolLinks([caller([{ source: "./Helper", specifiers: ["Helper"] }]), helper, sameDir]);
    const link = links.find((l) => l.targetFile === "b/svc/DriverApiImpl.cs");
    expect(link).toBeDefined();
    // Same directory IS evidence — the stronger of the two sub-tiers.
    expect(link!.strategy).toBe("unique-global");
  });

  it("keeps the old behavior for import-blind source files", () => {
    const links = buildSymbolLinks([caller([]), helper, target]);
    const link = links.find((l) => l.targetFile === "a/api/DriverApiImpl.cs");
    expect(link).toBeDefined();
    // Same edge, same AMBIGUOUS confidence, but reached with no evidence at all
    // — only the strategy tag separates it from the case above, which is the
    // whole reason strategy 7 was split.
    expect(link!.strategy).toBe("unique-global-blind");
    expect(link!.confidence).toBe("AMBIGUOUS");
  });

  it("never links production code into a test file by a unique name alone", () => {
    const inTests = file("a/tests/DriverApiImpl.cs", "app", {
      classes: [{ ...cls("DriverApiImpl"), methods: [fn("computeOverview", [])] }],
    });
    const links = buildSymbolLinks([caller([]), helper, inTests]);
    expect(links.some((l) => l.targetFile === "a/tests/DriverApiImpl.cs")).toBe(false);
  });

  it("never links a JDK/stdlib member name (builtin veto), even same-directory", () => {
    const sameDirToList = file("b/svc/Utils.cs", "app", {
      classes: [{ ...cls("Utils"), methods: [fn("toList", [])] }],
    });
    const src = {
      ...file("b/svc/Caller2.cs", "app", {
        classes: [{ ...cls("Caller2"), methods: [fn("Run", [call("items.toList")])] }],
      }),
      imports: [],
    } as unknown as FileAnalysis;
    const links = buildSymbolLinks([src, sameDirToList]);
    expect(links.some((l) => l.targetFile === "b/svc/Utils.cs")).toBe(false);
  });
});

describe("symbol-linker — Strategy 7 receiver-type contradiction veto", () => {
  // `existing.setStartDate()` where `existing` is declared `Club` must not
  // bind DriverEntity.setStartDate — even when DriverEntity is imported
  // (evidence gate passes) and the setter name is repo-unique.
  const driverEntity = file("jpa/DriverEntity.cs", "app", {
    classes: [{ ...cls("DriverEntity"), methods: [fn("setStartDate", [])] }],
  });
  const clubEntity = file("jpa/Club.cs", "app", { classes: [cls("Club")] });
  const callerWith = (localType: string) =>
    ({
      ...file("api/ClubApiImpl.cs", "app", {
        classes: [{
          ...cls("ClubApiImpl"),
          methods: [{
            ...fn("update", [call("existing.setStartDate")]),
            localTypes: [{ name: "existing", type: localType }],
          }],
        }],
      }),
      imports: [
        { source: "../jpa/DriverEntity", specifiers: ["DriverEntity"], isDefault: false, isNamespace: false, isType: false, line: 1 },
        { source: "../jpa/Club", specifiers: ["Club"], isDefault: false, isNamespace: false, isType: false, line: 2 },
      ],
    } as unknown as FileAnalysis);

  it("vetoes the unique-name match when the declared receiver type contradicts it", () => {
    const links = buildSymbolLinks([callerWith("Club"), driverEntity, clubEntity]);
    expect(links.some((l) => l.targetSymbol === "DriverEntity.setStartDate")).toBe(false);
  });

  it("keeps the match when the declared type IS the target's class", () => {
    const links = buildSymbolLinks([callerWith("DriverEntity"), driverEntity, clubEntity]);
    expect(links.some((l) => l.targetSymbol === "DriverEntity.setStartDate")).toBe(true);
  });

  it("keeps the match when no declared type is known (dynamic receiver)", () => {
    const noLocal = {
      ...callerWith("ignored"),
    } as any;
    noLocal.classes[0].methods[0].localTypes = [];
    const links = buildSymbolLinks([noLocal, driverEntity, clubEntity]);
    expect(links.some((l) => l.targetSymbol === "DriverEntity.setStartDate")).toBe(true);
  });
});

describe("symbol-linker — spec-route → impl-method name join", () => {
  const specFile = (path: string, httpMethod: string) =>
    ({
      ...file("src/main/jsight/club-ui-api.jsight", "app", {}),
      language: "jsight",
      routes: [{ path, httpMethod, kind: "api", handler: null, calls: [], middleware: [], line: 3 }],
    } as unknown as FileAnalysis);

  it("joins GET /grantable-club-entity-types to the verb-prefixed method", () => {
    const impl = file("api/ClubUiApiImpl.cs", "app", {
      classes: [{ ...cls("ClubUiApiImpl"), methods: [fn("getGrantableClubEntityTypes", [])] }],
    });
    const links = buildSymbolLinks([specFile("/grantable-club-entity-types", "GET"), impl]);
    const l = links.find((x) => x.sourceSymbol === "route:GET /grantable-club-entity-types");
    expect(l?.targetSymbol).toBe("ClubUiApiImpl.getGrantableClubEntityTypes");
    expect(l?.confidence).toBe("INFERRED");
  });

  it("joins the bare camel form when no verb-prefixed method exists", () => {
    const impl = file("api/ClubUiApiImpl.cs", "app", {
      classes: [{ ...cls("ClubUiApiImpl"), methods: [fn("findPersons", [])] }],
    });
    const links = buildSymbolLinks([specFile("/find-persons", "GET"), impl]);
    expect(links.some((l) => l.targetSymbol === "ClubUiApiImpl.findPersons")).toBe(true);
  });

  it("never binds a test file, and stays silent on ambiguity", () => {
    const test = file("src/test/api/FindPersonsTest.cs", "app", {
      classes: [{ ...cls("FindPersonsTest"), methods: [fn("findPersons", [])] }],
    });
    const links = buildSymbolLinks([specFile("/find-persons", "GET"), test]);
    expect(links.some((l) => l.targetFile.includes("Test"))).toBe(false);

    const a = file("api/A.cs", "app", { classes: [{ ...cls("A"), methods: [fn("findPersons", [])] }] });
    const b = file("api/B.cs", "app", { classes: [{ ...cls("B"), methods: [fn("findPersons", [])] }] });
    const ambiguous = buildSymbolLinks([specFile("/find-persons", "GET"), a, b]);
    expect(ambiguous.some((l) => String(l.sourceSymbol).startsWith("route:"))).toBe(false);
  });
});

describe("symbol-linker — strategy provenance", () => {
  /**
   * The load-bearing invariant. `confidence` says how much to trust an edge;
   * `strategy` says what produced it, and a link with no tag is a link no
   * consumer can attribute — `lsp:compare` would bucket it under "(untagged)"
   * and the standing "reject any strategy that introduces conflicts" rule would
   * have nothing to name. Every construction site must set it, so assert over
   * the whole output rather than per case.
   */
  it("tags every link it produces", () => {
    const svc = file("app/Service.cs", "app", {
      classes: [{ ...cls("Service"), methods: [fn("Run", [])] }],
    });
    const caller = file("app/Caller.cs", "app", {
      classes: [{ ...cls("Caller"), methods: [fn("Go", [call("Service.Run")])] }],
    });
    const base = file("app/Base.cs", "app", {
      classes: [{ ...cls("Base"), methods: [fn("Shared", [])] }],
    });
    const derived = {
      ...file("app/Derived.cs", "app", {
        classes: [
          {
            ...cls("Derived"),
            extends: "Base",
            methods: [fn("Use", [call("Shared")])],
          },
        ],
      }),
    } as unknown as FileAnalysis;

    const links = buildSymbolLinks([svc, caller, base, derived]);
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((l) => l.strategy === undefined)).toEqual([]);
    expect(links.filter((l) => l.relation === undefined)).toEqual([]);
  });

  it("names the strategy that resolved each kind of edge", () => {
    const target = file("app/Target.cs", "app", {
      classes: [{ ...cls("Target"), methods: [fn("Work", [])] }],
    });
    const caller = file("app/Caller.cs", "app", {
      classes: [{ ...cls("Caller"), methods: [fn("Go", [call("Target.Work")])] }],
    });
    const links = buildSymbolLinks([target, caller]);
    const link = links.find((l) => l.targetSymbol === "Target.Work");
    expect(link?.strategy).toBe("class-name");
    expect(link?.relation).toBe("calls");
  });

  it("derives relation from strategy rather than asking each site to repeat it", () => {
    // A reverse-reference edge is not a call, and consumers should be able to
    // ask that directly instead of sniffing `sourceSymbol === "(reference)"`.
    const dep = {
      ...file("app/dep.ts", "app", { functions: [fn("helper", [])] }),
      language: "typescript",
      exports: [{ name: "helper", line: 1, kind: "function" }],
    } as unknown as FileAnalysis;
    const user = {
      ...file("app/user.ts", "app", { functions: [] }),
      language: "typescript",
      imports: [
        { source: "./dep", specifiers: ["helper"], isDefault: false, isNamespace: false, isType: false, line: 1 },
      ],
    } as unknown as FileAnalysis;

    const ref = buildSymbolLinks([dep, user]).find((l) => l.sourceSymbol === "(reference)");
    expect(ref?.strategy).toBe("reference");
    expect(ref?.relation).toBe("reference");
  });
});

describe("symbol-linker — factory-via fallback", () => {
  // `const { login } = useAuth(); login(…)` links the hook; `name.startsWith`
  // on a string the factory returned is a stdlib call, not the factory's code.
  const viaCall = (name: string, via: string): CallInfo =>
    ({ name, kind: "cross-file", target: "./hooks", line: 3, via, confidence: "INFERRED" });
  const page = (calls: CallInfo[]) =>
    ({ ...file("src/Page.tsx", "root", { functions: [fn("Page", calls)] }), language: "typescript" } as FileAnalysis);
  const hooks = { ...file("src/hooks.ts", "root", { functions: [fn("useAuth", []), fn("useName", [])] }), language: "typescript" } as FileAnalysis;

  it("links the factory for a member the project does not define", () => {
    const links = buildSymbolLinks([page([viaCall("login", "useAuth")]), hooks]);
    expect(links.map((l) => `${l.callName}->${l.targetSymbol}:${l.strategy}`)).toContain("login->useAuth:factory-via");
  });

  it("does not link it for the caller language's builtin members, but asks only that language", () => {
    const links = buildSymbolLinks([page([viaCall("name.startsWith", "useName"), viaCall("name.trim", "useName")]), hooks]);
    expect(links.filter((l) => l.strategy === "factory-via")).toEqual([]);
    // `login` is a builtin member for Python (smtplib) — irrelevant to a .tsx caller, as the first test shows.
  });
});

describe("symbol-linker — imports that name a sibling sub-project by package", () => {
  const rust = (filePath: string, projectId: string, opts: { functions?: any[]; classes?: any[]; imports?: any[] }): FileAnalysis =>
    ({ ...file(filePath, projectId, opts), language: "rust", imports: opts.imports ?? [] } as unknown as FileAnalysis);
  const subProjects = [
    { id: "crates-api", name: "api", root: "crates/api", kind: "rust", markers: [], packageName: "lemmy_api", packageEcosystem: "cargo" },
    { id: "crates-db_views-site", name: "site", root: "crates/db_views/site", kind: "rust", markers: [], packageName: "lemmy-db-views-site", packageEcosystem: "cargo" },
  ] as any[];

  it("resolves `Type::method` into the crate a `use` names by its Cargo package name", () => {
    const handler = rust("crates/api/src/site/read.rs", "crates-api", {
      functions: [fn("read_site", [call("SiteView.read_local")])],
      imports: [{ source: "lemmy_db_views_site::SiteView", specifiers: ["SiteView"], isDefault: false, isNamespace: false, isType: false, line: 1 }],
    });
    const struct = rust("crates/db_views/site/src/lib.rs", "crates-db_views-site", { classes: [cls("SiteView")] });
    const impls = rust("crates/db_views/site/src/impls.rs", "crates-db_views-site", {
      classes: [{ ...cls("SiteView"), methods: [{ name: "read_local", line: 10, endLine: 20, params: [], calls: [] }] }],
    });
    const links = buildSymbolLinks([handler, struct, impls], subProjects);
    expect(links.filter((l) => l.callName === "SiteView.read_local").map((l) => `${l.targetFile}::${l.targetSymbol}`)).toEqual([
      "crates/db_views/site/src/impls.rs::SiteView.read_local",
    ]);
  });

  it("stays unlinked when the import names no sub-project", () => {
    const handler = rust("crates/api/src/site/read.rs", "crates-api", {
      functions: [fn("read_site", [call("SiteView.read_local")])],
      imports: [{ source: "some_crate::SiteView", specifiers: ["SiteView"], isDefault: false, isNamespace: false, isType: false, line: 1 }],
    });
    const impls = rust("crates/db_views/site/src/impls.rs", "crates-db_views-site", {
      classes: [{ ...cls("SiteView"), methods: [{ name: "read_local", line: 10, endLine: 20, params: [], calls: [] }] }],
    });
    const other = rust("crates/other/src/lib.rs", "crates-other", {
      classes: [{ ...cls("SiteView"), methods: [{ name: "read_local", line: 10, endLine: 20, params: [], calls: [] }] }],
    });
    expect(buildSymbolLinks([handler, impls, other], subProjects).filter((l) => l.callName === "SiteView.read_local")).toEqual([]);
  });
});

describe("symbol-linker — an imported instance's inherited member", () => {
  it("links `MonitorsAPI.update` to the base class when the subclass does not define it", () => {
    const js = (f: FileAnalysis) => ({ ...f, language: "javascript" }) as FileAnalysis;
    const base = js(file("api/ApiClient.js", "web", {
      classes: [{ ...cls("ApiClient"), methods: [{ name: "update", line: 5, endLine: 7, params: [], calls: [] }] }],
    }));
    const sub = js({
      ...file("api/monitors.js", "web", {
        classes: [{ ...cls("MonitorsAPI"), extends: "ApiClient", methods: [{ name: "resume", line: 9, endLine: 11, params: [], calls: [] }] }],
      }),
      imports: [{ source: "./ApiClient", specifiers: ["ApiClient"], line: 1, isDefault: true }],
    } as FileAnalysis);
    const page = js({
      ...file("pages/Monitor.vue", "web", {
        functions: [fn("submit", [{ name: "MonitorsAPI.update", kind: "cross-file", target: "../api/monitors", line: 3 }])],
      }),
      imports: [{ source: "../api/monitors", specifiers: ["MonitorsAPI"], line: 1, isDefault: true }],
    } as FileAnalysis);
    const links = buildSymbolLinks([base, sub, page]);
    const link = links.find((l) => l.callName === "MonitorsAPI.update");
    expect(link?.targetFile).toBe("api/ApiClient.js");
    expect(link?.strategy).toBe("inheritance");
    // Called on MonitorsAPI: what the HTTP pass moves onto the subclass's own member.
    expect([link?.viaType, link?.viaTypeFile]).toEqual(["MonitorsAPI", "api/monitors.js"]);
  });
});

describe("symbol-linker — overloads picked by argument count", () => {
  const method = (name: string, line: number, params: Array<{ name: string; defaultValue?: string; variadic?: boolean }>, calls: CallInfo[] = []) =>
    ({ name, line, endLine: line + 2, params: params.map((p) => ({ type: null, defaultValue: null, ...p })), calls } as any);

  it("links each call to the overload whose arity accepts it, and leaves an undecided one alone", () => {
    const svc = file("src/CarService.java", "app", {
      classes: [{
        ...cls("CarService"),
        methods: [
          method("save", 4, [{ name: "o" }]),
          method("save", 8, [{ name: "o" }, { name: "flush" }, { name: "tag", defaultValue: "\"x\"" }]),
          method("log", 12, [{ name: "level" }]),
          method("log", 14, [{ name: "level" }, { name: "parts", variadic: true }]),
          method("run", 20, [], [
            { ...call("save", 21), argCount: 1 },
            { ...call("log", 22), argCount: 5 },
          ]),
          method("again", 30, [], [{ ...call("save", 31), argCount: 2 }]),
          method("unknown", 40, [], [{ ...call("log", 41), argCount: 1 }]),
        ],
      }],
    });
    const at = (from: string, name: string) =>
      buildSymbolLinks([svc]).find((l) => l.sourceSymbol === from && l.callName === name)?.targetLine;
    expect(at("CarService.run", "save")).toBe(4);
    expect(at("CarService.again", "save")).toBe(8); // the third parameter has a default
    expect(at("CarService.run", "log")).toBe(14); // only the variadic one takes five
    // One argument fits both `log`s (the variadic may get none): undecided, so
    // the link keeps what the index gave it.
    const { argCount: _, ...bare } = { ...call("log", 41), argCount: 1 };
    const unpicked = file("src/CarService.java", "app", {
      classes: [{ ...cls("CarService"), methods: [method("log", 12, [{ name: "level" }]), method("log", 14, [{ name: "level" }, { name: "parts", variadic: true }]), method("unknown", 40, [], [bare])] }],
    });
    const indexed = buildSymbolLinks([unpicked]).find((l) => l.sourceSymbol === "CarService.unknown")?.targetLine;
    expect(at("CarService.unknown", "log")).toBe(indexed);
  });
});

describe("symbol-linker — a route declared inside a class", () => {
  it("anchors on that class's method when several classes in the file define one of the same name", () => {
    const route = (path: string, line: number) => ({ path, httpMethod: "GET", kind: "api", handler: "get_all", calls: [], middleware: [], line });
    const controllers = {
      ...file("routes/explore/organizers.py", "app", {
        classes: [
          { ...cls("PublicLeaguesController"), line: 10, endLine: 20, methods: [{ ...fn("get_all", []), line: 13, endLine: 19 }] },
          { ...cls("PublicClubsController"), line: 22, endLine: 32, methods: [{ ...fn("get_all", []), line: 25, endLine: 31 }] },
        ],
      }),
      language: "python",
      routes: [route("/organizers/leagues", 12), route("/organizers/clubs", 24)],
    } as unknown as FileAnalysis;
    const links = buildSymbolLinks([controllers]);
    const target = (path: string) => links.find((l) => l.sourceSymbol === `route:GET ${path}`)?.targetSymbol;
    expect(target("/organizers/leagues")).toBe("PublicLeaguesController.get_all");
    expect(target("/organizers/clubs")).toBe("PublicClubsController.get_all");
  });
});
