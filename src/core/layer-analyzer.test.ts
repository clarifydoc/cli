import { describe, it, expect } from "vitest";
import { classifyFileLayers, detectLayerViolations } from "./layer-analyzer.js";
import type { FileAnalysis } from "../types/analysis.js";

const classify = (fp: string) => classifyFileLayers([fp])[fp];

describe("classifyFileLayers", () => {
  it("classifies EF database-view entities as data, not ui (tessa FP)", () => {
    // `Views` here holds SQL-view entity classes; the dotted `.Models` segment wins
    expect(classify("src/Core/Trio/Trio.Models/TrioDb/Views/VEKSTRAOPGAVER.cs")).toBe("data");
  });

  it("matches dotted .NET directory segments", () => {
    expect(classify("src/Services/TrioSync/TrioSyncService.Infrastructure.Models/Aktivitet.cs")).toBe("data");
    expect(classify("src/Services/Plan/Plan.Domain/Model/Emner/Emne.cs")).toBe("data");
  });

  it("keeps plain MVC views as ui", () => {
    expect(classify("src/Web/App/Views/Home/Index.cshtml")).toBe("ui");
    expect(classify("frontend/src/pages/Dashboard.vue")).toBe("ui");
  });

  it("classifies persistence/EntityConfigurations as data, not config (tessa FP)", () => {
    expect(classify("src/Web/Vikardaekning.Infrastructure/Persistence/EntityConfigurations/FerieEntityConfiguration.cs")).toBe("data");
  });

  it("does not classify *Configuration.cs basenames as config via substring", () => {
    // no persistence/data segment → unknown, never "config"
    expect(classify("src/Web/Setup/FerieEntityConfiguration.cs")).toBe("unknown");
  });

  it("still recognizes real config files and directories", () => {
    expect(classify("webpack.config.js")).toBe("config");
    expect(classify("proj/settings.py")).toBe("config");
    expect(classify("src/config/database.ts")).toBe("config");
  });

  it("classifies test files as test regardless of directory (tessa FP)", () => {
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
    expect(classify("src/Web/Vikardaekning/Vikardaekning.Shared.HttpClients/ExpoPushHttpClient.cs")).toBe("services");
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
    expect(classify("src/components/undervisning/undervisningQueries.ts")).toBe("services");
    expect(classify("src/components/VikarPlus/types.ts")).toBe("utils");
  });

  it("prefers semantic tokens over the generic app container (Rails layout)", () => {
    expect(classify("app/models/user.rb")).toBe("data");
    expect(classify("app/controllers/users_controller.rb")).toBe("services");
    expect(classify("app/views/users/index.html.erb")).toBe("ui");
  });
});

describe("detectLayerViolations", () => {
  const analyses = [] as unknown as FileAnalysis[];

  it("does not flag utils importing data (1-level jump) or test sources", () => {
    const graph = {
      "src/utils/coverage.ts": ["src/App.Models/Aktivitet.cs"],
      "src/utils/coverage.spec.ts": ["src/services/planClient.ts"],
    };
    const layers = classifyFileLayers([
      "src/utils/coverage.ts", "src/App.Models/Aktivitet.cs",
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
});
