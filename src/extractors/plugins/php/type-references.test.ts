import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractPhpTypeReferences } from "./type-references.js";

const refs = async (src: string) => extractPhpTypeReferences(await parseSource(src, "php" as never, "Scoring.php"), "Scoring.php");

describe("PHP class constant references", () => {
  const SRC = `<?php
namespace League;
use League\\Rules\\Points;
class Scoring {
    const BONUS = Points::EXTRA;
    private array $rules = [Rules::GOAL => 3];
    private int $limit = self::BONUS;
    public function total(int $x = Rules::GOAL): int {
        $c = Rules::class;
        return \\League\\Rules::GOAL + static::BONUS + Rules::build() + parent::LIMIT;
    }
}
`;

  it("reads the class a constant is read through, in a property default, a constant and a body", async () => {
    const out = (await refs(SRC)).map((r) => `${r.typeName} ${r.usageKind} ${r.sourceSymbol} ${r.sourceLine}`);
    expect(out).toEqual([
      "Points constant Scoring.BONUS 5",
      "Rules constant Scoring.rules 6",
      "Rules constant Scoring.total 8",
      "Rules constant Scoring.total 10",
    ]);
  });

  it("leaves self::, static::, parent::, Rules::class and a Rules::build() call alone", async () => {
    const names = (await refs(SRC)).filter((r) => r.sourceSymbol === "Scoring.limit");
    expect(names).toEqual([]);
    expect((await refs(SRC)).filter((r) => r.sourceLine === 9)).toEqual([]);
  });
});
