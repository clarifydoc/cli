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
