import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { loadSwiftReader } from "./tree-sitter.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { ParsedStructure } from "../../../types/language-plugin.js";

let readSwift: (source: string) => ParsedStructure;
beforeAll(async () => {
  readSwift = await loadSwiftReader();
});

const GARAGE = `import Vapor

/// A garage.
final class Garage {
    let repo: CarRepo

    @MainActor
    func park(_ car: Car) async throws -> Bay {
        guard let bay = try await self.repo.findBay(for: car.size) else { throw GarageError.full }
        bay?.reserve()
        let report = Club(id: 7).squad()
        DispatchQueue.main.async { self.notify(car) }
        func helper(_ c: Car) -> Int { c.wheels() }
        let wash = { (c: Car) in washCar(c) }
        print("parked \\(car.plate.normalized())")
        return try repo.find(car.id).first()
    }

    override init() {
        super.init()
    }
}

protocol CarRepo {
    func findBay(for size: Int) async throws -> Bay?
}
`;

describe("Swift through tree-sitter", () => {
  it("reads every func and init with its exact span, a nested one owning its calls", () => {
    const parsed = readSwift(GARAGE);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => [f.name, f.line, f.endLine])).toEqual([
      ["park", 8, 17],
      ["helper", 13, 13],
      ["init", 19, 21],
      ["findBay", 25, 25],
    ]);
    expect(parsed.functions.find((f) => f.name === "helper")!.calls.map((c) => c.name)).toEqual(["c.wheels"]);
  });

  it("names calls as the patterns do, and the chains, constructions and interpolations they cannot read", () => {
    const park = readSwift(GARAGE).functions.find((f) => f.name === "park")!;
    expect(park.calls.map((c) => c.name)).toEqual([
      "repo.findBay",
      "bay.reserve",
      "Club.squad",
      "Club",
      "DispatchQueue.main.async",
      "self.notify",
      "washCar",
      "car.plate.normalized",
      "repo.find().first",
      "repo.find",
    ]);
    expect(park.calls.find((c) => c.name === "Club.squad")).toMatchObject({ receiverType: "Club" });
  });

  it("names no subscript, macro, case pattern or construction by trailing closure (real-repo FP)", () => {
    const calls = (body: string) => readSwift(`func f() {\n${body}\n}\n`).functions[0]!.calls.map((c) => c.name);
    expect(calls("let x = items[0].name()")).toEqual([]);
    // The grammar puts a prefix operator inside the callee.
    expect(calls("if !isOffside(player), !self.rules.allows(pass) { whistle() }")).toEqual(["isOffside", "rules.allows", "whistle"]);
    expect(calls("#expect(club.isActive())")).toEqual(["club.isActive"]);
    expect(calls("VStack { Text(title) }")).toEqual(["Text"]);
    expect(calls("switch result { case .success(let squad): show(squad) case .failure: break }")).toEqual(["show"]);
    expect(calls("let handler: @Sendable (Int) -> Void = { _ in }")).toEqual([]);
    // A closure's `$0` is a receiver of its own; the extraction settles it bare unless a typed collection hands it over.
    expect(calls("monitors.forEach { $0.kickoff(match) }")).toEqual(["monitors.forEach", "$0.kickoff"]);
    expect(extractWithRegex("func f() {\n    monitors.forEach { $0.kickoff(match) }\n}\n", "a.swift", "swift", undefined, readSwift("func f() {\n    monitors.forEach { $0.kickoff(match) }\n}\n")).functions[0]!.calls.map((c) => c.name)).toEqual(["monitors.forEach", "kickoff"]);
    // A generic type's construction, which the patterns miss at `<`.
    expect(calls("let cache = Cache<String, Club>(capacity: 8)")).toEqual(["Cache"]);
  });

  it("names a container lookup as the DI patterns do", () => {
    const calls = readSwift("func f() { container.resolve(SquadRepo.self)!.save(player) }\n").functions[0]!.calls;
    expect(calls.map((c) => c.name)).toContain("container.resolve(SquadRepo.self).save");
    expect(calls.find((c) => c.name.endsWith(".save"))).toMatchObject({ receiverType: "SquadRepo" });
  });

  it("starts every parse from a clean scanner (the scanner patch in setup-grammars)", () => {
    // Before the patch the scanner's state lived in memory it never allocated: every parse after the first broke.
    for (let i = 0; i < 3; i++) {
      expect(readSwift("#if os(iOS)\nlet x = 1\n#endif\n").syntaxErrors).toBe(0);
      expect(readSwift("let s = #selector(kickoff)\nfunc f() { if #available(iOS 15, *) { g() } }\n").syntaxErrors).toBe(0);
    }
  });

  it("counts the errors of a file the grammar cannot read, so core keeps the regex reading", () => {
    expect(readSwift("func f( {\n").syntaxErrors).toBeGreaterThan(0);
  });
});

