import { describe, it, expect } from "vitest";
import { distinctCycleLabels, generateSuggestions } from "./suggestions-engine.js";

describe("distinctCycleLabels", () => {
  it("uses bare basenames when they are already unique", () => {
    expect(distinctCycleLabels(["src/a/PlayerService.cs", "src/b/Repo.cs"])).toEqual([
      "PlayerService.cs",
      "Repo.cs",
    ]);
  });

  it("disambiguates colliding basenames with parent segments", () => {
    expect(
      distinctCycleLabels([
        "TicketRights.Account.Api/Controllers/InternalsController.cs",
        "TicketRights.Feature.Api/Controllers/InternalsController.cs",
        "TicketRights.License.Api/Controllers/InternalsController.cs",
      ]),
    ).toEqual([
      "TicketRights.Account.Api/Controllers/InternalsController.cs",
      "TicketRights.Feature.Api/Controllers/InternalsController.cs",
      "TicketRights.License.Api/Controllers/InternalsController.cs",
    ]);
  });
});

describe("generateSuggestions — import cycles", () => {
  it("names a cycle by a path the imports take, and the size of its group", () => {
    const componentGraph = {
      "src/club.ts": ["src/squad.ts"],
      "src/squad.ts": ["src/player.ts"],
      "src/player.ts": ["src/club.ts", "src/kit.ts"],
      "src/kit.ts": ["src/squad.ts"],
    };
    const out = generateSuggestions({
      analyses: [],
      healthScore: { score: 100, grade: "A", penalties: [] } as never,
      patterns: [], securityIssues: [], duplicates: [], complexity: [], layerViolations: [], blastRadius: [],
      componentGraph,
    });
    const cycle = out.find((s) => s.message.startsWith("Circular dependency"));
    expect(cycle?.message).toBe("Circular dependency: club.ts → squad.ts → player.ts → club.ts (one cycle in a group of 4 files)");
  });
});

describe("generateSuggestions — missing tests", () => {
  const file = (filePath: string, language: string, extra: Record<string, unknown> = {}) =>
    ({ filePath, language, routes: [], functions: [], ...extra }) as never;
  const untested = (analyses: never[]) =>
    generateSuggestions({
      analyses,
      healthScore: { score: 100, grade: "A", penalties: [] } as never,
      patterns: [], securityIssues: [], duplicates: [], complexity: [], layerViolations: [], blastRadius: [],
      componentGraph: {},
    }).filter((s) => s.category === "Testing").map((s) => s.filePath);

  it("pairs a subject with its test by each language's naming, and never flags the test itself", () => {
    expect(untested([
      file("internal/league/handler.go", "go"), file("internal/league/handler_test.go", "go"),
      file("app/club_service.py", "python"), file("tests/test_club_service.py", "python"),
      file("src/main/java/com/example/league/GarageController.java", "java"), file("src/test/java/com/example/league/GarageControllerTest.java", "java"),
      file("app/controllers/clubs_controller.rb", "ruby"), file("spec/controllers/clubs_controller_spec.rb", "ruby"),
      file("src/club.service.ts", "typescript"), file("src/club.service.spec.ts", "typescript"),
    ])).toEqual([]);
  });

  it("flags a service with no test of its name, and leaves one declaring its own tests alone", () => {
    expect(untested([
      file("src/transfer.service.ts", "typescript"),
      file("src/transfer.service.helpers.test.ts", "typescript"),
      file("src/garage_service.rs", "rust", { functions: [{ name: "parks", testCase: { title: "parks", path: ["tests"], kind: "case" } }] }),
    ])).toEqual(["src/transfer.service.ts"]);
  });
});
