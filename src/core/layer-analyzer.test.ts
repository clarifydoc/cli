import { describe, it, expect } from "vitest";
import { classifyFileLayers, detectLayerViolations, layerDisagreements, layerEvidence, layerEvidenceAll, type LayerTier } from "./layer-analyzer.js";
import { createEmptyAnalysis, type FileAnalysis } from "../types/analysis.js";

const classify = (fp: string) => classifyFileLayers([fp])[fp];

describe("classifyFileLayers", () => {
  it("classifies EF database-view entities as data, not ui (real-repo FP)", () => {
    // `Views` here holds SQL-view entity classes; the dotted `.Models` segment wins
    expect(classify("src/Core/League/League.Models/LeagueDb/Views/VFIXTURES.cs")).toBe("data");
  });

  it("matches dotted .NET directory segments", () => {
    expect(classify("src/Services/SquadSync/SquadSyncService.Infrastructure.Models/Training.cs")).toBe("data");
    expect(classify("src/Services/Plan/Plan.Domain/Model/Tactics/Tactic.cs")).toBe("data");
  });

  it("keeps plain MVC views as ui", () => {
    expect(classify("src/Web/App/Views/Home/Index.cshtml")).toBe("ui");
    expect(classify("frontend/src/pages/Dashboard.vue")).toBe("ui");
  });

  it("classifies persistence/EntityConfigurations as data, not config (real-repo FP)", () => {
    expect(classify("src/Web/Substitutions.Infrastructure/Persistence/EntityConfigurations/HolidayEntityConfiguration.cs")).toBe("data");
  });

  it("does not classify *Configuration.cs basenames as config via substring", () => {
    // no persistence/data segment → unknown, never "config"
    expect(classify("src/Web/Setup/HolidayEntityConfiguration.cs")).toBe("unknown");
  });

  it("still recognizes real config files and directories", () => {
    expect(classify("webpack.config.js")).toBe("config");
    expect(classify("proj/settings.py")).toBe("config");
    expect(classify("src/config/database.ts")).toBe("config");
  });

  it("classifies test files as test regardless of directory (real-repo FP)", () => {
    expect(classify("Frontend/App/src/utils/activityCoverage.spec.ts")).toBe("test");
    expect(classify("src/services/api.test.ts")).toBe("test");
    expect(classify("cypress/e2e/login.cy.ts")).toBe("test");
  });

  it("recognizes .NET test-scaffolding segments (CommonTest, Foo.Tests, TestXxx)", () => {
    expect(classify("src/Core/CommonTest/TestDataAccessHelper.cs")).toBe("test");
    expect(classify("src/Api/Api.IntegrationTests/PlayersTests.cs")).toBe("test");
    // …but not words that merely contain "test"
    expect(classify("src/Contest/ContestEntry.cs")).toBe("unknown");
    expect(classify("src/pages/TestimonialSection.vue")).toBe("ui");
  });

  it("classifies .NET HttpClients projects as services, not utils via Shared", () => {
    expect(classify("src/Web/Substitutions/Substitutions.Shared.HttpClients/ExpoPushHttpClient.cs")).toBe("services");
  });

  it("lets the basename suffix beat generic directory tokens", () => {
    // `App/` is a generic container — DrillController is services, not ui
    expect(classify("Sources/App/DrillController.swift")).toBe("services");
    expect(classify("src/app/player.service.ts")).toBe("services");
    expect(classify("src/app/app.component.ts")).toBe("components");
    expect(classify("WinApp/MainWindow.xaml")).toBe("ui");
    expect(classify("src/CarRepository.cs")).toBe("data");
  });

  it("does not read CamelCase suffixes out of unrelated words", () => {
    // Platform !== *Form, Restore !== *Store
    expect(classify("src/Platform.cs")).toBe("unknown");
    expect(classify("src/Restore.cs")).toBe("unknown");
  });

  it("classifies file-based route pages as ui (top of stack), not config", () => {
    expect(classify("Frontend/App/src/routes/index/rapport/configuration.[rapportId].vue")).toBe("ui");
  });

  it("classifies data-fetching query modules and type barrels regardless of directory", () => {
    expect(classify("src/components/coaching/coachingQueries.ts")).toBe("services");
    expect(classify("src/components/SubstitutePlus/types.ts")).toBe("utils");
  });

  it("prefers semantic tokens over the generic app container (Rails layout)", () => {
    expect(classify("app/models/player.rb")).toBe("data");
    expect(classify("app/controllers/players_controller.rb")).toBe("services");
    expect(classify("app/views/players/index.html.erb")).toBe("ui");
  });

  it("does not read the app/ container dir as ui (pit-stop FP: Laravel Enums, Kotlin dto)", () => {
    // 92 phantom services→ui violations: controllers importing an enum that
    // only lived under Laravel's app/ container.
    expect(classify("dsps-web/LEGACY/app/Enums/API_REQUEST_TYPE.php")).toBe("utils");
    expect(classify("dsps-web/LEGACY/app/Providers/ApiPlayerProvider.php")).toBe("unknown");
  });

  it("classifies dto dirs and ALL-CAPS acronym suffixes as data (pit-stop FP)", () => {
    expect(classify("server/model/dto/organization/US2000InstitutionNumberDTO.kt")).toBe("data");
    expect(classify("server/app/dto/AppSupportActivityDTO.kt")).toBe("data");
    expect(classify("server/model/dao/DatabaseStudentDAO.kt")).toBe("data");
  });

  it("does not let a bare capitalized word claim a suffix layer (pit-stop FP: util/Page.kt)", () => {
    // Page.kt is a pagination util — the ui suffix needs a compound name.
    expect(classify("server/util/Page.kt")).toBe("utils");
    expect(classify("app/NewChatPage.dart")).toBe("ui"); // compound still works
  });

  it("exempts CI/CD and script trees from layering (pit-stop FP)", () => {
    expect(classify("dsps_app/CICD/ios_app_store_api/set_release_type.py")).toBe("unknown");
    expect(classify("dsps_app/CICD/utils/csv_deployment_manager.py")).toBe("unknown");
    expect(classify("pit-stop-scripts/jira/sync.py")).toBe("unknown");
  });
});

