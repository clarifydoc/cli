/** Supported languages for analysis */
export type Language =
  | "typescript" | "javascript" | "csharp" | "python" | "java" | "kotlin" | "pascal" | "dfm"
  | "go" | "rust" | "ruby" | "php" | "swift" | "lua" | "scala"
  | "perl" | "vb" | "sql" | "c" | "cpp" | "prisma" | "dart" | "elixir" | "erlang" | "objc"
  | "haskell" | "clojure" | "blazor" | "html";

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
   *  "file::filePath". For external types: "::typeName" (empty owning file). */
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
  /** True when this class carries an `["entity", <orm>]` decorator — i.e. it
   *  is an ORM entity that also appears as a node in the ER diagram. Lets the
   *  Data Models view distinguish DB-backed entities from plain models/DTOs. */
  isEntity?: boolean;
  /** ORM tag for entity nodes ("prisma" | "typeorm" | …); null/undefined otherwise. */
  orm?: string | null;
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

/**
 * Entity-relationship graph for the report's "Data Model" (ER diagram) view.
 * Nodes are ORM entities / SQL tables / enums (from entity-decorated
 * `ClassInfo`); edges are derived from `entityRelations`, with mirror pairs
 * merged into one relationship carrying crow's-foot multiplicity at each end.
 */
export interface EntityGraphColumn {
  name: string;
  type: string | null;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
}

/**
 * A data/view model (class, interface, DTO) that references an entity in type
 * position (field/variable/generic-arg). Derived by joining the ClassGraph
 * onto the EntityGraph by name — see `linkEntityModels` in entity-graph.ts.
 */
export interface EntityModelRef {
  /** ClassGraph node id of the referencing model (`${filePath}::${name}`). */
  id: string;
  name: string;
  filePath: string;
  /** Heuristic interface-vs-class hint carried over from the ClassGraph node. */
  isInterface: boolean;
  /** Data-position usage kinds backing the link (field, variable, generic-arg). */
  kinds: TypeUsageKind[];
  /** Total data-position references from this model to the entity. */
  count: number;
}

export interface EntityGraphNode {
  /** `${filePath}::${name}` — unique even when two files define the same name. */
  id: string;
  name: string;
  /** Originating ORM / source, e.g. "prisma" | "typeorm" | "sql". */
  orm: string | null;
  kind: "entity" | "enum";
  filePath: string;
  columns: EntityGraphColumn[];
  line: number;
  /** Data/view models that hold this entity in type position. Omitted when none. */
  referencingModels?: EntityModelRef[];
}

export interface EntityGraphEdge {
  /** Source/target node ids, in canonical (sorted) orientation. */
  source: string;
  target: string;
  /** Multiplicity at each end ("one" or "many") — drives crow's-foot notation. */
  sourceCardinality: "one" | "many";
  targetCardinality: "one" | "many";
  /** Navigation field name(s) backing the relationship. */
  fields: string[];
  /** Owning-side foreign-key column, when known. */
  foreignKey?: string | null;
  /** Join/through/pivot table for many-to-many relationships, when named. */
  joinTable?: string | null;
  orm?: string | null;
  confidence?: Confidence;
  /** True for a self-referential relationship (source === target). */
  selfRef?: boolean;
}

export interface EntityGraph {
  nodes: EntityGraphNode[];
  edges: EntityGraphEdge[];
}

/**
 * Project-wide data-access graph. One synthetic "datastore" node per unique
 * data-source target (e.g. `@prisma/client`, `Microsoft.EntityFrameworkCore`,
 * `../lib/prisma`), plus one node per file that performs DB calls. Edges
 * carry the actual call sites so the UI can render per-edge detail.
 */
