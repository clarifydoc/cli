import { vendoredMinoritySet } from "./security-scanner.js";
import { isApiContractLanguage } from "../extractors/registry.js";
import { DEAD_CODE_ENTRY_LIMIT } from "../types/analysis.js";
import type {
  DeadCodeReport,
  ExportInfo,
  FileAnalysis,
  Language,
  SymbolLink,
  TemplateComponentNode,
  UnreachableFile,
  UnusedExport,
} from "../types/analysis.js";
import type { ReachabilityModel } from "../types/language-plugin.js";
import { byOrdinal } from "./ordinal.js";
import { escapeRegex } from "../extractors/plugins/shared/path-utils.js";

/**
 * Detect generated/library "barrel" roots and the unused files within them.
 *
 * Motivation: code generators (kubb, openapi-generator, GraphQL codegen, …)
 * emit a large tree of files plus an `index.ts` barrel that re-exports
 * everything. Consumers import only a handful directly, so the vast majority
 * of generated files are dead — but a naive "no importers" check fails because
 * each file *is* referenced by its barrel.
 *
 * Approach:
 *   1. Identify barrel directories — a directory whose `index.*` re-exports many
 *      siblings (`export { x } from "./x"`) and whose tree is self-contained
 *      (depends on fewer than three project files outside itself), and that is
 *      not a package's public entry. The shallowest such directory is treated
 *      as a generated root (its nested barrels are subsumed).
 *   2. Mark a file "used" if it's reachable, by following import edges, from any
 *      file OUTSIDE the generated roots. Re-exports do NOT create import edges
 *      (see imports-exports.ts), so a barrel never keeps its siblings alive —
 *      only a real consumer outside the tree does.
 *   3. Unused = files under a generated root that nothing outside reaches.
 *
 * Scoping to the generated subtree means app code can never be flagged, even
 * when its own entry points are reached via dynamic import.
 */

const BARREL_RE = /(^|\/)index\.(ts|tsx|js|jsx|mjs|cjs)$/;
const MIN_REEXPORTS = 5;
/** Distinct project files outside a barrel's tree that make it authored, not generated. */
const AUTHORED_MIN_OUTSIDE_DEPS = 3;

/**
 * Directory segments that mark a subtree as generated or vendored by
 * convention alone — no barrel needed. Language-agnostic path tokens:
 * `generated` covers jOOQ/protobuf/openapi output (`…/jooq/generated/…`),
 * the rest are package-manager / vendoring conventions. Deliberately NOT
 * `gen` (a real word) or `external` (apps name integration code that).
 */
const CONVENTION_SEGMENT_RE =
  /^(?:generated|__generated__|codegen|node_modules|bower_components|jspm_packages|vendors?|vendored|third[-_]?party|thirdparty)$/i;
/** The vendoring half of the conventions: someone else's code, copied in.
 *  Not `vendors` — an app's own domain folder as often as a library's (a
 *  marketplace's `vendors/` module), and discovery already skips `vendor/`. */
const VENDORED_SEGMENT_RE = /^(?:node_modules|bower_components|jspm_packages|vendored|third[-_]?party|thirdparty)$/i;

/** Static-asset containers; a `plugins`/`lib(s)` dir below one holds vendored
 *  browser libraries (`public/js/plugins/ckeditor`), not authored code. */
const ASSETS_SEGMENT_RE = /^(?:public|static|assets|wwwroot|htdocs)$/i;
const ASSET_LIB_SEGMENT_RE = /^(?:plugins|libs?)$/i;

/** Root dirs (posix, no trailing slash) marked generated/vendored by path
 *  convention. Shallowest-wins pruning happens in the caller's merge. */
export function conventionRoots(filePaths: string[], segmentRe: RegExp = CONVENTION_SEGMENT_RE): string[] {
  const roots = new Set<string>();
  for (const f of filePaths) {
    const segs = f.replace(/\\/g, "/").split("/");
    let underAssets = false;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]!;
      if (segmentRe.test(seg) || (underAssets && ASSET_LIB_SEGMENT_RE.test(seg))) {
        roots.add(segs.slice(0, i + 1).join("/"));
        break;
      }
      if (ASSETS_SEGMENT_RE.test(seg)) underAssets = true;
    }
  }
  return [...roots];
}

