import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import "./meta.js";

/**
 * A getter of a class, mixin or extension is a method of its own (`FlagService get flags { _flags ??= FlagService(dio); … }`,
 * `Club get club => Club(id)`), and a closure that calls a callback the widget is handed (`onSave(club)`,
 * `widget.onSelect?.call(club)`, `onLongPress!(club)`) is the click's handler, holding a call that value flow joins to
 * what the parent passes — never to a top-level function of the same name in another file (real-repo FP: ~45 locator
 * getters and the tile callbacks of a list screen recorded nothing).
 */
const FILES: Record<string, string> = {
  "pubspec.yaml": "name: garage\ndependencies:\n  dio: ^5.0.0\n  flutter:\n    sdk: flutter\n",
  "lib/gateways.dart": `import 'package:dio/dio.dart';

class FlagService {
  FlagService(this.dio);
  final Dio dio;
}

class Club {
  Club(this.id);
  final int id;
  Future<void> save() async { await Dio().post('/api/clubs'); }
}

class Stadium {
  Stadium(this.id);
  final int id;
}
`,
  "lib/locator.dart": `import 'package:dio/dio.dart';
import 'gateways.dart';

class Locator {
  FlagService? _flags;
  FlagService get flags {
    _flags ??= FlagService(Dio());
    return _flags!;
  }
  Club get club => Club(1);
}

mixin Helper {
  Club get helperClub => Club(2);
}

extension Ex on Locator {
  Club get exClub => Club(3);
}
`,
  "lib/other.dart": `import 'gateways.dart';

class Decoy {
  Stadium get club => Stadium(9);
  Stadium get flags => Stadium(8);
}
`,
  "lib/util.dart": `import 'package:dio/dio.dart';
import 'gateways.dart';

void onSave(Club c) { Dio().delete('/api/decoy'); }
void onSelect(Club c) { Dio().delete('/api/decoy'); }
void onLongPressCallback(Club c) { Dio().delete('/api/decoy'); }
void onRename(Club c) { Dio().delete('/api/decoy'); }
`,
  "lib/screens.dart": `import 'package:flutter/material.dart';
import 'gateways.dart';
import 'util.dart';

class ClubTile extends StatelessWidget {
  const ClubTile({super.key, required this.onSave, this.onSelect, this.onLongPressCallback, required this.onRename});
  final void Function(Club) onSave;
  final void Function(Club)? onSelect;
  final void Function(Club)? onLongPressCallback;
  final void Function(Club) onRename;
  @override
  Widget build(BuildContext context) {
    final club = Club(1);
    return Column(children: [
      ElevatedButton(onPressed: () { onSave(club); }, child: Text('save')),
      InkWell(onTap: () => onSelect?.call(club), child: Text('x')),
      GestureDetector(onLongPress: () => onLongPressCallback!(club), child: Text('y')),
      GestureDetector(onDoubleTap: () => onRename(club), child: Text('z')),
    ]);
  }
}

class ClubPage extends StatelessWidget {
  Future<void> _save(Club c) async { await c.save(); }
  @override
  Widget build(BuildContext context) {
    return ClubTile(onSave: _save, onSelect: _save, onLongPressCallback: _save, onRename: _save);
  }
}
`,
};

describe.each([["tree-sitter", undefined], ["regex", "no-tree-sitter:dart"]])("Dart class getters and callback closures (%s front end)", (name, features) => {
  let dir = "";
  let summary: ProjectAnalysis;
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env.CLARIFYDOC_FEATURES;
    if (features) process.env.CLARIFYDOC_FEATURES = features;
    else delete process.env.CLARIFYDOC_FEATURES;
    dir = await mkdtemp(join(tmpdir(), "cd-dart-getter-callbacks-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    if (saved === undefined) delete process.env.CLARIFYDOC_FEATURES;
    else process.env.CLARIFYDOC_FEATURES = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const reaches = (file: string, from: string) =>
    summary.symbolLinks.filter((l) => l.sourceFile === file && l.sourceSymbol === from && l.relation !== "reference").map((l) => `${l.callName}->${l.targetFile}::${l.targetSymbol}`);

  it("records a class, mixin and extension getter as a method with its constructions", () => {
    expect(reaches("lib/locator.dart", "Locator.flags")).toContain("FlagService->lib/gateways.dart::FlagService.FlagService");
    expect(reaches("lib/locator.dart", "Locator.club")).toContain("Club->lib/gateways.dart::Club.Club");
    expect(reaches("lib/locator.dart", "Helper.helperClub")).toContain("Club->lib/gateways.dart::Club.Club");
    expect(reaches("lib/locator.dart", "Ex.exClub")).toContain("Club->lib/gateways.dart::Club.Club");
  });

  it("keeps a same-named getter of another class on its own construction", () => {
    expect(reaches("lib/other.dart", "Decoy.club")).toEqual(["Stadium->lib/gateways.dart::Stadium.Stadium"]);
    expect(reaches("lib/other.dart", "Decoy.flags")).toEqual(["Stadium->lib/gateways.dart::Stadium.Stadium"]);
    expect(reaches("lib/locator.dart", "Locator.club")).not.toContain("Stadium->lib/gateways.dart::Stadium.Stadium");
  });

  it("gives each callback-calling closure a function, and the click that handler", () => {
    const handlers = (summary.interactiveElements ?? []).filter((e) => e.filePath === "lib/screens.dart").map((e) => e.handler);
    for (const event of ["onPressed", "onTap", "onLongPress", "onDoubleTap"]) {
      expect(handlers.some((h) => h?.startsWith(`<${event}@`)), `${event} handler in ${JSON.stringify(handlers)}`).toBe(true);
    }
  });

  if (name === "tree-sitter") {
    it("links each closure's callback call to what the parent passes, never to a same-named function elsewhere", () => {
      const closures = new Set(summary.symbolLinks.filter((l) => l.sourceFile === "lib/screens.dart" && l.sourceSymbol.startsWith("<on")).map((l) => l.sourceSymbol));
      expect(closures.size).toBe(4);
      for (const closure of summary.symbolLinks.filter((l) => l.sourceFile === "lib/screens.dart" && l.sourceSymbol.startsWith("<on")).map((l) => l.sourceSymbol)) {
        const rows = reaches("lib/screens.dart", closure).filter((r) => !r.startsWith("Club->"));
        expect(rows.length, closure).toBeGreaterThan(0);
        for (const row of rows) expect(row, closure).toMatch(/->lib\/screens\.dart::ClubPage\._save$/);
      }
    });
  }
});