describe("detectLayerViolations", () => {
  const analyses = [] as unknown as FileAnalysis[];

  it("does not flag utils importing data (1-level jump) or test sources", () => {
    const graph = {
      "src/utils/coverage.ts": ["src/App.Models/Training.cs"],
      "src/utils/coverage.spec.ts": ["src/services/planClient.ts"],
    };
    const layers = classifyFileLayers([
      "src/utils/coverage.ts", "src/App.Models/Training.cs",
      "src/utils/coverage.spec.ts", "src/services/planClient.ts",
    ]);
    expect(detectLayerViolations(analyses, graph, layers)).toHaveLength(0);
  });

  it("flags a genuine 2+ level upward import (data -> ui)", () => {
    const graph = { "src/models/player.ts": ["src/pages/Profile.vue"] };
    const layers = classifyFileLayers(["src/models/player.ts", "src/pages/Profile.vue"]);
    const v = detectLayerViolations(analyses, graph, layers);
    expect(v).toHaveLength(1);
    expect(v[0].sourceLayer).toBe("data");
    expect(v[0].targetLayer).toBe("ui");
  });

  it("exempts build-tool config files as violation sources (pit-stop FP: vite.config.js)", () => {
    const files = ["web/vite.config.js", "web/src/pages/Home.vue"];
    const graph = { "web/vite.config.js": ["web/src/pages/Home.vue"] };
    const layers = classifyFileLayers(files);
    expect(layers["web/vite.config.js"]).toBe("config"); // display keeps the layer
    expect(detectLayerViolations(analyses, graph, layers)).toHaveLength(0);
  });
});

