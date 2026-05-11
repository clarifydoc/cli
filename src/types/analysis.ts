/** Supported languages for analysis */
export type Language =
  | "typescript" | "javascript" | "csharp" | "python" | "java" | "kotlin" | "pascal" | "dfm"
  | "go" | "rust" | "ruby" | "php" | "swift" | "lua" | "scala"
  | "perl" | "vb";

export interface ExtractorWarning {
  /** Dotted-path location, e.g. "functions[3].endLine" or "routes[0].kind". */
  field: string;
  message: string;
}

/**
 * Where a class/interface name is used. Distinct from CallInfo — these are
 * type-position references (parameter types, return types, field types,
 * extends/implements, generic args, casts, instantiations, variable
 * annotations), not function invocations.
 */
export type TypeUsageKind =
  | "extends"
  | "implements"
  | "parameter"
  | "return"
  | "field"
  | "variable"
  | "generic-arg"
  | "cast"
  | "instantiation";

export interface TypeReference {
  /** The original type token as it appeared in source (e.g. "Promise<User>"). */
  rawType: string;
  /** Bare identifier after stripping generics, optionals, arrays, etc. */
  typeName: string;
  usageKind: TypeUsageKind;
  /** Resolved to a project file when typeName matches a ClassInfo elsewhere. */
  resolvedTargetFile?: string;
  sourceFile: string;
  sourceLine: number;
  /** Containing symbol — "ClassName.method", "functionName", or "(top-level)". */
  sourceSymbol: string;
  /**
   * The class that contains this reference, if any. Lets the Type View
   * render a class→class graph directly. Empty for references made from
   * top-level functions or module-scope code.
   */
  sourceClass?: string;
  /** EXTRACTED for direct annotations, INFERRED for new-expr / heuristics,
   *  AMBIGUOUS when multiple files define a class with this name. */
  confidence?: Confidence;
}

/** Per-file breakdown of how a single class is used inside that file. */
export interface TypeUsageByFile {
  filePath: string;
  /** Total references in this file. */
  count: number;
  /** Reference count split by usage kind for this specific file. */
  byKind: Partial<Record<TypeUsageKind, number>>;
  /** Source-symbol → line numbers for jumping to specific sites. */
  sites: Array<{ symbol: string; line: number; kind: TypeUsageKind }>;
}

export interface TypeUsageSummary {
  /** Class/interface name being summarised. */
  typeName: string;
  /** Where the class is defined (always inside the BlastRadiusInfo's filePath). */
  definedAt: { line: number; isInterface: boolean };
  /** Reference counts grouped by usage kind, aggregated across all files. */
  usageByKind: Partial<Record<TypeUsageKind, number>>;
  /** Total reference count across all kinds. */
  totalUsages: number;
  /** Distinct files that contain at least one usage. */
  usedByFiles: string[];
  /**
   * Per-file usage breakdown. Each entry shows how many references that file
   * makes and which kinds they are. Sorted by count desc — top-impact callers
   * first. This is what the report uses to answer "where is User used as a
   * return type, specifically?".
   */
  usagesByFile: TypeUsageByFile[];
  /** Up to 100 representative reference sites — sorted by usage-kind weight. */
  topReferences: TypeReference[];
  /** Same scoring scheme as the existing BlastRadiusInfo. */
  impactScore: number;
  level: "critical" | "high" | "medium" | "low";
  changeRisk: "safe" | "moderate" | "dangerous";
}

/**
 * Class-level dependency graph derived from TypeReferences. Used by the
 * Architecture tab's "Data Models" mode toggle — answers "what does
 * changing this class touch?" visually.
 */
export interface ClassGraphNode {
  /** Unique id. For classes: "filePath::className". For file sources:
   *  "file::filePath". For external types: "external::typeName". */
  id: string;
  /** Human-readable name (class name, file basename, or external type name). */
  name: string;
  /** Where the entity lives (relative path). Empty for external types. */
  filePath: string;
  /** Heuristic — interface-like (no methods, has properties). */
  isInterface: boolean;
  /** True when the type is referenced but never declared in the project. */
  isExternal: boolean;
  /** True when the node is a file that emits class-targeting references
   *  from non-class code (top-level functions, Vue setup blocks, etc.). */
  isFile: boolean;
  /** Total inbound references to this entity (degree-in). */
  inboundCount: number;
  /** Total outbound references from this entity (degree-out). */
  outboundCount: number;
}

