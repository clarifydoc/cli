/**
 * Dart value-flow facts through the real per-file pipeline and the linker: a function value in a local, a field, a
 * list or map, a factory's return, and a widget's `onPressed` handed to its constructor and run by its State — each
 * beside a namesake that must link nothing.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyzeAll(files: Record<string, string>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "dart-vf-"));
  const out = await mkdtemp(join(tmpdir(), "dart-vf-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "dart" },
      frameworkIds: [],
      projectId: "root",
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

const FUNCTIONS = `void saveClub() {}
void loadClub() {}
void retireClub() {}
`;

describe("Dart value flow", () => {
  let links: string[];
  beforeAll(async () => {
    const analyses = await analyzeAll({
      "lib/actions.dart": FUNCTIONS,
      "lib/wiring.dart": `import 'actions.dart';

void wrapper(void Function() cb) {
  cb();
}

void localCopy() {
  final f = saveClub;
  final g = f;
  wrapper(g);
}

class Holder {
  VoidCallback? stored;
  void arm() {
    stored = loadClub;
  }
  void fire() {
    stored?.call();
  }
}

VoidCallback makeHandler() => retireClub;

void viaFactory() {
  final h = makeHandler();
  h();
}

void viaList() {
  final handlers = [saveClub, loadClub];
  for (final h in handlers) {
    h();
  }
}

class Registry {
  final table = <String, VoidCallback>{'save': saveClub};
  void fire() {
    table['save']!();
  }
}

class Gate {
  final VoidCallback _cb;
  late final VoidCallback later = () => retireClub();
  Gate(VoidCallback cb) : _cb = cb;
  void open() {
    _cb();
    later();
  }
}

void useGate() {
  Gate(saveClub);
}

void viaClosure(void Function()? onDone) {
  final cb = () => retireClub();
  cb();
  onDone!();
}
`,
      // A class with its own call(): the ordinary linker's, never a held function's.
      "lib/caller.dart": `class Caller {
  void call() {}
}
void useCaller() {
  final c = Caller();
  c.call();
}
void saveClubDecoy() {}
`,
      "lib/button.dart": `import 'package:flutter/material.dart';
import 'actions.dart';

class ClubButton extends StatefulWidget {
  final VoidCallback onPressed;
  final void Function(String)? onLongPressCallback;
  const ClubButton({required this.onPressed, this.onLongPressCallback});
  State<ClubButton> createState() => _ClubButtonState();
}

class _ClubButtonState extends State<ClubButton> {
  void tap() {
    widget.onPressed();
    widget.onLongPressCallback!('club');
  }
}

class Screen {
  Widget build() {
    return ClubButton(onPressed: saveClub, onLongPressCallback: (c) => loadClub());
  }
}
`,
      // The same field name on an unrelated widget, given another function.
      "lib/other_button.dart": `import 'package:flutter/material.dart';
import 'actions.dart';

class OtherButton extends StatefulWidget {
  final VoidCallback onPressed;
  const OtherButton({required this.onPressed});
  State<OtherButton> createState() => _OtherButtonState();
}

class _OtherButtonState extends State<OtherButton> {
  void tap() {
    widget.onPressed();
  }
}

class OtherScreen {
  Widget build() {
    return OtherButton(onPressed: retireClub);
  }
}
`,
    });
    links = flow(analyses);
  });

  it("follows a local copied and handed to a wrapper", () => {
    expect(links).toContain("wrapper: cb -> lib/actions.dart::saveClub");
    expect(links.filter((l) => l.startsWith("wrapper:"))).toHaveLength(1);
  });

  it("follows a field set in one method and called in another", () => {
    expect(links).toContain("Holder.fire: stored.call -> lib/actions.dart::loadClub");
    expect(links.filter((l) => l.startsWith("Holder.fire:"))).toHaveLength(1);
  });

  it("follows a factory's return", () => {
    expect(links).toContain("viaFactory: h -> lib/actions.dart::retireClub");
  });

  it("follows the elements of a list and a map", () => {
    expect(links).toContain("viaList: h -> lib/actions.dart::saveClub");
    expect(links).toContain("viaList: h -> lib/actions.dart::loadClub");
    expect(links).toContain("Registry.fire: table[] -> lib/actions.dart::saveClub");
  });

  it("carries a constructor argument through an initializer list and a field initializer's closure", () => {
    expect(links.filter((l) => l.startsWith("Gate.open:")).sort()).toEqual([
      "Gate.open: _cb -> lib/actions.dart::saveClub",
      "Gate.open: later -> lib/actions.dart::retireClub",
    ]);
  });

  it("runs a closure that calls one function, and a callback parameter through `!`", () => {
    expect(links).toContain("viaClosure: cb -> lib/actions.dart::retireClub");
    expect(links.filter((l) => l.startsWith("viaClosure: onDone"))).toEqual([]);
  });

  it("joins a widget's constructor argument to the State's widget.onPressed", () => {
    expect(links.filter((l) => l.startsWith("_ClubButtonState.tap: widget.onPressed "))).toEqual([
      "_ClubButtonState.tap: widget.onPressed -> lib/actions.dart::saveClub",
    ]);
    expect(links).toContain("_ClubButtonState.tap: widget.onLongPressCallback -> lib/actions.dart::loadClub");
  });

  it("keeps an unrelated widget's namesake field apart", () => {
    expect(links.filter((l) => l.startsWith("_OtherButtonState.tap:"))).toEqual([
      "_OtherButtonState.tap: widget.onPressed -> lib/actions.dart::retireClub",
    ]);
  });

  it("leaves a class's own call() to the ordinary linker", () => {
    expect(links.filter((l) => l.startsWith("useCaller:"))).toEqual([]);
  });
});

describe("Dart value flow keeps the ordinary links of calls that only look held", () => {
  it("scopes a local to its block, lets a parameter shadow a method, and leaves a callable object alone", async () => {
    const analyses = await analyzeAll({
      "lib/repo.dart": "class Repo {}\n",
      "lib/styles.dart": `import 'repo.dart';
class Customizer {
  String baseStyle(String family) => family;
  String callout(bool mobile) {
    if (mobile) {
      final baseStyle = this.baseStyle('a');
      return baseStyle;
    } else {
      return baseStyle('b');
    }
  }
  void fold(void Function(int) onSuccess) {
    onSuccess(1);
  }
  void onSuccess(int v) {}
}
final getIt = createLocator();
void resolve() {
  getIt<Repo>();
}
`,
    });
    const all = buildSymbolLinks(analyses).map((l) => `${l.sourceSymbol}: ${l.callName} -> ${l.targetSymbol} [${l.strategy}]`);
    // `baseStyle('b')` is the method: the local of the other branch is out of scope there.
    expect(all.some((l) => l.startsWith("Customizer.callout: baseStyle -> Customizer.baseStyle"))).toBe(true);
    // `onSuccess(1)` runs the parameter, never the method of the same name.
    expect(all.filter((l) => l.startsWith("Customizer.fold: onSuccess"))).toEqual([]);
    // `getIt<Repo>()` is a callable object: the ordinary link to the type argument stays.
    expect(all.some((l) => l.startsWith("resolve: getIt<Repo> -> Repo"))).toBe(true);
  });
});
