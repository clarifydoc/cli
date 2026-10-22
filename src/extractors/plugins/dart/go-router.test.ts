import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { goRoutes } from "./go-router.js";

/** GoRoutes whose path is a screen's `routeName` constant, declared in the screen's file (real-repo FP: 0 of 35 routes read). */
const FILES: Record<string, string> = {
  "pubspec.yaml": "name: league\ndependencies:\n  flutter:\n    sdk: flutter\n  go_router: ^14.0.0\n",
  "lib/screens/club_screen.dart": `import 'package:flutter/material.dart';

class ClubScreen extends StatelessWidget {
  static const routeName = '/clubs';
  const ClubScreen({super.key});
  Widget build(BuildContext context) => TextButton(
        onPressed: () => context.push(MatchScreen.routeName),
        child: const Text('Matches'),
      );
}
`,
  "lib/screens/match_screen.dart": `import 'package:flutter/material.dart';

class MatchScreen extends StatelessWidget {
  static const routeName = '/matches';
  const MatchScreen({super.key});
  Widget build(BuildContext context) => const Text('Matches');
}
`,
  "lib/router.dart": `import 'package:go_router/go_router.dart';
import 'screens/club_screen.dart';
import 'screens/match_screen.dart';

final router = GoRouter(routes: [
  GoRoute(
    path: ClubScreen.routeName,
    pageBuilder: (context, state) => FadePage(
      child: const ClubScreen(),
      name: ClubScreen.routeName,
    ),
  ),
  GoRoute(
    name: MatchScreen.routeName,
    path: MatchScreen.routeName,
    builder: (context, state) => const MatchScreen(),
  ),
]);
`,
};

describe("GoRouter routes", () => {
  it("read a literal path written on the line after GoRoute(, and leave a child route's path to the child", () => {
    const routes = goRoutes(`GoRoute(
  path: '/league',
  builder: (c, s) => const LeaguePage(),
  routes: [
    GoRoute(path: 'table', builder: (c, s) => const TablePage()),
  ],
)`.split("\n"), []);
    expect(routes.map((r) => `${r.path} ${r.handler} @${r.line}`)).toEqual(["/league LeaguePage @1", "table TablePage @5"]);
    const shell = goRoutes(["GoRoute(path: '/', pageBuilder: (c, s) => FadePage(child: child))"], []);
    expect(shell.map((r) => `${r.path} ${r.handler}`)).toEqual(["/ null"]);
  });
});

describe("GoRouter routes through a screen's constant", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-gorouter-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("are served at the constant's value and render the widget the page builds", () => {
    const routes = summary.routeMap.filter((r) => r.filePath === "lib/router.dart").map((r) => `${r.path} ${r.handler}`).sort();
    expect(routes).toEqual(["/clubs ClubScreen", "/matches MatchScreen"]);
    expect(summary.screens.filter((s) => s.routePath).map((s) => `${s.filePath} ${s.routePath}`).sort()).toEqual([
      "lib/screens/club_screen.dart /clubs",
      "lib/screens/match_screen.dart /matches",
    ]);
  });

  it("let a screen navigate to another through the other's constant", () => {
    expect(summary.screens.find((s) => s.name === "ClubScreen")?.navigatesTo).toEqual(["MatchScreen"]);
  });
});
