import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { createEmptyAnalysis, type FileAnalysis } from "../../../types/analysis.js";

const CLUB = `function Club(name) {
  this.name = name;
  this.rename = function (next) {
    this.name = next;
    this.announce();
  };
}

Club.prototype.sign = function (player) {
  this.announce();
  return player;
};

Club.prototype.announce = function () {
  return this.name;
};

function Garage() {}
Garage.prototype = {
  park: function (car) { this.wash(car); },
  wash(car) { return car; },
};

module.exports = Club;
`;

async function read(src: string) {
  const tree = await parseSource(src, "javascript" as any, "club.js");
  const x = new JavaScriptExtractor();
  return { functions: x.extractFunctions(tree, src), classes: x.extractClasses(tree, src) };
}

describe("ES5 constructor functions are classes", () => {
  it("gathers prototype members, `X.prototype = { … }` members and `this.m = function` into a class named for the constructor", async () => {
    const { functions, classes } = await read(CLUB);
    expect(classes.map((c) => `${c.name}: ${c.methods.map((m) => m.name).join(",")}`)).toEqual([
      "Club: rename,sign,announce",
      "Garage: park,wash",
    ]);
    // The prototype members are no longer free functions; the constructor keeps only its own calls.
    expect(functions.map((f) => f.name)).toEqual(["Club", "Garage"]);
    expect(functions[0]!.calls).toEqual([]);
    expect(classes[0]!.methods.find((m) => m.name === "rename")?.calls.map((c) => c.name)).toEqual(["this.announce"]);
  });

  it("links `new Club().sign()`, a typed local's member and `this.` calls inside prototype members", async () => {
    const club = createEmptyAnalysis("src/club.js", "javascript") as FileAnalysis;
    Object.assign(club, await read(CLUB));
    const main = createEmptyAnalysis("src/main.js", "javascript") as FileAnalysis;
    main.imports = [{ source: "./club", specifiers: ["Club"], isDefault: true, isNamespace: false, isType: false, line: 1 }];
    main.functions = [{
      name: "run", params: [], returnType: null, isAsync: false, isExported: false, decorators: [], line: 3, endLine: 8,
      localTypes: [{ name: "c", type: "Club" }],
      calls: [
        { name: "new Club('Rovers').sign", kind: "internal", target: null, line: 4 },
        { name: "c.rename", kind: "internal", target: null, line: 6 },
      ],
    }];
    const links = buildSymbolLinks([club, main]).map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetSymbol}`);
    expect(links).toEqual(expect.arrayContaining([
      "run new Club('Rovers').sign -> Club.sign",
      "run c.rename -> Club.rename",
      "Club.sign this.announce -> Club.announce",
      "Garage.park this.wash -> Garage.wash",
    ]));
  });
});