/**
 * Where the two readings of a fixture differ, and why the parser's is the one to keep: `file → function →
 * [calls only the patterns record, calls only the parser records]`. A method on a call's result is named as the
 * chain from its first call (`app.grouped().get`), which the linker types through declared return types; the
 * patterns skip it, since a bare name after `)` would let any same-named function capture it.
 */
const KNOWN: Record<string, Record<string, [string[], string[]]>> = {
  // A SwiftUI `body` is a chain of modifiers on a view: the parser names each from its first call.
  "test-fixtures/sample-ios-swiftui/Notes/NotesApp.swift": { "NotesApp.body": [["modelContainer"], ["WindowGroup.modelContainer"]] },
  "test-fixtures/sample-ios-swiftui/Notes/Views/BallListView.swift": { "BallListView.body": [["sheet"], ["List.toolbar().sheet", "List.toolbar"]] },
  "test-fixtures/sample-ios-swiftui/Notes/Views/RootTabs.swift": { "RootTabs.body": [[], ["BallListView.tabItem", "SettingsView.tabItem"]] },
  // A call through a property of a lowercase receiver keeps its whole path (`req.content.decode`), so the linker
  // types it field by field; the patterns name its last two (`content.decode`).
  "test-fixtures/sample-ios-swiftui/Notes/Legacy/ArchiveStore.swift": {
    "ArchiveStore.archivedNotes": [["viewContext.fetch"], ["container.viewContext.fetch"]],
    "ArchiveStore.makeFolder": [["viewContext.save"], ["container.viewContext.save"]],
  },
  "test-fixtures/sample-swift-vapor/Sources/App/DrillController.swift": {
    "DrillController.create": [["content.decode"], ["req.content.decode"]],
    "DrillController.index": [[], ["Drill.query().filter().all"]],
    "DrillController.remove": [["parameters.get"], ["req.parameters.get"]],
    "DrillController.search": [[], ["Drill.query().filter().limit", "Drill.query().filter().limit().all"]],
    "DrillController.show": [["parameters.get"], ["req.parameters.get"]],
  },
  "test-fixtures/sample-swift-vapor/Sources/App/routes.swift": {
    routes: [[], ["app.grouped().get"]],
  },
};