export interface ClassGraphEdge {
  /** Source class id (the class containing the reference). */
  source: string;
  /** Target class id (the class being referenced). */
  target: string;
  /** Per-kind reference counts on this edge. */
  byKind: Partial<Record<TypeUsageKind, number>>;
  /** Sum across kinds. */
  total: number;
  /**
   * Category derived from byKind, used by the renderer to colour the edge:
   *   - "inheritance" — extends, implements (strongest coupling)
   *   - "data" — field, variable, generic-arg (data composition)
   *   - "function" — parameter, return, cast, instantiation (signature usage)
   * Picked by max-weight kind on the edge.
   */
  category: "inheritance" | "data" | "function";
}

export interface ClassGraph {
  nodes: ClassGraphNode[];
  edges: ClassGraphEdge[];
}

/** Per-file analysis result */
export interface FileAnalysis {
  filePath: string;
  language: Language;
  frameworks: string[];
  /** ID of the sub-project this file belongs to (see SubProject). "root" if none. */
  projectId: string;
  analyzedAt: string;

  imports: ImportInfo[];
  exports: ExportInfo[];
  functions: FunctionInfo[];
  classes: ClassInfo[];
  routes: RouteInfo[];
  dataSources: DataSourceInfo[];
  dataMutations: DataMutationInfo[];
  subComponents: SubComponentInfo[];
  interactiveElements: InteractiveElementInfo[];
  events: EventInfo[];
  screens: ScreenInfo[];
  /** Schema-validation warnings produced by validateFileAnalysis(). Omitted when empty. */
  extractorWarnings?: ExtractorWarning[];
  /**
   * Per-file complexity rows (one per function/method). Persisted so an
   * incremental run can reconstruct the project-level aggregates from cached
   * FileAnalysis JSON without re-parsing.
   */
  complexities?: ComplexityInfo[];
  /** Per-file security findings — persisted for the same reason as `complexities`. */
  securityIssues?: SecurityIssue[];
  /**
   * Type-position references emitted from this file (class extends/implements,
   * parameter/return/field/variable types, generic args, casts, `new`
   * expressions). Used by `data-model-blast` to compute per-class blast
   * radius. Persisted so the incremental cache works without re-parsing.
   */
  typeReferences?: TypeReference[];
}

export interface ImportInfo {
  source: string;
  specifiers: string[];
  isDefault: boolean;
  isNamespace: boolean;
  isType: boolean;
  line: number;
}

export interface ExportInfo {
  name: string;
  kind:
    | "function"
    | "class"
    | "variable"
    | "type"
    | "interface"
    | "enum"
    | "default"
    | "re-export";
  line: number;
}

export interface ParamInfo {
  name: string;
  type: string | null;
  defaultValue: string | null;
}

/**
 * Provenance of an extracted relation:
 *   EXTRACTED — directly observable in source (import statement, exact name match, known pattern)
 *   INFERRED  — derived via a heuristic or second-pass resolver (LSP, name-shape rules, injection)
 *   AMBIGUOUS — multiple candidates matched or resolver fell back to a loose guess
 */
export type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export interface CallInfo {
  name: string;
  kind: "cross-file" | "database" | "api-call" | "internal";
  target: string | null;
  line: number;
  column?: number;
  confidence?: Confidence;
}

export interface FunctionInfo {
  name: string;
  params: ParamInfo[];
  returnType: string | null;
  isAsync: boolean;
  isExported: boolean;
  decorators: string[];
  calls: CallInfo[];
  line: number;
  endLine: number;
}

export interface PropertyInfo {
  name: string;
  type: string | null;
  visibility: "public" | "private" | "protected" | null;
  isStatic: boolean;
  isReadonly: boolean;
}

export interface ClassInfo {
  name: string;
  extends: string | null;
  implements: string[];
  decorators: string[];
  methods: FunctionInfo[];
  properties: PropertyInfo[];
  isExported: boolean;
  line: number;
  endLine: number;
}

export interface RouteInfo {
  path: string;
  httpMethod: string | null;
  kind: "frontend" | "api";
  handler: string | null;
  calls: CallInfo[];
  middleware: string[];
  line: number;
}

