/**
 * Element registry codec — normalizes/denormalizes the on-disk JSON artifacts.
 *
 * The codebase is a property graph whose node table (a code element identified
 * by file + symbol + kind + line) is inlined into every edge. This codec lifts
 * those nodes into a single `elements` registry keyed by a deterministic
 * `file::symbol` id, so references point at an id instead of re-spelling the
 * tuple.
 *
 * CORE PRINCIPLE: the codec lives strictly at the disk I/O boundary. Every
 * in-memory shape (`FileAnalysis` / `ProjectAnalysis`) that the extractors,
 * analyzer, and renderer operate on is unchanged. We `normalize…()` just before
 * serializing and `denormalize…()` just after parsing, so the rest of the
 * pipeline never sees the registry form.
 *
 * Phase 0: scaffold only — `normalize…` / `denormalize…` are identity
 * pass-throughs and no artifact format has changed yet. `denormalize…` is
 * format-detecting (see `isNormalized`) so that once later phases emit the
 * registry form, old-format artifacts still load untouched and a rollback is a
 * no-op for readers.
 */

import type {
  BlastRadiusInfo,
  BlastSymbolUsage,
  ClassGraphNode,
  Confidence,
  DataAccessEdge,
  DataAccessEdgeCall,
  DataAccessNode,
  EntityGraphColumn,
  EntityGraphEdge,
  EntityGraphNode,
  EntityModelRef,
  FileAnalysis,
  ProjectAnalysis,
  SymbolLink,
  TypeReference,
  TypeUsageByFile,
  TypeUsageKind,
  TypeUsageSummary,
} from "../types/analysis.js";

/** On-disk format version. Present only on normalized artifacts. */
export const SCHEMA_VERSION = 1;

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
}
export interface NormFileComplexity {
  /** File element index (kind "file"). */
  file: number;
  totalComplexity: number;
  maxComplexity: number;
  averageComplexity: number;
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
export interface NormTypeReference {
  rawType: string;
  typeName: string;
  usageKind: TypeUsageKind;
  /** Source use-site element index (sourceFile::sourceSymbol). */
  source: number;
  sourceLine: number;
  sourceClass?: string;
  /** Resolved target file element index (file node), when known. */
  resolvedTarget?: number;
  confidence?: Confidence;
}
export interface NormTypeUsageSummary {
  /** Type-declaration element index (carries definedAt line + isInterface). */
  type: number;
  usageByKind: Partial<Record<TypeUsageKind, number>>;
  totalUsages: number;
  // usedByFiles is DERIVED on denormalize (sorted unique usagesByFile paths minus the defining file).
  usagesByFile: NormTypeUsageByFile[];
  topReferences: NormTypeReference[];
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

/**
 * Normalized aggregate artifact. Ref-bearing fields normalized so far are typed
 * as their id-based variants; everything else is carried through unchanged.
 */
export type NormalizedProjectAnalysis = Omit<
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

/**
 * Convert an in-memory `ProjectAnalysis` to its on-disk normalized form.
 * Two passes: intern every endpoint into the shared registry, then `finalize()`
 * (sort + remap), then build each structure with remapped integer indices.
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
      topReferences: tu.topReferences.map((tr) => ({
        tr,
        source: reg.intern(tr.sourceFile, tr.sourceSymbol),
        resolvedTarget: tr.resolvedTargetFile !== undefined ? internFile(reg, tr.resolvedTargetFile) : undefined,
      })),
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
  const out: NormalizedProjectAnalysis = { ...restP, schemaVersion: SCHEMA_VERSION, elements, symbolLinks };

  if (cxRaw) {
    out.complexity = cxRaw.map(({ fe, file, fns }) => ({
      file: remap[file],
      totalComplexity: fe.totalComplexity,
      maxComplexity: fe.maxComplexity,
      averageComplexity: fe.averageComplexity,
      functions: fns.map(({ fn, idx }) => ({ fn: remap[idx], complexity: fn.complexity })),
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
      if (r.typeUsages) {
        nb.typeUsages = r.typeUsages.map(({ tu, type, usagesByFile, topReferences }) => ({
          type: remap[type],
          usageByKind: tu.usageByKind,
          totalUsages: tu.totalUsages,
          usagesByFile: usagesByFile.map(({ uf, file }) => ({
            file: remap[file],
            count: uf.count,
            byKind: uf.byKind,
            sites: uf.sites,
          })),
          topReferences: topReferences.map(({ tr, source, resolvedTarget }) => {
            const ntr: NormTypeReference = {
              rawType: tr.rawType,
              typeName: tr.typeName,
              usageKind: tr.usageKind,
              source: remap[source],
              sourceLine: tr.sourceLine,
            };
            if (tr.sourceClass !== undefined) ntr.sourceClass = tr.sourceClass;
            if (resolvedTarget !== undefined) ntr.resolvedTarget = remap[resolvedTarget];
            if (tr.confidence !== undefined) ntr.confidence = tr.confidence;
            return ntr;
          }),
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

  return out;
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
      functions: fe.functions.map((nf) => {
        const el = elements[nf.fn];
        const [, functionName] = splitElementId(el?.id ?? "");
        return { functionName, complexity: nf.complexity, line: el?.line ?? 0, endLine: el?.endLine ?? 0 };
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
            topReferences: ntu.topReferences.map((ntr): TypeReference => {
              const sEl = elements[ntr.source];
              const [sourceFile, sourceSymbol] = splitElementId(sEl?.id ?? "");
              const tr: TypeReference = {
                rawType: ntr.rawType,
                typeName: ntr.typeName,
                usageKind: ntr.usageKind,
                sourceFile,
                sourceLine: ntr.sourceLine,
                sourceSymbol,
              };
              if (ntr.sourceClass !== undefined) tr.sourceClass = ntr.sourceClass;
              if (ntr.resolvedTarget !== undefined) tr.resolvedTargetFile = fileOf(elements, ntr.resolvedTarget);
              if (ntr.confidence !== undefined) tr.confidence = ntr.confidence;
              return tr;
            }),
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

  return result;
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
