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

  it("resolves a generic type argument (`_db.Set<Account>()`) to the unique type's file", () => {
    const repo = file("Infra/AccountRepository.cs", "Infra", {
      classes: [{ ...cls("AccountRepository"), methods: [fn("GetAll", [call("_db.Set<Account>")])] }],
    });
    const domain = file("Domain/Account.cs", "Domain", { classes: [cls("Account")] });
    const links = buildSymbolLinks([repo, domain]);
    expect(links.some((l) => l.targetFile === "Domain/Account.cs")).toBe(true);
  });

  it("resolves a call on a dependency INHERITED from a base handler (`_repository.AddAsync`)", () => {
    // CQRS base-handler pattern: the injected repo lives on the base class.
    const iface = file("Shared/IRepository.cs", "Shared", {
      classes: [{ ...cls("IRepository"), kind: "interface", methods: [{ name: "AddAsync", line: 7, endLine: 7, params: [], calls: [] }] }],
    });
    const base = file("Shared/BaseCommandHandler.cs", "Shared", {
      classes: [{ ...cls("BaseCommandHandler"), properties: [{ name: "_repository", type: "IRepository<TResult>" }] }],
    });
    const handler = file("App/CreateAccountCommandHandler.cs", "App", {
      classes: [{
        ...cls("CreateAccountCommandHandler"),
        extends: "BaseCommandHandler<CreateAccountCommand, Account>",
        methods: [fn("Handle", [call("_repository.AddAsync")])],
      }],
    });
    const links = buildSymbolLinks([iface, base, handler]);
    expect(links.some((l) => l.sourceFile === "App/CreateAccountCommandHandler.cs" && l.targetFile === "Shared/IRepository.cs")).toBe(true);
  });

  it("does NOT resolve a generic arg when the type name is not globally unique (avoids false edges)", () => {
    const repo = file("Infra/AccountRepository.cs", "Infra", {
      classes: [{ ...cls("AccountRepository"), methods: [fn("GetAll", [call("_db.Set<Account>")])] }],
    });
    const d1 = file("Domain/Account.cs", "Domain", { classes: [cls("Account")] });
    const d2 = file("Scaffold/Account.cs", "Infra", { classes: [cls("Account")] });
    const links = buildSymbolLinks([repo, d1, d2]);
    expect(links.some((l) => /Account\.cs$/.test(l.targetFile) && l.sourceFile === "Infra/AccountRepository.cs")).toBe(false);
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
    const component = file("spa/Cart.vue", "spa", {
      functions: [fn("onClick", [
        { name: "cart.updateQuantity", kind: "cross-file", target: "./useShopCart", via: "useShopCart", line: 3 },
      ])],
    });
    const composable = file("spa/useShopCart.ts", "spa", {
      functions: [fn("useShopCart", []), fn("updateQuantity", [])],
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
      routes: [{ path: "/users", httpMethod: "GET", handler: "listUsers", kind: "api", line: 7, calls: [] }],
    } as unknown as FileAnalysis;
    const controller = file("src/users.controller.ts", "api", {
      functions: [fn("listUsers", [])],
    });
    (controller as any).language = "typescript";
    const links = buildSymbolLinks([spec, controller]);
    const specLink = links.find((l) => l.sourceFile === "api/openapi.yaml" && l.callName === "listUsers");
    expect(specLink?.targetFile).toBe("src/users.controller.ts");
  });

  it("joins a WSDL PascalCase operation to a camelCase Java handler (GetUser → getUser)", () => {
    const wsdl = {
      ...file("api/users.wsdl", "api", {}),
      language: "wsdl",
      routes: [{ path: "/GetUser", httpMethod: null, handler: "GetUser", kind: "api", line: 5, calls: [] }],
    } as unknown as FileAnalysis;
    const impl = file("src/UserServiceImpl.java", "api", {
      classes: [{ ...cls("UserServiceImpl"), methods: [fn("getUser", [])] }],
    });
    (impl as any).language = "java";
    const links = buildSymbolLinks([wsdl, impl]);
    expect(links.some((l) => l.sourceFile === "api/users.wsdl" && l.targetFile === "src/UserServiceImpl.java")).toBe(true);
  });

  it("requires the qualified handler's class to be evidenced in the target file", () => {
    const webPhp = {
      ...file("web/LEGACY/routes/web.php", "web", {}),
      language: "php",
      routes: [route("/dashboard", "DashboardController#create")],
    } as unknown as FileAnalysis;
    const wrong = {
      ...file("web/LEGACY/app/Models/Order.php", "web", {
        classes: [{ ...cls("Order"), methods: [fn("create", [])] }],
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
    expect(handlerLinks.some((l) => l.targetFile === "web/LEGACY/app/Models/Order.php")).toBe(false);
    expect(handlerLinks.some((l) => l.targetFile === "web/LEGACY/app/Http/Controllers/DashboardController.php")).toBe(true);
  });

  it("never binds a `Class.method` handler to another class's method by name alone", () => {
    const groovy = (path: string, opts: Parameters<typeof file>[2]) =>
      ({ ...file(path, "app", opts), language: "groovy" }) as unknown as FileAnalysis;
    // Grails `resources: "book"` routes every REST action, `create` included,
    // and `/api/reviews` names a controller the project does not have.
    const mappings = {
      ...groovy("grails-app/controllers/UrlMappings.groovy", {}),
      routes: [route("/api/books/create", "BookController.create"), route("/api/reviews", "ReviewController.save")],
    } as unknown as FileAnalysis;
    const controller = groovy("grails-app/controllers/BookController.groovy", {
      classes: [{ ...cls("BookController"), methods: [fn("save", [])] }],
    });
    const service = groovy("grails-app/services/BookService.groovy", {
      classes: [{ ...cls("BookService"), methods: [fn("create", [])] }],
    });
    const links = buildSymbolLinks([mappings, controller, service]).filter((l) => l.sourceSymbol.startsWith("route:"));
    expect(links).toEqual([]);
  });

  it("grades a route-scan link by whether the route states its target", () => {
    const php = (path: string, opts: Parameters<typeof file>[2]) =>
      ({ ...file(path, "web", opts), language: "php" }) as unknown as FileAnalysis;
    const routes = {
      ...php("routes/api.php", {}),
      routes: [route("/api/user", "UserController#index"), route("/api/health", "ping")],
    } as unknown as FileAnalysis;
    const controller = php("app/Http/Controllers/UserController.php", {
      classes: [{ ...cls("UserController"), methods: [fn("index", [])] }],
    });
    const helpers = php("app/helpers.php", { functions: [fn("ping", [])] });
    const graded = (files: FileAnalysis[]) =>
      buildSymbolLinks(files).filter((l) => l.sourceSymbol.startsWith("route:")).map((l) => [l.callName, l.confidence]);
    // The one `UserController.index`: named by the route, only the import is missing.
    // A bare handler name found by search stays a guess.
    expect(graded([routes, controller, helpers])).toEqual([
      ["UserController#index", "INFERRED"],
      ["ping", "AMBIGUOUS"],
    ]);
    // Two controllers of that name: whichever is linked is a guess.
    const other = php("legacy/UserController.php", {
      classes: [{ ...cls("UserController"), methods: [fn("index", [])] }],
    });
    expect(graded([routes, controller, other])[0]).toEqual(["UserController#index", "AMBIGUOUS"]);
  });

  it("keeps a `Class.method` handler whose class is namespaced on the target side (Phoenix)", () => {
    const router = {
      ...file("lib/app_web/router.ex", "app", {}),
      language: "elixir",
      routes: [route("/api/users/:id", "UserController.show")],
    } as unknown as FileAnalysis;
    const controller = {
      ...file("lib/app_web/user_controller.ex", "app", {
        classes: [{ ...cls("AppWeb.UserController"), methods: [fn("show", [])] }],
      }),
      language: "elixir",
    } as unknown as FileAnalysis;
    const links = buildSymbolLinks([router, controller]).filter((l) => l.sourceSymbol.startsWith("route:"));
    expect(links.map((l) => l.targetSymbol)).toEqual(["AppWeb.UserController.show"]);
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
  const target = file("a/api/CustomerApiImpl.cs", "app", {
    classes: [{ ...cls("CustomerApiImpl"), methods: [fn("computeOverview", [])] }],
  });

  it("does NOT link a unique leaf across directories without import evidence", () => {
    const links = buildSymbolLinks([caller([{ source: "./Helper", specifiers: ["Helper"] }]), helper, target]);
    expect(links.some((l) => l.targetFile === "a/api/CustomerApiImpl.cs")).toBe(false);
  });

  it("links when the source file imports the target", () => {
    const links = buildSymbolLinks([
      caller([{ source: "../../a/api/CustomerApiImpl", specifiers: ["CustomerApiImpl"] }]),
      helper,
      target,
    ]);
    expect(links.some((l) => l.targetFile === "a/api/CustomerApiImpl.cs")).toBe(true);
  });

  it("links a same-directory target (same package needs no import)", () => {
    const sameDir = file("b/svc/CustomerApiImpl.cs", "app", {
      classes: [{ ...cls("CustomerApiImpl"), methods: [fn("computeOverview", [])] }],
    });
    const links = buildSymbolLinks([caller([{ source: "./Helper", specifiers: ["Helper"] }]), helper, sameDir]);
    const link = links.find((l) => l.targetFile === "b/svc/CustomerApiImpl.cs");
    expect(link).toBeDefined();
    // Same directory IS evidence — the stronger of the two sub-tiers.
    expect(link!.strategy).toBe("unique-global");
  });

  it("keeps the old behavior for import-blind source files", () => {
    const links = buildSymbolLinks([caller([]), helper, target]);
    const link = links.find((l) => l.targetFile === "a/api/CustomerApiImpl.cs");
    expect(link).toBeDefined();
    // Same edge, same AMBIGUOUS confidence, but reached with no evidence at all
    // — only the strategy tag separates it from the case above, which is the
    // whole reason strategy 7 was split.
    expect(link!.strategy).toBe("unique-global-blind");
    expect(link!.confidence).toBe("AMBIGUOUS");
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
  // `existing.setStartDate()` where `existing` is declared `Account` must not
  // bind CustomerEntity.setStartDate — even when CustomerEntity is imported
  // (evidence gate passes) and the setter name is repo-unique.
  const customerEntity = file("jpa/CustomerEntity.cs", "app", {
    classes: [{ ...cls("CustomerEntity"), methods: [fn("setStartDate", [])] }],
  });
  const accountEntity = file("jpa/Account.cs", "app", { classes: [cls("Account")] });
  const callerWith = (localType: string) =>
    ({
      ...file("api/AccountApiImpl.cs", "app", {
        classes: [{
          ...cls("AccountApiImpl"),
          methods: [{
            ...fn("update", [call("existing.setStartDate")]),
            localTypes: [{ name: "existing", type: localType }],
          }],
        }],
      }),
      imports: [
        { source: "../jpa/CustomerEntity", specifiers: ["CustomerEntity"], isDefault: false, isNamespace: false, isType: false, line: 1 },
        { source: "../jpa/Account", specifiers: ["Account"], isDefault: false, isNamespace: false, isType: false, line: 2 },
      ],
    } as unknown as FileAnalysis);

  it("vetoes the unique-name match when the declared receiver type contradicts it", () => {
    const links = buildSymbolLinks([callerWith("Account"), customerEntity, accountEntity]);
    expect(links.some((l) => l.targetSymbol === "CustomerEntity.setStartDate")).toBe(false);
  });

  it("keeps the match when the declared type IS the target's class", () => {
    const links = buildSymbolLinks([callerWith("CustomerEntity"), customerEntity, accountEntity]);
    expect(links.some((l) => l.targetSymbol === "CustomerEntity.setStartDate")).toBe(true);
  });

  it("keeps the match when no declared type is known (dynamic receiver)", () => {
    const noLocal = {
      ...callerWith("ignored"),
    } as any;
    noLocal.classes[0].methods[0].localTypes = [];
    const links = buildSymbolLinks([noLocal, customerEntity, accountEntity]);
    expect(links.some((l) => l.targetSymbol === "CustomerEntity.setStartDate")).toBe(true);
  });
});

describe("symbol-linker — spec-route → impl-method name join", () => {
  const specFile = (path: string, httpMethod: string) =>
    ({
      ...file("src/main/jsight/account-ui-api.jsight", "app", {}),
      language: "jsight",
      routes: [{ path, httpMethod, kind: "api", handler: null, calls: [], middleware: [], line: 3 }],
    } as unknown as FileAnalysis);

  it("joins GET /grantable-club-entity-types to the verb-prefixed method", () => {
    const impl = file("api/AccountUiApiImpl.cs", "app", {
      classes: [{ ...cls("AccountUiApiImpl"), methods: [fn("getGrantableClubEntityTypes", [])] }],
    });
    const links = buildSymbolLinks([specFile("/grantable-club-entity-types", "GET"), impl]);
    const l = links.find((x) => x.sourceSymbol === "route:GET /grantable-club-entity-types");
    expect(l?.targetSymbol).toBe("AccountUiApiImpl.getGrantableClubEntityTypes");
    expect(l?.confidence).toBe("INFERRED");
  });

  it("joins the bare camel form when no verb-prefixed method exists", () => {
    const impl = file("api/AccountUiApiImpl.cs", "app", {
      classes: [{ ...cls("AccountUiApiImpl"), methods: [fn("findPersons", [])] }],
    });
    const links = buildSymbolLinks([specFile("/find-persons", "GET"), impl]);
    expect(links.some((l) => l.targetSymbol === "AccountUiApiImpl.findPersons")).toBe(true);
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
  });
});