describe("Swift: tree-sitter and the patterns agree on the fixtures", () => {
  const root = resolve(__dirname, "../../../..");
  const files = globSync("test-fixtures/**/*.swift", { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} as the patterns do, but where it is listed as better`, () => {
      const src = readFileSync(resolve(root, rel), "utf-8");
      const parsed = readSwift(src);
      expect(parsed.syntaxErrors).toBe(0);
      const shape = (a: ReturnType<typeof extractWithRegex>) => [
        ...a.functions.map((f) => ({ name: f.name, line: f.line, endLine: f.endLine, calls: f.calls.map((c) => c.name) })),
        ...a.classes.flatMap((c) => c.methods.map((m) => ({ name: `${c.name}.${m.name}`, line: m.line, endLine: m.endLine, calls: m.calls.map((x) => x.name) }))),
      ];
      const regex = shape(extractWithRegex(src, rel, "swift"));
      const tree = shape(extractWithRegex(src, rel, "swift", undefined, parsed));
      expect(tree.map(({ calls: _, ...span }) => span)).toEqual(regex.map(({ calls: _, ...span }) => span));
      const differences: Record<string, [string[], string[]]> = {};
      regex.forEach((fn, i) => {
        const b = tree[i]!.calls;
        const onlyA = fn.calls.filter((c) => !b.includes(c));
        const onlyB = b.filter((c) => !fn.calls.includes(c));
        if (onlyA.length + onlyB.length > 0) differences[fn.name] = [onlyA, onlyB];
      });
      expect(differences).toEqual(KNOWN[rel] ?? {});
    });
  }
});

describe("Swift body bindings", () => {
  const read = (src: string) => extractWithRegex(src, "Sources/App/a.swift", "swift", undefined, readSwift(src));

  it("records return types, so a method's result types the next call", () => {
    const a = read("class Car {\n    func engine() -> Engine { Engine() }\n    func clubs() async throws -> [Club] { [] }\n    func plain() {}\n}\n");
    const [engine, clubs, plain] = a.classes[0]!.methods;
    expect([engine!.returnType, clubs!.returnType, plain!.returnType]).toEqual(["Engine", "[Club]", null]);
    const f = read("func drive(car: Car) {\n    let e = car.engine()\n    e.start()\n    car.engine().start()\n    car.radio.start()\n}\n").functions[0]!;
    expect(f.localTypes).toEqual([{ name: "e", type: "", from: "car.engine()" }]);
    expect(f.calls.map((c) => c.name)).toEqual(["car.engine", "e.start", "car.engine().start", "car.radio.start"]);
  });

  it("makes a computed or observed property a function that owns its calls", () => {
    const a = read("struct ClubView: View {\n    let model: ClubModel\n    var body: some View {\n        Button(\"go\") { model.load() }\n    }\n    var title: String { model.name() }\n    var count: Int = 0 {\n        didSet { model.save() }\n    }\n    var plain: Int = 1\n}\n");
    const methods = a.classes.find((c) => c.name === "ClubView")!.methods;
    expect(methods.map((m) => [m.name, m.calls.map((c) => c.name).filter((n) => n !== "Button")])).toEqual([
      ["body", ["model.load"]],
      ["title", ["model.name"]],
      ["count", ["model.save"]],
    ]);
  });

  it("records an extension of a nested type on that type, and its construction by the nested name", () => {
    const a = read("extension League.Table: Trainable {\n    func train() {}\n}\nfunc mk() {\n    let t = League.Table()\n}\n");
    expect(a.classes.map((c) => c.name)).toEqual(["League::Table"]);
    expect(a.functions.find((f) => f.name === "mk")!.calls.map((c) => c.name)).toEqual(["League.Table"]);
  });

  it("types loop, closure and narrowed bindings", () => {
    const f = read(
      [
        "func f(clubs: [Club], maybe: Club?, thing: Any) {",
        "    for c in clubs { c.promote() }",
        "    clubs.forEach { $0.promote() }",
        "    clubs.map { club in club.inspect() }",
        "    if let m = maybe { m.promote() }",
        "    guard let g = maybe else { return }",
        "    if let k = thing as? Club { k.inspect() }",
        "    if case let .some(s) = maybe { s.promote() }",
        "    switch thing { case let w as Club: w.inspect() default: break }",
        "}",
        "",
      ].join("\n"),
    ).functions[0]!;
    expect(f.localTypes).toEqual(
      expect.arrayContaining(
        ["m", "g", "k", "s", "w", "c", "club", "$0"].map((name) => ({ name, type: "Club" })),
      ),
    );
  });
});
