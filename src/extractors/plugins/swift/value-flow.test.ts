/**
 * Swift value-flow facts through the real per-file pipeline and the linker: a function value in a local, a stored
 * closure property, an array or dictionary of closures, a returned function and an `@escaping` parameter kept by
 * an initializer — each beside a namesake that must link nothing.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyzeAll(files: Record<string, string>, projectOf: (rel: string) => string = () => "root"): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "swift-vf-"));
  const out = await mkdtemp(join(tmpdir(), "swift-vf-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "swift" },
      frameworkIds: [],
      projectId: projectOf(rel),
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

const flow = (analyses: FileAnalysis[]): string[] =>
  buildSymbolLinks(analyses)
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.sourceSymbol}: ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();

describe("Swift value flow", () => {
  let links: string[];
  beforeAll(async () => {
    const analyses = await analyzeAll({
      "Sources/Actions.swift": `func saveClub() {}
func loadClub() {}
func retireClub() {}
func loanClub() {}
`,
      "Sources/Wiring.swift": `func wrapper(_ cb: @escaping () -> Void) {
    cb()
}

func localCopy() {
    let f = saveClub
    let g = f
    wrapper(g)
}

func makeHandler() -> () -> Void {
    return retireClub
}

func viaFactory() {
    let h = makeHandler()
    h()
}

func viaArray() {
    var handlers: [() -> Void] = [saveClub]
    handlers.append(loadClub)
    for h in handlers {
        h()
    }
}

final class Registry {
    var table: [String: () -> Void] = ["save": saveClub]
    func fire() {
        table["save"]?()
    }
}

final class Editor {
    var onSave: (() -> Void)?
    var onClose: (() -> Void)?
    init(done: @escaping () -> Void) {
        self.onClose = done
    }
    func fire() {
        onSave?()
        onClose?()
    }
}

final class Lookalike {
    var onSave: (() -> Void)?
    func fire() {
        onSave?()
    }
}

final class Printer {
    func onSave() {}
    func run() {
        onSave()
    }
}

func assemble() {
    let editor = Editor(done: loanClub)
    editor.onSave = { [weak editor] in loadClub() }
    editor.fire()
}
`,
    });
    links = flow(analyses);
  });

  it("follows a local copied and handed to an @escaping wrapper", () => {
    expect(links).toContain("wrapper: cb -> Sources/Actions.swift::saveClub");
    expect(links.filter((l) => l.startsWith("wrapper:"))).toHaveLength(1);
  });

  it("follows a returned function", () => {
    expect(links).toContain("viaFactory: h -> Sources/Actions.swift::retireClub");
  });

  it("follows the elements of an array and a dictionary", () => {
    expect(links).toContain("viaArray: h -> Sources/Actions.swift::saveClub");
    expect(links).toContain("viaArray: h -> Sources/Actions.swift::loadClub");
    expect(links).toContain("Registry.fire: table[] -> Sources/Actions.swift::saveClub");
  });

  it("joins a closure property set through a typed local and run in the type's own method", () => {
    expect(links.filter((l) => l.startsWith("Editor.fire: onSave"))).toEqual(["Editor.fire: onSave -> Sources/Actions.swift::loadClub"]);
  });

  it("joins an @escaping initializer argument kept in a property", () => {
    expect(links).toContain("Editor.fire: onClose -> Sources/Actions.swift::loanClub");
  });

  it("keeps a namesake property of another type, and a method of the same name, apart", () => {
    expect(links.filter((l) => l.startsWith("Lookalike.fire:"))).toEqual([]);
    expect(links.filter((l) => l.startsWith("Printer.run:"))).toEqual([]);
  });

  it("binds an argument label to the parameter that label names, never by position or by internal name", async () => {
    const analyses = await analyzeAll({
      "Sources/Hooks.swift": `func onFullTime() {}
func onKickoff() {}
func onSubstitution() {}
func onWhistle() {}
`,
      "Sources/Schedule.swift": `func schedule(when: Int, callback handler: @escaping () -> Void, fallback: (() -> Void)? = nil) {
    handler()
    fallback?()
}

func scheduleTwo(_ first: @escaping () -> Void, callback: (() -> Void)? = nil) {
    callback?()
    first()
}

func plan() {
    schedule(when: 1, callback: onFullTime, fallback: onKickoff)
    scheduleTwo(onWhistle, callback: onSubstitution)
    schedule(when: 2, handler: onWhistle)
}
`,
    });
    const found = flow(analyses);
    expect(found).toContain("schedule: handler -> Sources/Hooks.swift::onFullTime");
    expect(found).toContain("schedule: fallback -> Sources/Hooks.swift::onKickoff");
    expect(found.filter((l) => l.startsWith("schedule: handler"))).toHaveLength(1);
    expect(found).toContain("scheduleTwo: first -> Sources/Hooks.swift::onWhistle");
    expect(found).toContain("scheduleTwo: callback -> Sources/Hooks.swift::onSubstitution");
    // `handler:` is the internal name, not a label a caller may write: it binds nothing.
    expect(found.some((l) => l.endsWith("::onWhistle") && l.startsWith("schedule:"))).toBe(false);
  });
});

describe("Swift value flow through a typealias'd function type", () => {
  it("recognises a typealias of the same file or another, never a class of that name", async () => {
    const found = flow(await analyzeAll({
      "Sources/Types.swift": `typealias ClubTask = (Club) -> Void
final class Club {}
final class Squad {}
`,
      "Sources/Actions.swift": `func saveClub(_ c: Club) {}
func loadClub(_ c: Club) {}
func retireClub(_ c: Club) {}
`,
      "Sources/Editor.swift": `typealias LocalTask = () -> Void
func localOne() {}
final class Editor {
    var onSave: ClubTask
    var onLoad: LocalTask?
    var onRetire: ClubTask?
    init(onSave: @escaping ClubTask) {
        self.onSave = onSave
    }
    func fire(_ c: Club) {
        onSave(c)
        onLoad?()
        onRetire?(c)
    }
}
final class Lookalike {
    var onSave: Squad
    init(onSave: Squad) { self.onSave = onSave }
    func fire(_ c: Club) {
        onSave(c)
    }
}
func assemble() {
    let e = Editor(onSave: saveClub)
    e.onLoad = localOne
    e.onRetire = retireClub
    e.fire(Club())
}
`,
    }));
    expect(found).toContain("Editor.fire: onSave -> Sources/Actions.swift::saveClub");
    expect(found).toContain("Editor.fire: onLoad -> Sources/Editor.swift::localOne");
    expect(found).toContain("Editor.fire: onRetire -> Sources/Actions.swift::retireClub");
    expect(found.filter((l) => l.startsWith("Lookalike.fire:"))).toEqual([]);
  });
});

describe("Swift value flow: a name two sub-projects declare differently", () => {
  it("reads the name in the file's own sub-project, never a pool across sub-projects", async () => {
    const found = flow(await analyzeAll({
      "league/Sources/Kick.swift": `typealias Kick = (Player) -> Void
final class Player {}
`,
      "cup/Sources/Kick.swift": `final class Kick {
    func callAsFunction(_ p: Player) {}
}
final class Player {}
`,
      "cup/Sources/Actions.swift": `func scoreGoal(_ p: Player) {}
`,
      "cup/Sources/Own.swift": `final class OwnTaker {
    var onKick: Kick
    init(onKick: Kick) { self.onKick = onKick }
    func fire(_ p: Player) {
        onKick(p)
    }
}
func ownWire() {
    OwnTaker(onKick: Kick()).fire(Player())
}
`,
      "arena/Sources/Stray.swift": `func scoreGoal(_ p: Player) {}
final class StrayTaker {
    var onKick: Kick
    init(onKick: @escaping Kick) { self.onKick = onKick }
    func fire(_ p: Player) {
        onKick(p)
    }
}
func strayWire() {
    StrayTaker(onKick: scoreGoal).fire(Player())
}
`,
      "league/Sources/Own.swift": `func scoreGoal(_ p: Player) {}
final class LeagueTaker {
    var onKick: Kick
    init(onKick: @escaping Kick) { self.onKick = onKick }
    func fire(_ p: Player) {
        onKick(p)
    }
}
func leagueWire() {
    LeagueTaker(onKick: scoreGoal).fire(Player())
}
`,
    }, (rel) => rel.split("/")[0]!));
    expect(found.filter((l) => l.startsWith("OwnTaker.fire:") || l.startsWith("StrayTaker.fire:"))).toEqual([]);
    expect(found).toContain("LeagueTaker.fire: onKick -> league/Sources/Own.swift::scoreGoal");
  });
});