describe("Struts/WebFlow Action + JVM form-bean classification (real-repo FPs)", () => {
  it("classifies *Action.java as services even under a settings/ directory", () => {
    const layers = classifyFileLayers([
      "admin/src/main/java/com/example/league/admin/web/settings/SeasonCreateAction.java",
    ]);
    expect(Object.values(layers)[0]).toBe("services");
  });

  it("does NOT read a frontend *Actions component as services (Vue toolbar FP)", () => {
    const layers = classifyFileLayers([
      "frontend/src/components/MatchSheet/live/MatchSheetLiveHeaderActions.vue",
    ]);
    expect(Object.values(layers)[0]).not.toBe("services");
  });

  it("does NOT read a JVM *Form as ui (form-backing bean), falling to dir tokens", () => {
    const layers = classifyFileLayers([
      "admin/src/main/java/com/example/league/admin/web/settings/RuleManageForm.java",
      "src/main/java/com/example/garage/domain/CarForm.java",
    ]);
    // settings/ dir → config; domain/ has no token → unknown (exempt). Neither is ui.
    for (const layer of Object.values(layers)) expect(layer).not.toBe("ui");
  });

  it("keeps non-JVM *Form files as ui (React component, Delphi form)", () => {
    const layers = classifyFileLayers([
      "web/src/components/LoginForm.tsx",
      "src/ui/MainForm.pas",
    ]);
    for (const layer of Object.values(layers)) {
      expect(["ui", "components"]).toContain(layer);
    }
  });

  it("keeps JVM *View/*Page/*Window basenames as ui", () => {
    const layers = classifyFileLayers(["src/main/java/com/x/wicket/ClubPage.java"]);
    expect(Object.values(layers)[0]).toBe("ui");
  });
});

describe("wiring classes, flow definitions, singular service dirs (real-repo FPs)", () => {
  it("classifies WebFlow XMLs under flows/ as ui (top-of-stack, like routes)", () => {
    const layers = classifyFileLayers([
      "admin/src/main/webapp/WEB-INF/flows/settings/league.wf.settings.rule.manage.xml",
    ]);
    expect(Object.values(layers)[0]).toBe("ui");
  });

  it("matches a singular service/ directory segment", () => {
    const layers = classifyFileLayers([
      "core/src/main/java/com/example/league/domain/settings/service/LeagueSettingServiceImpl.java",
    ]);
    expect(Object.values(layers)[0]).toBe("services");
  });

  it("exempts *Config/*Configuration wiring classes as violation sources", () => {
    const mk = (filePath: string, imports: string[]): FileAnalysis =>
      ({ filePath, imports: imports.map((s, i) => ({ source: s, specifiers: [], isDefault: false, isNamespace: false, isType: false, line: i + 1 })) } as unknown as FileAnalysis);
    const files = [
      "admin/web/config/LeagueResourceConfig.java",
      "domain/capacity/StadiumService.java",
    ];
    const layers = classifyFileLayers(files);
    const graph = { "admin/web/config/LeagueResourceConfig.java": ["domain/capacity/StadiumService.java"] };
    const violations = detectLayerViolations([mk(files[0]!, ["StadiumService"])], graph, layers);
    expect(violations).toEqual([]);
  });
});

describe("classifyFileLayers — repository overrides", () => {
  const overrides = {
    layers: [
      { layer: "data" as const, patterns: ["src/Persistence/**", "*Repository.cs"] },
      { layer: "ui" as const, patterns: ["src/adapters/**"] },
    ],
    exempt: ["tools/**"],
  };
  const c = (fp: string) => classifyFileLayers([fp], overrides)[fp];

  it("lets a layer rule beat the path heuristics", () => {
    // Heuristics would say services (Application) / unknown (adapters).
    expect(c("src/Persistence/Application/CarStore.cs")).toBe("data");
    expect(c("src/adapters/Toolbar.vue")).toBe("ui");
  });

  it("matches a slash-less pattern against the bare file name anywhere", () => {
    expect(c("deep/in/the/tree/CarRepository.cs")).toBe("data");
    expect(c("deep/in/the/tree/CarRepositoryTests.cs")).toBe("test"); // tests still win
  });

  it("applies rules in order — first match wins", () => {
    const first = classifyFileLayers(["x/a.ts"], {
      layers: [{ layer: "config", patterns: ["x/**"] }, { layer: "ui", patterns: ["x/a.ts"] }],
      exempt: [],
    })["x/a.ts"];
    expect(first).toBe("config");
  });

  it("marks exempt trees unknown even when a heuristic or rule would classify them", () => {
    expect(c("tools/services/deploy.ts")).toBe("unknown");
  });

  it("keeps tests exempt regardless of rules", () => {
    expect(c("src/Persistence/CarStore.spec.ts")).toBe("test");
  });

  it("changes nothing when no overrides are given", () => {
    expect(classifyFileLayers(["src/adapters/Toolbar.vue"])["src/adapters/Toolbar.vue"]).toBe("unknown");
  });
});

