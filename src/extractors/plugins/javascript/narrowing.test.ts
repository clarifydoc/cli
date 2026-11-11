import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";

async function callsOf(src: string): Promise<Map<string, (string | undefined)[]>> {
  const tree = await parseSource(src, "typescript", "x.ts");
  const fns = new JavaScriptExtractor().extractFunctions(tree, src);
  const out = new Map<string, (string | undefined)[]>();
  for (const c of fns.find((f) => f.name === "run")!.calls) {
    out.set(c.name, [...(out.get(c.name) ?? []), c.receiverType]);
  }
  return out;
}

describe("instanceof narrowing (CallInfo.receiverType)", () => {
  it("types a call in the true branch, and only there", async () => {
    const m = await callsOf(`
      function run(x: Squad) {
        if (x instanceof Club && ready) { x.sign(); }
        x.train();
      }`);
    expect(m.get("x.sign")).toEqual(["Club"]);
    expect(m.get("x.train")).toEqual([undefined]);
  });

  it("narrows the else of a negated test, an early exit's tail, && and ?:", async () => {
    const m = await callsOf(`
      function run(a, b, c, d, e) {
        if (!(a instanceof Club)) { other(); } else { a.sign(); }
        if (!(b instanceof Garage)) return;
        b.park();
        c instanceof Player && c.train();
        d instanceof Car ? d.drive() : d.walk();
      }`);
    expect(m.get("a.sign")).toEqual(["Club"]);
    expect(m.get("b.park")).toEqual(["Garage"]);
    expect(m.get("c.train")).toEqual(["Player"]);
    expect(m.get("d.drive")).toEqual(["Car"]);
    expect(m.get("d.walk")).toEqual([undefined]);
  });

  it("does not narrow a rebound name, a callback, another name or a test that does not guard", async () => {
    const m = await callsOf(`
      function run(x, y) {
        if (x instanceof Club) { x = pick(); x.sign(); }
        if (x instanceof Club) { later(() => x.train()); }
        if (y instanceof Club) { x.rank(); }
        if (!(x instanceof Club)) { x.fire(); }
        if (!(x instanceof Club)) log();
        x.after();
      }`);
    expect(m.get("x.sign")).toEqual([undefined]);
    expect(m.get("x.train")).toEqual([undefined]);
    expect(m.get("x.rank")).toEqual([undefined]);
    expect(m.get("x.fire")).toEqual([undefined]);
    expect(m.get("x.after")).toEqual([undefined]);
  });
});
