import { describe, it, expect } from "vitest";
import { distinctCycleLabels } from "./suggestions-engine.js";

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
