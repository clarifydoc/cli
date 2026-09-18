/**
 * Element registry codec — normalizes/denormalizes the on-disk JSON artifacts.
 *
 * The codebase is a property graph whose nodes (code elements and files) are
 * inlined into every edge. This codec lifts those nodes into two registries so a
 * node is spelled exactly once and references point at an index:
 *
 *   1. `elements` registry — symbol-level nodes (file + symbol + kind + line),
 *      keyed by a deterministic `file::symbol` id. Used by the symbol/graph
 *      structures: symbolLinks, complexity, classGraph, entityGraph, blastRadius,
 *      dataAccessGraph.
 *   2. `files` registry — the top-level `files[]` array IS the file registry; a
 *      file's `page_id` is its index in it. Every remaining section that used to
 *      repeat a raw project-relative path (componentGraph, linkGraph, routeMap,
 *      communities, godNodes, fileProjects/fileLayerMap keys, the analysis
 *      lists, …) stores that integer page_id instead. See `rewritePageRefs`.
 *
 * CORE PRINCIPLE: the codec lives strictly at the disk I/O boundary. Every
 * in-memory shape (`FileAnalysis` / `ProjectAnalysis`) that the extractors,
 * analyzer, and renderer operate on is unchanged. We `normalize…()` just before
 * serializing and `denormalize…()` just after parsing, so the rest of the
 * pipeline never sees the registry form.
 *
 * `denormalize…` is format-detecting on two axes: `isNormalized` (presence of
 * `schemaVersion`) gates the whole transform so pre-codec artifacts pass through
 * untouched, and the page layer is per-value shape-detecting (a `number` is a
 * page_id, a `string` is a legacy raw path) so artifacts written before page
 * encoding existed — or by a rolled-back writer — still load.
 */

import type {
  ApiRouteLink,
  ArchLayer,
  BlastRadiusInfo,
  BlastSymbolUsage,
  ClassGraphNode,
  ComponentLaunch,
  Confidence,
  DataAccessEdge,
  DataAccessEdgeCall,
  DataAccessNode,
  DataSourceInfo,
  DuplicateGroup,
  EntityGraphColumn,
  EntityGraphEdge,
  EntityGraphNode,
  EntityModelRef,
  EventInfo,
  FileAnalysis,
  InteractiveElementInfo,
  LayerViolation,
  LinkInfo,
  MigrationInfo,
  PatternInfo,
  ProjectAnalysis,
  RouteInfo,
  ScreenInfo,
  SecurityIssue,
  SubComponentInfo,
  Suggestion,
  SymbolDataAccess,
  SymbolLink,
  TraceImpactInfo,
  TypeReference,
  TypeUsageByFile,
  TypeUsageKind,
  TypeUsageSummary,
} from "../types/analysis.js";

/**
 * On-disk format version. Present only on normalized artifacts.
 *   1 — `elements` registry only (file references still raw path strings).
 *   2 — adds the `files[]` page_id layer (file references are integer page_ids).
 * Bumped for documentation/provenance; readers shape-detect rather than gate on
 * this value (see the page layer note in the file header).
 */
export const SCHEMA_VERSION = 2;

/** A deterministic, readable element id — `"<relPath>::<symbol>"`, or `"::<name>"` for externals. */
export type ElementId = string;

/**
 * One entry in the `elements` registry (an array; references are integer
 * indices into it). The `id` is a readable `file::symbol` label kept for
 * debugging and as the cross-view key. `file`/`symbol` are recovered from `id`
 * by `splitElementId` (split on the FIRST `::`, which is safe because relative
 * file paths never contain `::` while symbols may, e.g. Perl `A::B::c`).
 */
export interface ElementInfo {
  /** Readable `file::symbol` label; `::name` for externals. */
  id: ElementId;
  /** class | interface | method | function | field | enum | file | datastore | …
   *  Omitted when the contributing reference carries no kind (e.g. a symbolLink
   *  target only knows its declaration line). */
  kind?: string;
  /** Declaration line (1-based). Omitted for use-sites / synthetic nodes. */
  line?: number;
  endLine?: number;
  /** Heuristic interface-vs-class flag, carried for graph nodes that need it. */
  isInterface?: boolean;
  /** True when the element is referenced but never declared in the project. */
  isExternal?: boolean;
}

/** The metadata a caller contributes when interning an element (identity aside). */
export type ElementMeta = Omit<ElementInfo, "id">;

/**
 * A symbolLink in normalized form. References are integer indices into
 * `elements`. The target is a declaration (its line lives once in the registry);
 * the source is a use-site, so its (varying) call line stays inline as `fromLine`.
 * Per-edge properties (`callName`, `resolvedBy`, `confidence`) stay inline.
 */
export interface NormSymbolLink {
  /** Source use-site element index. */
  from: number;
  /** Call line of the source use-site (varies per link). */
  fromLine: number;
  /** Target declaration element index. */
  to: number;
  callName: string;
  resolvedBy?: "text" | "lsp";
  confidence?: Confidence;
}

/** Normalized FileComplexityInfo — filePath → file element; each function → a function element. */
export interface NormComplexityFn {
  /** Function-declaration element index (carries line/endLine). */
  fn: number;
  complexity: number;
  /** Cognitive metrics — present only for rows written by extractor ≥ 1.49. */
  cognitive?: number;
  nestingDepth?: number;
  paramCount?: number;
}
export interface NormFileComplexity {
  /** File element index (kind "file"). */
  file: number;
  totalComplexity: number;
  maxComplexity: number;
  averageComplexity: number;
  totalCognitive?: number;
  maxCognitive?: number;
  maxNestingDepth?: number;
  functions: NormComplexityFn[];
}

