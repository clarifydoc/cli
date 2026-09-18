import type {
  FileAnalysis,
  TypeReference,
  TypeUsageSummary,
  TypeUsageByFile,
  TypeUsageKind,
  Confidence,
  ClassGraph,
  ClassGraphNode,
  ClassGraphEdge,
} from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";
import { buildImportIndex, type ImportIndex } from "./import-index.js";
import { ormOf } from "./entity-graph.js";
import { SYNTHETIC_ENTITY } from "../extractors/entities/base.js";

/**
 * Aggregate per-class type-blast records from per-file TypeReferences.
 *
 * Output: a Map keyed on the *defining* file path. Each entry is a list of
 * TypeUsageSummary objects, one per class/interface defined in that file
 * that has at least one inbound usage somewhere in the project. The map is
 * consumed by analyzer.ts which attaches the list to the matching
 * BlastRadiusInfo entry.
 *
 * The aggregator is deliberately separate from blast-radius.ts so the
 * file-level and type-level computations stay independent — file blast
 * depends on the component graph, type blast depends on type references.
 */

export function aggregateTypeBlast(
  analyses: FileAnalysis[],
  importIndex: ImportIndex = buildImportIndex(analyses),
): Map<string /* filePath */, TypeUsageSummary[]> {
  // Step 1: build a name → [file] index. We pull from both ClassInfo and
  // type-shaped exports so TypeScript interfaces (kind: "interface") and
  // type aliases (kind: "type") get tracked too — those are not currently
  // captured in ClassInfo by the TS/JS extractor.
  const nameToFiles = new Map<string, string[]>();
  const classMeta = new Map<string /* file::name */, { line: number; isInterface: boolean }>();

  for (const a of analyses) {
    for (const cls of a.classes ?? []) {
      const arr = nameToFiles.get(cls.name) ?? [];
      if (!arr.includes(a.filePath)) arr.push(a.filePath);
      nameToFiles.set(cls.name, arr);

      // Heuristic for interface-vs-class: TS/Java/C# all store interfaces in
      // ClassInfo with no methods + no extends and may or may not have a
      // marker. Best signal: ClassInfo has methods (class) vs. no methods
      // (likely interface). Surfaced as a hint, not a hard guarantee.
      const isInterface = (cls.methods?.length ?? 0) === 0 && (cls.properties?.length ?? 0) > 0;
      classMeta.set(`${a.filePath}::${cls.name}`, { line: cls.line, isInterface });
    }

    // Fallback for type-shaped exports the language extractor didn't promote
    // to ClassInfo (TypeScript interfaces + type aliases + enums).
    for (const exp of a.exports ?? []) {
      if (exp.kind !== "interface" && exp.kind !== "type" && exp.kind !== "enum") continue;
      const arr = nameToFiles.get(exp.name) ?? [];
      if (!arr.includes(a.filePath)) arr.push(a.filePath);
      nameToFiles.set(exp.name, arr);
      const key = `${a.filePath}::${exp.name}`;
      if (!classMeta.has(key)) {
        classMeta.set(key, { line: exp.line, isInterface: exp.kind === "interface" });
      }
    }
  }

  // Step 2: resolve every TypeReference to a defining file. If a name has
  // multiple candidates, consult the importing file's import table to pick
  // the right one; otherwise mark AMBIGUOUS. (importIndex is shared from the
  // caller — see the default param above.)
  type ResolvedRef = TypeReference & { resolvedTargetFile: string };
  const resolved: ResolvedRef[] = [];

  for (const a of analyses) {
    for (const ref of a.typeReferences ?? []) {
      const candidates = nameToFiles.get(ref.typeName);
      if (!candidates || candidates.length === 0) continue;

      let targetFile: string;
      let confidence: Confidence = ref.confidence ?? "EXTRACTED";

      if (candidates.length === 1) {
        targetFile = candidates[0]!;
      } else {
        // Prefer import-resolved candidate (the source file explicitly
        // imported this name from a known defining file).
        const importedFrom = importIndex.localFor(ref.sourceFile, ref.typeName);
        const sameFile = candidates.find((c) => c === ref.sourceFile);
        if (importedFrom && candidates.includes(importedFrom)) {
          targetFile = importedFrom;
        } else if (sameFile) {
          targetFile = sameFile;
        } else {
          // Fall back to first candidate but mark AMBIGUOUS so the report
          // can flag the uncertainty.
          targetFile = candidates[0]!;
          confidence = "AMBIGUOUS";
        }
      }

      resolved.push({
        ...ref,
        resolvedTargetFile: targetFile,
        confidence,
      });
    }
  }

  // Step 3: group by (targetFile, typeName).
  const grouped = new Map<string /* file */, Map<string /* typeName */, ResolvedRef[]>>();
  for (const r of resolved) {
    let byFile = grouped.get(r.resolvedTargetFile);
    if (!byFile) {
      byFile = new Map();
      grouped.set(r.resolvedTargetFile, byFile);
    }
    const list = byFile.get(r.typeName) ?? [];
    list.push(r);
    byFile.set(r.typeName, list);
  }

  // Step 4: build TypeUsageSummary entries per (file, typeName).
  const out = new Map<string, TypeUsageSummary[]>();

  for (const [filePath, byName] of grouped) {
    const summaries: TypeUsageSummary[] = [];
    for (const [typeName, refs] of byName) {
      const meta = classMeta.get(`${filePath}::${typeName}`);
      // Skip references whose "target" is not actually a class defined in
      // this file (can happen on collisions where we routed to a candidate
      // that didn't actually own this name in classMeta).
      if (!meta) continue;

      const usageByKind: Partial<Record<TypeUsageKind, number>> = {};
      const usedByFilesSet = new Set<string>();
      // Build per-file × per-kind index so the report can answer "where is
      // X used as a return type?" without recomputing client-side.
      const byFile = new Map<string, TypeUsageByFile>();
      for (const r of refs) {
        usageByKind[r.usageKind] = (usageByKind[r.usageKind] ?? 0) + 1;
        // Self-references (a class methods that mention themselves) don't
        // count as cross-file usage.
        if (r.sourceFile !== filePath) usedByFilesSet.add(r.sourceFile);

        let entry = byFile.get(r.sourceFile);
        if (!entry) {
          entry = { filePath: r.sourceFile, count: 0, byKind: {}, sites: [] };
          byFile.set(r.sourceFile, entry);
        }
        entry.count += 1;
        entry.byKind[r.usageKind] = (entry.byKind[r.usageKind] ?? 0) + 1;
        entry.sites.push({ symbol: r.sourceSymbol, line: r.sourceLine, kind: r.usageKind });
      }
      const usedByFiles = [...usedByFilesSet].sort();

      // Sort each file's sites by line for stable navigation; sort the
      // per-file list by count desc (top-impact callers first). Sites are
      // capped per file — `count` stays exact, and the viewer shows 12 with a
      // "+N more" badge anyway; unbounded site lists were a payload-size
      // driver on reflection-heavy corpora.
      const usagesByFile = [...byFile.values()];
      for (const entry of usagesByFile) {
        entry.sites.sort((a, b) => a.line - b.line);
        if (entry.sites.length > 20) entry.sites.length = 20;
      }
      usagesByFile.sort((a, b) => b.count - a.count || byOrdinal(a.filePath, b.filePath));

      const totalUsages = refs.length;
      const extendsCount = usageByKind.extends ?? 0;
      const implementsCount = usageByKind.implements ?? 0;
      const inheritanceCount = extendsCount + implementsCount;

      const impactScore = totalUsages + usedByFiles.length * 2 + inheritanceCount * 3;

      let level: TypeUsageSummary["level"] = "low";
      if (inheritanceCount >= 3 || totalUsages >= 20) level = "critical";
      else if (totalUsages >= 10 || usedByFiles.length >= 5) level = "high";
      else if (totalUsages >= 3 || usedByFiles.length >= 2) level = "medium";

      let changeRisk: TypeUsageSummary["changeRisk"] = "safe";
      const riskScore = totalUsages + usedByFiles.length * 2 + inheritanceCount * 4;
      if (riskScore >= 25 || inheritanceCount >= 4) changeRisk = "dangerous";
      else if (riskScore >= 8) changeRisk = "moderate";

      summaries.push({
        typeName,
        definedAt: meta,
        usageByKind,
        totalUsages,
        usedByFiles,
        usagesByFile,
        impactScore,
        level,
        changeRisk,
      });
    }
    // Sort summaries by impact descending so the most-referenced types come first.
    summaries.sort((a, b) => b.impactScore - a.impactScore || byOrdinal(a.typeName, b.typeName));
    out.set(filePath, summaries);
  }

  return out;
}