describe("classifyFileLayers — language-aware test detection", () => {
  // Without the language only the generic and .NET conventions fire, so these
  // were classified as real application layers: they could be layer-violation
  // endpoints and were scored for refactor pressure like production code.
  const cases: Array<[path: string, language: string]> = [
    ["pkg/handlers/server_test.go", "go"],
    ["api/test_views.py", "python"],
    ["lib/foo_spec.rb", "ruby"],
    ["app/models/player_spec.rb", "ruby"],
  ];
  for (const [path, language] of cases) {
    it(`${path} is a test when the language is known`, () => {
      expect(classifyFileLayers([{ path, language: language as never }])[path]).toBe("test");
    });
  }

  it("still accepts bare paths, and still finds the conventions that need no language", () => {
    expect(classifyFileLayers(["src/services/api.test.ts"])["src/services/api.test.ts"]).toBe("test");
    expect(classifyFileLayers(["src/Api/Api.IntegrationTests/PlayersTests.cs"])["src/Api/Api.IntegrationTests/PlayersTests.cs"]).toBe("test");
  });

  it("does not turn a production file into a test just because a language is supplied", () => {
    expect(classifyFileLayers([{ path: "pkg/handlers/server.go", language: "go" as never }])["pkg/handlers/server.go"]).toBe("services");
  });
});

describe("detectRuleViolations — the team's own import rules", () => {
  it("reports an import a rule forbids, with the rule's name, and honours except", async () => {
    const { detectRuleViolations } = await import("./layer-analyzer.js");
    const graph = {
      "features/billing/bill.ts": ["features/payroll/salary.ts", "features/payroll/shared/money.ts", "lib/date.ts"],
      "features/payroll/salary.ts": ["features/billing/bill.ts"],
    };
    const rules = [{ name: "billing ↛ payroll", from: ["features/billing/**"], to: ["features/payroll/**"], except: ["**/shared/**"], severity: "error" as const }];
    const v = detectRuleViolations([], graph, {}, rules);
    expect(v.map((x) => [x.sourceFile, x.targetFile, x.rule, x.severity])).toEqual([
      ["features/billing/bill.ts", "features/payroll/salary.ts", "billing ↛ payroll", "error"],
    ]);
  });

  const rule = (r: Record<string, unknown>) => ({ name: "r", from: [], to: [], except: [], severity: "error" as const, ...r });
  const graph = {
    "src/features/club/page.ts": ["src/features/club/api.ts", "src/features/match/api.ts", "src/shared/date.ts", "src/core/store.ts"],
    "src/features/club/api.ts": ["src/shared/date.ts"],
    "src/features/match/api.ts": ["src/features/club/api.ts", "src/shared/date.ts"],
    "src/features/match/view.ts": ["src/features/player/card.ts"],
    "src/shared/date.ts": [],
  };
  const pairs = (v: Array<{ sourceFile: string; targetFile: string }>) => v.map((x) => `${x.sourceFile} → ${x.targetFile}`);

  it("keeps each element apart: an import into another element breaks it, one within its own does not", async () => {
    const { detectRuleViolations } = await import("./layer-analyzer.js");
    const v = detectRuleViolations([], graph, {}, [rule({ name: "features apart", each: "src/features/*", except: ["**/api.ts"] })]);
    // `except` lifts the api files on either end; the shared folder is no element.
    expect(pairs(v)).toEqual(["src/features/match/view.ts → src/features/player/card.ts"]);
  });

  it("allowOnly: an element imports its own files and what the rule lists, nothing else", async () => {
    const { detectRuleViolations } = await import("./layer-analyzer.js");
    const v = detectRuleViolations([], graph, {}, [rule({ name: "features use shared only", each: "src/features/*", allowOnly: ["src/shared/**"] })]);
    expect(pairs(v)).toEqual([
      "src/features/club/page.ts → src/features/match/api.ts",
      "src/features/club/page.ts → src/core/store.ts",
      "src/features/match/api.ts → src/features/club/api.ts",
      "src/features/match/view.ts → src/features/player/card.ts",
    ]);
    // Without elements, `from` names who is held to the list.
    const flat = detectRuleViolations([], graph, {}, [rule({ from: ["src/shared/**", "src/features/club/api.ts"], allowOnly: ["src/shared/**"] })]);
    expect(pairs(flat)).toEqual([]);
  });

  it("noCycles: every import of a cycle between elements, with the cycle named", async () => {
    const { detectRuleViolations } = await import("./layer-analyzer.js");
    const cyclic = { ...graph, "src/features/club/api.ts": ["src/features/match/api.ts"] };
    const v = detectRuleViolations([], cyclic, {}, [rule({ name: "no feature cycles", each: "src/features/*", noCycles: true, severity: "warn" })]);
    expect(v.map((x) => [`${x.sourceFile} → ${x.targetFile}`, x.cycle, x.severity])).toEqual([
      ["src/features/club/page.ts → src/features/match/api.ts", ["src/features/club", "src/features/match"], "warn"],
      ["src/features/club/api.ts → src/features/match/api.ts", ["src/features/club", "src/features/match"], "warn"],
      ["src/features/match/api.ts → src/features/club/api.ts", ["src/features/club", "src/features/match"], "warn"],
    ]);
    // No cycle, nothing reported; and between files when there are no elements.
    const acyclic = { ...graph, "src/features/match/api.ts": ["src/shared/date.ts"] };
    expect(detectRuleViolations([], acyclic, {}, [rule({ each: "src/features/*", noCycles: true })])).toEqual([]);
    const files = detectRuleViolations([], cyclic, {}, [rule({ from: ["src/features/**"], noCycles: true })]);
    expect(pairs(files)).toEqual(["src/features/club/api.ts → src/features/match/api.ts", "src/features/match/api.ts → src/features/club/api.ts"]);
  });
});