/** Normalized ClassGraphNode — identity → element index; flags/counts stay inline. */
export interface NormClassGraphNode {
  /** Element index. A file-node has an empty-symbol element (`<path>::`). */
  el: number;
  isEntity?: boolean;
  orm?: string | null;
  inboundCount: number;
  outboundCount: number;
}
export interface NormClassGraphEdge {
  source: number;
  target: number;
  byKind: Partial<Record<string, number>>;
  total: number;
  category: "inheritance" | "data" | "function";
}
export interface NormClassGraph {
  nodes: NormClassGraphNode[];
  edges: NormClassGraphEdge[];
}

/** Normalized EntityModelRef — id → element index; isInterface/kinds/count stay inline. */
export interface NormEntityModelRef {
  ref: number;
  isInterface: boolean;
  kinds: TypeUsageKind[];
  count: number;
}
/** Normalized EntityGraphNode — identity (id, kind, line) → element; everything else inline verbatim. */
export interface NormEntityGraphNode {
  ref: number;
  orm: string | null;
  columns: EntityGraphColumn[];
  referencingModels?: NormEntityModelRef[];
}
/** Normalized EntityGraphEdge — endpoints → element indices; props inline (tri-state preserved). */
export interface NormEntityGraphEdge {
  source: number;
  target: number;
  sourceCardinality: "one" | "many";
  targetCardinality: "one" | "many";
  fields: string[];
  foreignKey?: string | null;
  joinTable?: string | null;
  orm?: string | null;
  confidence?: Confidence;
  selfRef?: boolean;
}
export interface NormEntityGraph {
  nodes: NormEntityGraphNode[];
  edges: NormEntityGraphEdge[];
}

// ── blastRadius ──
/** A caller use-site: file element index + the (varying) call line. */
export interface NormCaller {
  ref: number;
  line: number;
}
export interface NormBlastSymbolUsage {
  name: string;
  usedByCount: number;
  callers: NormCaller[];
}
/** A type use-site within a file; `file` is the parent's element so it's omitted here. */
export interface NormSite {
  symbol: string;
  line: number;
  kind: TypeUsageKind;
}
export interface NormTypeUsageByFile {
  file: number;
  count: number;
  byKind: Partial<Record<TypeUsageKind, number>>;
  sites: NormSite[];
}
export interface NormTypeUsageSummary {
  /** Type-declaration element index (carries definedAt line + isInterface). */
  type: number;
  usageByKind: Partial<Record<TypeUsageKind, number>>;
  totalUsages: number;
  // usedByFiles is DERIVED on denormalize (sorted unique usagesByFile paths minus the defining file).
  usagesByFile: NormTypeUsageByFile[];
  impactScore: number;
  level: "critical" | "high" | "medium" | "low";
  changeRisk: "safe" | "moderate" | "dangerous";
}
export interface NormBlastRadiusInfo {
  /** Subject file element index. */
  file: number;
  directDependents: number;
  transitiveDependents: number;
  impactScore: number;
  centrality: number;
  level: "critical" | "high" | "medium" | "low";
  changeRisk: "safe" | "moderate" | "dangerous";
  maxDepth: number;
  affectedFiles: number[];
  transitiveFiles: number[];
  dependsOn: number[];
  exportedSymbols: NormBlastSymbolUsage[];
  typeUsages?: NormTypeUsageSummary[];
  /** Cross-tier reach — carried VERBATIM (paths stay strings): the lists are
   *  hard-capped, so interning would save nothing, and screens/routes are
   *  mostly non-path data (names, HTTP methods, route paths) anyway. */
  traceImpact?: TraceImpactInfo;
}

// ── dataAccessGraph ──
/** Element index + the node's (non-derivable) aggregate call-weight counts. */
export interface NormDataAccessNode {
  el: number;
  inboundCount: number;
  outboundCount: number;
}
export interface NormDataAccessEdge {
  source: number;
  target: number;
  /** Call sites — verbatim (name/line/entity); `total` is stored, NOT calls.length. */
  calls: DataAccessEdgeCall[];
  total: number;
}
export interface NormDataAccessGraph {
  nodes: NormDataAccessNode[];
  edges: NormDataAccessEdge[];
}

// ── page layer ──
/** A reference into the top-level `files[]` registry: `files[pageId]` is the path. */
export type PageId = number;

type ApiCallEntry = DataSourceInfo & { filePath: string };
type InteractiveEntry = InteractiveElementInfo & { filePath: string };
type EventEntry = EventInfo & { filePath: string };
type ComponentUsageEntry = SubComponentInfo & { filePath: string };
type SurprisingConnection = NonNullable<ProjectAnalysis["surprisingConnections"]>[number];

/** Page-id variants — each replaces a project-relative path with a `files[]` index. */
type NormLinkInfo = Omit<LinkInfo, "source" | "target"> & { source: PageId; target: PageId };
type NormSurprisingConnection = Omit<SurprisingConnection, "source" | "target"> & { source: PageId; target: PageId };
type NormRouteInfo = RouteInfo & { filePath: PageId };
type NormApiRouteLink = Omit<ApiRouteLink, "source" | "target"> & { source: PageId; target: PageId };
type NormApiCall = Omit<ApiCallEntry, "filePath"> & { filePath: PageId };
type NormInteractiveElement = Omit<InteractiveEntry, "filePath"> & { filePath: PageId };
type NormEventEntry = Omit<EventEntry, "filePath"> & { filePath: PageId };
type NormComponentUsage = Omit<ComponentUsageEntry, "filePath"> & { filePath: PageId };
type NormScreenInfo = Omit<ScreenInfo, "filePath"> & { filePath: PageId };
type NormComponentLaunch = Omit<ComponentLaunch, "sourceFile" | "targetFile"> & { sourceFile: PageId; targetFile: PageId };
type NormPatternInfo = Omit<PatternInfo, "filePath"> & { filePath: PageId };
type NormSecurityIssue = Omit<SecurityIssue, "filePath"> & { filePath: PageId };
type NormSuggestion = Omit<Suggestion, "filePath"> & { filePath?: PageId };
type NormDuplicateGroup = Omit<DuplicateGroup, "occurrences"> & {
  occurrences: { filePath: PageId; line: number; similarity: number }[];
};
type NormLayerViolation = Omit<LayerViolation, "sourceFile" | "targetFile"> & { sourceFile: PageId; targetFile: PageId };
type NormMigrationInfo = Omit<MigrationInfo, "filePath"> & { filePath: PageId };
type NormSymbolDataAccess = Omit<SymbolDataAccess, "file"> & { file: PageId };

