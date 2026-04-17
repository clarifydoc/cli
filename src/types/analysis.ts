/** Supported languages for analysis */
export type Language =
  | "typescript" | "javascript" | "csharp" | "python" | "java" | "kotlin" | "pascal" | "dfm"
  | "go" | "rust" | "ruby" | "php" | "swift" | "lua" | "scala";

/** Per-file analysis result */
export interface FileAnalysis {
  filePath: string;
  language: Language;
  frameworks: string[];
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

export interface CallInfo {
  name: string;
  kind: "cross-file" | "database" | "api-call" | "internal";
  target: string | null;
  line: number;
  column?: number;
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

/** Project-level summary */
export interface ProjectAnalysis {
  projectRoot: string;
  detectedFrameworks: FrameworkDetection[];
  files: string[];
  componentGraph: Record<string, string[]>;
  linkGraph: LinkInfo[];
  interactiveElements: (InteractiveElementInfo & { filePath: string })[];
  events: (EventInfo & { filePath: string })[];
  routeMap: RouteInfo[];
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
