import { describe, it, expect } from "vitest";
import "../registry.js";
import { dropProductionToTestLinks, resolveProjectDispatch } from "./index.js";
import type { FileAnalysis, SymbolLink } from "../../types/analysis.js";

function fa(filePath: string, over: Partial<FileAnalysis> = {}): FileAnalysis {
  return { filePath, language: "typescript", functions: [], classes: [], imports: [], exports: [], dataSources: [], events: [], interactiveElements: [], subComponents: [], ...over } as unknown as FileAnalysis;
}
const fn = (name: string, line: number, endLine: number) =>
  ({ name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line, endLine });

const child = fa("src/components/ClubCard.vue", { functions: [fn("handleDelete", 10, 15)], events: [{ name: "delete", params: [], line: 12 }] });
const page = fa("src/pages/Clubs.vue", {
  functions: [fn("removeClub", 20, 30)],
  interactiveElements: [{ element: "custom", event: "@delete", handler: "removeClub", line: 4, component: "ClubCard" }],
  subComponents: [{ name: "ClubCard", importSource: "../components/ClubCard.vue", props: [], line: 4 }],
});
const story = fa("src/components/ClubCard.story.vue", {
  functions: [fn("onDelete", 20, 30)],
  interactiveElements: [{ element: "custom", event: "@delete", handler: "onDelete", line: 4, component: "ClubCard" }],
  subComponents: [{ name: "ClubCard", importSource: "./ClubCard.vue", props: [], line: 4 }],
});

describe("resolveProjectDispatch — test and story harnesses", () => {
  it("links a child's emit to the page that binds it but never into a story that renders the child", () => {
    const links = resolveProjectDispatch([child, page, story]);
    const targets = links.filter((l) => l.callName === "emit:delete").map((l) => l.targetFile);
    expect(targets).toEqual(["src/pages/Clubs.vue"]);
  });

  it("keeps a link from a test file and drops one from production into a spec", () => {
    const l = (sourceFile: string, targetFile: string): SymbolLink => ({ sourceFile, sourceSymbol: "a", sourceLine: 1, callName: "MQ x", targetFile, targetSymbol: "b", targetLine: 1, confidence: "INFERRED", strategy: "queue" } as SymbolLink);
    const analyses = [fa("src/useAlert.ts"), fa("src/Editor.spec.js", { language: "javascript" }), fa("src/Worker.ts")];
    const out = dropProductionToTestLinks([l("src/useAlert.ts", "src/Editor.spec.js"), l("src/Editor.spec.js", "src/Worker.ts"), l("src/useAlert.ts", "src/Worker.ts")], analyses);
    expect(out.map((x) => `${x.sourceFile}>${x.targetFile}`)).toEqual(["src/Editor.spec.js>src/Worker.ts", "src/useAlert.ts>src/Worker.ts"]);
  });
});