/**
 * Elements-normalized but BEFORE the page-id layer (internal intermediate). The
 * symbol/graph structures already carry element indices; file references are
 * still raw path strings here. `rewritePageRefs` turns this into the final form.
 */
type ElementNormalizedProject = Omit<
  ProjectAnalysis,
  "symbolLinks" | "complexity" | "classGraph" | "entityGraph" | "blastRadius" | "dataAccessGraph"
> & {
  schemaVersion: number;
  elements: ElementInfo[];
  symbolLinks: NormSymbolLink[];
  complexity?: NormFileComplexity[];
  classGraph?: NormClassGraph;
  entityGraph?: NormEntityGraph;
  blastRadius?: NormBlastRadiusInfo[];
  dataAccessGraph?: NormDataAccessGraph;
};

/**
 * Final normalized aggregate artifact. Symbol/graph fields carry `elements`
 * indices; all remaining file references carry `files[]` page_ids. `fileProjects`
 * / `fileLayerMap` keep their `Record<string, …>` type — the keys are now
 * page_id strings (e.g. `"5"`) rather than paths, but the TypeScript shape is
 * identical, so no override is needed.
 */
export type NormalizedProjectAnalysis = Omit<
  ElementNormalizedProject,
  | "componentGraph" | "linkGraph" | "communities" | "godNodes" | "surprisingConnections"
  | "routeMap" | "apiCalls" | "apiRouteLinks" | "interactiveElements" | "events" | "componentUsage" | "screens"
  | "componentLaunches" | "patterns" | "securityIssues" | "suggestions" | "duplicates"
  | "layerViolations" | "migrations" | "symbolDataAccess" | "unusedFiles"
> & {
  componentGraph: Record<string, PageId[]>;
  linkGraph: NormLinkInfo[];
  communities?: Record<string, PageId[]>;
  godNodes?: { file: PageId; degree: number }[];
  surprisingConnections?: NormSurprisingConnection[];
  routeMap: NormRouteInfo[];
  apiCalls: NormApiCall[];
  apiRouteLinks?: NormApiRouteLink[];
  interactiveElements: NormInteractiveElement[];
  events: NormEventEntry[];
  componentUsage?: NormComponentUsage[];
  screens: NormScreenInfo[];
  componentLaunches?: NormComponentLaunch[];
  patterns?: NormPatternInfo[];
  securityIssues?: NormSecurityIssue[];
  suggestions?: NormSuggestion[];
  duplicates?: NormDuplicateGroup[];
  layerViolations?: NormLayerViolation[];
  migrations?: NormMigrationInfo[];
  symbolDataAccess?: NormSymbolDataAccess[];
  unusedFiles?: PageId[];
};

/** Normalized per-file artifact. See `NormalizedProjectAnalysis`. */
export type NormalizedFileAnalysis = FileAnalysis & {
  schemaVersion: number;
  elements?: ElementInfo[];
};

const META_FIELDS: (keyof ElementMeta)[] = ["kind", "line", "endLine", "isInterface", "isExternal"];

/** Build a readable element id from a file path + symbol. */
export function elementId(file: string, symbol: string): ElementId {
  return file ? `${file}::${symbol}` : `::${symbol}`;
}

/** Element id for an external (undeclared) type — no owning file. */
export function externalElementId(name: string): ElementId {
  return `::${name}`;
}

/**
 * Recover `[file, symbol]` from an element id by splitting on the FIRST `::`.
 * Safe even when the symbol itself contains `::` (Perl/C++), because relative
 * file paths never contain `::`. Inverse of `elementId`.
 */
export function splitElementId(id: ElementId): [file: string, symbol: string] {
  const idx = id.indexOf("::");
  if (idx === -1) return [id, ""];
  return [id.slice(0, idx), id.slice(idx + 2)];
}

/**
 * Accumulates the element registry (an array) while normalizing. `intern`
 * returns the integer index for an element, deduping by `(id, line)`: every
 * reference to the same declaration collapses onto one entry. A use-site that
 * knows no line and a declaration that does intern as separate entries (cheap;
 * keeps the transform trivially reversible). Newly-known metadata for an
 * existing `(id, line)` is merged in.
 */
class RegistryBuilder {
  readonly elements: ElementInfo[] = [];
  private readonly byKey = new Map<string, number>();

  intern(file: string, symbol: string, meta: ElementMeta = {}): number {
    const id = elementId(file, symbol);
    const key = `${id} ${meta.line ?? ""}`;
    const hit = this.byKey.get(key);
    if (hit !== undefined) {
      fillMissing(this.elements[hit], meta);
      return hit;
    }
    const idx = this.elements.length;
    this.elements.push({ id, ...meta });
    this.byKey.set(key, idx);
    return idx;
  }

  /**
   * Sort the registry deterministically (by id, then line) for stable diffs and
   * return the sorted array plus an old-index → new-index remap to apply to all
   * references.
   */
  finalize(): { elements: ElementInfo[]; remap: number[] } {
    const order = this.elements.map((_, i) => i).sort((a, b) => {
      const ea = this.elements[a];
      const eb = this.elements[b];
      if (ea.id !== eb.id) return ea.id < eb.id ? -1 : 1;
      return (ea.line ?? -1) - (eb.line ?? -1);
    });
    const remap = new Array<number>(this.elements.length);
    const elements = order.map((oldIdx, newIdx) => {
      remap[oldIdx] = newIdx;
      return this.elements[oldIdx];
    });
    return { elements, remap };
  }
}

