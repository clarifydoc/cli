import type {
  ArchLayer,
  BlastRadiusInfo,
  EntityGraph,
  FileAnalysis,
  PatternInfo,
  ResponsibilityProfile,
  RiskCategory,
  RiskVerdict,
} from "../types/analysis.js";
import { traceEscalationFor } from "./trace-impact.js";

/**
 * Risk verdict: the interpretation layer over blast radius.
 *
 * `blast-radius.ts` answers "how many files depend on this" and thresholds
 * that count into `level` and `changeRisk`. Both are magnitudes. Neither says
 * what KIND of thing the file is, and the kind is what decides whether the
 * magnitude matters: five importers of an interface everything is typed
 * against is a different proposition from five importers of a date helper.
 *
 * So this pass classifies each file into one of six categories through an
 * ORDERED CASCADE — first arm with a fired rule wins, `unknown` is a
 * legitimate outcome — and then derives a level from the thresholds that
 * apply to THAT category.
 *
 * Two deliberate departures from Ix's `risk-semantics.ts`, which this is
 * modelled on:
 *
 *  - **No name tokens.** Ix classifies partly by matching English verbs in
 *    identifiers (`parse`, `resolve`, `ingest`) and nouns (`client`,
 *    `adapter`). That degrades badly outside English, which matters here.
 *    Every rule below reads structure the pipeline already extracted —
 *    responsibility profiles, the cross-tier trace graph, the entity graph,
 *    the layer map — and none reads an identifier's spelling.
 *  - **`boundary` is not gated on fan-in.** A file that talks to the outside
 *    world is a boundary whether or not anything imports it; how bad that is
 *    is the level's job, not the category's.
 *
 * Every verdict carries `reasons[]` naming each rule that fired, expressed
 * through the same stable-identifier idiom as `RefactorPressureInfo.drivers`
 * (`REASON_LABELS`, `describeReasons`). Rules in arms BELOW the winning one
 * still record themselves, so the reasons are complete even though the
 * category is first-match-wins.
 *
 * Deterministic, pure, and derived: it reads the analysis summary and changes
 * no extraction, so it needs no `EXTRACTOR_VERSION` bump.
 */

export interface RiskVerdictConfig {
  /** Files defining contracts others are typed against; graded per importer AND per reference. */
  foundation: {
    criticalImporters: number;
    criticalRefs: number;
    highImporters: number;
    highRefs: number;
    /**
     * Concern count above which an exported interface stops counting as
     * foundation evidence. A module that mixes persistence, transport,
     * messaging and auth is a boundary that happens to declare a type at the
     * top — not a file whose purpose is defining contracts. The two stronger
     * foundation rules (a declared ER entity, an abstract/data class) are NOT
     * gated this way: there the declaration IS the file's purpose, and an ORM
     * import would otherwise disqualify every model file.
     */
    maxConcernsForInterfaceRule: number;
  };
  /** Files meeting the outside world; graded by how much user-facing traffic crosses them. */
  boundary: { criticalUpstream: number; highUpstream: number; highSymbolCallers: number };
  /** Files on a UI→data path; graded on both ends at once. */
  flow: { criticalUpstream: number; criticalDownstream: number; highUpstream: number; highDownstream: number };
  /** Widely-imported internals with no boundary or flow evidence. */
  shared: {
    /** Fan-in at which the `shared` category itself fires. */
    minDependents: number;
    minTransitive: number;
    minSymbolCallers: number;
    /** Level ladder, once the category has fired. */
    critical: number;
    high: number;
    medium: number;
    /**
     * The same ladder in transitive terms, as a SHARE of the project's files.
     * The category can fire on transitive reach alone (a file with 2 direct
     * importers and 254 transitive ones is shared by any reading), so grading
     * on direct importers alone would call that "low".
     *
     * A share rather than a count because transitive totals are a property of
     * the repository's topology, not of the file: this project's plugin
     * registry puts a quarter of its files on a plateau at ~111 transitive
     * dependents, and any absolute threshold would be fitted to that accident.
     * "Reaches half the codebase" travels; "reaches 150 files" does not.
     */
    criticalTransitiveShare: number;
    highTransitiveShare: number;
  };
  /** Total fan-in at or below which a file is `localized`. */
  localized: { maxFanIn: number };
  /** Max entries in `behaviourAtRisk`. */
  behaviourCap: number;
}

/**
 * Ix's published thresholds where it had one (foundation at 5 importers,
 * shared at 5 dependents / 8 transitive / 20 member callers, boundary at 30
 * member-level callers), and the EXISTING cross-tier escalation rule for
 * `flow`, so a verdict can never contradict the `level` that rule already set.
 */
