import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildSymbolLinks } from "./symbol-linker.js";
import { isTestFile } from "./test-file-detector.js";
import { buildReportPayload, SYMBOL_LINK_RELATIONS, SYMBOL_LINK_STRATEGIES } from "./report-payload.js";
import { extensionFamily } from "../extractors/plugins/shared/path-utils.js";
import { relationForStrategy } from "../types/analysis.js";
import type { CallInfo, Confidence, FileAnalysis, Language, ProjectAnalysis, SubProject, SymbolLink, SymbolLinkStrategy } from "../types/analysis.js";

/**
 * Invariants of the symbol linker, checked over generated projects.
 *
 * The fixtures prove that a given input still gives the same output; they
 * cannot show that no input gives an impossible one. Here fast-check builds
 * small projects — files in several sub-projects and languages, classes with
 * typed fields, imports, calls in every shape the linker reads — and every
 * link the linker returns must be one it could possibly mean.
 */

const PROJECTS = ["web", "api", "shared"] as const;
const LANGUAGES: Record<string, Language> = { ts: "typescript", py: "python", cs: "csharp", java: "java" };
const TYPES = ["Club", "Match", "Player", "Garage", "Car", "League"];
const MEMBERS = ["save", "load", "find", "create", "handle", "render", "list"];
const DIRS = ["src", "src/services", "src/models", "tests"];

interface Spec {
  project: (typeof PROJECTS)[number];
  dir: string;
  name: string;
  classes: { name: string; iface: boolean; extendsIdx: number | null; fields: { name: string; type: string }[]; methods: { name: string; calls: string[] }[] }[];
  functions: { name: string; calls: string[] }[];
  imports: { from: number; names: string[] }[];
}

const callText = fc.oneof(
  fc.constantFrom(...MEMBERS),
  fc.constantFrom(...MEMBERS).map((m) => `this.${m}`),
  fc.tuple(fc.constantFrom(...TYPES), fc.constantFrom(...MEMBERS)).map(([t, m]) => `${t}.${m}`),
  fc.constantFrom(...TYPES).map((t) => `new ${t}`),
  fc.tuple(fc.constantFrom("repo", "club", "service", "db"), fc.constantFrom(...MEMBERS)).map(([r, m]) => `${r}.${m}`),
  fc.tuple(fc.constantFrom("this.repo", "this.club", "x.y"), fc.constantFrom(...MEMBERS)).map(([r, m]) => `${r}.${m}`),
);
const calls = fc.array(callText, { maxLength: 4 });

const fileSpec: fc.Arbitrary<Spec> = fc.record({
  project: fc.constantFrom(...PROJECTS),
  dir: fc.constantFrom(...DIRS),
  name: fc.constantFrom(...TYPES, "index", "util"),
  classes: fc.uniqueArray(
    fc.record({
      name: fc.constantFrom(...TYPES),
      iface: fc.boolean(),
      extendsIdx: fc.option(fc.nat({ max: 5 }), { nil: null }),
      fields: fc.array(fc.record({ name: fc.constantFrom("repo", "club", "service"), type: fc.constantFrom(...TYPES) }), { maxLength: 2 }),
      methods: fc.uniqueArray(fc.record({ name: fc.constantFrom(...MEMBERS), calls }), { maxLength: 3, selector: (m) => m.name }),
    }),
    { maxLength: 2, selector: (c) => c.name },
  ),
  functions: fc.uniqueArray(fc.record({ name: fc.constantFrom(...MEMBERS), calls }), { maxLength: 3, selector: (f) => f.name }),
  imports: fc.array(fc.record({ from: fc.nat({ max: 7 }), names: fc.subarray([...TYPES, ...MEMBERS], { maxLength: 3 }) }), { maxLength: 3 }),
});

interface Built {
  analyses: FileAnalysis[];
  subProjects: SubProject[];
}

function relativeImport(from: string, to: string): string {
  const a = from.split("/").slice(0, -1);
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  const rest = b.slice(i).join("/").replace(/\.[^.]+$/, "");
  return (up === 0 ? "./" : "../".repeat(up)) + rest;
}