export interface DataAccessNode {
  /** Unique id. For files: `file::<path>`. For datastores: `db::<target>`.
   *  For entities: `entity::<target>::<entity>`. For queues: `queue::<target>`. */
  id: string;
  /** Display name (file basename, datastore target, or entity/table name). */
  name: string;
  /** "file" for caller files; "datastore" for synthetic DB sinks;
   *  "entity" for a specific table/model under a datastore;
   *  "queue" for message-broker destinations (exchange/queue/topic) —
   *  publish edges point file→queue, consume edges queue→file. */
  kind: "file" | "datastore" | "entity" | "queue";
  /** File path for "file" nodes. Empty for datastore/entity nodes. */
  filePath: string;
  /** Number of incoming edges (only meaningful for datastore nodes). */
  inboundCount: number;
  /** Number of outgoing edges (only meaningful for file nodes). */
  outboundCount: number;
}

export interface DataAccessEdgeCall {
  /** Call expression as captured (e.g. `prisma.user.findMany`). */
  name: string;
  line: number;
  /** Resolved entity/table this call touches (e.g. `user`), when derivable. */
  entity?: string;
}

export interface DataAccessEdge {
  /** Source file node id. */
  source: string;
  /** Target datastore node id. */
  target: string;
  /** Individual call sites that produced this edge. */
  calls: DataAccessEdgeCall[];
  /** Sum of `calls.length`. Surfaced for fast edge-weight sorting. */
  total: number;
}

export interface DataAccessGraph {
  nodes: DataAccessNode[];
  edges: DataAccessEdge[];
}

/** Per-file analysis result */
export interface FileAnalysis {
  filePath: string;
  language: Language;
  frameworks: string[];
  /** ID of the sub-project this file belongs to (see SubProject). "root" if none. */
  projectId: string;

  imports: ImportInfo[];
  exports: ExportInfo[];
  functions: FunctionInfo[];
  classes: ClassInfo[];
  routes: RouteInfo[];
  dataSources: DataSourceInfo[];
  dataMutations: DataMutationInfo[];
  subComponents: SubComponentInfo[];
  interactiveElements: InteractiveElementInfo[];
  /**
   * Nested component tree mirroring the frontend template's element nesting
   * (with `repeated` set on looped nodes). Populated for frontend files
   * (Vue/React/Svelte/Angular); empty/absent otherwise. `buildScreen` consumes
   * it to reproduce real nesting instead of the flat sub-component fallback.
   */
  templateTree?: TemplateComponentNode[];
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
  /**
   * ORM entity relations for entities defined in this file (associations /
   * foreign keys with cardinality), emitted by the language `entities`
   * extractor. Omitted when empty. Persisted for the incremental cache.
   */
  entityRelations?: EntityRelation[];
  /**
   * Tables parsed from a Rails `db/schema.rb`. Only set on the schema file
   * itself; a project-level join attaches these columns to the model entities
   * (whose own class bodies declare no columns). Omitted for non-schema files.
   */
  railsSchemaTables?: RailsSchemaTable[];
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
  /**
   * The FACTORY function this call's receiver was bound from, when the
   * binding is visible (`const m = useAddLicenseMutation(...)` →
   * `m.mutateAsync(...)` carries via:"useAddLicenseMutation"). When the call's
   * leaf doesn't exist in the target module (the member lives on a
   * library-made object — a tanstack mutation, an event emitter), the symbol
   * linker falls back to linking the factory itself, which is where the
   * meaningful project code (mutationFn → service call) sits.
   */
  via?: string;
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
  /**
   * Local variables assigned a constructed instance in this body
   * (`$x = new Foo()` → `{ name: "x", type: "Foo" }`). Lets the symbol linker
   * resolve `x.method()` to `Foo.method` without LSP — the common "construct a
   * client/connection locally, then call it" pattern. Optional; populated only
   * by plugins that extract it.
   */
  localTypes?: Array<{ name: string; type: string }>;
  /**
   * For a URL-builder helper — a function whose return value is an
   * app-relative request URL assembled from string concatenation / a template
   * (`requestUri(endpoint, version) → /api/{version}/institution/{}/{endpoint}`)
   * — the parameterized URL template: path literals verbatim, each parameter
   * as `{paramName}`, and any unresolvable runtime reference (env base, closure
   * variable) as `{}`. A project-level pass substitutes a call site's literal
   * args so an `axios.get(requestUri('teamtalk','v4'))` api-call gets a
   * concrete URL that joins to the backend route. Optional; only JS/TS sets it.
   */
  urlTemplate?: string;
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
  /** "interface" marks abstract types so the linker can route calls to concrete implementations. */
  kind?: "class" | "interface";
}

