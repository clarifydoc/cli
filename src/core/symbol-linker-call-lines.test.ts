import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, FileAnalysis } from "../types/analysis.js";

/** One link per caller and name keeps the earliest line, whichever record is listed first. */
const call = (name: string, line: number, target?: string): CallInfo =>
  ({ name, kind: target ? "cross-file" : "internal", target: target ?? null, line }) as CallInfo;
const fn = (name: string, calls: CallInfo[], line = 1) => ({ name, line, endLine: 20, params: [], calls }) as any;
const file = (filePath: string, functions: any[], extra: object = {}): FileAnalysis =>
  ({ filePath, projectId: "p", language: "typescript", functions, classes: [], imports: [], exports: [], routes: [], dataSources: [], ...extra }) as unknown as FileAnalysis;

const training = () => file("src/training.ts", [fn("warmUp", [], 1)], { exports: [{ name: "warmUp", kind: "named", line: 1 }] });
const coach = (calls: CallInfo[]) =>
  file("src/coach.ts", [fn("plan", calls, 2)], { imports: [{ source: "./training", specifiers: ["warmUp"], line: 1 }] });

describe("symbol-linker — a call's line when two records name one call", () => {
  it("keeps the earliest line when a later record is listed first", () => {
    const links = buildSymbolLinks([
      training(),
      coach([call("warmUp", 9, "./training"), call("warmUp", 4, "./training"), call("warmUp", 6, "./training")]),
    ]).filter((l) => l.sourceFile === "src/coach.ts" && l.callName === "warmUp" && l.relation === "calls");
    expect(links).toHaveLength(1);
    expect(links[0]!.targetFile).toBe("src/training.ts");
    expect(links[0]!.sourceLine).toBe(4);
  });

  it("leaves a same-named function in another file, and its caller's line, alone", () => {
    const garage = file("src/garage.ts", [fn("warmUp", [], 1), fn("race", [call("warmUp", 12)], 8)]);
    const links = buildSymbolLinks([
      training(),
      garage,
      coach([call("warmUp", 9, "./training"), call("warmUp", 4, "./training")]),
    ]).filter((l) => l.relation === "calls");
    const garageLinks = links.filter((l) => l.sourceFile === "src/garage.ts");
    expect(garageLinks).toHaveLength(1);
    expect(garageLinks[0]!.sourceLine).toBe(12);
    expect(garageLinks[0]!.targetFile).toBe("src/garage.ts");
    const coachLinks = links.filter((l) => l.sourceFile === "src/coach.ts");
    expect(coachLinks).toHaveLength(1);
    expect(coachLinks[0]!.targetFile).toBe("src/training.ts");
    expect(coachLinks[0]!.sourceLine).toBe(4);
  });
});
