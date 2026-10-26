import { describe, it, expect, afterAll } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { glob } from "./glob.js";
import { denormalizeProject } from "./element-registry.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Two runs over one tree write the same bytes. The async directory walk lists
 * folders as their reads complete, so a package several manifests declare
 * took its first `declaredIn` from whichever manifest the walk met first, and
 * blast-radius rows with equal scores kept the order their files arrived in —
 * which differs between a cold run and an incremental one.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const CLUBS = ["Rovers", "United", "Athletic", "Wanderers", "Albion", "City", "Town", "Rangers", "Celtic", "Villa", "Forest", "County"];

/** Twelve .NET projects declaring one package at two versions, and leaf services of equal weight. */
async function writeLeague(root: string): Promise<void> {
  for (const [i, club] of CLUBS.entries()) {
    const dir = join(root, "src", club);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${club}.csproj`),
      `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Newtonsoft.Json" Version="${i % 2 ? "13.0.3" : "13.0.1"}" />\n  </ItemGroup>\n</Project>\n`,
    );
    await writeFile(
      join(dir, `${club}Service.cs`),
      `namespace League.${club};\n\npublic class ${club}Service\n{\n    public int Points() { return ${i}; }\n}\n`,
    );
  }
  const web = join(root, "web");
  await mkdir(web, { recursive: true });
  for (const club of CLUBS) {
    await writeFile(join(web, `${club.toLowerCase()}.ts`), `export function ${club.toLowerCase()}Points(): number {\n  return 1;\n}\n`);
  }
  await writeFile(
    join(web, "table.ts"),
    CLUBS.map((c) => `import { ${c.toLowerCase()}Points } from "./${c.toLowerCase()}";`).join("\n") +
      `\n\nexport function table(): number[] {\n  return [${CLUBS.map((c) => `${c.toLowerCase()}Points()`).join(", ")}];\n}\n`,
  );
}

function comparable(text: string): unknown {
  const s = JSON.parse(text) as { provenance?: Record<string, unknown> };
  if (s.provenance) {
    delete s.provenance.incremental;
    delete s.provenance.reusedFiles;
    delete s.provenance.stageTimings;
  }
  return s;
}

describe("output is deterministic", () => {
  it("glob results come back in code-point order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarifydoc-det-glob-"));
    dirs.push(dir);
    await writeLeague(dir);
    const found = await glob(["**/*.csproj"], { cwd: dir });
    expect(found).toEqual([...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(found).toHaveLength(CLUBS.length);
  });

  it("two cold runs and an incremental one write the same summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarifydoc-det-"));
    dirs.push(dir);
    const root = join(dir, "league");
    await writeLeague(root);
    const settings = { projectRoot: root, lsp: false, gitHistory: false, stableOutput: true, pretty: true } as const;
    await analyze({ ...settings, outputDir: join(dir, "a"), incremental: true });
    await analyze({ ...settings, outputDir: join(dir, "b"), incremental: false });
    await analyze({ ...settings, outputDir: join(dir, "a"), incremental: true });

    const first = await readFile(join(dir, "b", "project-summary.json"), "utf8");
    const again = await readFile(join(dir, "a", "project-summary.json"), "utf8");
    expect(comparable(again)).toEqual(comparable(first));

    const summary: ProjectAnalysis = denormalizeProject(JSON.parse(first));
    const json = summary.externalPackages?.find((p) => p.name === "Newtonsoft.Json");
    expect(json?.declaredIn).toBe("src/Albion/Albion.csproj");
    const declaredIn = (json?.declarations ?? []).map((d) => d.declaredIn);
    expect(declaredIn).toEqual([...declaredIn].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    // Equal-score rows are ordered by path.
    const rows = summary.blastRadius ?? [];
    expect(rows.length).toBeGreaterThan(CLUBS.length);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1]!.impactScore === rows[i]!.impactScore) {
        expect(rows[i - 1]!.filePath < rows[i]!.filePath).toBe(true);
      }
    }
  }, 120_000);
});