export interface RouteInfo {
  path: string;
  httpMethod: string | null;
  kind: "frontend" | "api";
  handler: string | null;
  /**
   * For frontend routes: the raw module specifier of the route's `component`
   * (e.g. "./pak.vue" from `component: () => import("./pak.vue")`, or the
   * identifier name for a statically-imported component). Lets the screen
   * builder follow the route to the actual page file instead of treating the
   * route-config file as the screen. Null for API routes or when no component
   * could be identified.
   */
  componentPath?: string | null;
  calls: CallInfo[];
  middleware: string[];
  line: number;
}

/**
 * A resolved frontend→backend link: an outbound `api-call` (from client code)
 * matched to the inbound `api` route that serves it, by HTTP method + a
 * structurally-normalized path (case/separator-insensitive, with both
 * `${param}` template literals and `{param}`/`:param` route params collapsed to
 * a wildcard). This is the keystone of the "screen → API → DB" chain: it joins
 * the two route halves the extractors produce independently. `source`/`target`
 * are project-relative file paths in memory (page_ids on disk).
 */
export interface ApiRouteLink {
  /** Frontend file containing the api-call. */
  source: string;
  sourceLine: number;
  /** HTTP method of the call (GET/POST/…), uppercased; null if not derivable. */
  method: string | null;
  /** Raw outbound target as written in the client (e.g. `/access-report/roles/${roleId}/holders`). */
  url: string;
  /** Backend file declaring the matched route. */
  target: string;
  targetLine: number;
  /** Matched route's handler/action name. */
  handler: string | null;
  /** Matched route's full path (e.g. `/AccessReport/roles/{roleId}/holders`). */
  routePath: string;
  /**
   * EXTRACTED — method + path matched exactly (one route).
   * INFERRED  — path matched but method differed/was unknown.
   * AMBIGUOUS — more than one route matched; `target` is the first.
   */
  confidence: Confidence;
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
    | "env"
    | "queue-publish"
    | "queue-consume";
  name: string;
  /**
   * For queue kinds: the broker destination — exchange (RabbitMQ publish),
   * queue (consume / sendToQueue), or topic (Kafka). May be a non-literal
   * expression's source text (`_eventConsumerConfiguration.Queue`) when the
   * name is resolved at runtime; still useful as a label and join key.
   */
  target: string | null;
  calls: CallInfo[];
  line: number;
  /**
   * Resolved ORM entity/model/table this DB op touches, when derivable from
   * the call chain (e.g. "user" from `prisma.user.findMany`) or the DML target
   * (e.g. the table named in `knex("users")`). Only meaningful for
   * `kind === "database"`. Populated by `enrichFileDataSources`.
   *
   * For `queue-publish`: the routing key or message type when statically
   * visible (`GrantExpiringMessage.RoutingKey`, `new OrderCreatedEvent(...)` →
   * "OrderCreatedEvent") — the business-level name of the event.
   */
  entity?: string;
}

/**
 * A relation between two ORM entities, richer than `ClassInfo.implements`
 * (which only records the related name). Emitted per file alongside the
 * entity `ClassInfo`s a file defines, by the language `entities` extractor.
 */