type Ext = keyof typeof LANGUAGES;
function build([specs, extOf]: [Spec[], Record<string, Ext>]): Built {
  // Paths are unique by construction: a duplicate gets a numeric suffix.
  const seen = new Set<string>();
  const paths = specs.map((s) => {
    const ext = extOf[s.project]!;
    let p = `${s.project}/${s.dir}/${s.name}.${ext}`;
    for (let n = 2; seen.has(p); n++) p = `${s.project}/${s.dir}/${s.name}${n}.${ext}`;
    seen.add(p);
    return p;
  });
  let line = 1;
  const at = () => (line += 3);
  const mkCalls = (list: string[], cross: boolean, targets: string[]): CallInfo[] =>
    list.map((name, i) => ({
      name,
      kind: cross && targets.length ? "cross-file" : "internal",
      target: cross && targets.length ? targets[i % targets.length]! : null,
      ...(cross && targets.length ? { confidence: "EXTRACTED" as const } : {}),
      line: at(),
    }));
  const analyses = specs.map((s, i): FileAnalysis => {
    const filePath = paths[i]!;
    // Code imports code of its own language family only.
    const imports = s.imports
      .filter((imp) => imp.from % specs.length !== i && extOf[specs[imp.from % specs.length]!.project] === extOf[s.project])
      .map((imp) => ({ source: relativeImport(filePath, paths[imp.from % specs.length]!), specifiers: imp.names, line: at() }));
    const targets = imports.map((imp) => imp.source);
    const classes = s.classes.map((c, ci) => {
      const start = at();
      return {
        name: c.name,
        kind: c.iface ? "interface" : "class",
        // Never itself: a class cannot extend its own name.
        extends: c.extendsIdx !== null && TYPES[c.extendsIdx % TYPES.length] !== c.name ? TYPES[c.extendsIdx % TYPES.length]! : null,
        implements: [],
        properties: c.fields.map((f) => ({ name: f.name, type: f.type })),
        methods: c.methods.map((m) => {
          const l = at();
          return { name: m.name, line: l, endLine: l + 2, params: [], calls: mkCalls(m.calls, ci % 2 === 0, targets) };
        }),
        line: start,
        endLine: at(),
      };
    });
    const functions = s.functions.map((f, fi) => {
      const l = at();
      return { name: f.name, line: l, endLine: l + 2, params: [], calls: mkCalls(f.calls, fi % 2 === 1, targets) };
    });
    return {
      filePath,
      projectId: s.project,
      language: LANGUAGES[extOf[s.project]!]!,
      imports,
      exports: [...classes.map((c) => ({ name: c.name, kind: "class", line: c.line })), ...functions.map((f) => ({ name: f.name, kind: "function", line: f.line }))],
      functions,
      classes,
      routes: [],
      dataSources: [],
    } as unknown as FileAnalysis;
  });
  const used = [...new Set(specs.map((s) => s.project))];
  const subProjects = used.map((id) => ({ id, name: id, root: id, kind: "node", markers: [] }) as unknown as SubProject);
  return { analyses, subProjects };
}

const ext = fc.constantFrom(...(Object.keys(LANGUAGES) as Ext[]));
const projects = fc.tuple(fc.array(fileSpec, { minLength: 2, maxLength: 7 }), fc.record({ web: ext, api: ext, shared: ext })).map(build);

/** Every symbol a file declares, in the spellings a link may name. */
function declared(a: FileAnalysis): Set<string> {
  const names = new Set<string>(["<setup>", "(reference)"]);
  for (const f of a.functions) names.add(f.name);
  for (const c of a.classes) {
    names.add(c.name);
    for (const m of c.methods) {
      names.add(`${c.name}.${m.name}`);
      names.add(m.name);
    }
  }
  return names;
}

/** The last segment of a call or symbol name: `this.repo.save` → `save`, `new Club` → `Club`. */
const leaf = (name: string): string => name.replace(/^new /, "").split(".").pop()!;

/** A fixed seed: the same projects on every run, so CI never flakes on a newly drawn input. */
const RUNS = { numRuns: 400, seed: 20261025 };