export interface DataSourceInfo {
  kind:
    | "api-call"
    | "prop"
    | "state"
    | "store"
    | "context"
    | "import"
    | "database"
    | "env";
  name: string;
  target: string | null;
  calls: CallInfo[];
  line: number;
}

export interface DataMutationInfo {
  kind: "setState" | "dispatch" | "assignment" | "ref-mutation" | "db-write";
  target: string;
  value: string | null;
  line: number;
}

export interface SubComponentInfo {
  name: string;
  importSource: string | null;
  props: string[];
  line: number;
}

export interface InteractiveElementInfo {
  element: "button" | "input" | "form" | "link" | "select" | "textarea" | "custom";
  event: string;
  handler: string | null;
  line: number;
}

export interface EventInfo {
  name: string;
  params: ParamInfo[];
  line: number;
}

// ─── Screen / Form types ─────────────────────────────────────────────────

export type ScreenComponentCategory =
  | "container"
  | "input"
  | "display"
  | "data"
  | "action"
  | "navigation"
  | "custom";

export interface ScreenComponentInfo {
  name: string;
  componentType: string;
  category: ScreenComponentCategory;
  caption: string | null;
  position: { left: number; top: number; width: number; height: number } | null;
  align: string | null;
  visible: boolean;
  children: ScreenComponentInfo[];
  events: string[];
  dataBindings: string[];
  line: number;
}

export interface ScreenInfo {
  name: string;
  formType: string;
  caption: string | null;
  dimensions: { width: number; height: number } | null;
  components: ScreenComponentInfo[];
  filePath: string;
  routePath: string | null;
  navigatesTo: string[];
}

export type LinkProximity = 1 | 2 | 3;

export interface LinkInfo {
  source: string;
  target: string;
  proximity: LinkProximity;
  reason: string;
  calls: string[];
  confidence?: Confidence;
}

export interface SymbolLink {
  sourceFile: string;
  sourceSymbol: string;
  sourceLine: number;
  callName: string;
  targetFile: string;
  targetSymbol: string;
  targetLine: number;
  resolvedBy?: "text" | "lsp";
  confidence?: Confidence;
}

export interface LspStats {
  serversUsed: string[];
  lspResolvedCount: number;
  referenceLinksCount: number;
  enhancementTimeMs: number;
}

// ─── Advanced analysis types ────────────────────────────────────────────

export interface ComplexityInfo {
  functionName: string;
  complexity: number;
  line: number;
  endLine: number;
}

export interface FileComplexityInfo {
  filePath: string;
  totalComplexity: number;
  maxComplexity: number;
  averageComplexity: number;
  functions: ComplexityInfo[];
}

export type PatternKind =
  | "singleton" | "factory" | "observer" | "custom-hook" | "hoc"
  | "context-provider" | "dataclass" | "abc" | "middleware"
  | "god-object" | "long-file";

export interface PatternInfo {
  kind: PatternKind;
  name: string;
  filePath: string;
  line: number;
  confidence: "high" | "medium" | "low";
  detail: string;
}

export type SecuritySeverity = "critical" | "high" | "medium" | "low";
export type SecurityCategory =
  | "hardcoded-secret" | "sql-injection" | "xss" | "eval-exec"
  | "command-injection" | "debug-statement" | "todo-fixme"
  | "pickle" | "subprocess-shell" | "bare-except";

export interface SecurityIssue {
  category: SecurityCategory;
  severity: SecuritySeverity;
  message: string;
  filePath: string;
  line: number;
  snippet: string;
}

export interface DuplicateGroup {
  functionName: string;
  occurrences: { filePath: string; line: number; similarity: number }[];
  kind: "name-based" | "structural";
}

export type ArchLayer = "ui" | "components" | "services" | "data" | "utils" | "config" | "test" | "unknown";

export interface LayerViolation {
  sourceFile: string;
  sourceLayer: ArchLayer;
  targetFile: string;
  targetLayer: ArchLayer;
  importSpecifier: string;
  line: number;
}

export interface BlastSymbolUsage {
  name: string;
  usedByCount: number;
  callers: { file: string; line: number }[];
}