export interface EntityRelation {
  /** Entity declaring the relation — matches a ClassInfo.name in this file. */
  fromEntity: string;
  /** Field/property on fromEntity holding the relation (e.g. "author", "posts"). */
  fromField: string;
  /** Target entity name — matches a ClassInfo.name somewhere in the project. */
  toEntity: string;
  cardinality: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
  /** Owning-side foreign-key column, when the ORM declares it (e.g. "authorId"). */
  foreignKey?: string | null;
  /** Inverse field on toEntity, when the ORM declares both sides. */
  inverseField?: string | null;
  /** Join/through/pivot table for many-to-many relations, when named. */
  joinTable?: string | null;
  /** Whether the relation is optional (nullable FK). */
  optional?: boolean;
  /** Originating ORM, e.g. "prisma" | "typeorm" | "gorm". */
  orm?: string;
  /** EXTRACTED for explicit schema/decorators, INFERRED for name heuristics. */
  confidence?: Confidence;
}

/**
 * One `create_table` block parsed from a Rails `db/schema.rb` (the consolidated
 * schema dump). ActiveRecord/Sequel models declare no columns in the model
 * class — they live in the schema — so this carries the column list that a
 * project-level join (`applyRailsSchemaColumns`) attaches to the matching model
 * entity by table-name convention. Emitted on the schema file's FileAnalysis.
 */
export interface RailsSchemaTable {
  /** Physical table name as written in `create_table "..."` (e.g. "absences"). */
  table: string;
  /** Columns in declaration order; the implicit `id` primary key is prepended. */
  columns: PropertyInfo[];
}

/**
 * A detected ORM/DB migration file or directory, surfaced at the project level
 * so the report can show schema evolution chronologically.
 */