/** Run the linker over each generated project and hand every link, with its files, to `check`. */
function forEveryLink(check: (link: SymbolLink, source: FileAnalysis, target: FileAnalysis) => void): void {
  fc.assert(
    fc.property(projects, ({ analyses, subProjects }) => {
      const byFile = new Map(analyses.map((a) => [a.filePath, a]));
      for (const link of buildSymbolLinks(analyses, subProjects)) {
        const source = byFile.get(link.sourceFile);
        const target = byFile.get(link.targetFile);
        expect(source, `source file of ${JSON.stringify(link)}`).toBeDefined();
        expect(target, `target file of ${JSON.stringify(link)}`).toBeDefined();
        check(link, source!, target!);
      }
    }),
    RUNS,
  );
}

const CONFIDENCES: readonly Confidence[] = ["EXTRACTED", "INFERRED", "AMBIGUOUS"];

/** Strategies that find a target by a declared type or an `extends` name rather than by an import. */
const BY_DECLARED_TYPE = new Set<SymbolLinkStrategy>(["inheritance", "injection", "interface-redirect", "interface-fanout"]);

describe("symbol linker properties", () => {
  it("both endpoints are input files, and each symbol is one its file declares", () => {
    forEveryLink((link, source, target) => {
      expect(declared(source).has(link.sourceSymbol), `source symbol of ${JSON.stringify(link)}`).toBe(true);
      expect(declared(target).has(link.targetSymbol), `target symbol of ${JSON.stringify(link)}`).toBe(true);
      expect(Number.isInteger(link.sourceLine) && link.sourceLine >= 1, `source line of ${JSON.stringify(link)}`).toBe(true);
      expect(Number.isInteger(link.targetLine) && link.targetLine >= 1, `target line of ${JSON.stringify(link)}`).toBe(true);
    });
  });

  it("confidence, strategy and relation come from their closed sets, and the relation is the strategy's", () => {
    forEveryLink((link) => {
      expect(CONFIDENCES, JSON.stringify(link)).toContain(link.confidence);
      expect(link.strategy!.startsWith("dispatch:") || SYMBOL_LINK_STRATEGIES.includes(link.strategy!), JSON.stringify(link)).toBe(true);
      expect(SYMBOL_LINK_RELATIONS, JSON.stringify(link)).toContain(link.relation);
      expect(link.relation, JSON.stringify(link)).toBe(relationForStrategy(link.strategy!));
    });
  });

  it("a call lands on a member of the name it calls; a construction on the class it names", () => {
    forEveryLink((link) => {
      if (link.relation === "reference") expect(leaf(link.targetSymbol), JSON.stringify(link)).toBe(link.callName);
      else if (link.relation === "implements") expect(leaf(link.targetSymbol), JSON.stringify(link)).toBe(leaf(link.sourceSymbol));
      else if (link.strategy === "constructor") expect(link.targetSymbol.split(".")[0], JSON.stringify(link)).toBe(leaf(link.callName));
      else expect(leaf(link.targetSymbol), JSON.stringify(link)).toBe(leaf(link.callName));
    });
  });

  it("a symbol links to itself only by calling its own name (recursion)", () => {
    forEveryLink((link) => {
      if (link.sourceFile !== link.targetFile || link.sourceSymbol !== link.targetSymbol || link.relation === "implements") return;
      expect(link.relation, JSON.stringify(link)).toBe("calls");
      expect(leaf(link.callName), JSON.stringify(link)).toBe(leaf(link.sourceSymbol));
    });
  });

  it("a link found through an import or a name stays within its language family", () => {
    forEveryLink((link) => {
      if (BY_DECLARED_TYPE.has(link.strategy!)) return;
      expect(extensionFamily(link.targetFile), JSON.stringify(link)).toBe(extensionFamily(link.sourceFile));
    });
  });

  it("production code reaches a test file only through an import it states", () => {
    forEveryLink((link, source, target) => {
      if (BY_DECLARED_TYPE.has(link.strategy!) || link.strategy === "class-name") return;
      if (!isTestFile(target.filePath, target.language) || isTestFile(source.filePath, source.language)) return;
      expect(source.imports.length, JSON.stringify(link)).toBeGreaterThan(0);
      expect(["direct", "deep-qualified", "import-file", "reference", "constructor"], JSON.stringify(link)).toContain(link.strategy);
    });
  });

  // Known gaps, kept as failing properties so the fix shows up here: when one
  // is fixed its `it.fails` starts failing, and becomes a plain `it`.
  it("open: a declared type or `extends` name resolves only within the caller's language family", () => {
    // A Python class extending `League` links `self.handle()` to a TypeScript
    // `League` in another sub-project when Python declares none.
    forEveryLink((link) => {
      expect(extensionFamily(link.targetFile), JSON.stringify(link)).toBe(extensionFamily(link.sourceFile));
    });
  });

  it("open: a class-qualified call never lands on a free function beside the class", () => {
    // `Match.find()` where `Match` inherits `find` from a base class, and the
    // file also defines a module-level `find`, links to the free function.
    forEveryLink((link, _source, target) => {
      if (link.strategy !== "class-name" || link.targetSymbol.includes(".")) return;
      expect(target.classes.map((c) => c.name), JSON.stringify(link)).toContain(link.targetSymbol);
    });
  });

  it("open: an interface member never fans out to itself", () => {
    // `interface Club { save }` and `class Match : Club` declaring no `save`:
    // the fan-out links `Club.save` to `Club.save`.
    forEveryLink((link) => {
      if (link.relation !== "implements") return;
      expect(`${link.targetFile}::${link.targetSymbol}`, JSON.stringify(link)).not.toBe(`${link.sourceFile}::${link.sourceSymbol}`);
    });
  });

  it("the links do not depend on the order the files come in", () => {
    const sig = (links: SymbolLink[]) => links.map((l) => JSON.stringify(l)).sort();
    fc.assert(
      fc.property(projects, fc.nat(), ({ analyses, subProjects }, seed) => {
        const shuffled = [...analyses];
        for (let i = shuffled.length - 1, r = seed; i > 0; i--) {
          r = (r * 1103515245 + 12345) % 2147483648;
          const j = r % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        expect(sig(buildSymbolLinks(structuredClone(shuffled), subProjects))).toEqual(sig(buildSymbolLinks(structuredClone(analyses), subProjects)));
      }),
      RUNS,
    );
  });

  it("the report's wire encoding of the links decodes back to them", () => {
    fc.assert(
      fc.property(projects, ({ analyses, subProjects }) => {
        const links = buildSymbolLinks(analyses, subProjects);
        const files = analyses.map((a) => a.filePath);
        const payload = buildReportPayload({ projectRoot: "/garage", files, symbolLinks: links, routeMap: [], detectedFrameworks: [] } as unknown as ProjectAnalysis) as unknown as {
          symbolLinks: unknown[][];
          wireStrings: string[];
        };
        expect(payload.symbolLinks).toHaveLength(links.length);
        const file = (v: unknown) => {
          expect(Number.isInteger(v) && (v as number) >= 0 && (v as number) < files.length, `file index ${String(v)}`).toBe(true);
          return files[v as number];
        };
        const str = (v: unknown) => {
          expect(Number.isInteger(v) && (v as number) >= 0 && (v as number) < payload.wireStrings.length, `string index ${String(v)}`).toBe(true);
          return payload.wireStrings[v as number];
        };
        payload.symbolLinks.forEach((row, i) => {
          const l = links[i]!;
          const meta = (row[7] as number | undefined) ?? 0;
          const code = Math.floor(meta / 1000) % 100;
          expect({
            sourceFile: file(row[0]), sourceSymbol: str(row[1]), sourceLine: row[2], callName: str(row[3]),
            targetFile: file(row[4]), targetSymbol: str(row[5]), targetLine: row[6],
            relation: SYMBOL_LINK_RELATIONS[Math.floor(meta / 100000) - 1],
            strategy: SYMBOL_LINK_STRATEGIES[code - 1],
            confidence: CONFIDENCES[(Math.floor(meta / 10) % 10) - 1],
            navigational: meta % 10 === 1 || undefined,
          }).toEqual({
            sourceFile: l.sourceFile, sourceSymbol: l.sourceSymbol, sourceLine: l.sourceLine, callName: l.callName,
            targetFile: l.targetFile, targetSymbol: l.targetSymbol, targetLine: l.targetLine,
            relation: l.relation,
            strategy: l.strategy!.startsWith("dispatch:") ? "dispatch" : l.strategy,
            confidence: l.confidence,
            navigational: l.navigational || undefined,
          });
        });
      }),
      RUNS,
    );
  });
});