/** Copy fields from `meta` that are absent on `target` (last-writer fills gaps). */
function fillMissing(target: ElementInfo, meta: ElementMeta): void {
  for (const f of META_FIELDS) {
    if (target[f] === undefined && meta[f] !== undefined) {
      (target as unknown as Record<string, unknown>)[f] = meta[f];
    }
  }
}

/**
 * True when a parsed artifact is in the normalized (registry) format. Drives the
 * format-detection guard in `denormalize…`: artifacts written before this codec
 * existed carry no `schemaVersion` and must pass through untouched.
 */
export function isNormalized(obj: unknown): boolean {
  return (
    !!obj &&
    typeof obj === "object" &&
    typeof (obj as { schemaVersion?: unknown }).schemaVersion === "number"
  );
}

// ─── Aggregate codec ───────────────────────────────────────────────────────

/** Intern a file-as-node / file reference: empty symbol, `kind:"file"`, id `<path>::`. */
function internFile(reg: RegistryBuilder, filePath: string): number {
  return reg.intern(filePath, "", { kind: "file" });
}
/** Reconstruct a plain file path from a file element (id `<path>::`). */
function fileOf(elements: ElementInfo[], idx: number): string {
  return splitElementId(elements[idx]?.id ?? "")[0];
}

/**
 * Intern a dataAccessGraph node. File nodes share the canonical file element;
 * datastore/entity nodes keep their synthetic id verbatim as the symbol (so the
 * id is NEVER routed through the file-path split), discriminated by `kind`.
 */
function internDataAccessNode(reg: RegistryBuilder, node: DataAccessNode): number {
  if (node.kind === "file") return internFile(reg, node.filePath);
  return reg.intern("", node.id, { kind: node.kind });
}
/** Recover a dataAccess node's original synthetic id string from its element. */
function dataAccessIdOf(elements: ElementInfo[], idx: number): string {
  const el = elements[idx];
  const [file, symbol] = splitElementId(el?.id ?? "");
  return el?.kind === "file" ? `file::${file}` : symbol;
}
/** Intern a dataAccess endpoint by its raw id string (fallback when not found among nodes). */
function internDataAccessIdString(reg: RegistryBuilder, id: string): number {
  if (id.startsWith("file::")) return internFile(reg, id.slice("file::".length));
  if (id.startsWith("db::")) return reg.intern("", id, { kind: "datastore" });
  if (id.startsWith("entity::")) return reg.intern("", id, { kind: "entity" });
  return reg.intern("", id);
}

// ─── Page registry (files[] index) ─────────────────────────────────────────
//
// Only fields holding a CANONICAL project-relative path (a `files[]` member) are
// rewritten. Import specifiers ("../services/auth"), datastore targets, route
// paths, `navigatesTo`, free-text questions, the absolute `projectRoot`,
// sub-project roots, `generatedRoots`, and `skippedSensitive` (skipped → not in
// files[]) are NOT page references and stay verbatim.

function buildPageIndex(files: string[]): Map<string, PageId> {
  const m = new Map<string, PageId>();
  files.forEach((f, i) => m.set(f, i));
  return m;
}

/** Encode a path value → its page_id; a path absent from files[] is kept verbatim. */
function toPage(idx: Map<string, PageId>, path: unknown): PageId | unknown {
  if (typeof path !== "string") return path;
  const p = idx.get(path);
  return p === undefined ? path : p;
}
/** Decode a page_id → its path; a legacy raw-path string passes through unchanged. */
function fromPage(files: string[], ref: unknown): string | unknown {
  return typeof ref === "number" ? files[ref] ?? "" : ref;
}
/** Encode an object KEY (paths → decimal page_id strings; non-paths kept). */
function keyToPage(idx: Map<string, PageId>, key: string): string {
  const p = idx.get(key);
  return p === undefined ? key : String(p);
}
/** Decode an object KEY (decimal page_id string → path; raw paths are never bare integers). */
function keyFromPage(files: string[], key: string): string {
  if (/^\d+$/.test(key)) {
    const i = Number(key);
    if (i < files.length) return files[i];
  }
  return key;
}

/**
 * Rewrite every page reference in an aggregate artifact, parameterized by the
 * per-value transform `ref` and per-key transform `key`. Used in BOTH directions
 * (encode passes path→id fns, decode passes id→path fns) so the two stay in
 * lockstep on exactly which locations are page references. Returns a fresh object
 * with fresh objects/arrays for every rewritten field — the input (and any shape
 * it shares with the caller's in-memory `ProjectAnalysis`) is never mutated.
 */
