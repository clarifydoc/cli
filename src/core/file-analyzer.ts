import { readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { parseErrorsOf } from "./coverage.js";
import { readFile } from "fs/promises";
import { isMainThread } from "worker_threads";
import { computeRegexComplexity } from "./complexity-regex.js";
import { splitLines } from "../extractors/shared/source-lines.js";
import type { DiscoveredFile } from "./file-discovery.js";
import { serializeFileAnalysis, writeFileAnalysis, type OutputOptions } from "./output-writer.js";
import { parseSource } from "../parsers/parser-manager.js";
import { extractImports, extractExports } from "../extractors/imports-exports/index.js";
import { extractFunctions, extractClasses } from "../extractors/functions-classes/index.js";
import { extractRoutes } from "../extractors/routes/index.js";
import { extractDataAccess } from "../extractors/data-access.js";
import { extractEntities, mergeEntities } from "../extractors/entities/index.js";
import { classifyCalls, extractTopLevelCalls } from "../extractors/shared/call-graph.js";
import { hasDbRootTypes } from "../extractors/shared/call-patterns.js";
import { patternBindings } from "../extractors/shared/destructuring.js";
import { dirname, relative } from "path";
import { applyAliases, type AliasMap, applyPackageImports, applySourceRoot, loadTsconfigAliasesForDir, packageImportsStamp, sourceRootStamp } from "../extractors/shared/tsconfig-aliases.js";
import { applyWorkspacePackages, loadWorkspacePackages, type WorkspacePackage } from "../extractors/shared/workspace-packages.js";
import { extensionFamily } from "../extractors/plugins/shared/path-utils.js";
import { pluginFor, astHooksFor, inferFileFrameworks, ensureLanguagesLoaded, manifestFor, regexSpecFor } from "../extractors/registry.js";
import { computeComplexity } from "./complexity-analyzer.js";
import { attachDocComments } from "./doc-comments.js";
import { scanSecurity, isMinifiedSource, isVendoredSource } from "./security-scanner.js";
import { isSuppressed } from "./security-rules.js";
import { isGeneratedSource, vendoredLibraryOf } from "./generated-file-detector.js";
import { extractTypeReferences } from "./type-reference-extractor.js";
import { enrichFileDataSources } from "./import-index.js";
import type { BuildMacros, ParsedStructure, VariableAliasBinding } from "../types/language-plugin.js";
import { featureEnabled } from "./feature-flags.js";
import type { CallInfo, ClassInfo, FunctionInfo, RouteFact } from "../types/analysis.js";
import { isTestFile } from "./test-file-detector.js";
import {
  inferExpoRouterRoutes,
  inferFlatRoutes,
  inferNextRoutes,
  inferNuxtServerRoutes,
  inferReactRouterConfig,
  inferSvelteKitRoutes,
  inferAstroRoutes,
  inferTrpcEndpointFacts,
} from "../extractors/plugins/javascript/routes/file-routes.js";
import { inferNextMiddlewareFacts } from "../extractors/plugins/javascript/routes/next-middleware.js";
import { restoreTypedReceiverCalls } from "./typed-receivers.js";
import {
  createEmptyAnalysis,
  type FileAnalysis,
  type Language,
  type ComplexityInfo,
  type SecurityIssue,
  type RouteInfo,
  type TaintFacts,
} from "../types/analysis.js";

/** Whether a React Router 7 project's `app/routes.ts` delegates to `flatRoutes()`, per sub-project root. */
const flatRoutesByRoot = new Map<string, boolean>();
function usesFlatRoutes(absolutePath: string, routePath: string): boolean {
  const abs = absolutePath.replace(/\\/g, "/");
  const rel = routePath.replace(/\\/g, "/");
  if (!abs.endsWith(rel)) return false;
  const root = abs.slice(0, abs.length - rel.length);
  // Keyed by the config's mtime too: a long-lived process (the MCP server) sees an edit.
  const dir = rel.split("/")[0];
  for (const ext of ["ts", "js", "mts", "mjs"]) {
    const config = `${root}${dir}/routes.${ext}`;
    let key: string;
    try {
      key = `${config}:${statSync(config).mtimeMs}`;
    } catch {
      continue;
    }
    let hit = flatRoutesByRoot.get(key);
    if (hit === undefined) {
      hit = /\bflatRoutes\s*\(/.test(readFileSync(config, "utf-8"));
      flatRoutesByRoot.set(key, hit);
    }
    return hit;
  }
  return false;
}

// ─── Per-file analysis task / result ─────────────────────────────────────

/**
 * One unit of per-file work, shaped so it can cross a worker-thread boundary:
 * the file, the frameworks and sub-project it belongs to, and the output
 * settings the analyzer would otherwise read from its own options.
 */
export interface FileTask {
  file: DiscoveredFile;
  frameworkIds: string[];
  projectId: string;
  outputOpts: OutputOptions;
  verbose: boolean;
  projectRoot: string;
  /** tsconfig.json paths-style aliases for the project (may be empty). */
  tsconfigAliases: AliasMap;
  /**
   * The caller writes the file's JSON: the result carries it (`FileResult.json`)
   * and nothing is written here. A file being created holds up the reads
   * beside it, so a pool's files are written once its sources are read.
   */
  deferWrite?: boolean;
  /**
   * Where file-based routing reads from: the file's path relative to its own
   * sub-project's root, and that sub-project's frameworks. An Expo app in
   * `mobile/` routes `mobile/app/x.tsx` as `app/x.tsx`, and a Next.js web app
   * beside it does not switch Expo routing off. Absent: the analyzed root's.
   */
  routeScope?: { relativePath: string; frameworkIds: string[] };
  /**
   * Hand back a `SkippedFile` rather than null when the file's plugin refuses it (preprocess
   * `{ skip }`), so an incremental run can remember the refusal by content hash.
   */
  reportSkips?: boolean;
  /** The macros the file's translation unit sets on its command line (compilation database): `#ifdef` is judged by them. */
  buildMacros?: BuildMacros;
  /**
   * The project-dependent reading of this file (`LanguagePluginManifest.readingVariant`), decided by the analyzer from
   * the project's file mix before any worker starts; handed to the language's front end.
   */
  reading?: string;
}

/** A file its plugin refused by content: what `analyzeFile` returns for it when the task sets `reportSkips`. */
export interface SkippedFile {
  skipped: string;
}

/**
 * What `analyzeFile` hands back: the `FileAnalysis` plus the side channels the
 * analyzer aggregates separately (complexity rows, security issues, and the raw
 * source when a later pass needs it).
 */
export interface FileResult {
  analysis: FileAnalysis;
  rawSource: string | null; // non-null only for frontend route files
  complexities: ComplexityInfo[];
  securityIssues: SecurityIssue[];
  /** The file's output JSON, not yet written: set for a task with `deferWrite`, whose caller writes it. */
  json?: Uint8Array;
}

/**
 * Classify a parse failure into a closed reason. Raw messages carry absolute
 * grammar paths, so they would leak machine state into the artifact and churn
 * fixtures; the class of failure is what a reader needs.
 */
/**
 * The longest source (in characters) a parser front end reads. A parse holds
 * every token and the whole tree at once: measured on C, a file of tables
 * (a generated parser) costs ~350 MB of heap per MB of source and authored
 * code ~200 MB, so an 18 MB generated parser ran a 4 GB heap out where the
 * patterns read it in 1.5 s. The largest authored files measured (1.2 MB of
 * C tests) stay under it; past it the patterns read the file. Counted, never
 * timed, so a reading cannot depend on the machine's load.
 */
export const FRONT_END_MAX_CHARS = 2_000_000;

/**
 * The longest generated file read at all. A generator's output this size is
 * tables (a tree-sitter `parser.c` runs to 100 MB), and even the patterns'
 * reading of one held ~1 GB: a repository vendoring fifty grammars peaked at
 * 17 GB. Past it the file is skipped like one its plugin refuses.
 */
export const GENERATED_MAX_CHARS = 4_000_000;

/**
 * A parser front end's reading of a regex-language file: the language's ANTLR
 * grammar when the `antlr` feature covers it (`antlr` or `antlr:<grammar>`),
 * else its tree-sitter grammar when `tree-sitter` does. `parsed` is absent —
 * the patterns read the file — when the parse had syntax errors or the reader
 * threw: a recovered tree can give a function the next one's calls. A file
 * its generator signed (`generated`) or one past `FRONT_END_MAX_CHARS` is
 * never parsed: nobody reads generated tables call by call, and such a file
 * is where a parse runs out of memory.
 */
export async function readWithParser(
  language: Language,
  source: string,
  filePath: string,
  generated = false,
  buildMacros?: BuildMacros,
  variant?: string,
): Promise<{ parsed?: ParsedStructure; frontEnd: NonNullable<FileAnalysis["frontEnd"]> } | null> {
  const plugin = pluginFor(language);
  const choice = plugin?.antlr && featureEnabled(`antlr:${plugin.antlr.grammar}`)
    ? { parser: "antlr" as const, frontEnd: plugin.antlr }
    : plugin?.treeSitter && featureEnabled(`tree-sitter:${plugin.treeSitter.grammar}`)
      ? { parser: "tree-sitter" as const, frontEnd: plugin.treeSitter }
      : null;
  if (!choice) return null;
  const { parser, frontEnd } = choice;
  if (frontEnd.extensions && !frontEnd.extensions.some((ext) => filePath.endsWith(ext))) return null;
  const grammar = frontEnd.grammar;
  if (generated) return { frontEnd: { parser, grammar, fallback: "generated" } };
  if (source.length > FRONT_END_MAX_CHARS) return { frontEnd: { parser, grammar, fallback: "too-large" } };
  try {
    const read = await frontEnd.load();
    const parsed = read(source, buildMacros, variant);
    const named = variant ? { variant } : {};
    if (parsed.syntaxErrors > 0) return { frontEnd: { parser, grammar, fallback: "syntax-errors", syntaxErrors: parsed.syntaxErrors, ...named } };
    return { parsed, frontEnd: { parser, grammar, ...named } };
  } catch {
    return { frontEnd: { parser, grammar, fallback: "parser-error", ...(variant ? { variant } : {}) } };
  }
}

function fallbackReason(err: unknown): "grammar-unavailable" | "null-tree" | "parser-error" {
  const message = err instanceof Error ? err.message : String(err);
  if (/grammar|\.wasm|registered|load/i.test(message)) return "grammar-unavailable";
  if (/failed to parse|null tree/i.test(message)) return "null-tree";
  return "parser-error";
}

/** Physical line count of the raw source (a trailing newline does not add a line). */
export function countLines(source: string): number {
  if (source.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) n++;
  if (source.charCodeAt(source.length - 1) === 10) n--;
  return n;
}

// ─── Single-file analysis ────────────────────────────────────────────────

/**
 * Analyze a single file: read, parse, extract, write JSON.
 * Returns null on error (error is logged internally).
 */
/**
 * A bare call to a name the file imports (`use crate::util::{is_hidden}` …
 * `is_hidden(p)`) is a call into the importing module — for a language whose
 * plugin resolves its own import paths (`resolveImport`), so the linker can
 * follow it. Names the file defines itself stay internal.
 */
function importedNameCalls(analysis: FileAnalysis): void {
  if (!pluginFor(analysis.language)?.resolveImport) return;
  const imported = new Map<string, string>();
  for (const imp of analysis.imports) if (!imp.isType) for (const s of imp.specifiers) if (!imported.has(s)) imported.set(s, imp.source);
  if (imported.size === 0) return;
  const own = new Set([...analysis.functions.map((f) => f.name), ...analysis.classes.map((c) => c.name)]);
  const promote = (calls: CallInfo[]) => {
    for (const c of calls) {
      const source = c.kind === "internal" && !own.has(c.name) ? imported.get(c.name) : undefined;
      if (source) {
        c.kind = "cross-file";
        c.target = source;
        // The import names it — the same evidence as classifyCalls' exact specifier match.
        c.confidence = "EXTRACTED";
      }
    }
  };
  for (const fn of analysis.functions) promote(fn.calls);
  for (const cls of analysis.classes) for (const m of cls.methods) promote(m.calls);
  for (const r of analysis.routes) promote(r.calls);
}

/** Serialized alias maps and workspace package tables, by identity: files share the same few maps. */
const stampParts = new WeakMap<object, string>();
function stampOf(map: AliasMap | Map<string, WorkspacePackage>, projectRoot: string): string {
  let hit = stampParts.get(map);
  if (hit === undefined) {
    const rel = (p: string) => relative(projectRoot, p).split("\\").join("/");
    hit = JSON.stringify([...map].map(([k, v]) => (typeof v === "string"
      ? [k, rel(v)]
      : Array.isArray(v)
        ? [k, v.map(rel)]
        : [k, rel(v.dir), rel(v.entry), ...(v.requireEntry ? [rel(v.requireEntry)] : []), ...(v.exports ? [v.exports] : [])])));
    stampParts.set(map, hit);
  }
  return hit;
}

/**
 * A fingerprint of the configuration `analyzeFile` rewrites a file's imports
 * with — the nearest tsconfig/jsconfig and bundler aliases (its `paths`,
 * `baseUrl`, `extends` and `references`), the repository's workspace packages,
 * and the nearest package.json's dependencies and `imports` — or undefined when
 * none applies. The rewritten sources are stored in the cached analysis, so an
 * incremental run reuses a file only while this is unchanged: an edited alias
 * map moves the imports of files whose own bytes did not change.
 */
export function importRewriteStamp(file: Pick<DiscoveredFile, "absolutePath" | "relativePath" | "language">, projectRoot: string, tsconfigAliases: AliasMap): string | undefined {
  // Every input is per directory and per kind of file: sibling files share one stamp.
  const isJs = file.language === "typescript" || file.language === "javascript";
  const isScript = extensionFamily(file.relativePath) === "script";
  let byDir = stampMemo.get(tsconfigAliases);
  if (!byDir) stampMemo.set(tsconfigAliases, (byDir = new Map()));
  const key = `${dirname(file.absolutePath)}\0${isJs ? 1 : 0}${isScript ? 1 : 0}\0${file.language}\0${projectRoot}`;
  if (byDir.has(key)) return byDir.get(key);
  const stamp = computeImportRewriteStamp(file, isJs, isScript, projectRoot, tsconfigAliases);
  byDir.set(key, stamp);
  return stamp;
}

/** `importRewriteStamp` by directory, per root alias map (one per run: the analyzer clears the config caches first). */
const stampMemo = new WeakMap<AliasMap, Map<string, string | undefined>>();

function computeImportRewriteStamp(file: Pick<DiscoveredFile, "absolutePath" | "language">, isJs: boolean, isScript: boolean, projectRoot: string, tsconfigAliases: AliasMap): string | undefined {
  const nearest = loadTsconfigAliasesForDir(dirname(file.absolutePath));
  const aliases = nearest.size > 0 ? nearest : tsconfigAliases;
  const parts: string[] = [];
  if (aliases.size > 0) parts.push(`a${stampOf(aliases, projectRoot)}`);
  if (isJs) {
    const packages = loadWorkspacePackages(projectRoot);
    if (packages.size > 0) parts.push(`w${stampOf(packages, projectRoot)}`);
  }
  if (isScript) {
    const root = sourceRootStamp(file.absolutePath, projectRoot);
    if (root) parts.push(`s${root}`);
    const imports = packageImportsStamp(file.absolutePath);
    if (imports) parts.push(`p${imports}`);
  }
  // What the plugin's own preprocess reads beside the file (a dbt project's files).
  const own = pluginFor(file.language)?.preprocessStamp?.(file.absolutePath, projectRoot);
  if (own) parts.push(`x${own}`);
  return parts.length ? createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16) : undefined;
}

/** Analyze one file and write its JSON; null when it fails or its plugin refuses it. */
export async function analyzeFile(task: FileTask): Promise<FileResult | null> {
  const outcome = await analyzeFileOutcome({ ...task, reportSkips: false });
  return outcome && "skipped" in outcome ? null : outcome;
}

/** `analyzeFile`, telling a file its plugin refused (`SkippedFile`) from a failure when the task sets `reportSkips`. */
export async function analyzeFileOutcome(task: FileTask): Promise<FileResult | SkippedFile | null> {
  const { file, frameworkIds, projectId, outputOpts, verbose, projectRoot, tsconfigAliases } = task;
  const routeScope = task.routeScope ?? { relativePath: file.relativePath, frameworkIds };

  /** Write the file's JSON, or hand it back as bytes for the caller to write (`deferWrite`). */
  const store = async (a: FileAnalysis): Promise<{ json?: Uint8Array }> => {
    if (!task.deferWrite) {
      await writeFileAnalysis(a, outputOpts);
      return {};
    }
    return { json: new TextEncoder().encode(serializeFileAnalysis(a, outputOpts)) };
  };

  const applyTsconfigAliasesToImports = (a: FileAnalysis): void => {
    if (a.imports.length === 0) return; // nothing to rewrite — skip the tsconfig lookup
    rewriteModuleSources(a.imports, a.language);
  };

  /** Module specifiers as the importing file writes them → as the project's aliases and packages name them. */
  const rewriteModuleSources = (items: Array<{ source: string; commonJs?: boolean }>, language: string): void => {
    // Nearest tsconfig wins (the compiler's own rule): monorepo sub-projects
    // define their own `paths` and the repo root often has NO tsconfig, so
    // the task-level root map alone left whole SPAs' aliased imports — and
    // with them every cross-file link in those SPAs — unresolved.
    // `import { findClub } from "#db/clubs"`: the package's own `imports` map.
    if (extensionFamily(file.relativePath) === "script") {
      for (const imp of items) imp.source = applyPackageImports(imp.source, file.absolutePath, projectRoot);
    }
    const nearest = loadTsconfigAliasesForDir(dirname(file.absolutePath));
    const aliases = nearest.size > 0 ? nearest : tsconfigAliases;
    if (aliases.size > 0) {
      for (const imp of items) imp.source = applyAliases(imp.source, aliases, projectRoot);
    }
    // A package of this repository imported by its name (`@league/sdk`) is a
    // project file, not a dependency (workspace-packages.ts).
    if (language === "typescript" || language === "javascript") {
      const packages = loadWorkspacePackages(projectRoot);
      if (packages.size > 0) {
        for (const imp of items) imp.source = applyWorkspacePackages(imp.source, file.absolutePath, packages, projectRoot, imp.commonJs === true);
      }
    }
    // `import { Rest } from "model/rest"`: a module under the package's `src/` its bundler resolves.
    if (extensionFamily(file.relativePath) === "script") {
      for (const imp of items) imp.source = applySourceRoot(imp.source, file.absolutePath, projectRoot);
    }
  };

  /** A route's lazily imported component (`() => import('@/views/Home.vue')`), written as a module path: rewritten like an import. */
  const applyAliasesToComponentPaths = (a: FileAnalysis): void => {
    const lazy = a.routes.filter((r) => r.componentPath && r.componentPath.includes("/") && !/^[./]/.test(r.componentPath));
    if (lazy.length === 0) return;
    const nearest = loadTsconfigAliasesForDir(dirname(file.absolutePath));
    const aliases = nearest.size > 0 ? nearest : tsconfigAliases;
    for (const r of lazy) {
      let spec = r.componentPath!;
      if (aliases.size > 0) spec = applyAliases(spec, aliases, projectRoot);
      if (extensionFamily(file.relativePath) === "script") spec = applySourceRoot(spec, file.absolutePath, projectRoot);
      r.componentPath = spec;
    }
  };

  try {
    // Safety net for entry points that never ran the analyzer's bulk load
    // (worker threads see it via the analyzer-set activation; watch mode and
    // single-file callers may not) — a no-op when the plugin is loaded.
    await ensureLanguagesLoaded([file.language]);
    const filePlugin = pluginFor(file.language);
    // A worker thread has one file in hand, so it reads without a round trip
    // through the I/O threads; the main thread keeps several files in flight.
    const encoding = filePlugin?.sourceEncoding ?? "utf-8";
    const rawSource = isMainThread ? await readFile(file.absolutePath, encoding) : readFileSync(file.absolutePath, encoding);
    // Flag minified/bundled artifacts once; every branch below stamps it on
    // the analysis so project-level detectors can exclude these files.
    const minified = isMinifiedSource(rawSource);
    // A single-file library copied in (the SQLite amalgamation) is vendored
    // by its banner, wherever it sits and however many licensed files the repo has.
    const vendoredLibrary = vendoredLibraryOf(rawSource, file.language);
    const vendored = vendoredLibrary !== undefined || isVendoredSource(rawSource);
    const generated = isGeneratedSource(rawSource);
    if (generated && rawSource.length > GENERATED_MAX_CHARS) {
      const skip = `generated, ${(rawSource.length / 1e6).toFixed(1)} MB`;
      if (verbose) console.log(`    Skipping ${file.relativePath}: ${skip}`);
      return task.reportSkips ? { skipped: skip } : null;
    }

    // Formats with their own dedicated parser (e.g. Delphi .dfm — no tree-sitter)
    if (filePlugin?.customParse) {
      const analysis = filePlugin.customParse(rawSource, file.relativePath);
      analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath);
      analysis.projectId = projectId;
      analysis.lineCount = countLines(rawSource);
      if (minified) analysis.minified = true;
      if (vendored) analysis.vendored = true;
      if (vendoredLibrary) analysis.vendoredLibrary = vendoredLibrary;
      if (generated) analysis.generated = true;
      applyTsconfigAliasesToImports(analysis);
      const customTypeRefs = extractTypeReferences(analysis, file.language);
      if (customTypeRefs.length > 0) analysis.typeReferences = customTypeRefs;
      return { analysis, rawSource: null, complexities: [], securityIssues: [], ...(await store(analysis)) };
    }

    // Languages without tree-sitter grammars: use regex extraction
    if (filePlugin?.parsing === "regex") {
      // Content-sniffing preprocess, mirroring the tree-sitter path below: a
      // plugin that claims a broad extension (springxml claims `.xml`) skips
      // the files that aren't its format instead of emitting empty analyses.
      const pre = filePlugin.preprocess?.(rawSource, file.relativePath, { absolutePath: file.absolutePath, projectRoot: task.projectRoot });
      if (pre && "skip" in pre) {
        if (verbose) console.log(`    Skipping ${file.relativePath}: ${pre.skip}`);
        return task.reportSkips ? { skipped: pre.skip } : null;
      }
      const regexSource = pre?.sourceText ?? rawSource;
      // A file handed to another language's reader (a WSDL saved as `.xml`): that plugin may not be loaded yet.
      if (pre?.language && pre.language !== file.language) await ensureLanguagesLoaded([pre.language]);
      const { extractWithRegex } = await import("./regex-extractor.js");
      const regexLines = splitLines(regexSource);
      const regexLanguage = pre?.language ?? file.language;
      const read = await readWithParser(regexLanguage, regexSource, file.relativePath, generated, task.buildMacros, pre?.language ? undefined : task.reading);
      const analysis = extractWithRegex(regexSource, file.relativePath, regexLanguage, regexLines, read?.parsed);
      if (read) analysis.frontEnd = read.frontEnd;
      const caseInsensitive = pluginFor(analysis.language)?.caseInsensitiveNames === true;
      restoreTypedReceiverCalls(analysis, caseInsensitive);
      importedNameCalls(analysis);
      pre?.postExtract?.(analysis, rawSource);
      if (pre?.restoreTypedCalls) restoreTypedReceiverCalls(analysis, caseInsensitive);
      analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath);
      analysis.projectId = projectId;
      analysis.lineCount = countLines(rawSource);
      if (minified) analysis.minified = true;
      if (vendored) analysis.vendored = true;
      if (vendoredLibrary) analysis.vendoredLibrary = vendoredLibrary;
      if (generated) analysis.generated = true;
      applyTsconfigAliasesToImports(analysis);
      attachDocComments(analysis, rawSource, manifestFor(analysis.language)?.docComments);
      const fileSecurityIssues = scanSecurity(rawSource, file.relativePath, file.language);
      if (fileSecurityIssues.length > 0) analysis.securityIssues = fileSecurityIssues;
      const regexTypeRefs = extractTypeReferences(analysis, file.language);
      if (regexTypeRefs.length > 0) analysis.typeReferences = regexTypeRefs;
      const regexSpec = regexSpecFor(analysis.language);
      const regexComplexities = regexSpec ? computeRegexComplexity(regexLines, analysis, regexSpec, caseInsensitive) : [];
      if (regexComplexities.length > 0) analysis.complexities = regexComplexities;
      const stored = await store(analysis);
      // Keep raw source for regex-path UI files that back a screen (HTML pages,
      // Blazor .razor) so buildScreen can recover the page caption + navigation.
      const isUiSource =
        analysis.routes.some((r) => r.kind === "frontend") ||
        analysis.subComponents.length > 0 ||
        analysis.interactiveElements.length > 0;
      return { analysis, rawSource: isUiSource ? rawSource : null, complexities: regexComplexities, securityIssues: fileSecurityIssues, ...stored };
    }

    // Container-format preprocessing (e.g. Vue SFC → its <script> block)
    let sourceText: string = rawSource;
    let language: Language = file.language;
    let postExtract: ((analysis: FileAnalysis, raw: string) => void) | undefined;
    let embedded = false;
    const pre = filePlugin?.preprocess?.(rawSource, file.relativePath);
    if (pre) {
      if ("skip" in pre) {
        if (verbose) console.log(`    Skipping ${file.relativePath}: ${pre.skip}`);
        return task.reportSkips ? { skipped: pre.skip } : null;
      }
      sourceText = pre.sourceText;
      language = pre.language;
      postExtract = pre.postExtract;
      embedded = pre.embedded === true;
      // The effective language can differ from the file's (Vue SFC → its
      // <script> block); make sure ITS plugin is loaded too.
      await ensureLanguagesLoaded([language]);
    }

    let tree;
    try {
      tree = await parseSource(sourceText, language as any, file.relativePath);
    } catch (parseErr) {
      // Tree-sitter parse failure: fall back to regex extraction. Marked on the
      // analysis, because the result is otherwise indistinguishable from a
      // first-class regex language — and the realistic trigger is a grammar
      // that failed to load, which degrades EVERY file of that language at once.
      if (verbose) console.log(`    Parse failed for ${file.relativePath}, using regex fallback`);
      const { extractWithRegex } = await import("./regex-extractor.js");
      const analysis = extractWithRegex(rawSource, file.relativePath, file.language);
      restoreTypedReceiverCalls(analysis, pluginFor(analysis.language)?.caseInsensitiveNames === true);
      analysis.extraction = { method: "regex", fallback: true, reason: fallbackReason(parseErr) };
      analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath);
      analysis.projectId = projectId;
      analysis.lineCount = countLines(rawSource);
      if (minified) analysis.minified = true;
      if (vendored) analysis.vendored = true;
      if (vendoredLibrary) analysis.vendoredLibrary = vendoredLibrary;
      if (generated) analysis.generated = true;
      applyTsconfigAliasesToImports(analysis);
      attachDocComments(analysis, rawSource, manifestFor(analysis.language)?.docComments);
      const fileSecurityIssues = scanSecurity(rawSource, file.relativePath, file.language);
      if (fileSecurityIssues.length > 0) analysis.securityIssues = fileSecurityIssues;
      const fallbackTypeRefs = extractTypeReferences(analysis, file.language);
      if (fallbackTypeRefs.length > 0) analysis.typeReferences = fallbackTypeRefs;
      return { analysis, rawSource: null, complexities: [], securityIssues: fileSecurityIssues, ...(await store(analysis)) };
    }

    const analysis = createEmptyAnalysis(file.relativePath, language);
    analysis.projectId = projectId;
    analysis.lineCount = countLines(rawSource);
    const parseErrors = parseErrorsOf(tree, sourceText.length);
    if (parseErrors) analysis.parseErrors = parseErrors;
    if (minified) analysis.minified = true;
      if (vendored) analysis.vendored = true;
      if (vendoredLibrary) analysis.vendoredLibrary = vendoredLibrary;
      if (generated) analysis.generated = true;

    // Language-specific AST hooks (looked up for the effective language —
    // for .vue files that's the <script> block's language).
    const hooks = astHooksFor(language);

    // Run all extractors
    analysis.imports = extractImports(tree, sourceText, language, embedded);
    // Rewrite tsconfig path aliases (e.g. "@/utils/foo" → "src/utils/foo")
    // BEFORE classifyCalls so the importMap it builds uses resolved paths.
    const writtenSources = analysis.imports.map((i) => i.source);
    applyTsconfigAliasesToImports(analysis);
    // The modules this file names by a path of the project (relative, or an alias the project's own configuration rewrote).
    const projectSources = new Set(analysis.imports.filter((i, n) => i.source.startsWith(".") || i.source !== writtenSources[n]).map((i) => i.source));
    analysis.exports = extractExports(tree, sourceText, language, file.relativePath);
    analysis.functions = extractFunctions(tree, sourceText, language);
    analysis.classes = extractClasses(tree, sourceText, language);
    // Test files (unit/integration/e2e specs) never expose real routes — a
    // Cypress `cy.get('button')` or `request(app).get('/x')` is not an endpoint.
    const isTest = isTestFile(file.relativePath, language);
    const routeFacts: RouteFact[] = [];
    analysis.routes = isTest ? [] : extractRoutes(tree, sourceText, language, analysis.filePath, routeFacts);
    applyAliasesToComponentPaths(analysis);
    if (routeFacts.length > 0) analysis.routeFacts = routeFacts;
    // Data sources + mutations share one tree walk (extractDataAccess);
    // mutations are assigned further down at their original position.
    const dataAccess = extractDataAccess(tree, sourceText, language);
    analysis.dataSources = dataAccess.dataSources;
    // Backfill missing `target` on data sources by tracing each call's root
    // identifier through this file's imports (named imports, namespace
    // aliases, and global/wildcard namespaces).
    // Variable aliases must exist BEFORE enrichment: they are what resolves a
    // receiver bound to an imported constructor or factory. They were computed
    // afterwards, so even the factory shape the extractor already understood
    // (`const db = drizzle(...)`) reached enrichment too late to help.
    const variableAliases = hooks?.variableAliases?.(tree, analysis.imports) ?? new Map<string, VariableAliasBinding>();
    enrichFileDataSources(analysis, undefined, variableAliases);
    // ORM entity & relationship extraction (TypeORM/Mongoose/Sequelize, JPA,
    // EF Core, etc.). Entities are merged into analysis.classes by name so they
    // flow into the class/data-model graph; relations are persisted separately.
    const entityResult = extractEntities(analysis, sourceText, language);
    mergeEntities(analysis, entityResult);
    if (entityResult.relations.length > 0) analysis.entityRelations = entityResult.relations;
    if (entityResult.schemaTables && entityResult.schemaTables.length > 0) {
      analysis.railsSchemaTables = entityResult.schemaTables;
    }
    if (entityResult.schemaOps && entityResult.schemaOps.length > 0) analysis.schemaOps = entityResult.schemaOps;
    analysis.dataMutations = dataAccess.dataMutations;
    analysis.events = hooks?.events?.(sourceText) ?? [];
    analysis.subComponents = hooks?.subComponents?.(tree, sourceText, analysis.imports) ?? [];

    // Extract top-level calls (Vue <script setup>, module-level hooks)
    // and variable aliases (const userStore = useUserStore())
    const topLevelCalls = extractTopLevelCalls(tree, language);

    // A module that only declares typed variables (`let ticket: SeasonTicket;`) has no statement to run, yet its
    // functions read those names (where the manifest's `moduleLocalsInScope` says they do): the pseudo-function is
    // made for its locals too, but only when the file has a function or class to read them (a module of constants,
    // `export const routes: Routes = […]`, gets none).
    const topLocals = hooks?.topLevelLocalTypes?.(tree, sourceText);
    const localsRead = (analysis.functions.length > 0 || analysis.classes.length > 0) && !!pluginFor(language)?.moduleLocalsInScope;
    // Only a local whose type is stated (`let ticket: SeasonTicket;`): one typed by its initializer alone is a value
    // a statement makes, and a file with no top-level statement makes none (an Options API component's method locals).
    const declaredLocals = !!topLocals?.some((l) => l.type !== "");
    if (topLevelCalls.length > 0 || (declaredLocals && localsRead)) {
      const setupFn: FunctionInfo = {
        name: "<setup>",
        params: [],
        returnType: null,
        isAsync: false,
        isExported: false,
        decorators: [],
        calls: topLevelCalls,
        line: 1,
        endLine: 1,
      };
      if (topLocals && topLocals.length > 0) setupFn.localTypes = topLocals;
      analysis.functions.unshift(setupFn);
    }

    // Member calls held back as noise by their leaf name (`repo.find`) come
    // back when their receiver has a declared type — before classification,
    // so they are classified like every other call.
    // A receiver bound from a factory of the project (`const store = useClubStore()`) is the factory's product,
    // whose members the project states: a call on it is held back no longer.
    const factoryHeads = new Set<string>();
    for (const [name, binding] of variableAliases) if (!name.includes(".") && typeof binding !== "string" && binding.factory && projectSources.has(binding.source)) factoryHeads.add(name);
    restoreTypedReceiverCalls(analysis, pluginFor(analysis.language)?.caseInsensitiveNames === true, factoryHeads);

    // Dependency-injection registrations this file makes (project-level
    // linking joins them to injection points).
    const diBindings = hooks?.diBindings?.(tree, sourceText, file.relativePath);
    if (diBindings && diBindings.length > 0) analysis.diBindings = diBindings;
    const typeAliases = hooks?.typeAliases?.(tree, sourceText);
    if (typeAliases && typeAliases.length > 0) analysis.typeAliases = typeAliases;
    const nameAliases = hooks?.nameAliases?.(tree, sourceText);
    if (nameAliases && nameAliases.length > 0) analysis.nameAliases = nameAliases;
    const moduleBindings = hooks?.moduleBindings?.(tree, sourceText);
    if (moduleBindings && moduleBindings.length > 0) analysis.moduleBindings = moduleBindings;
    const declaredNamespace = hooks?.declaredNamespace?.(tree, sourceText);
    if (declaredNamespace) analysis.declaredNamespace = declaredNamespace;
    const facadeClass = analysis.functions.some((f) => !f.name.startsWith("<")) ? hooks?.facadeClass?.(sourceText, file.relativePath) : null;
    if (facadeClass) analysis.facadeClass = facadeClass;
    const packageName = hooks?.packageName?.(tree, sourceText);
    if (packageName) analysis.packageName = packageName;

    // Classify calls using import context, language patterns, and variable
    // aliases — and what this file defines itself, so a call into the file's
    // own code is never mistaken for a DB/API call by its method name.
    const localSymbols = new Set<string>();
    for (const fn of analysis.functions) {
      if (fn.name === "<setup>") continue;
      localSymbols.add(fn.name);
      if (fn.name.includes(".")) localSymbols.add(fn.name.slice(0, fn.name.indexOf(".")));
    }
    for (const cls of analysis.classes) localSymbols.add(cls.name);
    // Top-level functions — none nested in another's body: what a bare call names over an import of its name.
    // A test block (`describe('useClub', …)`) is named for its title and declares nothing.
    const nested = nestedFunctions(analysis.functions);
    const ownFunctions = new Set(analysis.functions
      .filter((fn) => !fn.testCase && !fn.name.includes(".") && !fn.name.startsWith("<") && !nested.has(fn))
      .map((fn) => fn.name));
    // A dispatch map the file declares whose every value is a function the file defines or a
    // name it imports (`const ACTIONS = { save: saveClub, list: loadMatches }`): `ACTIONS.save()`
    // is a call through it, whatever its key is called. A map of members (`{ get: client.get }`)
    // may hold a library's, and its calls keep what their names say.
    const imported = new Set(analysis.imports.flatMap((i) => i.specifiers));
    const mapHolders = new Map<string, boolean>();
    for (const fn of [...analysis.functions, ...analysis.classes.flatMap((c) => c.methods)]) {
      for (const c of fn.calls) {
        const dot = c.passed === "property" ? c.returnedAs?.indexOf(".") ?? -1 : -1;
        if (dot <= 0) continue;
        const holder = c.returnedAs!.slice(0, dot);
        const own = !c.name.includes(".") && (localSymbols.has(c.name) || imported.has(c.name));
        mapHolders.set(holder, (mapHolders.get(holder) ?? true) && own);
      }
    }
    for (const [holder, own] of mapHolders) if (own) localSymbols.add(holder);
    // A parameter shadows a file-level alias of the same name (`function second(club)` vs another function's `const club = useClub()`);
    // a destructuring one binds the names its pattern does (`{ refresh: again }` binds `again`, never `refresh`).
    const paramNames = (fn: FunctionInfo): Set<string> | undefined =>
      fn.params.length > 0 ? new Set(fn.params.flatMap((p) => patternBindings(p.name) ?? p.name.match(/[A-Za-z_$][\w$]*/g) ?? [])) : undefined;
    // Declared receiver types, for a language whose DB roots are constrained by type (`dbRootTypes`).
    const typed = hasDbRootTypes(language);
    const receiverTypes = (fn: FunctionInfo, cls?: ClassInfo): Map<string, string> | undefined => {
      if (!typed) return undefined;
      const out = new Map<string, string>();
      for (const p of cls?.properties ?? []) if (p.type) out.set(p.name, p.type);
      for (const p of fn.params) if (p.type) out.set(p.name, p.type);
      for (const l of fn.localTypes ?? []) if (l.type) out.set(l.name, l.type);
      return out;
    };
    // Locals initialized from a call that states no type (`request` ← `pool.request()`).
    const receiverOrigins = (fn: FunctionInfo): Map<string, string> | undefined => {
      let out: Map<string, string> | undefined;
      for (const l of fn.localTypes ?? []) {
        if (l.type || !l.from || l.fromIndex !== undefined || l.element || l.destructured || l.member) continue;
        // One binding with two initializers says nothing.
        if (out?.has(l.name)) out.set(l.name, "");
        else (out ??= new Map()).set(l.name, l.from.replace(/\(\)$/, ""));
      }
      return out;
    };
    for (const fn of analysis.functions) {
      fn.calls = classifyCalls(fn.calls, analysis.imports, language, variableAliases, localSymbols, paramNames(fn), receiverTypes(fn), receiverOrigins(fn), ownFunctions);
    }
    for (const cls of analysis.classes) {
      for (const method of cls.methods) {
        method.calls = classifyCalls(method.calls, analysis.imports, language, variableAliases, localSymbols, paramNames(method), receiverTypes(method, cls), receiverOrigins(method), ownFunctions);
      }
    }
    for (const route of analysis.routes) {
      route.calls = classifyCalls(route.calls, analysis.imports, language, variableAliases, localSymbols);
    }
    // Also classify calls inside data source callbacks (lifecycle hooks, watchers)
    for (const ds of analysis.dataSources) {
      if (ds.calls.length > 0) {
        ds.calls = classifyCalls(ds.calls, analysis.imports, language, variableAliases, localSymbols);
      }
    }

    // Extract interactive elements (buttons, inputs, forms with event bindings)
    analysis.interactiveElements = hooks?.interactiveElements?.(tree, sourceText) ?? [];

    // Angular @Component with an external templateUrl: record the url so a
    // project-level pass can read the sibling .html and back-fill this
    // component's template-derived data (interactiveElements/templateTree).
    const externalTpl = hooks?.externalTemplate?.(sourceText);
    if (externalTpl) analysis.angularTemplateUrl = externalTpl;

    // Web Component registrations (customElements.define / Lit @customElement),
    // so the component graph can join `<kebab-tag>` markup usages to this file.
    const customEls = hooks?.customElements?.(sourceText);
    if (customEls && customEls.length > 0) analysis.customElements = customEls;
    const globalMembers = hooks?.globalMembers?.(sourceText);
    if (globalMembers && globalMembers.length > 0) analysis.globalMembers = globalMembers;

    // HTTP client instances with a base URL (`axios.create({ baseURL })`) —
    // the project pass prepends the base to calls made through them.
    const clientBases = hooks?.httpClientBases?.(tree, sourceText);
    if (clientBases && Object.keys(clientBases).length > 0) analysis.httpClientBases = clientBases;
    const storeModules = hooks?.storeModules?.(tree, sourceText);
    if (storeModules && storeModules.length > 0) analysis.storeModules = storeModules;
    const storeShapes = hooks?.storeShapes?.(tree, sourceText, analysis.filePath);
    if (storeShapes) analysis.storeShapes = storeShapes;
    const entryPoints = hooks?.entryPoints?.(tree, sourceText);
    if (entryPoints && entryPoints.length > 0) analysis.entryPoints = entryPoints;
    const deployed = hooks?.deployedResources?.(tree, sourceText);
    if (deployed && deployed.length > 0) analysis.deployedResources = deployed;
    const clientRegistrations = hooks?.httpClientRegistrations?.(tree, sourceText);
    if (clientRegistrations && clientRegistrations.length > 0) analysis.httpClientRegistrations = clientRegistrations;
    const proxyRules = hooks?.proxyRules?.(tree, sourceText, file.relativePath);
    if (proxyRules && proxyRules.length > 0) analysis.proxyRules = proxyRules;
    const generatedClients = hooks?.generatedClients?.(tree, sourceText, file.relativePath);
    if (generatedClients && generatedClients.length > 0) analysis.generatedClients = generatedClients;
    const mocked = hooks?.mockedModules?.(tree, sourceText);
    if (mocked && mocked.length > 0) {
      const items = mocked.map((source) => ({ source }));
      rewriteModuleSources(items, analysis.language);
      analysis.mockedModules = items.map((m) => m.source);
    }
    const pathArgCalls = hooks?.pathArgCalls?.(tree, sourceText);
    if (pathArgCalls && pathArgCalls.length > 0) analysis.pathArgCalls = pathArgCalls;
    const domBindings = hooks?.domBindings?.(tree, sourceText);
    if (domBindings && domBindings.length > 0) analysis.domBindings = domBindings;
    const instantiations = hooks?.instantiations?.(tree, sourceText);
    if (instantiations && instantiations.length > 0) analysis.instantiations = instantiations;
    const moduleValues = hooks?.moduleValues?.(tree, sourceText);
    if (moduleValues && Object.keys(moduleValues).length > 0) analysis.moduleValues = moduleValues;
    const stringConstants = hooks?.stringConstants?.(tree, sourceText);
    if (stringConstants && Object.keys(stringConstants).length > 0) analysis.stringConstants = stringConstants;
    const moduleValueFlow = hooks?.moduleValueFlow?.(tree, sourceText);
    if (moduleValueFlow && moduleValueFlow.length > 0) analysis.moduleValueFlow = moduleValueFlow;
    const attributeReads = hooks?.attributeReads?.(tree, sourceText);
    if (attributeReads && attributeReads.length > 0) analysis.attributeReads = attributeReads;
    const browserNavigations = hooks?.browserNavigations?.(tree, sourceText);
    if (browserNavigations && browserNavigations.length > 0) analysis.browserNavigations = browserNavigations;
    const appMount = hooks?.appMount?.(tree, sourceText, file.relativePath, routeScope.frameworkIds);
    if (appMount) analysis.appMount = appMount;

    // Paths named as string data the toolchain loads (glob imports, worker
    // URLs, config-file script paths) — dead-code reachability follows them.
    const pathRefs = hooks?.pathReferences?.(sourceText);
    if (pathRefs && pathRefs.length > 0) analysis.pathReferences = pathRefs;

    // Designer screens embedded in source files (e.g. WinForms *.Designer.cs).
    const hookScreens = hooks?.screens?.(tree, sourceText, file.relativePath);
    if (hookScreens && hookScreens.length > 0) analysis.screens = hookScreens;

    // Nested component tree from the AST (React JSX, Angular inline templates).
    // Vue/Svelte SFCs populate this from their preprocess postExtract instead,
    // which runs below and overrides this (their <script> AST has no JSX).
    analysis.templateTree = hooks?.componentTree?.(tree, sourceText, analysis.imports) ?? [];

    // Infer frameworks for this specific file based on its imports
    analysis.frameworks = inferFileFrameworks(analysis.imports, file.relativePath);

    // Merge container-format data back in (e.g. Vue template elements/components)
    postExtract?.(analysis, rawSource);
    // What the markup's handlers call, in the component scope the template closes over.
    const declared = new Set([...analysis.functions.map((f) => f.name), ...analysis.classes.flatMap((c) => c.methods.map((m) => m.name))]);
    const markupCalls = hooks?.markupCalls?.(analysis.interactiveElements, file.relativePath, declared) ?? [];
    if (markupCalls.length > 0) {
      const classified = classifyCalls(markupCalls, analysis.imports, language, variableAliases, localSymbols);
      let setup = analysis.functions.find((f) => f.name === "<setup>");
      if (!setup) {
        setup = { name: "<setup>", params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line: 1, endLine: 1 };
        analysis.functions.unshift(setup);
      }
      setup.calls.push(...classified);
    }
    const propBindings = hooks?.propBindings?.(tree, sourceText, rawSource, file.relativePath);
    if (propBindings && propBindings.length > 0) analysis.propBindings = propBindings;
    const functionProps = hooks?.functionProps?.(tree, sourceText, declared);
    if (functionProps && functionProps.length > 0) analysis.functionProps = [...(analysis.functionProps ?? []), ...functionProps];
    const subscriptions = hooks?.componentSubscriptions?.(tree, sourceText);
    if (subscriptions && subscriptions.length > 0) analysis.componentSubscriptions = subscriptions;
    const contextValues = hooks?.contextValues?.(tree, sourceText);
    if (contextValues && contextValues.length > 0) analysis.contextValues = contextValues;
    const busEvents = hooks?.busEvents?.(tree, sourceText);
    if (busEvents && busEvents.length > 0) analysis.busEvents = busEvents;
    for (const fn of hooks?.markupFunctions?.(analysis.interactiveElements, file.relativePath, declared) ?? []) {
      fn.calls = classifyCalls(fn.calls, analysis.imports, language, variableAliases, localSymbols);
      analysis.functions.push(fn);
    }
    if (hooks?.propFlows) {
      const flowFns = [...analysis.functions.filter((f) => f.name !== "<setup>"), ...analysis.classes.flatMap((c) => c.methods.map((m) => ({ name: `${c.name}.${m.name}`, line: m.line, endLine: m.endLine })))];
      const flows = hooks.propFlows(tree, sourceText, rawSource, file.relativePath, flowFns);
      if (flows) analysis.propFlows = flows;
    }
    if (hooks?.subjectFlows) {
      const flowFns = [...analysis.functions.filter((f) => f.name !== "<setup>"), ...analysis.classes.flatMap((c) => c.methods.map((m) => ({ name: `${c.name}.${m.name}`, line: m.line, endLine: m.endLine })))];
      const subjects = hooks.subjectFlows(tree, sourceText, flowFns);
      if (subjects) analysis.subjectFlows = subjects;
    }
    if (hooks?.reactiveCells) {
      const named = [
        ...analysis.functions.filter((f) => f.name !== "<setup>"),
        ...analysis.classes.flatMap((c) => c.methods.map((m) => ({ name: `${c.name}.${m.name}`, line: m.line, endLine: m.endLine }))),
      ];
      const cells = hooks.reactiveCells(tree, sourceText, named);
      if (cells && cells.triggers.length > 0 && (cells.writes.length > 0 || cells.triggers.some((t) => t.immediate))) analysis.reactiveCells = cells;
    }

    // File-based routing (Next.js, Nuxt, SvelteKit, Expo Router): the route
    // comes from where the file sits. Skipped for test files, same as
    // AST-extracted routes. API endpoints read the file's exported handlers.
    if (!isTest) {
      const { relativePath: routePath, frameworkIds: routeFrameworks } = routeScope;
      analysis.routes.push(
        ...inferNextRoutes(routePath, analysis, routeFrameworks, sourceText),
        ...inferNuxtServerRoutes(routePath, analysis, routeFrameworks, sourceText),
        ...inferSvelteKitRoutes(routePath, analysis, routeFrameworks, sourceText),
        ...inferAstroRoutes(routePath, analysis, routeFrameworks, rawSource),
        ...inferExpoRouterRoutes(routePath, analysis, routeFrameworks),
        ...inferReactRouterConfig(routePath, sourceText, routeFrameworks).routes,
        ...inferFlatRoutes(routePath, analysis, routeFrameworks, {
          flatRoutes: routeFrameworks.includes("react-router-framework") && /^(?:app|src)\/routes\//.test(routePath.replace(/\\/g, "/")) && usesFlatRoutes(file.absolutePath, routePath),
        }),
      );
      const endpoints = [...inferTrpcEndpointFacts(routePath, sourceText, routeFrameworks), ...inferNextMiddlewareFacts(routePath, sourceText, routeFrameworks)];
      if (endpoints.length > 0) analysis.routeFacts = [...(analysis.routeFacts ?? []), ...endpoints];
    }

    // Detect React directives: 'use client' / 'use server'
    detectDirectives(sourceText, analysis);

    // Advanced per-file analysis: complexity and security
    const fileComplexities = computeComplexity(tree, language, analysis.functions, analysis.classes);
    let fileSecurityIssues = scanSecurity(sourceText, file.relativePath, language);
    // Request input followed to a sink inside each handler; it says more than
    // the regex finding of the same kind on the same line, which it replaces.
    const taintFacts: TaintFacts = { summaries: [], calls: [] };
    const rawTainted = isTest || isMinifiedSource(sourceText) ? [] : hooks?.taint?.(tree, sourceText, file.relativePath, taintFacts) ?? [];
    // What another file's handler may pass request input into, and what this file's handlers pass on.
    if (taintFacts.summaries.length || taintFacts.calls.length) analysis.taintFacts = taintFacts;
    // A suppression on the sink's line (or the line before) holds for the taint finding too.
    let sourceLines: string[] | null = null;
    const tainted = rawTainted.filter((t) => {
      sourceLines ??= sourceText.split(/\r?\n/);
      return !isSuppressed(t.category, sourceLines[t.line - 1] ?? "", sourceLines[t.line - 2] ?? "");
    });
    // A finding suppressed as taint must not come back as the regex finding it replaces.
    const silenced = new Set(rawTainted.filter((t) => !tainted.includes(t)).map((t) => `${t.line}\u0000${t.category}`));
    if (silenced.size) fileSecurityIssues = fileSecurityIssues.filter((i) => !silenced.has(`${i.line}\u0000${i.category}`));
    if (tainted.length > 0) {
      const covered = new Set(tainted.map((t) => `${t.line}\u0000${t.category}`));
      fileSecurityIssues = [...fileSecurityIssues.filter((i) => !covered.has(`${i.line}\u0000${i.category}`)), ...tainted];
    }

    // Attach to the analysis itself so an incremental run can read both back
    // from disk and reconstruct the project-level aggregates without re-parsing.
    if (fileComplexities.length > 0) analysis.complexities = fileComplexities;
    if (fileSecurityIssues.length > 0) analysis.securityIssues = fileSecurityIssues;

    // Type-position references — combine FileAnalysis-level refs (classes,
    // named functions) with AST-level refs (arrow functions, variable type
    // annotations, casts, new-expressions). Dedup on
    // (typeName, kind, sourceFile, sourceLine, sourceSymbol).
    const fileLevelTypeRefs = extractTypeReferences(analysis, language);
    const astLevelTypeRefs = hooks?.typeReferences?.(tree, file.relativePath) ?? [];
    const combinedTypeRefs = mergeTypeRefs(fileLevelTypeRefs, astLevelTypeRefs);
    if (combinedTypeRefs.length > 0) analysis.typeReferences = combinedTypeRefs;
    // Read from the source as written: a container's preprocess keeps its lines in place.
    attachDocComments(analysis, rawSource, manifestFor(language)?.docComments);

    const stored = await store(analysis);

    // Keep raw source for files that can back a screen: route-config files
    // (caption/nav) AND the UI component files routes resolve to (Vue/JSX/TSX,
    // or anything with template components / interactive elements). buildScreen
    // re-parses the .vue template from this to recover nesting + v-for.
    const hasFrontendRoute = analysis.routes.some((r) => r.kind === "frontend");
    const isUiSource =
      hasFrontendRoute ||
      /\.(vue|svelte|astro|jsx|tsx)$/.test(analysis.filePath) ||
      // A Delphi/Lazarus project file is the application's entry point: its
      // ordered `Application.CreateForm` calls name the main form and the
      // startup-created ones, and the form class is an ARGUMENT, so the call
      // table cannot carry it. There are one or two per project.
      /\.(dpr|lpr)$/i.test(analysis.filePath) ||
      analysis.subComponents.length > 0 ||
      analysis.interactiveElements.length > 0;
    return {
      analysis,
      rawSource: isUiSource ? rawSource : null,
      complexities: fileComplexities,
      securityIssues: fileSecurityIssues,
      ...stored,
    };
  } catch (err) {
    console.error(
      `  Error analyzing ${file.relativePath}: ${(err as Error).message}`,
    );
    if (verbose) {
      console.error((err as Error).stack);
    }
    return null;
  }
}

