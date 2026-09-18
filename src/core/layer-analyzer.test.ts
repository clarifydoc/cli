import { describe, it, expect } from "vitest";
import { classifyFileLayers, detectLayerViolations } from "./layer-analyzer.js";
import type { FileAnalysis } from "../types/analysis.js";

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
    expect(classify("src/Api/Api.IntegrationTests/UsersTests.cs")).toBe("test");
    // …but not words that merely contain "test"
    expect(classify("src/Contest/ContestEntry.cs")).toBe("unknown");
    expect(classify("src/pages/TestimonialSection.vue")).toBe("ui");
  });

  it("classifies .NET HttpClients projects as services, not utils via Shared", () => {
    expect(classify("src/Web/Substitutions/Substitutions.Shared.HttpClients/ExpoPushHttpClient.cs")).toBe("services");
  });

  it("lets the basename suffix beat generic directory tokens", () => {
    // `App/` is a generic container — TodoController is services, not ui
    expect(classify("Sources/App/TodoController.swift")).toBe("services");
    expect(classify("src/app/user.service.ts")).toBe("services");
    expect(classify("src/app/app.component.ts")).toBe("components");
    expect(classify("WinApp/MainWindow.xaml")).toBe("ui");
    expect(classify("src/OrderRepository.cs")).toBe("data");
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
    expect(classify("app/models/user.rb")).toBe("data");
    expect(classify("app/controllers/users_controller.rb")).toBe("services");
    expect(classify("app/views/users/index.html.erb")).toBe("ui");
  });

  it("does not read the app/ container dir as ui (pit-stop FP: Laravel Enums, Kotlin dto)", () => {
    // 92 phantom services→ui violations: controllers importing an enum that
    // only lived under Laravel's app/ container.
    expect(classify("dsps-web/LEGACY/app/Enums/API_REQUEST_TYPE.php")).toBe("utils");
    expect(classify("dsps-web/LEGACY/app/Providers/ApiUserProvider.php")).toBe("unknown");
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
    const graph = { "src/models/user.ts": ["src/pages/Profile.vue"] };
    const layers = classifyFileLayers(["src/models/user.ts", "src/pages/Profile.vue"]);
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

  it("does NOT read a frontend *Actions component as services (Vue toolbar, league-planner FP)", () => {
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
    const layers = classifyFileLayers(["src/main/java/com/x/wicket/AccountPage.java"]);
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
      "core/src/main/java/com/example/league/domain/settings/service/SettingServiceImpl.java",
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
    expect(c("src/Persistence/Application/OrderStore.cs")).toBe("data");
    expect(c("src/adapters/Toolbar.vue")).toBe("ui");
  });

  it("matches a slash-less pattern against the bare file name anywhere", () => {
    expect(c("deep/in/the/tree/OrderRepository.cs")).toBe("data");
    expect(c("deep/in/the/tree/OrderRepositoryTests.cs")).toBe("test"); // tests still win
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
    expect(c("src/Persistence/OrderStore.spec.ts")).toBe("test");
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
    ["app/models/user_spec.rb", "ruby"],
  ];
  for (const [path, language] of cases) {
    it(`${path} is a test when the language is known`, () => {
      expect(classifyFileLayers([{ path, language: language as never }])[path]).toBe("test");
    });
  }

  it("still accepts bare paths, and still finds the conventions that need no language", () => {
    expect(classifyFileLayers(["src/services/api.test.ts"])["src/services/api.test.ts"]).toBe("test");
    expect(classifyFileLayers(["src/Api/Api.IntegrationTests/UsersTests.cs"])["src/Api/Api.IntegrationTests/UsersTests.cs"]).toBe("test");
  });

  it("does not turn a production file into a test just because a language is supplied", () => {
    expect(classifyFileLayers([{ path: "pkg/handlers/server.go", language: "go" as never }])["pkg/handlers/server.go"]).toBe("services");
  });
});