/** `{ [key]: value }` when the value is defined, `{}` otherwise — for optional fields in codec copies. */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function rewritePageRefs<T extends object>(
  src: T,
  ref: (v: unknown) => unknown,
  key: (k: string) => string,
): T {
  const o = { ...src } as Record<string, unknown>;

  const arr = (name: string, fn: (e: Record<string, unknown>) => Record<string, unknown>): void => {
    const v = o[name];
    if (Array.isArray(v)) o[name] = v.map(fn);
  };
  // Remap a `Record<path, …>` map's keys; optionally transform its values too.
  const remapKeys = (m: Record<string, unknown>, val?: (v: unknown) => unknown): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m)) out[key(k)] = val ? val(v) : v;
    return out;
  };
  // Remap an array's `.filePath` (when present), leaving every other field intact.
  const filePathArr = (name: string): void =>
    arr(name, (e) => (e.filePath === undefined ? e : { ...e, filePath: ref(e.filePath) }));

  if (o.fileProjects) o.fileProjects = remapKeys(o.fileProjects as Record<string, unknown>);
  if (o.fileLayerMap) o.fileLayerMap = remapKeys(o.fileLayerMap as Record<string, unknown>);
  if (o.componentGraph) {
    o.componentGraph = remapKeys(o.componentGraph as Record<string, unknown>, (deps) =>
      (deps as unknown[]).map(ref),
    );
  }
  if (o.communities) {
    // Keys are community ids (NOT paths) → keep; values are member paths.
    const c: Record<string, unknown> = {};
    for (const [k, members] of Object.entries(o.communities as Record<string, unknown[]>)) {
      c[k] = members.map(ref);
    }
    o.communities = c;
  }

  arr("linkGraph", (l) => ({ ...l, source: ref(l.source), target: ref(l.target) }));
  arr("apiRouteLinks", (l) => ({ ...l, source: ref(l.source), target: ref(l.target) }));
  arr("surprisingConnections", (s) => ({ ...s, source: ref(s.source), target: ref(s.target) }));
  arr("godNodes", (n) => ({ ...n, file: ref(n.file) }));
  arr("symbolDataAccess", (s) => ({ ...s, file: ref(s.file) }));
  arr("symbolReach", (s) => ({
    ...s,
    file: ref(s.file),
    effects: Array.isArray(s.effects)
      ? (s.effects as Record<string, unknown>[]).map((e) => ({ ...e, originFile: ref(e.originFile) }))
      : s.effects,
  }));
  arr("dataFlows", (f) => ({ ...f, entryFile: ref(f.entryFile) }));
  arr("fileChurn", (c) => ({ ...c, file: ref(c.file) }));
  arr("hotspots", (h) => ({ ...h, file: ref(h.file) }));
  arr("componentLaunches", (c) => ({ ...c, sourceFile: ref(c.sourceFile), targetFile: ref(c.targetFile) }));
  arr("layerViolations", (v) => ({ ...v, sourceFile: ref(v.sourceFile), targetFile: ref(v.targetFile) }));
  arr("duplicates", (d) => ({
    ...d,
    occurrences: (d.occurrences as Record<string, unknown>[]).map((occ) => ({ ...occ, filePath: ref(occ.filePath) })),
  }));
  for (const name of [
    "routeMap", "apiCalls", "interactiveElements", "events", "componentUsage",
    "screens", "patterns", "securityIssues", "suggestions", "migrations",
  ]) {
    filePathArr(name);
  }
  if (Array.isArray(o.unusedFiles)) o.unusedFiles = o.unusedFiles.map(ref);

  return o as T;
}

/**
 * Convert an in-memory `ProjectAnalysis` to its on-disk normalized form.
 * Two passes: intern every endpoint into the shared registry, then `finalize()`
 * (sort + remap), then build each structure with remapped integer indices.
 * Finally `rewritePageRefs` replaces the remaining raw file paths with page_ids.
 */