export const DEFAULT_RISK_VERDICT_CONFIG: RiskVerdictConfig = {
  foundation: {
    criticalImporters: 5,
    criticalRefs: 25,
    highImporters: 2,
    highRefs: 10,
    maxConcernsForInterfaceRule: 1,
  },
  boundary: { criticalUpstream: 8, highUpstream: 3, highSymbolCallers: 30 },
  flow: { criticalUpstream: 5, criticalDownstream: 3, highUpstream: 3, highDownstream: 3 },
  shared: {
    minDependents: 5,
    minTransitive: 8,
    minSymbolCallers: 20,
    critical: 15,
    high: 8,
    medium: 4,
    criticalTransitiveShare: 0.5,
    highTransitiveShare: 0.25,
  },
  localized: { maxFanIn: 2 },
  behaviourCap: 8,
};

/** Everything the cascade reads about one file. */
export interface FileRiskInput {
  blast: BlastRadiusInfo;
  /** Project size, for the transitive share. Falls back to an absolute count when absent. */
  totalFiles?: number;
  /** Absent for files with no per-file analysis (synthetic trace-only blast rows). */
  analysis?: FileAnalysis;
  profile?: ResponsibilityProfile;
  layer?: ArchLayer;
  /** The file declares at least one ER entity or enum. */
  declaresEntity: boolean;
  /** A `dataclass` or `abc` pattern was detected here. */
  abstractPattern: boolean;
  /** The file's test coverage, when a report covered it: lines counted and lines a test ran. */
  testCoverage?: { total: number; covered: number };
  /** Its history: commits, and the ones that fixed something. */
  history?: { commits: number; fixes: number };
}

/**
 * Project-wide inputs to `attachRiskVerdicts`, from which the per-file
 * `FileRiskInput` of each blast-radius row is assembled.
 */
export interface RiskVerdictInput {
  analyses: readonly FileAnalysis[];
  /** Denominator for the transitive share; defaults to `analyses.length`. */
  totalFiles?: number;
  responsibilityProfiles?: readonly ResponsibilityProfile[];
  fileLayerMap?: Record<string, ArchLayer>;
  patterns?: readonly PatternInfo[];
  entityGraph?: EntityGraph;
  /** Per-file test coverage from the reports a test run wrote. */
  testCoverage?: ReadonlyMap<string, { total: number; covered: number }>;
  /** Per-file commits and fix commits, from git history. */
  history?: ReadonlyMap<string, { commits: number; fixes: number }>;
  config?: RiskVerdictConfig;
}

type Level = RiskVerdict["level"];

const round2 = (n: number): number => Math.round(n * 100) / 100;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Total external call sites into this file's exported symbols. */
function symbolCallersOf(b: BlastRadiusInfo): number {
  let n = 0;
  for (const s of b.exportedSymbols) n += s.usedByCount;
  return n;
}

/** Total references to the types this file defines, across the project. */
function typeReferencesOf(b: BlastRadiusInfo): number {
  let n = 0;
  for (const t of b.typeUsages ?? []) n += t.totalUsages;
  return n;
}

/**
 * Does this file define an exported interface that anything actually uses —
 * and is that plausibly what the file is FOR? See
 * `maxConcernsForInterfaceRule`.
 */
function definesUsedInterface(input: FileRiskInput, cfg: RiskVerdictConfig): boolean {
  if ((input.profile?.concernCount ?? 0) > cfg.foundation.maxConcernsForInterfaceRule) return false;
  for (const t of input.blast.typeUsages ?? []) {
    if (t.definedAt.isInterface && t.totalUsages > 0) return true;
  }
  // `typeUsages` only covers classes with resolved references. An exported
  // interface imported by a file that never mentions it in type position still
  // constitutes a contract, so fall back to the declaration plus real fan-in.
  const classes = input.analysis?.classes ?? [];
  return classes.some((c) => c.kind === "interface" && c.isExported) && input.blast.directDependents > 0;
}

/**
 * The cascade. Returns the fired rule ids per arm, in arm order; the winning
 * category is the first arm with any.
 */
