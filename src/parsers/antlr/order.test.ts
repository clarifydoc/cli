import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The reading of a file must not depend on the files read before it. antlr4ng shares a DFA cache across parses, so
 * a decision whose predicate reads anything but the tokens at and after it (`lt(-1)`, state the parse fills) can
 * take a choice another file cached. This reads a fixture set forward in one fresh process and in reverse in
 * another, each starting with empty caches, and compares every file's functions and calls.
 *
 * Add a grammar by adding an entry to LANGUAGES: its reader's module and export, the extensions of the fixtures it
 * reads, and the inputs written for it in `order-inputs/` (first in the set, so the reverse run reads them last).
 */
interface Language {
  module: string;
  export: string;
  extensions: string[];
  /** Files in `order-inputs/` whose names begin with one of these belong to this language. */
  inputs: string[];
}

const LANGUAGES: Record<string, Language> = {
  c: { module: "/src/extractors/plugins/c/antlr.ts", export: "readC", extensions: [".c", ".h"], inputs: ["decls.c", "casts.c"] },
  cpp: { module: "/src/extractors/plugins/cpp/antlr.ts", export: "readCpp", extensions: [".cpp", ".cc", ".cxx", ".hpp", ".cu"], inputs: ["init-forms.cpp", "plain-conditions.cpp", "one-line-bodies.cpp"] },
  go: { module: "/src/extractors/plugins/go/antlr.ts", export: "readGo", extensions: [".go"], inputs: ["league.go"] },
  lua: { module: "/src/extractors/plugins/lua/antlr.ts", export: "readLua", extensions: [".lua"], inputs: ["keymap.lua", "gateway.lua"] },
  rust: { module: "/src/extractors/plugins/rust/antlr.ts", export: "readRust", extensions: [".rs"], inputs: ["league.rs"] },
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI_ROOT = join(HERE, "../../..");
const FIXTURES = join(CLI_ROOT, "test-fixtures");
const INPUTS = join(HERE, "order-inputs");
const CHILD = join(HERE, "order-child.mjs");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Hand-written inputs first, then every fixture file of the language, sorted. */
function filesOf(lang: Language): string[] {
  const own = lang.inputs.map((name) => join(INPUTS, name));
  const fixtures = walk(FIXTURES).filter((f) => lang.extensions.includes(extname(f)));
  return [...own, ...fixtures];
}

interface Reading {
  functions: { name: string; line: number; calls: { name: string; line: number; column: number }[] }[];
  syntaxErrors: number;
}

/** A reading as one line per function and per call, for a diff a person can read. */
function flatten(read: Reading | undefined): string[] {
  if (!read) return ["(no reading)"];
  const lines = [`syntaxErrors ${read.syntaxErrors}`];
  for (const fn of read.functions) {
    lines.push(`${fn.name}@${fn.line}`);
    for (const call of fn.calls) lines.push(`${fn.name}@${fn.line} -> ${call.name}@${call.line}:${call.column}`);
  }
  return lines;
}

function readAll(files: { path: string; lang: string }[], scratch: string, tag: string): Record<string, unknown> {
  const jobFile = join(scratch, `${tag}.json`);
  const readers = Object.fromEntries(Object.entries(LANGUAGES).map(([name, l]) => [name, { module: l.module, export: l.export }]));
  writeFileSync(jobFile, JSON.stringify({ readers, files }));
  const run = spawnSync(process.execPath, [CHILD, jobFile], { cwd: CLI_ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`order child (${tag}) failed: ${run.stderr || run.error}`);
  return JSON.parse(run.stdout);
}

describe("reading order", () => {
  const scratch = mkdtempSync(join(tmpdir(), "clarifydoc-order-"));

  for (const [name, lang] of Object.entries(LANGUAGES)) {
    it(`${name}: every file reads the same forward and in reverse`, () => {
      const files = filesOf(lang).map((path) => ({ path, lang: name }));
      expect(files.length).toBeGreaterThan(1);
      const forward = readAll(files, scratch, `${name}-forward`);
      const reverse = readAll([...files].reverse(), scratch, `${name}-reverse`);
      const differing = files.map((f) => f.path).filter((p) => JSON.stringify(forward[p]) !== JSON.stringify(reverse[p]));
      // What only the forward or only the reverse run read, per file.
      const report = differing.map((p) => {
        const f = flatten(forward[p] as Reading);
        const r = flatten(reverse[p] as Reading);
        return { file: relative(CLI_ROOT, p), onlyForward: f.filter((l) => !r.includes(l)), onlyReverse: r.filter((l) => !f.includes(l)) };
      });
      expect(report).toEqual([]);
      // The reading itself, not only its absence: an input that failed to parse would pass trivially.
      for (const input of lang.inputs) {
        const read = forward[join(INPUTS, input)] as Reading;
        expect({ input, errors: read.syntaxErrors, functions: read.functions.length > 0 }).toEqual({ input, errors: 0, functions: true });
      }
    }, 60_000);
  }

  it("cleans up", () => rmSync(scratch, { recursive: true, force: true }));
});