export function normalizeProject(p: ProjectAnalysis): NormalizedProjectAnalysis {
  const reg = new RegistryBuilder();

  // ── intern pass ──
  const slRaw = (p.symbolLinks ?? []).map((l) => ({
    l,
    // Target is a declaration → its line lives once in the registry. Source is a
    // use-site → interned for identity only; its (varying) call line stays inline.
    to: reg.intern(l.targetFile, l.targetSymbol, { line: l.targetLine }),
    from: reg.intern(l.sourceFile, l.sourceSymbol),
  }));

  const cxRaw = p.complexity?.map((fe) => ({
    fe,
    file: internFile(reg, fe.filePath),
    fns: fe.functions.map((fn) => ({
      fn,
      idx: reg.intern(fe.filePath, fn.functionName, {
        kind: "function",
        line: fn.line,
        endLine: fn.endLine,
      }),
    })),
  }));

  const cgRaw = p.classGraph
    ? {
        nodes: p.classGraph.nodes.map((node) => ({ node, el: internClassNode(reg, node) })),
        edges: p.classGraph.edges,
      }
    : undefined;

  const egRaw = p.entityGraph
    ? (() => {
        const nodeIdx = new Map<string, number>();
        const nodes = p.entityGraph.nodes.map((node) => {
          const [file, name] = splitElementId(node.id);
          const idx = reg.intern(file, name, { kind: node.kind, line: node.line });
          nodeIdx.set(node.id, idx);
          const rms = node.referencingModels?.map((rm) => {
            const [rf, rn] = splitElementId(rm.id);
            return { rm, idx: reg.intern(rf, rn) };
          });
          return { node, idx, rms };
        });
        const edges = p.entityGraph.edges.map((e) => {
          const src = nodeIdx.get(e.source);
          const tgt = nodeIdx.get(e.target);
          const [sf, ss] = splitElementId(e.source);
          const [tf, ts] = splitElementId(e.target);
          return {
            e,
            source: src ?? reg.intern(sf, ss),
            target: tgt ?? reg.intern(tf, ts),
          };
        });
        return { nodes, edges };
      })()
    : undefined;

  const brRaw = p.blastRadius?.map((b) => ({
    b,
    file: internFile(reg, b.filePath),
    affectedFiles: b.affectedFiles.map((f) => internFile(reg, f)),
    transitiveFiles: b.transitiveFiles.map((f) => internFile(reg, f)),
    dependsOn: b.dependsOn.map((f) => internFile(reg, f)),
    exportedSymbols: b.exportedSymbols.map((es) => ({
      es,
      callers: es.callers.map((c) => ({ c, ref: internFile(reg, c.file) })),
    })),
    typeUsages: b.typeUsages?.map((tu) => ({
      tu,
      // Type declaration: defined in this blast entry's filePath; line + isInterface live in the registry.
      type: reg.intern(b.filePath, tu.typeName, { line: tu.definedAt.line, isInterface: tu.definedAt.isInterface }),
      usagesByFile: tu.usagesByFile.map((uf) => ({ uf, file: internFile(reg, uf.filePath) })),
    })),
  }));

  const daRaw = p.dataAccessGraph
    ? (() => {
        const nodeIdx = new Map<string, number>();
        const nodes = p.dataAccessGraph.nodes.map((node) => {
          const idx = internDataAccessNode(reg, node);
          nodeIdx.set(node.id, idx);
          return { node, idx };
        });
        const edges = p.dataAccessGraph.edges.map((e) => ({
          e,
          source: nodeIdx.get(e.source) ?? internDataAccessIdString(reg, e.source),
          target: nodeIdx.get(e.target) ?? internDataAccessIdString(reg, e.target),
        }));
        return { nodes, edges };
      })()
    : undefined;

  const { elements, remap } = reg.finalize();

  // ── build pass ──
  const symbolLinks: NormSymbolLink[] = slRaw.map(({ l, from, to }) => {
    const out: NormSymbolLink = {
      from: remap[from],
      fromLine: l.sourceLine,
      to: remap[to],
      callName: l.callName,
    };
    if (l.resolvedBy !== undefined) out.resolvedBy = l.resolvedBy;
    if (l.confidence !== undefined) out.confidence = l.confidence;
    return out;
  });

  // Drop the fields we replace with id-based variants from the carry-through spread.
  const {
    symbolLinks: _sl,
    complexity: _c,
    classGraph: _cg,
    entityGraph: _eg,
    blastRadius: _br,
    dataAccessGraph: _da,
    ...restP
  } = p;
  const out: ElementNormalizedProject = { ...restP, schemaVersion: SCHEMA_VERSION, elements, symbolLinks };

  if (cxRaw) {
    out.complexity = cxRaw.map(({ fe, file, fns }) => ({
      file: remap[file],
      totalComplexity: fe.totalComplexity,
      maxComplexity: fe.maxComplexity,
      averageComplexity: fe.averageComplexity,
      // Optional cognitive fields are carried only when present so artifacts
      // written before they existed round-trip unchanged.
      ...optional("totalCognitive", fe.totalCognitive),
      ...optional("maxCognitive", fe.maxCognitive),
      ...optional("maxNestingDepth", fe.maxNestingDepth),
      functions: fns.map(({ fn, idx }) => ({
        fn: remap[idx],
        complexity: fn.complexity,
        ...optional("cognitive", fn.cognitive),
        ...optional("nestingDepth", fn.nestingDepth),
        ...optional("paramCount", fn.paramCount),
      })),
    }));
  }

  if (cgRaw) {
    const elOf = new Map<string, number>(); // node.id → remapped element index
    const nodes: NormClassGraphNode[] = cgRaw.nodes.map(({ node, el }) => {
      elOf.set(node.id, remap[el]);
      const nn: NormClassGraphNode = {
        el: remap[el],
        inboundCount: node.inboundCount,
        outboundCount: node.outboundCount,
      };
      if (node.isEntity !== undefined) nn.isEntity = node.isEntity;
      if ("orm" in node) nn.orm = node.orm;
      return nn;
    });
    const edges: NormClassGraphEdge[] = cgRaw.edges.map((e) => ({
      source: elOf.get(e.source)!,
      target: elOf.get(e.target)!,
      byKind: e.byKind,
      total: e.total,
      category: e.category,
    }));
    out.classGraph = { nodes, edges };
  }

  if (egRaw) {
    out.entityGraph = {
      nodes: egRaw.nodes.map(({ node, idx, rms }) => {
        const nn: NormEntityGraphNode = { ref: remap[idx], orm: node.orm, columns: node.columns };
        if (node.referencingModels !== undefined) {
          nn.referencingModels = rms!.map(({ rm, idx: rIdx }) => ({
            ref: remap[rIdx],
            isInterface: rm.isInterface,
            kinds: rm.kinds,
            count: rm.count,
          }));
        }
        return nn;
      }),
      edges: egRaw.edges.map(({ e, source, target }) => {
        const ne: NormEntityGraphEdge = {
          source: remap[source],
          target: remap[target],
          sourceCardinality: e.sourceCardinality,
          targetCardinality: e.targetCardinality,
          fields: e.fields,
        };
        if ("foreignKey" in e) ne.foreignKey = e.foreignKey;
        if ("joinTable" in e) ne.joinTable = e.joinTable;
        if ("orm" in e) ne.orm = e.orm;
        if (e.confidence !== undefined) ne.confidence = e.confidence;
        if (e.selfRef !== undefined) ne.selfRef = e.selfRef;
        return ne;
      }),
    };
  }

  if (brRaw) {
    out.blastRadius = brRaw.map((r) => {
      const nb: NormBlastRadiusInfo = {
        file: remap[r.file],
        directDependents: r.b.directDependents,
        transitiveDependents: r.b.transitiveDependents,
        impactScore: r.b.impactScore,
        centrality: r.b.centrality,
        level: r.b.level,
        changeRisk: r.b.changeRisk,
        maxDepth: r.b.maxDepth,
        affectedFiles: r.affectedFiles.map((i) => remap[i]),
        transitiveFiles: r.transitiveFiles.map((i) => remap[i]),
        dependsOn: r.dependsOn.map((i) => remap[i]),
        exportedSymbols: r.exportedSymbols.map(({ es, callers }) => ({
          name: es.name,
          usedByCount: es.usedByCount,
          callers: callers.map(({ c, ref }) => ({ ref: remap[ref], line: c.line })),
        })),
      };
      if (r.b.traceImpact) nb.traceImpact = r.b.traceImpact;
      if (r.typeUsages) {
        nb.typeUsages = r.typeUsages.map(({ tu, type, usagesByFile }) => ({
          type: remap[type],
          usageByKind: tu.usageByKind,
          totalUsages: tu.totalUsages,
          usagesByFile: usagesByFile.map(({ uf, file }) => ({
            file: remap[file],
            count: uf.count,
            byKind: uf.byKind,
            sites: uf.sites,
          })),
          impactScore: tu.impactScore,
          level: tu.level,
          changeRisk: tu.changeRisk,
        }));
      }
      return nb;
    });
  }

  if (daRaw) {
    out.dataAccessGraph = {
      nodes: daRaw.nodes.map(({ node, idx }) => ({
        el: remap[idx],
        inboundCount: node.inboundCount,
        outboundCount: node.outboundCount,
      })),
      edges: daRaw.edges.map(({ e, source, target }) => ({
        source: remap[source],
        target: remap[target],
        calls: e.calls,
        total: e.total,
      })),
    };
  }

  // ── page-id pass ── replace remaining raw file paths with files[] indices.
  const pageIndex = buildPageIndex(out.files ?? []);
  return rewritePageRefs(
    out,
    (v) => toPage(pageIndex, v),
    (k) => keyToPage(pageIndex, k),
  ) as unknown as NormalizedProjectAnalysis;
}

