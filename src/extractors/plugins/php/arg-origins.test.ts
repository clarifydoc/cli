import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the real per-file pipeline (tree-sitter parse + every extractor). */
async function analyze(src: string, rel = "app/Http/Controllers/ClubController.php"): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "php-origins-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "php" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "php-origins-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

describe("argument origins and filter fields (PHP)", () => {
  it("reads parameters, request values through a local and a cast, and Eloquent conditions", async () => {
    const a = await analyze(`<?php
namespace App\\Http\\Controllers;

use App\\Models\\Fixture;
use Illuminate\\Http\\Request;

class ClubController extends Controller
{
    public function show(Request $request, string $id)
    {
        $season = $request->route('season');
        $club = $this->clubs->forClub((int) $id, $request->query('sort'));
        $fixtures = Fixture::where('club_id', $id)->where('season', '=', $season)->get();
        $rival = Fixture::findOrFail($request->input('rival'));
        return view('clubs.show', compact('club', 'fixtures', 'rival'));
    }
}
`);
    const show = a.classes[0]!.methods.find((m) => m.name === "show")!;
    expect(show.calls.find((c) => c.name === "this.clubs.forClub")?.argOrigins).toEqual([
      { index: 0, origin: { kind: "param", name: "id", index: 1 }, transform: "(int)" },
      { index: 1, origin: { kind: "query-param", name: "sort" } },
    ]);
    expect(a.dataSources.filter((d) => d.whereFields).map((d) => [d.line, d.whereFields])).toEqual([
      [13, [{ field: "club_id", origin: { kind: "param", name: "id", index: 1 } }, { field: "season", origin: { kind: "route-param", name: "season" } }]],
      [14, [{ field: "id", origin: { kind: "request-param", name: "rival" } }]],
    ]);
  });
});
