import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";

/** Flutter's own router: `MaterialApp(routes: {...})` and `Navigator.pushNamed`. */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  "pubspec.yaml": "name: league\ndependencies:\n  flutter:\n    sdk: flutter\n",
  "lib/main.dart": `import 'package:flutter/material.dart';
import 'pages/clubs_page.dart';
import 'pages/details_page.dart';
import 'pages/table_page.dart';

void main() => runApp(MaterialApp(
      initialRoute: '/',
      routes: {
        '/': (context) => const ClubsPage(),
        '/details': (c) => DetailsPage(),
        TablePage.routeName: (context) => TablePage(),
      },
    ));
`,
  "lib/pages/clubs_page.dart": `import 'package:flutter/material.dart';

class ClubsPage extends StatelessWidget {
  const ClubsPage({super.key});
  Widget build(BuildContext context) => Scaffold(
        body: TextButton(
          onPressed: () => Navigator.pushNamed(context, '/details'),
          child: const Text('Details'),
        ),
      );
}
`,
  "lib/pages/details_page.dart": `import 'package:flutter/material.dart';

class DetailsPage extends StatelessWidget {
  Widget build(BuildContext context) => Scaffold(
        body: Column(children: [
          TextButton(
            onPressed: () => Navigator.of(context).pushNamed(TablePage.routeName),
            child: const Text('Table'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pushReplacementNamed('/'),
            child: const Text('Home'),
          ),
        ]),
      );
}
`,
  "lib/pages/table_page.dart": `import 'package:flutter/material.dart';

class TablePage extends StatelessWidget {
  static const routeName = '/table';
  Widget build(BuildContext context) => Scaffold(body: Text('Table'));
}
`,
};

describe("Flutter named routes", () => {
  it("reads a MaterialApp routes table as screens and pushNamed as navigation to them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dart-named-"));
    dirs.push(dir);
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    const routes = summary.screens.map((s) => `${s.routePath} ${s.filePath}`).sort();
    expect(routes).toEqual(expect.arrayContaining([
      "/ lib/pages/clubs_page.dart",
      "/details lib/pages/details_page.dart",
      "/table lib/pages/table_page.dart",
    ]));
    const edges = (summary.screenFlow?.edges ?? []).map((e) => `${e.kind}: ${e.from} -> ${e.to}`);
    expect(edges).toContain("navigate: lib/pages/clubs_page.dart -> lib/pages/details_page.dart");
    expect(edges).toContain("navigate: lib/pages/details_page.dart -> lib/pages/table_page.dart");
    expect(edges).toContain("navigate: lib/pages/details_page.dart -> lib/pages/clubs_page.dart");
  }, 180_000);
});