/** Intern a classGraph node, returning the (pre-remap) element index. */
function internClassNode(reg: RegistryBuilder, node: ClassGraphNode): number {
  if (node.isFile) return internFile(reg, node.filePath);
  const [file, symbol] = splitElementId(node.id);
  const meta: ElementMeta = {};
  if (node.isInterface) meta.isInterface = true;
  if (node.isExternal) meta.isExternal = true;
  return reg.intern(file, symbol, meta);
}

/**
 * Convert a parsed project artifact back to the in-memory `ProjectAnalysis`.
 * No-op for old-format artifacts (no `schemaVersion`).
 */
export function denormalizeProject(obj: unknown): ProjectAnalysis {
  if (!isNormalized(obj)) return obj as ProjectAnalysis;
  const n = obj as NormalizedProjectAnalysis;
  const elements = n.elements ?? [];

  const symbolLinks: SymbolLink[] = (n.symbolLinks ?? []).map((nl) => {
    const [sourceFile, sourceSymbol] = splitElementId(elements[nl.from]?.id ?? "");
    const [targetFile, targetSymbol] = splitElementId(elements[nl.to]?.id ?? "");
    const out: SymbolLink = {
      sourceFile,
      sourceSymbol,
      sourceLine: nl.fromLine,
      callName: nl.callName,
      targetFile,
      targetSymbol,
      targetLine: elements[nl.to]?.line ?? 0,
    };
    if (nl.resolvedBy !== undefined) out.resolvedBy = nl.resolvedBy;
    if (nl.confidence !== undefined) out.confidence = nl.confidence;
    return out;
  });

  const { schemaVersion: _sv, elements: _el, ...rest } = n;
  const result = { ...(rest as unknown as ProjectAnalysis), symbolLinks };

  if (n.complexity) {
    result.complexity = n.complexity.map((fe) => ({
      filePath: fileOf(elements, fe.file),
      totalComplexity: fe.totalComplexity,
      maxComplexity: fe.maxComplexity,
      averageComplexity: fe.averageComplexity,
      ...optional("totalCognitive", fe.totalCognitive),
      ...optional("maxCognitive", fe.maxCognitive),
      ...optional("maxNestingDepth", fe.maxNestingDepth),
      functions: fe.functions.map((nf) => {
        const el = elements[nf.fn];
        const [, functionName] = splitElementId(el?.id ?? "");
        return {
          functionName,
          complexity: nf.complexity,
          line: el?.line ?? 0,
          endLine: el?.endLine ?? 0,
          ...optional("cognitive", nf.cognitive),
          ...optional("nestingDepth", nf.nestingDepth),
          ...optional("paramCount", nf.paramCount),
        };
      }),
    }));
  }

  if (n.classGraph) {
    const idOf = (idx: number): string => {
      const el = elements[idx];
      const [file] = splitElementId(el?.id ?? "");
      // File nodes are reconstructed to their `file::<path>` form; class/external
      // nodes keep their stored id verbatim. Discriminate by the stored kind.
      return el?.kind === "file" ? `file::${file}` : (el?.id ?? "");
    };
    result.classGraph = {
      nodes: n.classGraph.nodes.map((nn): ClassGraphNode => {
        const el = elements[nn.el];
        const [file, symbol] = splitElementId(el?.id ?? "");
        const isFile = el?.kind === "file";
        const node: ClassGraphNode = {
          id: isFile ? `file::${file}` : el?.id ?? "",
          name: isFile ? basename(file) : symbol,
          filePath: file,
          isInterface: el?.isInterface ?? false,
          isExternal: el?.isExternal ?? false,
          isFile,
          inboundCount: nn.inboundCount,
          outboundCount: nn.outboundCount,
        };
        if (nn.isEntity !== undefined) node.isEntity = nn.isEntity;
        if ("orm" in nn) node.orm = nn.orm;
        return node;
      }),
      edges: n.classGraph.edges.map((e) => ({
        source: idOf(e.source),
        target: idOf(e.target),
        byKind: e.byKind,
        total: e.total,
        category: e.category,
      })),
    };
  }

  if (n.entityGraph) {
    result.entityGraph = {
      nodes: n.entityGraph.nodes.map((nn): EntityGraphNode => {
        const el = elements[nn.ref];
        const [filePath, name] = splitElementId(el?.id ?? "");
        const node: EntityGraphNode = {
          id: el?.id ?? "",
          name,
          orm: nn.orm,
          kind: (el?.kind as EntityGraphNode["kind"]) ?? "entity",
          filePath,
          columns: nn.columns,
          line: el?.line ?? 0,
        };
        if (nn.referencingModels !== undefined) {
          node.referencingModels = nn.referencingModels.map((r): EntityModelRef => {
            const rel = elements[r.ref];
            const [rf, rn] = splitElementId(rel?.id ?? "");
            return { id: rel?.id ?? "", name: rn, filePath: rf, isInterface: r.isInterface, kinds: r.kinds, count: r.count };
          });
        }
        return node;
      }),
      edges: n.entityGraph.edges.map((ne): EntityGraphEdge => {
        const edge: EntityGraphEdge = {
          source: elements[ne.source]?.id ?? "",
          target: elements[ne.target]?.id ?? "",
          sourceCardinality: ne.sourceCardinality,
          targetCardinality: ne.targetCardinality,
          fields: ne.fields,
        };
        if ("foreignKey" in ne) edge.foreignKey = ne.foreignKey;
        if ("joinTable" in ne) edge.joinTable = ne.joinTable;
        if ("orm" in ne) edge.orm = ne.orm;
        if (ne.confidence !== undefined) edge.confidence = ne.confidence;
        if (ne.selfRef !== undefined) edge.selfRef = ne.selfRef;
        return edge;
      }),
    };
  }

  if (n.blastRadius) {
    result.blastRadius = n.blastRadius.map((nb): BlastRadiusInfo => {
      const filePath = fileOf(elements, nb.file);
      const info: BlastRadiusInfo = {
        filePath,
        directDependents: nb.directDependents,
        transitiveDependents: nb.transitiveDependents,
        impactScore: nb.impactScore,
        centrality: nb.centrality,
        level: nb.level,
        affectedFiles: nb.affectedFiles.map((i) => fileOf(elements, i)),
        transitiveFiles: nb.transitiveFiles.map((i) => fileOf(elements, i)),
        dependsOn: nb.dependsOn.map((i) => fileOf(elements, i)),
        exportedSymbols: nb.exportedSymbols.map((es): BlastSymbolUsage => ({
          name: es.name,
          usedByCount: es.usedByCount,
          callers: es.callers.map((c) => ({ file: fileOf(elements, c.ref), line: c.line })),
        })),
        changeRisk: nb.changeRisk,
        maxDepth: nb.maxDepth,
      };
      if (nb.traceImpact) info.traceImpact = nb.traceImpact;
      if (nb.typeUsages) {
        info.typeUsages = nb.typeUsages.map((ntu): TypeUsageSummary => {
          const tEl = elements[ntu.type];
          const [, typeName] = splitElementId(tEl?.id ?? "");
          const usagesByFile = ntu.usagesByFile.map((uf): TypeUsageByFile => ({
            filePath: fileOf(elements, uf.file),
            count: uf.count,
            byKind: uf.byKind,
            sites: uf.sites,
          }));
          // usedByFiles = sorted unique usage filePaths, excluding the type's defining file.
          const usedByFiles = Array.from(new Set(usagesByFile.map((u) => u.filePath)))
            .filter((f) => f !== filePath)
            .sort();
          return {
            typeName,
            definedAt: { line: tEl?.line ?? 0, isInterface: tEl?.isInterface ?? false },
            usageByKind: ntu.usageByKind,
            totalUsages: ntu.totalUsages,
            usedByFiles,
            usagesByFile,
            impactScore: ntu.impactScore,
            level: ntu.level,
            changeRisk: ntu.changeRisk,
          };
        });
      }
      return info;
    });
  }

  if (n.dataAccessGraph) {
    result.dataAccessGraph = {
      nodes: n.dataAccessGraph.nodes.map((nn): DataAccessNode => {
        const el = elements[nn.el];
        const [file, symbol] = splitElementId(el?.id ?? "");
        if (el?.kind === "file") {
          return {
            id: `file::${file}`,
            name: basename(file),
            kind: "file",
            filePath: file,
            inboundCount: nn.inboundCount,
            outboundCount: nn.outboundCount,
          };
        }
        const id = symbol;
        const kind = (el?.kind as DataAccessNode["kind"]) ?? "datastore";
        // entity id = `entity::<target>::<entity>` where the bare entity name is the
        // last segment and `<target>` may itself contain `::` (e.g. `DBIx::Class`),
        // so take everything after the LAST `::`. datastore id = `db::<target>`
        // where the name IS the full target (which may contain `::`) → after first `::`.
        const name = kind === "entity"
          ? id.slice(id.lastIndexOf("::") + 2)
          : id.slice(id.indexOf("::") + 2);
        return { id, name, kind, filePath: "", inboundCount: nn.inboundCount, outboundCount: nn.outboundCount };
      }),
      edges: n.dataAccessGraph.edges.map((ne): DataAccessEdge => ({
        source: dataAccessIdOf(elements, ne.source),
        target: dataAccessIdOf(elements, ne.target),
        calls: ne.calls,
        total: ne.total,
      })),
    };
  }

  // ── page-id pass ── recover raw file paths from files[] indices. Shape-detecting
  // (number → page_id, string → legacy raw path), so pre-page artifacts also load.
  const files = result.files ?? [];
  return rewritePageRefs(
    result,
    (v) => fromPage(files, v),
    (k) => keyFromPage(files, k),
  );
}

