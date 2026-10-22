import { describe, it, expect } from "vitest";
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractSubComponents } from "./sub-components.js";
import type { ImportInfo } from "../../../types/analysis.js";

describe("Vue components registered app-wide", () => {
  it("are global entries naming each registered component's import source", async () => {
    const src = `import PClubCard from "component/club/card.vue";
import PFixtureList from "component/fixture/list.vue";

export function install(app) {
  app.component("PClubCard", PClubCard);
  app.component("p-fixture-list", PFixtureList);
  app.component("PUnknown", somethingElse);
}
`;
    const imports: ImportInfo[] = [
      { source: "src/component/club/card.vue", specifiers: ["PClubCard"], isDefault: true, isNamespace: false, isType: false, line: 1 },
      { source: "src/component/fixture/list.vue", specifiers: ["PFixtureList"], isDefault: true, isNamespace: false, isType: false, line: 2 },
    ];
    const subs = extractSubComponents(await parseSource(src, "javascript" as never, "components.js"), src, "javascript" as never, imports);
    expect(subs.map((s) => `${s.name} ${s.importSource} ${s.global ?? false}`)).toEqual([
      "PClubCard src/component/club/card.vue true",
      "p-fixture-list src/component/fixture/list.vue true",
    ]);
  });
});
