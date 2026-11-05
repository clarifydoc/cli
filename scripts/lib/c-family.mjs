/**
 * Shared by the C/C++ front-end measurement tools (c-family-*.mjs): finds the built readers in dist/, lists a
 * directory's C and C++ files in a fixed order, and says which reader a file belongs to. Not run on its own.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_ROOT = join(SCRIPTS, "..");
export const DIST = join(CLI_ROOT, "dist");

/** A file past this many characters is never parsed by a front end (core/file-analyzer.ts `FRONT_END_MAX_CHARS`). */
export const MAX_CHARS = 2_000_000;

/** Which reader a file goes to: C's, C++'s for sources, or C++'s then C's for `.h`. */
export const GROUPS = [
  { id: "c", label: "C (.c)", exts: [".c"] },
  { id: "cpp", label: "C++ sources", exts: [".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh", ".cu", ".cuh"] },
  { id: "h", label: "headers (.h)", exts: [".h"] },
];

export function groupOf(file) {
  const dot = file.lastIndexOf(".");
  const ext = dot < 0 ? "" : file.slice(dot).toLowerCase();
  return GROUPS.find((g) => g.exts.includes(ext))?.id ?? null;
}

/** Every C/C++ file under `dir`, relative posix paths in sorted order (the forward order). Links are not followed. */
export function listFiles(dir) {
  const root = resolve(dir);
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (name === ".git" || name === "node_modules") continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && groupOf(name)) out.push({ rel: relative(root, p).split("\\").join("/"), abs: p, group: groupOf(name) });
    }
  };
  walk(root);
  return out;
}

/** The chunk of dist/ whose export list holds `name`; chunk names are hashed, so they are found by content. */
function chunkExporting(prefix, name) {
  const re = new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\}`);
  for (const f of readdirSync(DIST)) {
    if (!f.startsWith(prefix) || !f.endsWith(".js")) continue;
    if (re.test(readFileSync(join(DIST, f), "utf8"))) return join(DIST, f);
  }
  throw new Error(`no chunk of dist/ exports ${name}: build first (npm run build)`);
}

/** The built engine's readers: `readC`, `readCpp`, `isGeneratedSource`, and the engine version. */
export async function loadEngine() {
  if (!existsSync(join(DIST, "index.js"))) throw new Error("dist/index.js is missing: build first (npm run build)");
  const imp = (p) => import(pathToFileURL(p).href);
  const cFile = chunkExporting("antlr-", "readC");
  const cppFile = chunkExporting("antlr-", "readCpp");
  const analyzerFile = chunkExporting("file-analyzer-", "isGeneratedSource");
  const alias = /isGeneratedSource as (\w+)/.exec(readFileSync(analyzerFile, "utf8"))?.[1] ?? "isGeneratedSource";
  const [c, cpp, analyzer, index] = await Promise.all([imp(cFile), imp(cppFile), imp(analyzerFile), imp(join(DIST, "index.js"))]);
  return { readC: c.readC, readCpp: cpp.readCpp, isGeneratedSource: analyzer[alias], version: index.EXTRACTOR_VERSION };
}

/** What the engine does with a file: `skipped` (generated, too large) or its reading. */
export function readOne(engine, group, source) {
  if (source.length > MAX_CHARS) return { skipped: "too-large" };
  if (engine.isGeneratedSource(source)) return { skipped: "generated" };
  return { parsed: group === "c" ? engine.readC(source) : engine.readCpp(source) };
}

/** A reading as comparable text: errors, functions with spans, calls with lines. */
export function canonical(parsed) {
  return JSON.stringify({ e: parsed.syntaxErrors, f: parsed.functions, t: parsed.topLevelCalls });
}

/** A directory's display name: its own, or its parent's when it is a bare `src` workspace. */
export function nameOf(dir) {
  const abs = resolve(dir);
  return basename(abs) === "src" ? basename(dirname(abs)) : basename(abs);
}

/** `--name value` from argv, or the fallback. */
export function option(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
}

/** Positional arguments: those that are no option and no option's value (`valued` lists the options that take one). */
export function positional(argv, valued) {
  return argv.filter((a, i) => !a.startsWith("--") && !valued.some((v) => argv[i - 1] === `--${v}`));
}

export function table(rows, headers) {
  const all = [headers, ...rows].map((r) => r.map(String));
  const w = headers.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => `| ${r.map((c, i) => c.padEnd(w[i])).join(" | ")} |`;
  return [line(all[0]), `|${w.map((n) => "-".repeat(n + 2)).join("|")}|`, ...all.slice(1).map(line)].join("\n");
}