function fireRules(input: FileRiskInput, cfg: RiskVerdictConfig): Array<[RiskCategory, string[]]> {
  const { blast: b, profile, layer } = input;
  const t = b.traceImpact;
  const upstream = t ? t.screenCount + t.routeCount : 0;
  const downstream = t ? t.entityCount + t.queueCount : 0;

  const foundation: string[] = [];
  if (definesUsedInterface(input, cfg)) foundation.push("exported_interface_in_use");
  if (input.declaresEntity) foundation.push("declares_data_entity");
  if (input.abstractPattern) foundation.push("abstract_or_dataclass");
  if (layer === "data" && (b.typeUsages?.length ?? 0) > 0) foundation.push("data_layer_type_definitions");

  const boundary: string[] = [];
  if (profile?.servesRequests) boundary.push("serves_api_routes");
  if (profile?.callsExternal) boundary.push("calls_external_service");
  if (profile?.boundaries.includes("queue")) boundary.push("broker_boundary");
  if (profile?.boundaries.includes("database")) boundary.push("datastore_boundary");

  const flow: string[] = [];
  if (upstream >= 1 && downstream >= 1) flow.push("on_ui_to_data_path");
  else if (upstream >= 1) flow.push("reached_by_user_facing_entry");

  const shared: string[] = [];
  if (b.directDependents >= cfg.shared.minDependents) shared.push("many_dependents");
  if (b.transitiveDependents >= cfg.shared.minTransitive) shared.push("many_transitive_dependents");
  if (symbolCallersOf(b) >= cfg.shared.minSymbolCallers) shared.push("many_symbol_callers");

  const localized: string[] = [];
  if (b.directDependents + symbolCallersOf(b) <= cfg.localized.maxFanIn) localized.push("low_fan_in");

  return [
    ["foundation", foundation],
    ["boundary", boundary],
    ["flow", flow],
    ["shared", shared],
    ["localized", localized],
  ];
}

/** Per-category level ladders — the reason this is more than a relabelled score. */
function levelFor(category: RiskCategory, input: FileRiskInput, cfg: RiskVerdictConfig): Level {
  const b = input.blast;
  const t = b.traceImpact;
  const upstream = t ? t.screenCount + t.routeCount : 0;
  const downstream = t ? t.entityCount + t.queueCount : 0;
  const importers = b.directDependents;
  const callers = symbolCallersOf(b);

  switch (category) {
    case "foundation": {
      const refs = typeReferencesOf(b);
      const f = cfg.foundation;
      if (importers >= f.criticalImporters || refs >= f.criticalRefs) return "critical";
      if (importers >= f.highImporters || refs >= f.highRefs) return "high";
      return importers >= 1 || refs >= 1 ? "medium" : "low";
    }
    case "boundary": {
      const bo = cfg.boundary;
      if (upstream >= bo.criticalUpstream) return "critical";
      if (upstream >= bo.highUpstream || callers >= bo.highSymbolCallers) return "high";
      // `importers` is the floor, not a driver: reach is what grades a
      // boundary, but a boundary something imports is never "low".
      return upstream >= 1 || callers >= 1 || importers >= 1 ? "medium" : "low";
    }
    case "flow": {
      const fl = cfg.flow;
      if (upstream >= fl.criticalUpstream && downstream >= fl.criticalDownstream) return "critical";
      if (upstream >= fl.highUpstream || downstream >= fl.highDownstream) return "high";
      return upstream >= 1 && downstream >= 1 ? "medium" : "low";
    }
    case "shared": {
      const sh = cfg.shared;
      // With no project size to divide by, the share tests simply never fire
      // and the ladder falls back to direct importers.
      const share = input.totalFiles && input.totalFiles > 0 ? b.transitiveDependents / input.totalFiles : 0;
      if (importers >= sh.critical || share >= sh.criticalTransitiveShare) return "critical";
      if (importers >= sh.high || share >= sh.highTransitiveShare) return "high";
      // The category only fires on substantial fan-in, so "low" would
      // contradict the rule that produced it.
      return "medium";
    }
    case "localized":
      return "low";
    default:
      // `unknown` has, by definition, no category-specific evidence to grade.
      // Deferring to the import-graph level keeps the verdict from
      // contradicting the number shown beside it.
      return b.level;
  }
}

/**
 * What a user would notice breaking. Carries no source-file reference: this
 * is free text, and `normalizeProject` cannot lift a path out of a sentence
 * into a `files[]` page id. Screen FILES are deliberately dropped here (they
 * are on `traceImpact`); screen ROUTES are kept even when path-shaped, since
 * routes are plain strings throughout the artifact.
 */
