import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { readC } from "./antlr.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["c"]);
});

const read = (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "c", undefined, readC(src)), projectId: "root" });

const engineH = `#ifndef ENGINE_H
#define ENGINE_H
int start(int rpm);
int stall(int rpm);
#endif
`;
const engineC = `#include "engine.h"

int start(int rpm) {
    return rpm + 1;
}

int stall(int rpm) {
    return 0;
}
`;
const garageC = `#include "engine.h"

int crank(int (*start)(int)) {
    return start(900);
}

int tune(void) {
    int (*stall)(int) = start;
    return stall(1200);
}

int drive(void) {
    return start(800) + stall(0);
}
`;

describe("C locals and parameters a body calls", () => {
  it("never links a function-pointer parameter or local to the header's function of that name", () => {
    const links = buildSymbolLinks([read(engineH, "src/engine.h"), read(engineC, "src/engine.c"), read(garageC, "src/garage.c")])
      .filter((l) => l.sourceFile === "src/garage.c")
      .map((l) => `${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();
    expect(links).toEqual([
      "drive@13 stall -> src/engine.c::stall",
      "drive@13 start -> src/engine.c::start",
      // The local holds `start` (value flow), which is the function it is called as.
      "tune@9 stall -> src/engine.c::start",
    ]);
  });
});