/** Basename of a relative path (posix-style separators in these artifacts). */
function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

// ─── Per-file codec ──────────────────────────────────────────────────────--
//
// INTENTIONALLY an identity no-op. Per-file FileAnalysis artifacts are tiny
// (median ~2.8 KB) so within-file dedup doesn't amortize an `elements` registry:
// measured across 232 fixtures it was net *larger* (+2.4%). The aggregate
// project-summary.json is where the repetition (and the ~20% win) lives. These
// codec hooks stay wired into the write/read paths (output-writer, analyzer
// cache, lsp-updater) so per-file normalization can be added later without
// touching callers — but it is deliberately not done. If revisited, bump
// EXTRACTOR_VERSION (manifest.ts) so the incremental cache discards old-format
// per-file JSON, and validate before normalizing (the validator expects the
// in-memory shape).

/** Pass-through: per-file artifacts are not normalized (see note above). */
export function normalizeFileAnalysis(f: FileAnalysis): FileAnalysis | NormalizedFileAnalysis {
  return f;
}

/**
 * Convert a parsed per-file artifact back to the in-memory `FileAnalysis`.
 * Identity today (per-file is never normalized); format-detecting so it stays
 * correct if per-file normalization is ever introduced.
 */
export function denormalizeFileAnalysis(obj: unknown): FileAnalysis {
  if (!isNormalized(obj)) return obj as FileAnalysis;
  return obj as FileAnalysis;
}