/**
 * The vendored subset of the convention roots: third-party libraries copied
 * into the tree (`public/js/plugins/ckeditor`, `third_party/`). Unlike
 * codegen output — a jOOQ table class, a generated API client, which state
 * the project's own schema and endpoints — nothing in them is a fact about
 * this project: their sample pages are not its screens, and their requests
 * and queries are not its calls.
 */
export function vendoredRoots(filePaths: string[]): string[] {
  const roots = conventionRoots(filePaths, VENDORED_SEGMENT_RE);
  return roots.filter((r) => !roots.some((o) => o !== r && r.startsWith(o + "/"))).sort();
}

/**
 * Clear what files under a vendored root would contribute to the screen →
 * route → table chain: their routes, screens, outbound requests, queries,
 * writes and entity relations. In memory, on the analyses the pipeline
 * aggregates; the files stay analyzed (functions, imports, size), and stay
 * excluded from the quality signals as before. Returns the files under a
 * vendored root, cleared or not, for builders that derive more from them
 * (component screens from a page's template).
 */
export function dropVendoredFacts(analyses: FileAnalysis[]): Set<string> {
  const roots = vendoredRoots(analyses.map((a) => a.filePath));
  // A library committed beside the code (`js/jquery/jquery-ui.js`, its banner or license
  // header saying so) is vendored too, when such files are a small minority of the repo.
  const licensed = vendoredMinoritySet(analyses);
  const vendored = new Set<string>();
  if (roots.length === 0 && licensed.size === 0) return vendored;
  for (const a of analyses) {
    const p = a.filePath.replace(/\\/g, "/");
    const underRoot = roots.some((r) => p.startsWith(r + "/"));
    if (!underRoot && !licensed.has(a.filePath)) continue;
    // An API contract carrying the Apache header (`demo.proto` in a repo whose code says only
    // `SPDX-License-Identifier`) is the system's contract, not a library pasted in.
    if (!underRoot && isApiContractLanguage(a.language)) continue;
    vendored.add(a.filePath);
    a.routes = [];
    a.screens = [];
    delete a.uiComponents;
    a.dataSources = [];
    a.dataMutations = [];
    if (a.entityRelations) a.entityRelations = [];
  }
  return vendored;
}

/**
 * Generated/vendored roots found by `analyzeUnusedCode`, and the files under
 * them that nothing authored imports.
 */
export interface UnusedCodeResult {
  /** Shallowest barrel directories (posix paths, no trailing slash). */
  generatedRoots: string[];
  /** Files under a generated root not reachable from any non-generated file. */
  unusedFiles: string[];
}

/** The posix directory of a path; empty for a root-level file. */
function dirOf(filePath: string): string {
  const p = filePath.replace(/\\/g, "/");
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : "";
}

/**
 * Find generated or vendored code and the part of it the project never uses.
 *
 * A root is a directory whose barrel re-exports many modules and that depends
 * on almost nothing outside itself (codegen output), or one named by
 * convention (`generated/`, `vendor/`, …). Files under a root count as unused
 * when no file outside any root reaches them through the component graph.
 *
 * @param analyses - Every file analysis
 * @param componentGraph - file → files it imports
 * @param publicEntries - Package entry points that must never be taken for a codegen barrel
 * @returns The shallowest roots and the unused files beneath them
 */