/** Map every TypeUsageKind onto the colour family the Architecture tab uses. */
const KIND_CATEGORY: Record<TypeUsageKind, "inheritance" | "data" | "function"> = {
  extends: "inheritance",
  implements: "inheritance",
  field: "data",
  variable: "data",
  "generic-arg": "data",
  parameter: "function",
  return: "function",
  cast: "function",
  instantiation: "function",
};

/** Pick the dominant category on an edge — the one with the most refs. */
function dominantCategory(byKind: Partial<Record<TypeUsageKind, number>>): ClassGraphEdge["category"] {
  const totals: Record<"inheritance" | "data" | "function", number> = {
    inheritance: 0, data: 0, function: 0,
  };
  for (const k of Object.keys(byKind) as TypeUsageKind[]) {
    const cat = KIND_CATEGORY[k];
    if (cat) totals[cat] += byKind[k] ?? 0;
  }
  // Tie-break: inheritance > data > function (most disruptive first).
  if (totals.inheritance > 0 && totals.inheritance >= totals.data && totals.inheritance >= totals.function) {
    return "inheritance";
  }
  if (totals.data > 0 && totals.data >= totals.function) return "data";
  return "function";
}

/**
 * Build the class-level dependency graph for the Architecture tab's Data
 * Models mode. Nodes are classes/interfaces; edges represent type-position
 * references between them (parameter, return, field, extends, etc.).
 *
 * Source class comes from `TypeReference.sourceClass` (set by both
 * extractors when a reference appears inside a class body). References made
 * from top-level functions are skipped — they have no class container so
 * they don't form class→class edges. They still feed file-level blast.
 */
