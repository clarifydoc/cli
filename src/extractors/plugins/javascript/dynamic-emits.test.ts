import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: link-scoring data
import { createEmptyAnalysis, type FileAnalysis } from "../../../types/analysis.js";
import { dynamicEmitFacts } from "./events.js";
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
});