function behaviourAtRisk(input: FileRiskInput, cfg: RiskVerdictConfig): string[] {
  const out: string[] = [];
  const t = input.blast.traceImpact;

  if (t) {
    for (const s of t.screens.slice(0, 3)) out.push(`${s.name} screen${s.route ? ` (${s.route})` : ""}`);
    for (const r of t.routes.slice(0, 3)) out.push(`${r.method ?? "ANY"} ${r.path}`);
    if (t.entities.length) out.push(`data: ${t.entities.slice(0, 5).join(", ")}`);
    if (t.queues.length) out.push(`queues: ${t.queues.slice(0, 3).join(", ")}`);
  }

  // No cross-tier reach: the responsibility profile still knows what the file
  // does at its boundaries, which is the same question one step less precise.
  if (out.length === 0 && input.profile) {
    const p = input.profile;
    if (p.servesRequests) out.push("serves API requests");
    if (p.callsExternal) out.push("calls external services");
    if (p.emitsEvents) out.push("publishes to a message broker");
    if (p.consumesEvents) out.push("consumes broker messages");
    if (p.writesState) out.push("writes persistent state");
    else if (p.readsState) out.push("reads persistent state");
  }

  return out.slice(0, cfg.behaviourCap);
}

/** One deterministic sentence. No LLM, no template that can read as a guess. */
function summarize(category: RiskCategory, level: Level, input: FileRiskInput): string {
  const b = input.blast;
  const t = b.traceImpact;
  const upstream = t ? t.screenCount + t.routeCount : 0;
  const downstream = t ? t.entityCount + t.queueCount : 0;
  const reach = upstream > 0 ? `, reached by ${plural(upstream, "screen or route", "screens or routes")}` : "";

  switch (category) {
    case "foundation": {
      const refs = typeReferencesOf(b);
      const what = refs > 0 ? `${plural(refs, "reference")} across ${plural(b.directDependents, "file")}` : plural(b.directDependents, "dependent");
      return `Defines contracts other code is written against — ${what}${reach}. Changing its shape is a ${level}-impact change.`;
    }
    case "boundary":
      return `Sits on the system's edge${reach}. ${
        downstream > 0 ? `It reaches ${plural(downstream, "data destination")}. ` : ""
      }Changing how it talks to the outside is a ${level}-impact change.`;
    case "flow":
      return `On the path from ${plural(upstream, "user-facing entry point", "user-facing entry points")} to ${plural(
        downstream,
        "data destination",
      )} — a ${level}-impact change.`;
    case "shared":
      return `Shared internals: ${plural(b.directDependents, "file")} depend on this directly and ${plural(
        b.transitiveDependents,
        "more",
        "more",
      )} transitively. A ${level}-impact change.`;
    case "localized":
      return `Localized: ${plural(b.directDependents, "dependent")} and ${plural(
        symbolCallersOf(b),
        "external call site",
      )}. Changes stay near.`;
    default:
      return `No classifying evidence — falling back to the import graph (${b.level} impact, ${b.changeRisk} to change).`;
  }
}

/**
 * Classify one file's change risk from its evidence.
 *
 * The rule arms are tried in cascade order (foundation, boundary, flow,
 * shared, localized) and the first that fires names the category; the reasons
 * keep every arm that fired, so the evidence below the winner is not lost.
 * The level is then derived per category, and a cross-tier escalation already
 * applied upstream is named explicitly.
 *
 * @param input - The file's blast radius and the classifying evidence
 * @param config - Thresholds; defaults to `DEFAULT_RISK_VERDICT_CONFIG`
 * @returns The verdict with its category, level, reasons and summary line
 */
export function classifyRiskVerdict(input: FileRiskInput, config?: RiskVerdictConfig): RiskVerdict {
  const cfg = config ?? DEFAULT_RISK_VERDICT_CONFIG;
  const arms = fireRules(input, cfg);

  const category: RiskCategory = arms.find(([, fired]) => fired.length > 0)?.[0] ?? "unknown";

  // Reasons keep cascade order and include arms BELOW the winner: the category
  // is first-match-wins, the evidence is not.
  const reasons: string[] = arms.flatMap(([, fired]) => fired);

  // The cross-tier escalation already silently raised `changeRisk`/`level`
  // upstream of here (trace-impact.ts). Naming it is the whole point.
  if (input.blast.traceImpact) {
    const e = traceEscalationFor(input.blast.traceImpact);
    if (e.risk !== null || e.level !== null) reasons.push("cross_tier_escalation");
  }

  // A test report covered the file and ran none of it: whatever breaks, no test will say so.
  if (input.testCoverage && input.testCoverage.total > 0 && input.testCoverage.covered === 0) reasons.push("uncovered");
  // Fixed again and again: what broke here before is likely to break again.
  if (input.history && input.history.fixes >= 3 && input.history.fixes / input.history.commits >= 0.3) reasons.push("fix_prone");

  const level = levelFor(category, input, cfg);
  if (category === "unknown") {
    // Nothing fired, and nothing can have: any cross-tier reach large enough
    // to escalate also fires the `flow` arm, so `reasons` is empty here.
    reasons.push("no_classifying_evidence", "fallback_to_import_graph_level");
  }

  // Confidence is per-file availability, not a project-wide gap: a file with
  // no responsibility profile and no cross-tier reach was classified on half
  // the evidence and should say so rather than look equally certain.
  const sources = [
    input.profile !== undefined,
    input.blast.traceImpact !== undefined,
    input.analysis !== undefined,
    input.layer !== undefined && input.layer !== "unknown",
  ];
  const confidence = round2(sources.filter(Boolean).length / sources.length);

  return {
    category,
    level,
    summary: summarize(category, level, input),
    behaviourAtRisk: behaviourAtRisk(input, cfg),
    reasons,
    confidence,
  };
}