describe("layers from what a file does — several labels, disagreements recorded", () => {
  const withFacts = (filePath: string, facts: { apiRoutes?: number; entity?: string; queries?: number }) => {
    const a = createEmptyAnalysis(filePath, "typescript");
    a.routes = Array.from({ length: facts.apiRoutes ?? 0 }, (_, i) => ({ path: `/api/v2/clubs/${i}`, httpMethod: "GET", kind: "api", line: i + 1 })) as never;
    if (facts.entity) a.classes = [{ name: facts.entity, decorators: ["entity"] }] as never;
    a.dataSources = Array.from({ length: facts.queries ?? 0 }, (_, i) => ({ kind: "database", name: "clubs", target: "clubs", calls: [], line: i + 1 })) as never;
    return a;
  };

  it("records the second layer of a controller that queries the database, and a utils file that does as misplaced", () => {
    const files = [
      withFacts("src/controllers/club.controller.ts", { apiRoutes: 2, queries: 3 }),
      withFacts("src/utils/fixtures.ts", { queries: 1 }),
      withFacts("src/models/player.ts", { entity: "Player" }),
      withFacts("src/wiring/main.ts", { queries: 1 }),
    ];
    const tiers: Record<string, LayerTier> = {};
    const layers = classifyFileLayers(files.map((f) => f.filePath), undefined, (f) => layerEvidence(files.find((a) => a.filePath === f)), {}, tiers);
    // Database access alone never places a file: `wiring/` stays unknown.
    expect(layers["src/wiring/main.ts"]).toBe("unknown");
    expect(tiers["src/utils/fixtures.ts"]).toBe("folder");
    const { alternates, conflicts } = layerDisagreements(files, layers, tiers, () => false);
    expect(Object.keys(alternates).sort()).toEqual(["src/utils/fixtures.ts"]);
    expect(conflicts).toEqual([{ file: "src/utils/fixtures.ts", layer: "utils", evidence: "it queries the database (1 statement)" }]);
    // The controller's routes and queries agree with the services layer its name gives it.
    expect(layers["src/controllers/club.controller.ts"]).toBe("services");
    expect(layerEvidenceAll(files[0]).map((e) => e.layer)).toEqual(["ui", "data"]);
  });
});

describe("layer disagreements — source containers", () => {
  it("does not call a lib/ file misplaced for querying the database (lib/ is where Elixir, Ruby and OCaml keep source)", () => {
    const a = createEmptyAnalysis("lib/league/clubs.ex", "elixir");
    a.dataSources = [{ kind: "database", name: "clubs", target: "clubs", calls: [], line: 3 }] as never;
    const tiers: Record<string, LayerTier> = {};
    const layers = classifyFileLayers([a.filePath], undefined, undefined, {}, tiers);
    expect(layers[a.filePath]).toBe("utils");
    const { alternates, conflicts } = layerDisagreements([a], layers, tiers, () => false);
    expect(conflicts).toEqual([]);
    expect(alternates[a.filePath]?.map((x) => x.layer)).toEqual(["data"]);
  });
});