export function analyzeUnusedCode(
  analyses: FileAnalysis[],
  componentGraph: Record<string, string[]>,
  /**
   * Files a package manifest names as its entry (package.json `main`/
   * `exports`, mapped back to source). A barrel that IS the package's public
   * API — a library's `src/index.ts` re-exporting its modules — is authored,
   * not generated; treating it as a codegen root excluded the library's whole
   * source tree from every quality signal.
   */
  publicEntries: ReadonlySet<string> = new Set(),
): UnusedCodeResult {
  // ── 1. Candidate barrel directories ──
  const barrelDirs = new Set<string>();
  for (const a of analyses) {
    if (!BARREL_RE.test(a.filePath.replace(/\\/g, "/"))) continue;
    if (publicEntries.has(a.filePath)) continue;
    const reexports = a.exports.filter((e) => e.kind === "re-export").length;
    if (reexports >= MIN_REEXPORTS) barrelDirs.add(dirOf(a.filePath));
  }
  // A barrel is how authored feature folders publish themselves too (an
  // Angular/Nest module's `index.ts`). What sets codegen output apart is that
  // it is self-contained: it depends on its own tree and npm packages, at most
  // on one or two project files a generator is pointed at (kubb's custom
  // `client`). An authored folder reaches across the project.
  for (const dir of [...barrelDirs]) {
    const inside = (f: string): boolean => f.startsWith(dir + "/");
    const outside = new Set<string>();
    for (const a of analyses) {
      if (!inside(a.filePath)) continue;
      for (const t of componentGraph[a.filePath] ?? []) if (!inside(t)) outside.add(t);
      if (outside.size >= AUTHORED_MIN_OUTSIDE_DEPS) break;
    }
    if (outside.size >= AUTHORED_MIN_OUTSIDE_DEPS) barrelDirs.delete(dir);
  }
  // Self-contained is not enough: an authored `src/shared` utility folder is
  // self-contained too. A generator says so in its output's header ("Generated
  // by Kubb", "Do not edit") — the analysis flags those files `generated` — so
  // a barrel root needs at least one such file under it.
  for (const dir of [...barrelDirs]) {
    if (!analyses.some((a) => a.generated && a.filePath.startsWith(dir + "/"))) barrelDirs.delete(dir);
  }

  // Merge barrel roots with convention-marked dirs (generated/, vendor/,
  // public/**/plugins/, …), keep only the shallowest — drop nested dirs.
  const dirs = [...new Set([...barrelDirs, ...conventionRoots(analyses.map((a) => a.filePath))])];
  const generatedRoots = dirs
    .filter((r) => r && !dirs.some((o) => o !== r && r.startsWith(o + "/")))
    .sort();

  if (generatedRoots.length === 0) {
    return { generatedRoots: [], unusedFiles: [] };
  }

  const isGenerated = (f: string): boolean => {
    const p = f.replace(/\\/g, "/");
    return generatedRoots.some((r) => p === r || p.startsWith(r + "/"));
  };

  // ── 2. Reachability from non-generated files over import edges ──
  const allFiles = analyses.map((a) => a.filePath);
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const f of allFiles) {
    if (!isGenerated(f)) {
      visited.add(f);
      queue.push(f);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const f = queue[qi++]!;
    for (const t of componentGraph[f] ?? []) {
      if (!visited.has(t)) {
        visited.add(t);
        queue.push(t);
      }
    }
  }

  // ── 3. Unused = generated files nothing outside reaches ──
  const unusedFiles = allFiles.filter((f) => isGenerated(f) && !visited.has(f)).sort();

  return { generatedRoots, unusedFiles };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reachability: authored code no entry point reaches
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inputs for {@link analyzeReachability}. Language knowledge arrives only
 * through `models` — one per language whose plugin declares `reachability`.
 */
export interface ReachabilityInput {
  analyses: FileAnalysis[];
  /** File → files it depends on (import resolution + symbol-link enrichment). */
  componentGraph: Record<string, string[]>;
  symbolLinks: SymbolLink[];
  models: ReadonlyMap<Language, ReachabilityModel>;
  /** Framework ids detected for the analysis. */
  frameworks: ReadonlySet<string>;
  /** Sub-project id → its root (posix, "" = analyzed root). */
  projectRoots: ReadonlyMap<string, string>;
  isTest(filePath: string, language: Language): boolean;
  /** Generated, vendored or minified — never judged. */
  isUnauthored(filePath: string): boolean;
  /**
   * Source files discovery refused to read (credential-looking names, links
   * that leave the tree). Their imports are unknown, so whatever sits beside
   * one may be what it loads: its directory is never reported dead.
   */
  opaqueFiles?: readonly string[];
  /** The file's source, for the "still used in its own file" check on unused exports. */
  readSource(filePath: string): string | undefined;
}

/**
 * What a static walk from the project's entry points cannot reach: whole
 * files, and exports no other file imports.
 *
 * Roots of the walk, in two tiers:
 *   - ANCHORS — entry points: the plugin's manifest entries, files a framework
 *     loads by convention, and scripts a page of another language loads
 *     (`index.html`'s `<script src="/src/main.ts">`).
 *   - PASSIVE roots — tests, ambient declarations, generated code, files a
 *     tool runs (the model's `passiveReason`: migrations, scripts, configs)
 *     and every file of a language that is not judged. They keep what they reach alive
 *     (code a test exercises is not reported), but they are no evidence of
 *     where the program starts.
 * A project none of whose judged files an anchor reaches is not judged at all
 * — with no known starting point, "unreachable" would mean every file. Its
 * files become passive roots and the project is listed in `skippedProjects`.
 *
 * Edges are the union of everything that can load a file: the component graph
 * (import heuristics + symbol links), the model's precise import resolution,
 * re-exports (barrels: `export { x } from "./x"` makes no import edge),
 * glob/worker path references and template tags without an import. Every
 * source of doubt adds reachability, never removes it.
 *
 * An export is judged only when every way into its file is accounted for by
 * name: a namespace import, a dynamic import, a glob, or a dependency edge
 * the resolver cannot explain all count as "every export used". Names are
 * followed through re-export chains, so a barrel re-exporting `x` does not
 * keep `x` alive unless someone imports it from the barrel. Entry points'
 * exports are never judged — a framework or a package consumer reads them.
 */
export function analyzeReachability(input: ReachabilityInput): DeadCodeReport | undefined {
  const { analyses, models } = input;
  if (models.size === 0) return undefined;
  const byPath = new Map(analyses.map((a) => [a.filePath, a]));
  const projectOf = (a: FileAnalysis): string => a.projectId ?? "root";

  // ── 1. Classify files ──
  const entryReason = new Map<string, string>();
  const publicApi = new Set<string>();
  for (const model of new Set(models.values())) {
    for (const e of model.manifestEntries) {
      const a = byPath.get(e.file);
      if (!a || !models.has(a.language)) continue;
      publicApi.add(e.file);
      if (!entryReason.has(e.file)) entryReason.set(e.file, e.reason);
    }
  }
  const anchors: string[] = [];
  const passive: string[] = [];
  const opaque = new Set(input.opaqueFiles ?? []);
  const known = (f: string): boolean => byPath.has(f) || opaque.has(f);
  /** Judged-language, authored, non-test, non-ambient files, entries included. */
  const candidates: FileAnalysis[] = [];
  for (const a of analyses) {
    const model = models.get(a.language);
    const test = input.isTest(a.filePath, a.language);
    if (!model) {
      // Another language's file keeps alive what it reaches, but only a page
      // that LOADS a script (below) says where a program starts — a GraphQL
      // schema or OpenAPI spec linking to its handlers does not.
      passive.push(a.filePath);
      continue;
    }
    if (test || FIXTURE_DIR_RE.test(a.filePath) || model.isAmbient?.(a.filePath) || input.isUnauthored(a.filePath)) {
      passive.push(a.filePath);
      continue;
    }
    let reason = entryReason.get(a.filePath);
    if (!reason) {
      const root = input.projectRoots.get(projectOf(a)) ?? "";
      const rel = root && a.filePath.startsWith(root + "/") ? a.filePath.slice(root.length + 1) : a.filePath;
      reason = model.entryReason(a, rel, input.frameworks, () => input.readSource(a.filePath)) ?? undefined;
      if (reason) entryReason.set(a.filePath, reason);
      // Run by a tool (a migration, a script, a config): alive, not judged,
      // and no evidence of where the program starts.
      else if (model.passiveReason?.(a, rel, input.frameworks, () => input.readSource(a.filePath))) {
        passive.push(a.filePath);
        continue;
      }
    }
    candidates.push(a);
    if (reason) anchors.push(a.filePath);
  }
  if (candidates.length === 0) return undefined;

  // ── 1b. Names, configuration entries, compilation units ──
  // Languages that reference by NAME (C#, Java, PHP, C, …) declare what other
  // files may mention; a type their framework reads from configuration is an
  // entry; a Go package is reached whole.
  const nameIndex = new Map<string, string[]>();
  const unitOfFile = new Map<string, string>();
  const unitMembers = new Map<string, string[]>();
  {
    const modelKey = new Map([...new Set(models.values())].map((m, i) => [m, i] as const));
    for (const a of candidates) {
      const model = models.get(a.language)!;
      if (model.declaredNames) {
        let configured: string | undefined;
        for (const n of new Set(model.declaredNames(a, input.readSource(a.filePath)))) {
          if (n.length < 2) continue;
          const list = nameIndex.get(n);
          if (list) list.push(a.filePath);
          else nameIndex.set(n, [a.filePath]);
          if (!configured && model.configMentions?.has(n)) configured = n;
        }
        if (configured && !entryReason.has(a.filePath)) {
          entryReason.set(a.filePath, `named in configuration (${configured})`);
          anchors.push(a.filePath);
        }
      }
      // `""` is a unit too — the project root's directory (a Go `main` package at the root).
      const unit = model.unitOf?.(a.filePath);
      if (unit !== null && unit !== undefined) {
        const key = `${modelKey.get(model)}\0${unit}`;
        unitOfFile.set(a.filePath, key);
        const members = unitMembers.get(key);
        if (members) members.push(a.filePath);
        else unitMembers.set(key, [a.filePath]);
      }
    }
  }
  /** Files whose declared names `file`'s text mentions. Read once per file. */
  const nameTargets = (file: string): string[] => {
    if (nameIndex.size === 0) return [];
    const src = input.readSource(file);
    if (!src) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const tok of src.match(IDENTIFIER_RE) ?? []) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      for (const t of nameIndex.get(tok) ?? []) if (t !== file) out.push(t);
    }
    return out;
  };

  // ── 2. Edges, and which export names each edge asks for ──
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string): void => {
    if (from === to || !known(to)) return;
    let set = edges.get(from);
    if (!set) edges.set(from, (set = new Set()));
    set.add(to);
  };
  /** (target, name) requests; name "*" = every export of the target. */
  const requests: Array<[string, string]> = [];
  const unresolvedByProject = new Map<string, number>();
  const distinctModels = [...new Set(models.values())];

  for (const a of analyses) {
    const from = a.filePath;
    const model = models.get(a.language);
    /** Targets this file reaches through something that names what it uses. */
    const explained = new Set<string>();
    if (model) {
      const resolveInto = (source: string, specifiers?: readonly string[]): string[] => {
        const targets = model.resolve(from, source, specifiers);
        if (targets === null) {
          unresolvedByProject.set(projectOf(a), (unresolvedByProject.get(projectOf(a)) ?? 0) + 1);
          return [];
        }
        return targets.filter((t) => t !== from && known(t));
      };
      for (const imp of a.imports) {
        for (const t of resolveInto(imp.source, imp.specifiers)) {
          addEdge(from, t);
          explained.add(t);
          // No binding (dynamic import, bare require, side-effect import) or a
          // namespace binding: the module object escapes, every export may be read.
          if (imp.isNamespace || imp.specifiers.length === 0) {
            requests.push([t, "*"]);
            continue;
          }
          // A default binding the target cannot satisfy is CommonJS interop —
          // `require()` / `import x from` of a module with only named exports.
          const target = byPath.get(t);
          if (!target) continue;
          if (imp.isDefault && !target.exports.some((e) => e.name === "default")) {
            requests.push([t, "*"]);
            continue;
          }
          if (imp.isDefault) requests.push([t, "default"]);
          // An aliased import requests the name the module exports.
          for (const s of imp.specifiers) requests.push([t, imp.aliases?.[s] ?? s]);
        }
      }
      for (const e of a.exports) {
        if (!e.source) continue;
        for (const t of resolveInto(e.source)) {
          addEdge(from, t);
          explained.add(t);
        }
      }
      for (const ref of a.pathReferences ?? []) {
        for (const t of model.resolvePath(from, ref)) {
          if (t === from || !known(t)) continue;
          addEdge(from, t);
          explained.add(t);
          requests.push([t, "*"]);
        }
      }
      if (model.resolveTag) {
        const imported = new Set(a.imports.flatMap((i) => i.specifiers));
        const tags = new Set<string>();
        for (const c of a.subComponents) if (!c.importSource) tags.add(c.name);
        const walk = (n: TemplateComponentNode): void => {
          if (!n.element) tags.add(n.name);
          for (const c of n.children) walk(c);
        };
        for (const n of a.templateTree ?? []) walk(n);
        for (const tag of tags) {
          if (imported.has(tag)) continue;
          for (const t of model.resolveTag(from, tag)) {
            if (t === from || !known(t)) continue;
            addEdge(from, t);
            explained.add(t);
            requests.push([t, "default"]);
          }
        }
      }
    } else {
      // A file of a language that is not judged can still load one that is —
      // a page's `<script src="/src/main.ts">`. Its imports are paths in the
      // judged language's terms, so that model resolves them.
      for (const imp of a.imports) {
        for (const m of distinctModels) {
          for (const t of m.resolvePath(from, imp.source)) {
            if (t === from || !known(t)) continue;
            addEdge(from, t);
            explained.add(t);
            requests.push([t, "*"]);
            if (!input.isTest(from, a.language) && !input.isUnauthored(from)) anchors.push(t);
          }
        }
      }
    }
    // Dependency edges the resolver did not produce (name-based heuristics,
    // symbol links, other languages): reachable, but by an unknown name.
    for (const t of input.componentGraph[from] ?? []) {
      addEdge(from, t);
      if (!explained.has(t)) requests.push([t, "?"]);
    }
  }
  // An opaque file, once reached, may load anything beside it — and may read
  // any of its exports.
  if (opaque.size > 0) {
    for (const o of opaque) {
      const dir = dirOf(o);
      for (const a of analyses) {
        if (dirOf(a.filePath) !== dir) continue;
        addEdge(o, a.filePath);
        requests.push([a.filePath, "*"]);
      }
    }
  }
  // Symbol links name the symbol they land on — a safety net for usages the
  // import resolution missed (and the "?" edges above resolve through these).
  const linkedNames = new Map<string, Set<string>>();
  for (const l of input.symbolLinks) {
    if (l.sourceFile === l.targetFile || l.navigational) continue;
    const head = l.targetSymbol.split(".")[0]!;
    let set = linkedNames.get(l.targetFile);
    if (!set) linkedNames.set(l.targetFile, (set = new Set()));
    set.add(head);
  }

  // ── 3. Walk: anchors, then unanchored projects and passive roots ──
  const visited = new Set<string>();
  const walk = (roots: Iterable<string>): void => {
    const queue: string[] = [];
    const enqueue = (t: string): void => {
      if (!visited.has(t)) { visited.add(t); queue.push(t); }
    };
    for (const r of roots) enqueue(r);
    let qi = 0;
    while (qi < queue.length) {
      const f = queue[qi++]!;
      for (const t of edges.get(f) ?? []) enqueue(t);
      const unit = unitOfFile.get(f);
      if (unit) for (const t of unitMembers.get(unit)!) enqueue(t);
      for (const t of nameTargets(f)) enqueue(t);
    }
  };
  walk(anchors);
  // Anchored per project AND language model: a Python service's entry points
  // say nothing about where a stray TypeScript file in the same tree starts.
  const modelIds = new Map([...new Set(models.values())].map((m, i) => [m, i] as const));
  const anchorKey = (a: FileAnalysis): string => `${projectOf(a)}\0${modelIds.get(models.get(a.language)!)}`;
  const anchored = new Set<string>();
  for (const a of candidates) if (visited.has(a.filePath)) anchored.add(anchorKey(a));
  const skipped = new Map<string, { project: string; files: number; languages: Set<Language> }>();
  const judged: FileAnalysis[] = [];
  for (const a of candidates) {
    if (anchored.has(anchorKey(a))) {
      judged.push(a);
      continue;
    }
    const key = anchorKey(a);
    const row = skipped.get(key) ?? { project: projectOf(a), files: 0, languages: new Set<Language>() };
    row.files++;
    row.languages.add(a.language);
    skipped.set(key, row);
    passive.push(a.filePath);
  }
  walk(passive);

  // ── 4. Unreachable files ──
  // An empty file (a bare `__init__.py` package marker) holds nothing to delete.
  const unreachable = judged.filter((a) => !visited.has(a.filePath) && a.lineCount !== 0);
  const unreachableSet = new Set(unreachable.map((a) => a.filePath));
  const deadImporters = new Map<string, number>();
  for (const f of unreachableSet) {
    const unit = unitOfFile.get(f);
    for (const t of new Set([...(edges.get(f) ?? []), ...nameTargets(f)])) {
      // A file of the same compilation unit is not an importer.
      if (unreachableSet.has(t) && (unit === undefined || unitOfFile.get(t) !== unit)) {
        deadImporters.set(t, (deadImporters.get(t) ?? 0) + 1);
      }
    }
  }
  // Names reachable code mentions without an import that resolved to them —
  // a dead-looking file spelled like one may be auto-imported or registered.
  // Per language model, and only for models that do not already match by
  // name or unit: a Rust `format!` says nothing about a Go `format.go`.
  const mentioned = new Map<ReachabilityModel, Set<string>>();
  if (unreachable.length > 0) {
    for (const f of visited) {
      const a = byPath.get(f);
      const model = a ? models.get(a.language) : undefined;
      if (!a || !model || model.declaredNames || model.unitOf) continue;
      let set = mentioned.get(model);
      if (!set) mentioned.set(model, (set = new Set()));
      const mention = (s: string): void => {
        for (const seg of s.split(/[^A-Za-z0-9_$-]+/)) if (seg) set!.add(normName(seg));
      };
      for (const fn of a.functions) for (const c of fn.calls) mention(c.name);
      for (const cls of a.classes) {
        for (const m of cls.methods) for (const c of m.calls) mention(c.name);
        if (cls.extends) mention(cls.extends);
      }
      for (const tr of a.typeReferences ?? []) mention(tr.typeName);
      for (const c of a.subComponents) mention(c.name);
    }
  }
  const files: UnreachableFile[] = unreachable.map((a) => {
    const name = normName(fileStem(a.filePath));
    const ambiguous =
      (unresolvedByProject.get(projectOf(a)) ?? 0) > 0 ||
      (name.length >= 3 && !!mentioned.get(models.get(a.language)!)?.has(name));
    const row: UnreachableFile = {
      filePath: a.filePath,
      confidence: ambiguous ? "AMBIGUOUS" : "INFERRED",
      deadImporters: deadImporters.get(a.filePath) ?? 0,
    };
    if (a.lineCount !== undefined) row.lineCount = a.lineCount;
    return row;
  });
  files.sort((x, y) => byOrdinal(x.filePath, y.filePath));

  // ── 5. Unused exports ──
  const allUsed = new Set<string>();
  const usedNames = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const use = (file: string, name: string): void => {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const a = byPath.get(file);
    const model = a ? models.get(a.language) : undefined;
    if (!a || !model) return;
    const follow = (e: ExportInfo, as: string): void => {
      for (const t of model.resolve(file, e.source!) ?? []) if (t !== file) use(t, as);
    };
    if (name === "*") {
      allUsed.add(file);
      for (const e of a.exports) if (e.source) follow(e, e.name === "*" ? "*" : e.sourceName ?? e.name);
      return;
    }
    let set = usedNames.get(file);
    if (!set) usedNames.set(file, (set = new Set()));
    set.add(name);
    const own = a.exports.filter((e) => e.name === name);
    for (const e of own) if (e.source) follow(e, e.sourceName ?? name);
    // `export *` forwards every name the module does not declare itself —
    // except `default`, which it never forwards.
    if (own.length === 0 && name !== "default") {
      for (const e of a.exports) if (e.name === "*" && e.source) follow(e, name);
    }
  };
  // Entry points are read whole — by a framework, or by the package's
  // consumers — so what they re-export is used, however deep the barrel.
  for (const f of entryReason.keys()) use(f, "*");
  for (const [t, name] of requests) {
    if (name !== "?") use(t, name);
  }
  // An edge nobody can name: the symbol links that explain it, else everything.
  for (const [t, name] of requests) {
    if (name !== "?") continue;
    const linked = linkedNames.get(t);
    if (linked && linked.size > 0) for (const n of linked) use(t, n);
    else use(t, "*");
  }
  for (const [t, names] of linkedNames) for (const n of names) use(t, n);

  const exportRows: UnusedExport[] = [];
  for (const a of judged) {
    const f = a.filePath;
    if (!visited.has(f) || entryReason.has(f) || publicApi.has(f) || allUsed.has(f)) continue;
    if (models.get(a.language)?.judgeExports === false) continue;
    const used = usedNames.get(f);
    const unused = a.exports.filter((e) => e.name !== "*" && !used?.has(e.name));
    if (unused.length === 0) continue;
    const source = input.readSource(f);
    const exportLines = new Set(a.exports.map((e) => e.line));
    for (const e of unused) {
      exportRows.push({
        filePath: f,
        name: e.name,
        kind: e.kind,
        line: e.line,
        usedInFile: source !== undefined && referencedOutsideDeclaration(source, e.name, exportLines),
      });
    }
  }
  exportRows.sort((x, y) => byOrdinal(x.filePath, y.filePath) || x.line - y.line || byOrdinal(x.name, y.name));

  const report: DeadCodeReport = {
    languages: [...new Set(judged.map((a) => a.language))].sort(),
    judgedFiles: judged.length,
    entryFiles: judged.filter((a) => entryReason.has(a.filePath)).length,
    files,
    exports: exportRows,
  };
  // What starts each program: where an agent begins reading (clarifydoc_status).
  const entries = judged
    .filter((a) => entryReason.has(a.filePath))
    .map((a) => ({ filePath: a.filePath, reason: entryReason.get(a.filePath)! }))
    .sort((x, y) => byOrdinal(x.filePath, y.filePath))
    .slice(0, DEAD_CODE_ENTRY_LIMIT);
  if (entries.length) report.entries = entries;
  if (skipped.size > 0) {
    report.skippedProjects = [...skipped.values()]
      .map((r) => ({
        root: input.projectRoots.get(r.project) ?? "",
        files: r.files,
        languages: [...r.languages].sort(),
        reason: "no entry point found",
      }))
      .sort((x, y) => byOrdinal(x.root, y.root) || byOrdinal(x.languages.join(), y.languages.join()));
  }
  const unresolved = [...unresolvedByProject.values()].reduce((s, n) => s + n, 0);
  if (unresolved > 0) report.unresolvedImports = unresolved;
  return report;
}