export interface BlastRadiusInfo {
  filePath: string;
  directDependents: number;
  transitiveDependents: number;
  impactScore: number;
  centrality: number;
  level: "critical" | "high" | "medium" | "low";
  affectedFiles: string[];
  transitiveFiles: string[];
  dependsOn: string[];
  exportedSymbols: BlastSymbolUsage[];
  changeRisk: "safe" | "moderate" | "dangerous";
  maxDepth: number;
  /** Per-class type-usage breakdown for classes defined in THIS file.
   *  Omitted (or empty) when the file defines no classes. Lets the report
   *  answer "if I change User, what's the blast?" alongside the existing
   *  file-level answer. */
  typeUsages?: TypeUsageSummary[];
}

export interface HealthScore {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  penalties: { reason: string; points: number }[];
}

export interface Suggestion {
  priority: "critical" | "high" | "medium" | "low";
  category: string;
  message: string;
  filePath?: string;
  actionable: string;
}

export type SubProjectKind =
  | "node"
  | "dotnet"
  | "delphi"
  | "lazarus"
  | "java-maven"
  | "java-gradle"
  | "rust"
  | "go"
  | "python"
  | "php"
  | "ruby"
  | "swift"
  | "root";

export interface SubProject {
  id: string;
  name: string;
  root: string;
  kind: SubProjectKind;
  markers: string[];
}

/** Project-level summary */
export interface ProjectAnalysis {
  projectRoot: string;
  detectedFrameworks: FrameworkDetection[];
  /** Detected sub-projects (monorepo packages, multi-language repos, etc.). */
  subProjects: SubProject[];
  /** Map from file path to owning sub-project id. */
  fileProjects: Record<string, string>;
  files: string[];
  componentGraph: Record<string, string[]>;
  linkGraph: LinkInfo[];
  interactiveElements: (InteractiveElementInfo & { filePath: string })[];
  events: (EventInfo & { filePath: string })[];
  routeMap: RouteInfo[];
  /**
   * Outbound API calls — HTTP calls made FROM client code to external or internal endpoints.
   * Aggregated from each file's `dataSources` where `kind === "api-call"`.
   */
  apiCalls: (DataSourceInfo & { filePath: string })[];
  screens: ScreenInfo[];
  symbolLinks: SymbolLink[];
  lspStats?: LspStats;
  analyzedAt: string;

  // Advanced analysis (optional)
  complexity?: FileComplexityInfo[];
  patterns?: PatternInfo[];
  securityIssues?: SecurityIssue[];
  duplicates?: DuplicateGroup[];
  layerViolations?: LayerViolation[];
  blastRadius?: BlastRadiusInfo[];
  healthScore?: HealthScore;
  suggestions?: Suggestion[];
  fileLayerMap?: Record<string, ArchLayer>;
  /** Aggregate provenance counts across symbolLinks for at-a-glance quality assessment. */
  confidenceCounts?: { extracted: number; inferred: number; ambiguous: number };
  /** Paths the discovery layer silently skipped because their names look like credentials. */
  skippedSensitive?: string[];
  /** Louvain-detected communities (community ID → file paths). Largest first. */
  communities?: Record<string, string[]>;
  /** Cohesion ∈ [0, 1] for each community ID — intra-community edges / max possible. */
  cohesion?: Record<string, number>;
  /** Top files by combined in+out degree — the structural core of the project. */
  godNodes?: Array<{ file: string; degree: number }>;
  /** Cross-community / low-confidence / peripheral→hub links worth a second look. */
  surprisingConnections?: Array<{
    source: string;
    target: string;
    confidence?: Confidence;
    relation: string;
    score: number;
    reason: string;
  }>;
  /** Auto-generated exploration questions derived from graph topology. */
  suggestedQuestions?: Array<{
    type: "ambiguous-edge" | "bridge-node" | "isolated-node" | "low-cohesion";
    question: string;
    why: string;
  }>;
  /** Class-level dependency graph for the Architecture tab's Data Models mode. */
  classGraph?: ClassGraph;
}

export interface FrameworkDetection {
  id: string;
  name: string;
  confidence: "high" | "medium" | "low";
  detectedVia: string;
}

/** Create an empty FileAnalysis for a given file */
export function createEmptyAnalysis(
  filePath: string,
  language: Language,
): FileAnalysis {
  return {
    filePath,
    language,
    frameworks: [],
    projectId: "root",
    analyzedAt: new Date().toISOString(),
    imports: [],
    exports: [],
    functions: [],
    classes: [],
    routes: [],
    dataSources: [],
    dataMutations: [],
    subComponents: [],
    interactiveElements: [],
    events: [],
    screens: [],
  };
}
