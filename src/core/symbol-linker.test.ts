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
    expect(links.some((l) => l.targetFile === "b/svc/CustomerApiImpl.cs")).toBe(true);
  });

  it("keeps the old behavior for import-blind source files", () => {
    const links = buildSymbolLinks([caller([]), helper, target]);
    expect(links.some((l) => l.targetFile === "a/api/CustomerApiImpl.cs")).toBe(true);
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