/**
 * Merge two TypeReference lists, dropping exact duplicates. The keys include
 * source position so legitimately distinct refs at different sites survive,
 * while the same `(typeName, kind, file, line, symbol)` from two extractors
 * (e.g. FileAnalysis classes + AST walker) collapses to one entry.
 */
function mergeTypeRefs(
  fileLevel: import("../types/analysis.js").TypeReference[],
  astLevel: import("../types/analysis.js").TypeReference[],
): import("../types/analysis.js").TypeReference[] {
  const seen = new Set<string>();
  const out: import("../types/analysis.js").TypeReference[] = [];
  for (const r of [...fileLevel, ...astLevel]) {
    const key = `${r.typeName}::${r.usageKind}::${r.sourceFile}::${r.sourceLine}::${r.sourceSymbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Detect 'use client' / 'use server' directives (React Server Components) */
function detectDirectives(
  sourceText: string,
  analysis: FileAnalysis,
) {
  const firstLine = sourceText.trimStart().split("\n")[0];
  if (firstLine.includes("'use client'") || firstLine.includes('"use client"')) {
    analysis.dataSources.push({
      kind: "prop",
      name: "use client",
      target: "React Server Component: client boundary",
      calls: [],
      line: 1,
    });
  }
  if (firstLine.includes("'use server'") || firstLine.includes('"use server"')) {
    analysis.dataSources.push({
      kind: "prop",
      name: "use server",
      target: "React Server Component: server action",
      calls: [],
      line: 1,
    });
  }
}

/** The functions another function's span strictly contains (`<setup>` and other `<…>` pseudo-functions aside), in one sweep. */
function nestedFunctions(functions: readonly FunctionInfo[]): Set<FunctionInfo> {
  const spans = functions.filter((f) => !f.name.startsWith("<")).sort((a, b) => a.line - b.line || b.endLine - a.endLine);
  const nested = new Set<FunctionInfo>();
  let maxEnd = -Infinity;
  for (let i = 0; i < spans.length;) {
    // Functions of one span contain each other no more than themselves.
    const { line, endLine } = spans[i]!;
    let j = i;
    while (j < spans.length && spans[j]!.line === line && spans[j]!.endLine === endLine) j++;
    // Every earlier span starts no later and, on the same line, ends later: one reaching this end contains it.
    if (maxEnd >= endLine) for (let k = i; k < j; k++) nested.add(spans[k]!);
    maxEnd = Math.max(maxEnd, endLine);
    i = j;
  }
  return nested;
}