/**
 * Classify every blast entry in place. Returns the number of files that got a
 * verdict with a category other than `unknown` — the useful count for progress
 * output, since `unknown` is a non-answer.
 */
export function attachRiskVerdicts(blastRadius: BlastRadiusInfo[], input: RiskVerdictInput): number {
  const cfg = input.config ?? DEFAULT_RISK_VERDICT_CONFIG;
  const totalFiles = input.totalFiles ?? input.analyses.length;
  const analysisByFile = new Map(input.analyses.map((a) => [a.filePath, a]));
  const profileByFile = new Map((input.responsibilityProfiles ?? []).map((p) => [p.filePath, p]));

  // Files that DECLARE an entity. A table seen only in a query is synthesized
  // as an `inferred` node keyed on the file that queries it — that file is a
  // datastore boundary, not where the data model is defined.
  const entityFiles = new Set<string>();
  for (const n of input.entityGraph?.nodes ?? []) if (n.orm !== "inferred") entityFiles.add(n.filePath);

  const abstractFiles = new Set<string>();
  for (const p of input.patterns ?? []) {
    if (p.kind === "dataclass" || p.kind === "abc") abstractFiles.add(p.filePath);
  }

  let classified = 0;
  for (const blast of blastRadius) {
    const verdict = classifyRiskVerdict(
      {
        blast,
        totalFiles,
        analysis: analysisByFile.get(blast.filePath),
        profile: profileByFile.get(blast.filePath),
        layer: input.fileLayerMap?.[blast.filePath],
        declaresEntity: entityFiles.has(blast.filePath),
        abstractPattern: abstractFiles.has(blast.filePath),
        testCoverage: input.testCoverage?.get(blast.filePath),
        history: input.history?.get(blast.filePath),
      },
      cfg,
    );
    blast.verdict = verdict;
    if (verdict.category !== "unknown") classified++;
  }
  return classified;
}

/** Human wording for a reason id, for MCP text and the report. */
export const REASON_LABELS: Record<string, string> = {
  exported_interface_in_use: "defines an interface other code is typed against",
  declares_data_entity: "declares a data entity",
  abstract_or_dataclass: "declares an abstract base or data class",
  data_layer_type_definitions: "defines types in the data layer",
  serves_api_routes: "serves API routes",
  calls_external_service: "calls an external service",
  broker_boundary: "publishes or consumes broker messages",
  datastore_boundary: "talks to the datastore",
  on_ui_to_data_path: "sits on a UI-to-data path",
  reached_by_user_facing_entry: "reached by a user-facing entry point",
  many_dependents: "many direct dependents",
  many_transitive_dependents: "many transitive dependents",
  many_symbol_callers: "many external call sites",
  low_fan_in: "little depends on it",
  cross_tier_escalation: "risk raised by its cross-tier reach",
  no_classifying_evidence: "no classifying evidence",
  fallback_to_import_graph_level: "level taken from the import graph",
  uncovered: "no test runs any of it",
  fix_prone: "fixed again and again in its history",
};

/** Short, stable wording per category — the noun the report and MCP both use. */
export const CATEGORY_LABELS: Record<RiskCategory, string> = {
  foundation: "foundation",
  boundary: "boundary",
  flow: "flow",
  shared: "shared",
  localized: "localized",
  unknown: "unknown",
};

/** Reason ids → a comma-separated readable list (unknown ids pass through). */
export const describeReasons = (ids: readonly string[]): string =>
  ids.map((r) => REASON_LABELS[r] ?? r).join(", ");
