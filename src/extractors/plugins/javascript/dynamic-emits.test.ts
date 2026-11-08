import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: link-scoring data
import { createEmptyAnalysis, type FileAnalysis } from "../../../types/analysis.js";
import { dynamicEmitFacts, tagEventLiterals } from "./events.js";
import { JsComponentEmitResolver } from "./dispatch.js";

const fn = (name: string, line: number) => ({ name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line, endLine: line });

describe("a component that emits by data", () => {
  it("reads the lines of non-literal emits and the strings a file gives an event key", () => {
    const facts = dynamicEmitFacts(`const UPLOAD = 'up'
const buttons = [{ text: 'Sell', event: 'sell' }, { text: 'Loan', event: "loan" }]
emit(UPLOAD)
$emit(btn.event)
emit('literal')
(name) => emit(name)`);
    expect(facts).toEqual({ lines: [4, 6], literals: ["sell", "loan"] });
  });

  it("reaches the handler of the event a parent states, and no other binding on the tag", () => {
    const parent: FileAnalysis = {
      ...createEmptyAnalysis("src/views/Garage.vue", "typescript"),
      functions: [fn("sellCar", 10), fn("noop", 11)],
      eventLiterals: ["sell"],
      imports: [{ source: "src/components/ButtonGroup.vue", specifiers: ["ButtonGroup"], isDefault: true, isNamespace: false, isType: false, line: 1 }],
      subComponents: [{ name: "ButtonGroup", importSource: "src/components/ButtonGroup.vue", props: [], line: 2 }],
      interactiveElements: [
        { element: "custom", event: "@sell", handler: "sellCar", line: 2, component: "ButtonGroup" },
        { element: "custom", event: "@other", handler: "noop", line: 2, component: "ButtonGroup" },
      ],
    };
    const child: FileAnalysis = { ...createEmptyAnalysis("src/components/ButtonGroup.vue", "typescript"), dynamicEmits: [3], functions: [fn("send", 3)] };
    const links = new JsComponentEmitResolver().resolve([parent, child]);
    expect(links.map((l) => `${l.callName} ${l.sourceSymbol} -> ${l.targetSymbol}`)).toEqual(["emit:sell send -> sellCar"]);
    // Without the parent stating the name, nothing is joined.
    expect(new JsComponentEmitResolver().resolve([{ ...parent, eventLiterals: [] }, child])).toEqual([]);
  });

  it("reads the strings a tag's bindings give it, through the declaration they name", () => {
    const script = `const buttons = [{ text: 'Sell', event: 'sell' }]
const other = computed(() => [
  { text: 'Loan', event: 'loan' },
])
const unrelated = [{ event: 'scrap' }]
const menu = computed(() => other.value.map((x) => x))`;
    const template = `<ButtonGroup :buttons="buttons" /><ToolBar :items="other.value" /><Plain :x="1" /><Chain :items="menu" /><Spread :items="[...buttons, ...other]" />`;
    expect(tagEventLiterals(template, script)).toEqual({ ButtonGroup: ["sell"], ToolBar: ["loan"], Spread: ["sell", "loan"], Chain: ["loan"] });
  });

  it("joins a dynamic emit only to the handler of an event its own tag states", () => {
    const mk = (path: string, name: string): FileAnalysis => ({ ...createEmptyAnalysis(path, "typescript"), functions: [fn(name, 10), fn("scrapIt", 12)] });
    const parent: FileAnalysis = {
      ...mk("src/views/Garage.vue", "sellCar"),
      eventLiterals: ["sell", "scrap"],
      eventLiteralsByTag: { ButtonGroup: ["sell"], ToolBar: ["scrap"] },
      imports: [
        { source: "src/components/ButtonGroup.vue", specifiers: ["ButtonGroup"], isDefault: true, isNamespace: false, isType: false, line: 1 },
        { source: "src/components/ToolBar.vue", specifiers: ["ToolBar"], isDefault: true, isNamespace: false, isType: false, line: 1 },
      ],
      subComponents: [
        { name: "ButtonGroup", importSource: "src/components/ButtonGroup.vue", props: [], line: 2 },
        { name: "ToolBar", importSource: "src/components/ToolBar.vue", props: [], line: 3 },
      ],
      interactiveElements: [
        { element: "custom", event: "@sell", handler: "sellCar", line: 2, component: "ButtonGroup" },
        { element: "custom", event: "@scrap", handler: "scrapIt", line: 2, component: "ButtonGroup" },
        { element: "custom", event: "@scrap", handler: "scrapIt", line: 3, component: "ToolBar" },
      ],
    };
    const group: FileAnalysis = { ...createEmptyAnalysis("src/components/ButtonGroup.vue", "typescript"), dynamicEmits: [3], functions: [fn("send", 3)] };
    const bar: FileAnalysis = { ...createEmptyAnalysis("src/components/ToolBar.vue", "typescript"), dynamicEmits: [3], functions: [fn("send", 3)] };
    const links = new JsComponentEmitResolver().resolve([parent, group, bar]);
    expect(links.map((l) => `${l.sourceFile} ${l.callName} -> ${l.targetSymbol}`).sort()).toEqual([
      "src/components/ButtonGroup.vue emit:sell -> sellCar",
      "src/components/ToolBar.vue emit:scrap -> scrapIt",
    ]);
  });

  it("reaches the parent's handler through a composable that calls the callback emitting, per instance", () => {
    const call = (name: string, line: number, extra: object = {}) => ({ name, kind: "internal" as const, target: null, line, ...extra });
    const form: FileAnalysis = {
      ...createEmptyAnalysis("src/components/MatchForm.vue", "typescript"),
      imports: [{ source: "src/composables/useDialog.ts", specifiers: ["useDialog"], isDefault: false, isNamespace: false, isType: false, line: 1 }],
      events: [{ name: "save", line: 5, sites: [5] }] as FileAnalysis["events"],
      functions: [
        { ...fn("<setup>", 3), endLine: 6, localTypes: [{ name: "dialog", type: "", from: "useDialog('match', v => emit('save', v))" }], calls: [call("useDialog", 5, { kind: "cross-file", target: "src/composables/useDialog.ts", args: ["", "=>emit"] })] },
        { ...fn("submit", 7), endLine: 8, calls: [call("dialog.confirm", 7)] },
      ],
    };
    const lib: FileAnalysis = {
      ...createEmptyAnalysis("src/composables/useDialog.ts", "typescript"),
      functions: [
        { ...fn("useDialog", 1), endLine: 10, params: [{ name: "name" }, { name: "onSave" }] as never },
        { ...fn("confirm", 3), endLine: 5, calls: [call("onSave", 4)] },
      ],
    };
    const parent: FileAnalysis = {
      ...createEmptyAnalysis("src/views/MatchPage.vue", "typescript"),
      functions: [fn("storeMatch", 10)],
      imports: [{ source: "src/components/MatchForm.vue", specifiers: ["MatchForm"], isDefault: true, isNamespace: false, isType: false, line: 1 }],
      subComponents: [{ name: "MatchForm", importSource: "src/components/MatchForm.vue", props: [], line: 2 }],
      interactiveElements: [{ element: "custom", event: "@save", handler: "storeMatch", line: 2, component: "MatchForm" }],
    };
    const links = new JsComponentEmitResolver().resolve([parent, form, lib]);
    expect(links.map((l) => `${l.sourceFile}:${l.sourceSymbol} ${l.callName} -> ${l.targetSymbol}`)).toContain("src/components/MatchForm.vue:submit dialog.confirm -> storeMatch");
    expect(links.some((l) => l.sourceFile === "src/composables/useDialog.ts")).toBe(false);
  });
});