export function buildClassGraph(
  analyses: FileAnalysis[],
  importIndex: ImportIndex = buildImportIndex(analyses),
): ClassGraph {
  // Index every class node we know about. Externally-referenced types
  // (no defining ClassInfo or interface export) become "external" nodes so
  // edges to them don't dangle.
  const nodeIndex = new Map<string /* classId */, ClassGraphNode>();

  function nodeIdFor(name: string, filePath: string): string {
    return `${filePath}::${name}`;
  }

  function ensureNode(name: string, filePath: string, isInterface: boolean, isExternal: boolean, isFile = false): string {
    const id = isFile ? `file::${filePath}` : nodeIdFor(name, filePath);
    if (!nodeIndex.has(id)) {
      nodeIndex.set(id, {
        id, name, filePath,
        isInterface, isExternal, isFile,
        inboundCount: 0, outboundCount: 0,
      });
    }
    return id;
  }

  function fileBasename(p: string): string {
    const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return slash >= 0 ? p.slice(slash + 1) : p;
  }

  // Pass 1: register every locally-defined class/interface as a node.
  // Key on (filePath, className) so two classes with the same name in
  // different files remain distinct nodes.
  const localByName = new Map<string /* className */, string[] /* classIds */>();
  // Synthesized entity names per file, so pass 2 can drop the column-type
  // references they carry — otherwise those edges would re-create the node.
  const syntheticByFile = new Map<string /* filePath */, Set<string /* className */>>();
  for (const a of analyses) {
    for (const cls of a.classes ?? []) {
      // Synthesized tables (Delphi DFM dataset DML) are not declared types —
      // they'd add one node per file that queries the table, next to the real
      // class of the same name. The Data Model tab is where they belong.
      if (cls.decorators?.includes(SYNTHETIC_ENTITY)) {
        const names = syntheticByFile.get(a.filePath) ?? new Set<string>();
        names.add(cls.name);
        syntheticByFile.set(a.filePath, names);
        continue;
      }
      const isInterface = (cls.methods?.length ?? 0) === 0 && (cls.properties?.length ?? 0) > 0;
      const id = ensureNode(cls.name, a.filePath, isInterface, false);
      // Tag ORM entities so the Data Models view can distinguish DB-backed
      // entities (also shown in the ER diagram) from plain models/DTOs.
      if (cls.decorators?.includes("entity")) {
        const node = nodeIndex.get(id);
        if (node) {
          node.isEntity = true;
          node.orm = ormOf(cls.decorators);
        }
      }
      const arr = localByName.get(cls.name) ?? [];
      if (!arr.includes(id)) arr.push(id);
      localByName.set(cls.name, arr);
    }
    // Type-shape exports the language extractor didn't promote to ClassInfo.
    for (const exp of a.exports ?? []) {
      if (exp.kind !== "interface" && exp.kind !== "type" && exp.kind !== "enum") continue;
      const id = ensureNode(exp.name, a.filePath, exp.kind === "interface", false);
      const arr = localByName.get(exp.name) ?? [];
      if (!arr.includes(id)) arr.push(id);
      localByName.set(exp.name, arr);
    }
  }

  // Pass 2: aggregate edges. Each TypeReference contributes one edge tick
  // from its source (class OR file, when not inside a class) to the type
  // it references. Functional codebases (no classes) only form file→class
  // edges, which is exactly the signal a user wants for Vue/React/express.
  // (importIndex is shared from the caller — see the default param above.)
  const edgeMap = new Map<string /* "src→tgt" */, ClassGraphEdge>();
  for (const a of analyses) {
    const synthetic = syntheticByFile.get(a.filePath);
    for (const ref of a.typeReferences ?? []) {
      // A synthesized table's columns reference SQL types (`varchar`, `date`).
      // Those edges would re-add the node pass 1 deliberately skipped, and the
      // SQL type nodes with them, so the reference is dropped whole.
      if (ref.sourceClass && synthetic?.has(ref.sourceClass)) continue;
      // Resolve the target FIRST so we know whether to draw an edge at all.
      const candidates = localByName.get(ref.typeName) ?? [];
      let targetId: string;
      if (candidates.length === 0) {
        // Skip external types when the reference is from a file (not a class).
        // Otherwise the file-node space fills up with edges to fetch/Request/etc.
        if (!ref.sourceClass) continue;
        targetId = ensureNode(ref.typeName, "", false, true);
      } else if (candidates.length === 1) {
        targetId = candidates[0]!;
      } else {
        const importedFrom = importIndex.localFor(ref.sourceFile, ref.typeName);
        const importedId = importedFrom ? `${importedFrom}::${ref.typeName}` : null;
        const fromImport = importedId && candidates.includes(importedId) ? importedId : null;
        const sameFile = candidates.find((c) => c.startsWith(`${a.filePath}::`));
        targetId = fromImport ?? sameFile ?? candidates[0]!;
      }

      // Pick the source node — either the containing class, or (when the
      // reference is in top-level / module-scope code) a synthetic file node
      // so functional codebases still draw edges to their data models.
      let sourceId: string;
      if (ref.sourceClass) {
        sourceId = nodeIdFor(ref.sourceClass, a.filePath);
        if (!nodeIndex.has(sourceId)) {
          ensureNode(ref.sourceClass, a.filePath, false, false);
        }
      } else {
        sourceId = ensureNode(fileBasename(a.filePath), a.filePath, false, false, true);
      }

      // Self-edges add visual clutter and rarely communicate something useful.
      if (sourceId === targetId) continue;

      const key = `${sourceId}→${targetId}`;
      let edge = edgeMap.get(key);
      if (!edge) {
        edge = { source: sourceId, target: targetId, byKind: {}, total: 0, category: "function" };
        edgeMap.set(key, edge);
      }
      edge.byKind[ref.usageKind] = (edge.byKind[ref.usageKind] ?? 0) + 1;
      edge.total += 1;
    }
  }

  // Pass 3: assign dominant category + compute degree counts.
  for (const edge of edgeMap.values()) {
    edge.category = dominantCategory(edge.byKind);
    const src = nodeIndex.get(edge.source);
    const tgt = nodeIndex.get(edge.target);
    if (src) src.outboundCount += edge.total;
    if (tgt) tgt.inboundCount += edge.total;
  }

  // Drop unreferenced external nodes — they add noise without informing
  // anything. Local classes with zero degree stay (they appear in the graph
  // as isolated nodes so a user can still see them).
  for (const [id, node] of nodeIndex) {
    if (node.isExternal && node.inboundCount === 0 && node.outboundCount === 0) {
      nodeIndex.delete(id);
    }
  }

  return {
    nodes: [...nodeIndex.values()].sort((a, b) => byOrdinal(a.id, b.id)),
    edges: [...edgeMap.values()].sort((a, b) => byOrdinal(a.source, b.source) || byOrdinal(a.target, b.target)),
  };
}