export interface MigrationInfo {
  /** Migration file (or migration-dir's representative file), relative path. */
  filePath: string;
  ecosystem:
    | "prisma"
    | "typeorm"
    | "sequelize"
    | "rails"
    | "django"
    | "ef-core"
    | "gorm"
    | "diesel"
    | "doctrine"
    | "flyway"
    | "liquibase"
    | "alembic";
  /** Migration name/identifier parsed from the path (timestamp + slug, version). */
  name: string;
  /** Sort key — timestamp or numeric version when parseable, else the name. */
  order: string;
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

/** A component usage from a frontend template, flat & de-duped. */
export interface TemplateComponent {
  name: string;
  props: string[];
  line: number;
}

/**
 * Framework-neutral nested component tree node. Produced per-frontend (Vue SFC
 * template, React JSX AST, Svelte/Angular templates) and consumed uniformly by
 * `treeToComponents` to build the screen's `ScreenComponentInfo` tree.
 */
export interface TemplateComponentNode extends TemplateComponent {
  /** True when this node is rendered in a loop — it carries the framework's
   *  loop construct (Vue `v-for`, Angular `*ngFor`, Svelte `{#each}`,
   *  React `.map()`), or an enclosing element/scope does. */
  repeated: boolean;
  /** For an interactive HTML element promoted into the tree (`<button>` with a
   *  handler, bound `<input>`, …) — its element kind. Undefined for components. */
  element?: "button" | "input" | "form" | "link" | "select" | "textarea";
  /** Child nodes (components or interactive elements) nested under this one. */
  children: TemplateComponentNode[];
}

export interface InteractiveElementInfo {
  element: "button" | "input" | "form" | "link" | "select" | "textarea" | "custom";
  event: string;
  handler: string | null;
  line: number;
  /**
   * For `element === "custom"`: the component tag the binding sits on
   * (`<MyButton @click=…>` → "MyButton"). Joined against the file's
   * subComponents to wire a child's `emit('save')` to THIS parent handler —
   * without the tag, two children used in one template are indistinguishable.
   */
  component?: string;
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
  /** True for a component rendered in a loop (Vue `v-for`, or an enclosing
   *  `v-for`). Drives the loop badge in the screen's component tree. */
  repeated?: boolean;
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

/**
 * A "this file opens that component" relationship, derived from a dynamic
 * `import("./X.vue")`. Captured directly (a function in `sourceFile` imports the
 * component) or transitively through a launcher function — e.g. a screen calls
 * a dialog barrel's `DutyDialog()`, which itself `import()`s the dialog SFC.
 * Powers the Screens & UI pane's "opens" / "opened by" cross-links for dialogs
 * and other lazily-mounted components that never appear as template tags.
 */
export interface ComponentLaunch {
  /** File that opens the component (a page/screen, or the launcher's own file). */
  sourceFile: string;
  /** Symbol in `sourceFile` that triggers the open (the calling function, or
   *  the launcher function itself for a direct import). */
  sourceSymbol: string;
  /** The component file being opened (e.g. a dialog SFC). */
  targetFile: string;
  /** Launcher function the open routes through (e.g. "DutyDialog"); equals
   *  `sourceSymbol` for a direct dynamic import in `sourceFile`. */
  launcher: string;
  /** Line of the call/import in `sourceFile`. */
  line: number;
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
  /**
   * True for *navigational* edges that aid the trace view but are NOT real
   * dependencies — specifically interface→implementation fan-out (an interface
   * does not depend on its implementors). Excluded from the component dependency
   * graph so they don't fabricate cycles across every sibling that shares an
   * interface. In-memory only (not persisted in the normalized summary).
   */
  navigational?: boolean;
}

/**
 * A database access attributed to the function/method that contains it — the
 * bridge between the symbol-level Call Traces graph and the entity-level Data
 * Model. One entry per (file, symbol, entity); `sites` lists the DB call lines.
 * Built by `attributeDataAccessToSymbols` in data-access-graph.ts.
 */
export interface SymbolDataAccess {
  /** Defining file of the containing function. */
  file: string;
  /** Containing symbol — "Class.method" | "functionName" (matches SymbolLink.sourceSymbol). */
  symbol: string;
  /** Containing function's start line. */
  symbolLine: number;
  /** Entity touched: the ER-diagram node name when matched, else the raw call segment. */
  entity: string;
  /** True when `entity` resolves to an EntityGraphNode name (drives the reverse ER view). */
  entityMatched: boolean;
  /** Datastore target, e.g. "@prisma/client" (null when unresolved). */
  datastore: string | null;
  /**
   * How the symbol touches the resource. Absent = "database" (the historical
   * meaning). Queue kinds mark message-broker I/O: `entity` is the routing
   * key / message type / topic and `datastore` the exchange/queue — the
   * "event on RabbitMQ" endpoint of a button→…→event trace.
   */
  access?: "queue-publish" | "queue-consume";
  /** Individual DB call sites inside the function, sorted by line. */
  sites: Array<{ name: string; line: number }>;
}

export interface LspStats {
  serversUsed: string[];
  lspResolvedCount: number;
  referenceLinksCount: number;
  enhancementTimeMs: number;
}

/**
 * One textDocument/definition query and its raw answer, recorded so the
 * text-based linker can be measured against what LSP resolved.
 * `target: null` means LSP was queried but returned no definition —
 * the text linker shouldn't be expected to resolve those either.
 */
export interface LspDefinitionRecord {
  sourceFile: string;
  sourceSymbol: string;
  line: number;
  column: number;
  callName: string;
  callKind: string;
  language: Language;
  /** Raw LSP answer (file + 1-based line), before interface redirection. */
  target: { file: string; line: number } | null;
  /** Where the link was re-aimed when interface→implementation redirection changed the target. */
  redirectedTarget?: { file: string; symbol: string; line: number };
}

/** One textDocument/references query: the exported symbol and every non-self reference LSP found. */
export interface LspReferenceRecord {
  symbolFile: string;
  symbolName: string;
  symbolLine: number;
  language: Language;
  references: { file: string; line: number }[];
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
  | "dart"
  | "root";

export interface SubProject {
  id: string;
  name: string;
  root: string;
  kind: SubProjectKind;
  markers: string[];
  /**
   * Frameworks/ORMs detected from this sub-project's own manifests (its nested
   * `package.json`, `Gemfile`, `*.csproj`, …). A repo whose build files live in
   * sub-project roots rather than the analyzed root only surfaces them here.
   */
  frameworks?: FrameworkDetection[];
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
  /**
   * Resolved frontend→backend links: each outbound `api-call` matched to the
   * inbound `api` route that serves it. Joins the two halves of the
   * screen→API→DB chain. Omitted when empty (e.g. pure frontend/backend repos).
   */
  apiRouteLinks?: ApiRouteLink[];
  /** Per-file child-component usages (JSX/Vue-template tags), with import source as `target`. */
  componentUsage?: (SubComponentInfo & { filePath: string })[];
  symbolLinks: SymbolLink[];
  /** Dynamic-import "opens component" relationships (dialogs, lazy components)
   *  derived from symbolLinks. Drives the Screens & UI "opens" / "opened by"
   *  cross-links. Omitted when empty. */
  componentLaunches?: ComponentLaunch[];
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
  /** Auto-detected generated/library barrel roots (e.g. kubb output dirs). */
  generatedRoots?: string[];
  /** Files under a generated root that nothing outside that tree imports (dead code). */
  unusedFiles?: string[];
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
  dataAccessGraph?: DataAccessGraph;
  /** Entity-relationship graph for the "Data Model" (ER diagram) view. */
  entityGraph?: EntityGraph;
  /** DB accesses attributed to the function that contains them — bridges the
   *  symbol-level Call Traces to the entity-level Data Model. Omitted when empty. */
  symbolDataAccess?: SymbolDataAccess[];
  /** Detected ORM/DB migrations across known ecosystems. Omitted when empty. */
  migrations?: MigrationInfo[];
  /**
   * Full third-party dependency inventory across every manifest ecosystem,
   * cross-referenced against the imports in analyzed code. Drives the report's
   * Dependencies view and feeds the framework detector. Omitted when the
   * project declares no external dependencies.
   */
  externalPackages?: ExternalPackage[];
  /**
   * Deployment topology parsed from container-orchestration manifests
   * (docker-compose/compose files): the deployed services, the infrastructure
   * they attach to, and the service→service edges evidenced by injected
   * API keys / connection strings / URLs. Drives the Architecture tab's
   * Context (C1) and Deployment (C2) levels. Omitted when no compose files.
   */
  deployment?: DeploymentModel;
}

// ─── Deployment topology (compose files) ───────────────────────────────────

/** Broad role of a deployed service, classified from its image/name. */
export type DeployedServiceKind =
  | "app"
  | "datastore"
  | "queue"
  | "cache"
  | "proxy"
  | "observability"
  | "other";

export interface DeployedService {
  /** Compose service name — unique across all parsed compose files. */
  name: string;
  /** Repo-relative posix path of the compose file that declared it (primary). */
  composeFile: string;
  /**
   * Every compose file that declares this service. Repos often carry several
   * deployment stacks (legacy + current, base + local variant) — this is what
   * lets the report filter the Deployment view down to one stack.
   */
  composeFiles?: string[];
  image?: string;
  /** Joined entrypoint/command, when declared (e.g. "dotnet Plan.API.dll"). */
  entrypoint?: string;
  kind: DeployedServiceKind;
  /** Infra family for merging instances (postgres, firebird, rabbitmq, redis…). */
  family?: string;
  /** Short tech label: entrypoint artifact or image tail. */
  tech?: string;
  /** Matched SubProject id — links the deployed unit to its source code. */
  project?: string;
  /** Attaches to a message bus (EventBus/AMQP/Kafka env vars present). */
  bus?: boolean;
  /** Uses a shared cache (Redis/Memcached env vars present). */
  cache?: boolean;
  /** Logical databases named by this service's connection-string env vars. */
  databases?: Array<{ name: string; primary: boolean }>;
  /** Databases hosted BY this service (datastore kind), e.g. POSTGRES_MULTIPLE_DATABASES. */
  hostedDatabases?: string[];
}

export interface DeploymentEdge {
  /** Compose service name, or an `ext:` external id. */
  from: string;
  to: string;
  kind: "http" | "db" | "bus" | "external" | "depends";
  /** Human hint: logical db name, external host, … */
  label?: string;
  /** Env var that evidenced the edge. */
  via?: string;
}

/** A system outside the compose network, evidenced by env URLs/issuers. */
export interface DeploymentExternal {
  /** Stable id, `ext:<slug>`. */
  id: string;
  name: string;
  /** Literal URL when one was present in the env (not a ${VAR} placeholder). */
  url?: string;
}

export interface DeploymentModel {
  /** Repo-relative posix paths of every compose file that contributed. */
  composeFiles: string[];
  services: DeployedService[];
  externals: DeploymentExternal[];
  edges: DeploymentEdge[];
}

export interface FrameworkDetection {
  id: string;
  name: string;
  confidence: "high" | "medium" | "low";
  detectedVia: string;
}

/** Package-manager ecosystem a dependency was declared in. */
export type PackageEcosystem =
  | "npm"
  | "nuget"
  | "pypi"
  | "maven"
  | "gradle"
  | "composer"
  | "cargo"
  | "go"
  | "rubygems"
  | "pub"
  | "swiftpm"
  | "cocoapods"
  | "vcpkg"
  | "conan"
  | "cpan"
  | "luarocks"
  | "hex"
  | "hackage"
  | "clojars";

/** How a dependency is consumed (production vs tooling-only). */
export type PackageScope = "prod" | "dev" | "peer" | "optional";

/**
 * Best-effort functional bucket for an external dependency. `framework` and
 * `orm` mirror the dedicated detectors; the rest let the report group the long
 * tail (build tooling, test runners, HTTP clients, …) instead of one flat list.
 */
export type PackageCategory =
  | "framework"
  | "frontend"
  | "orm"
  | "database"
  | "http"
  | "state"
  | "ui"
  | "testing"
  | "build"
  | "lint"
  | "auth"
  | "validation"
  | "logging"
  | "messaging"
  | "serialization"
  | "graphql"
  | "grpc"
  | "cloud"
  | "types"
  | "util"
  | "other";

/**
 * One external dependency declared in a project manifest (package.json,
 * *.csproj, go.mod, …), cross-referenced against the code that actually imports
 * it. This is the inventory the framework detector consumes and the report
 * surfaces — a reverse-doc tool should know not just *which* frameworks a repo
 * uses but its full third-party surface and how much of it is live.
 */
export interface ExternalPackage {
  /** Canonical package name in its ecosystem (`react`, `gorm.io/gorm`, `Microsoft.EntityFrameworkCore`). */
  name: string;
  /** Declared version / range spec, when the manifest carries one. */
  version: string | null;
  ecosystem: PackageEcosystem;
  scope: PackageScope;
  category: PackageCategory;
  /**
   * Whether any analyzed source file imports this package. `undefined` means
   * usage could not be reliably mapped for this ecosystem (e.g. Maven/NuGet,
   * where imports are namespaces, not artifact coordinates) — we never assert
   * "unused" when the import→package mapping is unreliable.
   */
  used?: boolean;
  /** Number of analyzed files importing it (only set when `used` is known). */
  usageCount?: number;
  /** Manifest the dependency was declared in, relative to the project root. */
  declaredIn: string;
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
    imports: [],
    exports: [],
    functions: [],
    classes: [],
    routes: [],
    dataSources: [],
    dataMutations: [],
    subComponents: [],
    interactiveElements: [],
    templateTree: [],
    events: [],
    screens: [],
  };
}