/**
 * Test data and sample directories: inputs a test suite or a tutorial feeds
 * the program, not the program (`__fixtures__/`, `test-fixtures/`,
 * `testdata/`, `examples/`, `samples/`). Each example is its own entry point,
 * so "nothing reaches it" says nothing. Never judged.
 */
const FIXTURE_DIR_RE =
  /(?:^|\/)(?:__fixtures__|fixtures|test-?fixtures|test-?data|__mocks__|examples?|samples?|demos?|bench(?:es|marks?)?)\//i;

/** A whole identifier, for name references (`$`/`@` prefixes split off). */
const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Basename without extension; an `index` file is named by its directory. */
function fileStem(filePath: string): string {
  const segs = filePath.split("/");
  const base = segs[segs.length - 1]!.replace(/\..*$/, "");
  return base === "index" && segs.length > 1 ? segs[segs.length - 2]! : base;
}

/** Lowercase alphanumerics only, so `my-module`, `MyModule` and `my_module` compare equal. */
function normName(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/**
 * Whether `name` is referenced in `source` anywhere other than where it is
 * declared or exported — i.e. dropping the `export` keeps the code compiling.
 */
function referencedOutsideDeclaration(source: string, name: string, exportLines: ReadonlySet<number>): boolean {
  if (name === "default" || !/^[A-Za-z_$][\w$]*$/.test(name)) return false;
  const esc = escapeRegex(name);
  const word = new RegExp(`(?<![\\w$.])${esc}(?![\\w$])`, "g");
  const decl = new RegExp(`\\b(?:const|let|var|function\\*?|class|interface|type|enum|namespace)\\s+${esc}(?![\\w$])`);
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (exportLines.has(i + 1)) continue;
    const line = lines[i]!;
    const hits = line.match(word)?.length ?? 0;
    if (hits === 0) continue;
    if (hits > (decl.test(line) ? 1 : 0)) return true;
  }
  return false;
}
