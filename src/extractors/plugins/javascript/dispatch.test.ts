import { describe, it, expect } from "vitest";
// Side-effect: the resolver builds file-path maps via link-scoring, whose
// plugin-aggregated data (extension strip regex, external prefixes) is pushed
// in by the registry.
import "../../registry.js";
import { JsComponentEmitResolver } from "./dispatch.js";
import type { FileAnalysis } from "../../../types/analysis.js";

/**
 * Component-event dispatch: a child's emit('save') and the parent's
 * <Child @save="onSave"> have no name-resolvable edge — the resolver joins
 * them via tag + declared event, exactly (no name guessing).
 */

function fa(filePath: string, over: Partial<FileAnalysis> = {}): FileAnalysis {
  return {
    filePath,
    language: "typescript",
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    dataSources: [],
    events: [],
    interactiveElements: [],
    subComponents: [],
    ...over,
  } as unknown as FileAnalysis;
}

const fn = (name: string, line: number, endLine: number) =>
  ({ name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line, endLine });

const parent = fa("src/pages/Orders.vue", {
  functions: [fn("onSave", 20, 30)],
  interactiveElements: [
    { element: "custom", event: "@save", handler: "onSave", line: 4, component: "SaveDialog" },
  ],
  subComponents: [{ name: "SaveDialog", importSource: "../components/SaveDialog.vue", props: [], line: 4 }],
});

const child = fa("src/components/SaveDialog.vue", {
  functions: [fn("confirm", 10, 15)],
  events: [{ name: "save", params: [], line: 12 }], // emit inside confirm()
});

describe("JsComponentEmitResolver", () => {
  it("wires the child's emit site to the parent's bound handler", () => {
    const [link] = new JsComponentEmitResolver().resolve([parent, child]);
    expect(link).toMatchObject({
      sourceFile: "src/components/SaveDialog.vue",
      sourceSymbol: "confirm",
      callName: "emit:save",
      targetFile: "src/pages/Orders.vue",
      targetSymbol: "onSave",
      confidence: "INFERRED",
    });
  });

  it("matches kebab-case tags and event names to their camel forms", () => {
    const kebabParent = fa("src/pages/Orders.vue", {
      functions: [fn("onItemClick", 20, 30)],
      interactiveElements: [
        { element: "custom", event: "@item-click", handler: "onItemClick", line: 4, component: "save-dialog" },
      ],
      subComponents: [{ name: "SaveDialog", importSource: "../components/SaveDialog.vue", props: [], line: 4 }],
    });
    const camelChild = fa("src/components/SaveDialog.vue", {
      events: [{ name: "itemClick", params: [], line: 2 }],
    });
    const [link] = new JsComponentEmitResolver().resolve([kebabParent, camelChild]);
    expect(link?.targetSymbol).toBe("onItemClick");
    expect(link?.sourceSymbol).toBe("<template>"); // no containing fn at the emit line
  });

  it("creates nothing for events the child never declares (native fallthrough)", () => {
    const clickParent = fa("src/pages/Orders.vue", {
      functions: [fn("submit", 20, 30)],
      interactiveElements: [
        { element: "custom", event: "@click", handler: "submit", line: 4, component: "SaveDialog" },
      ],
      subComponents: [{ name: "SaveDialog", importSource: "../components/SaveDialog.vue", props: [], line: 4 }],
    });
    expect(new JsComponentEmitResolver().resolve([clickParent, child])).toHaveLength(0);
  });

  it("creates nothing for external/library components", () => {
    const extParent = fa("src/pages/Orders.vue", {
      functions: [fn("submit", 20, 30)],
      interactiveElements: [
        { element: "custom", event: "@click", handler: "submit", line: 4, component: "IstButton" },
      ],
      subComponents: [{ name: "IstButton", importSource: "@ist-group/commonui-components-vue", props: [], line: 4 }],
    });
    expect(new JsComponentEmitResolver().resolve([extParent, child])).toHaveLength(0);
  });

  it("fans out to every parent binding the same child event", () => {
    const p2 = fa("src/pages/Archive.vue", {
      functions: [fn("onArchiveSave", 5, 9)],
      interactiveElements: [
        { element: "custom", event: "@save", handler: "onArchiveSave", line: 2, component: "SaveDialog" },
      ],
      subComponents: [{ name: "SaveDialog", importSource: "../components/SaveDialog.vue", props: [], line: 2 }],
    });
    const links = new JsComponentEmitResolver().resolve([parent, p2, child]);
    expect(links.map((l) => l.targetSymbol).sort()).toEqual(["onArchiveSave", "onSave"]);
  });
});

describe("JsPropCallbackResolver — React callback props", () => {
  it("links a child's prop call to the parent's bound handler, through a drilled prop", async () => {
    const { JsPropCallbackResolver } = await import("./dispatch.js");
    const call = (name: string, line: number) => ({ name, kind: "internal" as const, target: null, line });
    const grand = fa("src/AddMovie.js", {
      functions: [{ ...fn("AddMovie.onLookup", 10, 14) }],
      interactiveElements: [{ element: "custom", event: "onMovieLookupChange", handler: "this.onLookup", line: 20, component: "AddNewMovieConnector" }],
      subComponents: [{ name: "AddNewMovieConnector", importSource: "./AddNewMovieConnector", props: [], line: 20 }],
    });
    const connector = fa("src/AddNewMovieConnector.js", {
      // Drills the prop on: binds its own prop to the child's.
      interactiveElements: [{ element: "custom", event: "onMovieLookupChange", handler: "onMovieLookupChange", line: 8, component: "AddNewMovie" }],
      subComponents: [{ name: "AddNewMovie", importSource: "./AddNewMovie", props: [], line: 8 }],
    });
    const child = fa("src/AddNewMovie.js", {
      functions: [{ ...fn("AddNewMovie.onSearchInputChange", 3, 5), calls: [call("this.props.onMovieLookupChange", 4)] }],
      interactiveElements: [{ element: "custom", event: "onModalClose", handler: "onModalClose", line: 9, component: "Modal" }],
    });
    const links = new JsPropCallbackResolver().resolve([grand, connector, child]);
    expect(links.map((l) => `${l.sourceFile}::${l.sourceSymbol} -${l.callName}-> ${l.targetFile}::${l.targetSymbol}`)).toEqual([
      "src/AddNewMovieConnector.js::<template> -onMovieLookupChange-> src/AddMovie.js::AddMovie.onLookup",
      "src/AddNewMovie.js::AddNewMovie.onSearchInputChange -this.props.onMovieLookupChange-> src/AddMovie.js::AddMovie.onLookup",
    ]);
  });
});
