import { describe, it, expect, afterAll } from "vitest";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { extname, join, resolve } from "path";
import { analyze } from "./analyzer.js";

/**
 * Incremental ≡ cold. A per-file cache whose output secretly depends on
 * other files passes every fixture test and still lies after an edit: the
 * reused JSON describes a neighbour that changed. For each fixture: analyze,
 * edit one file (a function added, an import dropped), re-run incrementally,
 * then analyze the edited copy cold — the two summaries must be equal, the
 * run-mode fields of provenance aside.
 */

interface Edit {
  ext: string;
  /** The added function, and where it goes: the end, or before a class's last `}`. */
  fn: string;
  inClass?: boolean;
  importLine: RegExp;
}

const EDITS: Record<string, Edit> = {
  ts: { ext: ".ts", fn: "\nexport function addedByGate(): number {\n  return 1;\n}\n", importLine: /^import .*$/m },
  tsx: { ext: ".tsx", fn: "\nexport function addedByGate(): number {\n  return 1;\n}\n", importLine: /^import .*$/m },
  py: { ext: ".py", fn: "\n\ndef added_by_gate():\n    return 1\n", importLine: /^(?:from \S+ )?import .*$/m },
  java: { ext: ".java", fn: "\n    public int addedByGate() {\n        return 1;\n    }\n", inClass: true, importLine: /^import .*;$/m },
  cs: { ext: ".cs", fn: "\n    public int AddedByGate() { return 1; }\n", inClass: true, importLine: /^using [\w.]+;$/m },
  go: { ext: ".go", fn: "\nfunc addedByGate() int {\n\treturn 1\n}\n", importLine: /^\t"[^"]+"$/m },
  rb: { ext: ".rb", fn: "\ndef added_by_gate\n  1\nend\n", importLine: /^require .*$/m },
  php: { ext: ".php", fn: "\n    public function addedByGate() { return 1; }\n", inClass: true, importLine: /^use [\w\\]+;$/m },
};

const CASES: Array<[fixture: string, edit: keyof typeof EDITS]> = [
  ["sample-react", "tsx"],
  ["sample-backend", "ts"],
  ["sample-python-api", "py"],
  ["sample-java-api", "java"],
  ["sample-csharp-api", "cs"],
  ["sample-go-api", "go"],
  ["sample-ruby-web", "rb"],
  ["sample-laravel-api", "php"],
];

async function filesUnder(dir: string, ext: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "vendor") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p, ext, base)));
    else if (extname(e.name) === ext) out.push(p.slice(base.length + 1));
  }
  return out.sort();
}

/**
 * The first file of the language that has an import to drop (and, for a
 * class edit, a class) — else, where a language names no imports (a Rails
 * app autoloads), the first file to append to.
 */
async function pickTarget(root: string, edit: Edit): Promise<string | null> {
  const candidates = (await filesUnder(root, edit.ext)).filter((rel) => !/test|spec/i.test(rel));
  let fallback: string | null = null;
  for (const rel of candidates) {
    const text = await readFile(join(root, rel), "utf8");
    if (edit.inClass && !/\bclass\b/.test(text)) continue;
    if (edit.importLine.test(text)) return rel;
    fallback ??= rel;
  }
  return fallback;
}

function applyEdit(text: string, edit: Edit): string {
  const dropped = text.replace(edit.importLine, "");
  if (!edit.inClass) return dropped.trimEnd() + "\n" + edit.fn;
  const last = dropped.lastIndexOf("}");
  return dropped.slice(0, last) + edit.fn.trimStart() + dropped.slice(last);
}

/** Without what differs by construction: how it ran, how long each stage took. */
function comparable(summaryText: string): unknown {
  const s = JSON.parse(summaryText);
  if (s.provenance) {
    delete s.provenance.incremental;
    delete s.provenance.reusedFiles;
    delete s.provenance.stageTimings;
  }
  return s;
}

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("incremental ≡ cold", () => {
  for (const [fixture, editName] of CASES) {
    const src = resolve("test-fixtures", fixture);
    it.skipIf(!existsSync(src))(`${fixture}: an edited file re-analyzed incrementally matches a cold run`, async () => {
      const edit = EDITS[editName]!;
      const dir = await mkdtemp(join(tmpdir(), `clarifydoc-eq-${fixture}-`));
      dirs.push(dir);
      const root = join(dir, fixture);
      await cp(src, root, { recursive: true });
      const target = await pickTarget(root, edit);
      expect(target, `a ${edit.ext} file with an import in ${fixture}`).not.toBeNull();

      const settings = { projectRoot: root, lsp: false, gitHistory: false, stableOutput: true, pretty: true } as const;
      await analyze({ ...settings, outputDir: join(dir, "inc", fixture), incremental: true });
      const before = await readFile(join(root, target!), "utf8");
      const after = applyEdit(before, edit);
      expect(after).not.toBe(before);
      await writeFile(join(root, target!), after);

      const inc = await analyze({ ...settings, outputDir: join(dir, "inc", fixture), incremental: true });
      expect(inc.changedFiles).toContain(target!.split("\\").join("/"));
      await analyze({ ...settings, outputDir: join(dir, "cold", fixture), incremental: false });

      const a = comparable(await readFile(join(dir, "inc", fixture, "project-summary.json"), "utf8"));
      const b = comparable(await readFile(join(dir, "cold", fixture, "project-summary.json"), "utf8"));
      expect(a).toEqual(b);
    }, 120_000);
  }
});
