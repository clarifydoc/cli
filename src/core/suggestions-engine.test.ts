import { describe, it, expect } from "vitest";
import { distinctCycleLabels } from "./suggestions-engine.js";

describe("distinctCycleLabels", () => {
  it("uses bare basenames when they are already unique", () => {
    expect(distinctCycleLabels(["src/a/UserService.cs", "src/b/Repo.cs"])).toEqual([
      "UserService.cs",
      "Repo.cs",
    ]);
  });

  it("disambiguates colliding basenames with parent segments", () => {
    expect(
      distinctCycleLabels([
        "DigitalRights.Account.Api/Controllers/InternalsController.cs",
        "DigitalRights.Feature.Api/Controllers/InternalsController.cs",
        "DigitalRights.License.Api/Controllers/InternalsController.cs",
      ]),
    ).toEqual([
      "DigitalRights.Account.Api/Controllers/InternalsController.cs",
      "DigitalRights.Feature.Api/Controllers/InternalsController.cs",
      "DigitalRights.License.Api/Controllers/InternalsController.cs",
    ]);
  });
});
