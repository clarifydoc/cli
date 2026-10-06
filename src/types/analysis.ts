/** Supported languages for analysis */
export type Language =
  | "typescript" | "javascript" | "csharp" | "python" | "java" | "kotlin" | "pascal" | "dfm"
  | "go" | "rust" | "ruby" | "php" | "swift" | "lua" | "scala"
  | "perl" | "vb" | "sql" | "c" | "cpp" | "prisma" | "dart" | "elixir" | "erlang" | "objc"
  | "haskell" | "clojure" | "blazor" | "html" | "qml" | "qtui" | "xaml" | "jsp" | "springxml" | "jsight"
  | "openapi" | "graphql" | "wsdl";

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

  /**
   * Set ONLY when tree-sitter parsing failed and extraction silently fell back
   * to regex. A fallback result is indistinguishable from a first-class regex
   * language on disk — no complexity rows, coarser calls, no AST routes — so
   * without this marker a broken or missing grammar degrades every file of that
   * language with no signal at all. Absent means the normal path ran (which
   * path that was is derivable from `language` plus the plugin registry).
   */
  extraction?: {
    method: "regex";
    fallback: true;
    /** Closed set: raw error text carries absolute grammar paths and would churn fixtures. */
    reason: "grammar-unavailable" | "null-tree" | "parser-error";
  };

  /**
   * Physical line count of the source file. Feeds file-size signals (refactor
   * pressure, context burden) without re-reading the file. Absent on artifacts
   * written before extractor 1.50.
   */
  lineCount?: number;

  imports: ImportInfo[];
  exports: ExportInfo[];
  functions: FunctionInfo[];
  classes: ClassInfo[];
  routes: RouteInfo[];
  dataSources: DataSourceInfo[];
  dataMutations: DataMutationInfo[];
  /**
   * Named string constants defined in this file (`#define CUE_TABLE "cues"`,
   * `const QString kTable = QStringLiteral("x")`). Project-level enrichment
   * resolves macro-valued dataSource targets/entities through the union of
   * these maps (a DAO's table macro is usually defined in its header).
   * Omitted when empty.
   */
  stringConstants?: Record<string, string>;
  subComponents: SubComponentInfo[];
  interactiveElements: InteractiveElementInfo[];
  /**
   * Nested component tree mirroring the frontend template's element nesting
   * (with `repeated` set on looped nodes). Populated for frontend files
   * (Vue/React/Svelte/Angular); empty/absent otherwise. `buildScreen` consumes
   * it to reproduce real nesting instead of the flat sub-component fallback.
   */
  templateTree?: TemplateComponentNode[];
  /**
   * For an Angular `@Component` that references an EXTERNAL template
   * (`templateUrl: './x.component.html'`) instead of an inline `template:`
   * string — the raw url. A project-level pass reads the sibling .html and
   * back-fills this component's `interactiveElements`/`templateTree` from it
   * (the per-file pass can't, as it never sees sibling files). Omitted for
   * inline-template or non-Angular files.
   */
  angularTemplateUrl?: string;
  /**
   * Custom-element (Web Component) registrations in this file, so the component
   * graph can resolve `<kebab-tag>` markup usages to the file that defines them.
   * Omitted when the file registers none.
   */
  customElements?: CustomElementDef[];
  /**
   * Project paths this file names as string DATA rather than importing —
   * `import.meta.glob("./pages/*.vue")`, `new URL("./worker.ts",
   * import.meta.url)`, a jest config's `"<rootDir>/setup.ts"`. The toolchain
   * loads them, so reachability (dead-code analysis) follows them; nothing
   * else does, since they are not dependencies in the import sense. Specs as
   * written (globs allowed), resolved by the language plugin's
   * `reachability` model. Omitted when the file names none.
   */
  pathReferences?: string[];
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
   * Minified or bundled build artifact (webpack output, `*.min.js`-shaped
   * content) — not authored source. Project-level detectors (duplicates,
   * patterns, health) exclude these files the way they exclude generatedRoots.
   */
  minified?: boolean;
  /**
   * Opens with a third-party license/attribution header — vendored source
   * committed into the repo. Only honored at aggregation when such files are
   * a small minority (open-source repos stamp a license on every authored
   * file — that must not disable their scanning).
   */
  vendored?: boolean;
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
  /**
   * Re-exports only: the module the name is forwarded from, as written
   * (`export { x } from "./y"` → "./y"). `export * from "./y"` is recorded as
   * name "*". Absent on a local `export { x }`, which also has kind
   * "re-export" but forwards nothing.
   */
  source?: string;
  /** Re-exports only: the name inside `source`, when the re-export renames it (`export { a as b } from` → "a"). */
  sourceName?: string;
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
   * args so an `axios.get(requestUri('vikarbesked','v4'))` api-call gets a
   * concrete URL that joins to the backend route. Optional; only JS/TS sets it.
   */
  urlTemplate?: string;
  /**
   * The helper's OTHER url templates, when its body returns a different URL
   * per branch (`isEmployee ? base + "/api/personale/" + p : base + "/api/" + p`
   * → `urlTemplate` `/api/personale/{p}`, alternatives `["/api/{p}"]`). Source
   * order; a branch that only differs in a dropped base is not listed twice.
   * Absent when there is exactly one template.
   */
  urlTemplateAlternatives?: string[];
  /**
   * What this function reads from an HTTP request when it is a route handler
   * whose bindings are not declared in its signature — `req.body.name`,
   * `c.ShouldBindJSON(&input)`, `req.content.decode(T.self)`,
   * `params.require(:user)`. Extracted per file by the plugin from the body;
   * the project-level join (`core/request-schemas.ts`) copies it onto the
   * route that names this function as its handler, so a Go/Express/Vapor
   * route gets `params` although its registration line never shows them.
   */
  requestAccess?: RouteParamInfo[];
}

export interface PropertyInfo {
  name: string;
  type: string | null;
  visibility: "public" | "private" | "protected" | null;
  isStatic: boolean;
  isReadonly: boolean;
  /**
   * Attributes/annotations on the member, full text with arguments
   * (`Required`, `JsonPropertyName("start_date")`). Optional; populated by
   * plugins that read them (C#), consumed by the request-schema pass.
   */
  decorators?: string[];
  /** Language-level "must be set" marker (C# 11 `required` modifier). */
  isRequired?: boolean;
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
  /**
   * "interface" marks abstract types so the linker can route calls to concrete
   * implementations; "enum" marks a closed set of named values (its members
   * are the `properties`), which the request-schema pass renders as a string
   * enum instead of an object.
   */
  kind?: "class" | "interface" | "enum";
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
  /**
   * Guards and filters applied to the route, as readable strings: Express
   * middleware names, ASP.NET `Authorize(Policy=…)` / `AllowAnonymous`
   * attributes (class-level ones inherited by every action). The structured
   * form of the auth subset is `auth`.
   */
  middleware: string[];
  line: number;
  /**
   * Who may call the route, when the framework states it declaratively
   * (`[Authorize(Policy = …)]`, `@PreAuthorize`, `@UseGuards`). Absent when no
   * auth attribute is visible on the action or its class — which is "unknown",
   * not "open": a global policy may still apply.
   */
  auth?: RouteAuthInfo;
  /**
   * API versions the route serves, as declared (`[ApiVersion("2")]` → "2",
   * `[ApiVersion(2.0)]` → "2.0"). Absent for unversioned or version-neutral
   * routes. The cross-tier linker uses it to pick the twin that serves the
   * concrete version a client calls (`/api/v3/…`).
   */
  versions?: string[];
  /** Subset of `versions` marked deprecated (`[ApiVersion("2", Deprecated = true)]`). */
  deprecatedVersions?: string[];
  /**
   * The action's parameters with where each binds from in the request. Lets a
   * consumer that CALLS the endpoint know what body, query and route values it
   * takes — the per-file `FunctionInfo.params` has names and types but not the
   * binding.
   */
  params?: RouteParamInfo[];
}

/** Where a route handler parameter is read from. */
export type RouteParamBinding =
  | "body"
  | "query"
  | "route"
  | "header"
  | "form"
  | "services";

export interface RouteParamInfo {
  name: string;
  type: string | null;
  /** Null when neither declared nor inferable. */
  binding: RouteParamBinding | null;
  /**
   * True when `binding` was derived from the framework's default rules (the
   * name appears in the path template; a complex type on an `[ApiController]`
   * binds from the body) rather than an explicit `[FromX]` attribute.
   */
  inferred?: boolean;
}

/**
 * The subset of JSON Schema the request-schema pass emits for a route's body:
 * enough for a caller to build a valid request, small enough to embed per
 * route. `$ref` names a type that was not resolved (or was cut by the depth
 * cap) so the consumer can look it up in `classes` instead.
 */
export interface JsonSchemaNode {
  type?: "object" | "array" | "string" | "integer" | "number" | "boolean";
  format?: string;
  nullable?: boolean;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  $ref?: string;
  enum?: string[];
  additionalProperties?: JsonSchemaNode | boolean;
}

export interface RouteAuthInfo {
  /** Named policies (`Policy = nameof(Rettighed.Vikardaekke)` → "Rettighed.Vikardaekke"). */
  policies: string[];
  /** Required roles (`Roles = "Admin,Editor"` → ["Admin","Editor"]). */
  roles: string[];
  /** Authentication schemes (`AuthenticationSchemes = IstPersonale` → "IstPersonale"). */
  schemes: string[];
  /** `[AllowAnonymous]` — overrides any `Authorize` on the class. */
  anonymous: boolean;
  /** True when every guard came from the enclosing class, none from the action itself. */
  inherited: boolean;
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
  /**
   * How the path was matched, which `confidence` alone cannot tell you.
   *
   * `exact` and `method-fallback` are the difference between "this route serves
   * this call" and "some route at this path does"; `base-prefix:<p>` means the
   * two sides disagreed about a proxy base (`/api`) and names the prefix that
   * reconciled them — the one piece of evidence needed to judge whether the
   * match is real or an artefact of the default prefix list. `version-mismatch`
   * means the client named a concrete API version (`/api/v5/`) that no route
   * at that path declares serving; `target` is the best remaining guess.
   */
  matchedVia?: "exact" | "method-fallback" | "version-mismatch" | `base-prefix:${string}`;
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
  /**
   * For `api-call`: the named environment variable of a leading base that was
   * stripped to keep `target` app-relative (e.g. `VITE_API` from
   * `import.meta.env.VITE_API + "/api/x"`). Display/deployment-facing; `target`
   * stays app-relative so the route join is unaffected. Populated by the
   * symbolic value resolver.
   */
  baseEnv?: string;
  /**
   * For `api-call`: the other URLs this call may resolve to, when it goes
   * through a URL-builder helper whose body returns a different URL per branch
   * (see `FunctionInfo.urlTemplateAlternatives`). `target` is the first branch;
   * the route join tries these in order when `target` matches no route.
   */
  targetAlternatives?: string[];
  /**
   * For `kind === "database"`: whether the op reads or writes, when the plugin's
   * ORM knowledge can tell (e.g. `findMany` → read, `create`/`save` → write).
   * Absent = unclassified (the dataflow-lite pass keeps such an access as the
   * coarse `db` effect rather than guessing). The write-verb knowledge stays in
   * the language plugins — core never inspects method names.
   */
  access?: "read" | "write";
  /**
   * Provenance of a resolved `target`: EXTRACTED (fully literal), INFERRED (the
   * fold left `{param}`/`{}`/`{env}` holes), or AMBIGUOUS (a conflicting
   * binding). Absent when `target` was a plain literal needing no resolution.
   */
  targetConfidence?: Confidence;
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

/**
 * A custom-element (Web Component) registration in a JS/TS file:
 * `customElements.define("user-card", UserCard)` or Lit
 * `@customElement("user-card") class UserCard`. Web components are used in
 * markup by their kebab-case TAG (`<user-card>`), not by an imported symbol, so
 * the component graph joins a `<user-card>` usage to its defining file through
 * these registrations (a tag→file index) rather than an import path.
 */
export interface CustomElementDef {
  /** The registered kebab-case tag (`user-card`). */
  tag: string;
  /** The implementing class/constructor name (`UserCard`). */
  className: string;
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
   * (`<IstButton @click=…>` → "IstButton"). Joined against the file's
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
  /**
   * How the application creates this screen at startup, when it does.
   *
   * A Delphi `.dpr` states this outright: the FIRST `Application.CreateForm`
   * is the main form — the window the user gets when the app launches, and the
   * root of the navigation graph — and any later ones are auto-created at
   * startup but shown on demand. Absent for every screen the app constructs
   * later on (the normal case).
   */
  startup?: "main" | "auto-created";
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

/**
 * Which resolution strategy produced a `SymbolLink`.
 *
 * `confidence` says how much to trust an edge; this says *why* it exists. The
 * two are not the same question: an `INFERRED` link from inheritance lookup and
 * an `INFERRED` link from a globally-unique-name guess warrant very different
 * scepticism, and without this tag `lsp:compare` cannot attribute a conflict to
 * the strategy that caused it — which is what `AGENTS.md`'s standing rule
 * "reject any strategy that introduces conflicts" requires to be enforceable.
 *
 * Names are short because they are rendered to users (`[inferred via
 * unique-global]`). Grouped below in the order the linker attempts them.
 */
export type SymbolLinkStrategy =
  // ── Call cascade (symbol-linker.ts `resolveCallToDefinition`) ──
  /** Exact name (or leaf) found in the target file — no heuristic applied. */
  | "direct"
  /** Walked the extends-chain to a parent's member. */
  | "inheritance"
  /** Receiver's declared type is an interface; linked past it to the implementation. */
  | "interface-redirect"
  /** Receiver type came from DI registration, a param type, or a local `new`. */
  | "injection"
  /** Cross-file qualified call matched by dotted suffix (`prisma.user.findMany`). */
  | "deep-qualified"
  /** Member absent from the target module; routed to the factory in `CallInfo.via`. */
  | "factory-via"
  /** `ClassName.method` resolved through the class-name index. */
  | "class-name"
  /** `new X` / bare class instantiation. */
  | "constructor"
  /** Head of the call is an import alias resolving to one file. */
  | "import-file"
  /** Head of the call is an import naming a directory; unique-or-nothing tail match. */
  | "import-dir"
  /** Unique leaf name project-wide, backed by evidence (same dir, or actually imported). */
  | "unique-global"
  /**
   * Unique leaf name project-wide with NO import evidence either way — the
   * import-blind-ecosystem fallback (CodeIgniter-style autoloading). Strictly
   * weaker than `unique-global`; kept separate precisely so it can be measured
   * and, if it earns its keep poorly, dropped on its own.
   */
  | "unique-global-blind"
  /** Linked to a generic type argument's class (`_context.Set<Account>()`). */
  | "type-argument"
  // ── Outer pipeline (symbol-linker.ts `buildSymbolLinks`) ──
  /** Frontend route → the component file its handler names. */
  | "route-component"
  /** Route file IS the page component; anchored at its own setup block. */
  | "route-self"
  /** Last-resort global scan for a route handler name. */
  | "route-scan"
  /** Spec route (OpenAPI/WSDL/GraphQL) joined to an implementation by name. */
  | "spec-join"
  /** Interface → each implementation, for navigation only. */
  | "interface-fanout"
  /** Reverse edge from an import specifier back to the symbol it names. */
  | "reference"
  // ── Produced outside the linker ──
  /** Frontend api-call matched to the backend route serving it. */
  | "api-route"
  /** Message-queue publish matched to its consumer. */
  | "queue"
  /** Language server `textDocument/definition`. */
  | "lsp-definition"
  /** Language server `textDocument/references`. */
  | "lsp-reference"
  /** A plugin dispatch resolver, identified by its `id` (`dispatch:mediatr`). */
  | `dispatch:${string}`;

/**
 * What KIND of edge this is, as opposed to how it was found.
 *
 * Consumers used to sniff strings for this (`sourceSymbol === "(reference)"`),
 * which is both fragile and silent when it drifts.
 */
export type SymbolLinkRelation =
  /** A call from one symbol to another. The default. */
  | "calls"
  /** Construction of a type (`new X`). */
  | "instantiates"
  /** Interface → implementation, either direction. */
  | "implements"
  /** Crosses the HTTP boundary: a client call to the route that serves it. */
  | "http"
  /** Crosses a message queue: publish → consume. */
  | "mq"
  /** Resolved through a framework's indirection rather than a direct call. */
  | "dispatch"
  /** A reverse edge from an import back to the symbol it names, not a call. */
  | "reference";

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
   * The strategy that produced this link, as it FINALLY stands.
   *
   * Two things follow from "finally". `dedupSymbolLinks` keeps the
   * highest-confidence duplicate, so when several strategies find the same edge
   * this records the one that won, not every one that agreed. And a link that
   * is later re-aimed (LSP's interface redirect) is re-tagged at that point
   * rather than keeping the tag of whatever first created it.
   */
  strategy?: SymbolLinkStrategy;
  /** What kind of edge this is (call, instantiation, HTTP hop, …). */
  relation?: SymbolLinkRelation;
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
 * Default `relation` for a strategy. Every producer knows its strategy, and for
 * all but a handful the relation follows from it — so deriving here keeps the
 * two fields consistent by construction instead of asking twenty call sites to
 * remember both.
 */
export function relationForStrategy(strategy: SymbolLinkStrategy): SymbolLinkRelation {
  if (strategy.startsWith("dispatch:")) return "dispatch";
  switch (strategy) {
    case "constructor":
      return "instantiates";
    // Only the fan-out edge asserts the implements relationship. A redirect is
    // an ordinary call that merely had to go through the interface to find its
    // target — labelling it "implements" would tell a consumer the caller
    // implements something, which it does not.
    case "interface-fanout":
      return "implements";
    case "api-route":
      return "http";
    case "queue":
      return "mq";
    case "reference":
    case "lsp-reference":
      return "reference";
    default:
      return "calls";
  }
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

/**
 * A data-access effect kind for the transitive propagation pass. `db` is the
 * coarse historical bucket (the engine records `DataSourceInfo.kind === "database"`
 * without a read/write flag); `db-read`/`db-write` are reserved for a later
 * refinement (a plugin-provided classifier / DataMutationInfo join) and are not
 * populated yet.
 */
export type DataEffectKind =
  | "db"
  | "db-read"
  | "db-write"
  | "queue-publish"
  | "queue-consume"
  | "api-call";

/** One data-access effect reached (directly or transitively) from a symbol. */
export interface ReachedEffect {
  kind: DataEffectKind;
  /** Entity/table, broker destination, or api target the effect touches. */
  resource: string;
  /** File where the effect is DIRECTLY performed. */
  originFile: string;
  /** Symbol ("Class.method" | "fn") where the effect is directly performed. */
  originSymbol: string;
  /** 0 = direct; ≥1 = transitive (call-graph hops to the nearest origin). */
  distance: number;
  /** EXTRACTED at distance 0; INFERRED transitively; AMBIGUOUS if a heuristic link is on the path. */
  confidence: Confidence;
}

/**
 * Per-symbol "dataflow-lite" summary: the set of data-access effects a
 * function reaches through the call graph, computed by transitive propagation
 * (data-flow-reach.ts). Emitted only for symbols that reach at least one effect.
 */
export interface SymbolReachSummary {
  /** Defining file of the symbol (matches SymbolLink.sourceFile). */
  file: string;
  /** Symbol name ("Class.method" | "fn", matches SymbolLink.sourceSymbol). */
  symbol: string;
  /** Reached effects (capped; true totals in `effectCounts`), most-direct first. */
  effects: ReachedEffect[];
  /** Count of reached effects per kind (exact even when `effects` is capped). */
  effectCounts: Partial<Record<DataEffectKind, number>>;
  /** True when at least one effect is reached transitively (distance ≥ 1). */
  hasTransitive: boolean;
}

/**
 * A source→sink row: a UI/route entry point that transitively reaches a data
 * effect. The natural payoff of the reach pass — e.g. filter on
 * `effect === "db-write"` for "which handlers reach a DB write". Grounded in the
 * existing call graph, not a taint engine.
 */
export interface DataFlowPath {
  entryKind: "route" | "screen";
  /** "POST /api/orders" for a route, or the screen name. */
  entryLabel: string;
  entryFile: string;
  effect: DataEffectKind;
  resource: string;
  distance: number;
  confidence: Confidence;
}

export interface LspStats {
  serversUsed: string[];
  lspResolvedCount: number;
  referenceLinksCount: number;
  enhancementTimeMs: number;
  /** When the enhancement was produced. Absent on deltas written before this was recorded. */
  enhancedAt?: string;
  /**
   * The delta predates the analysis it was found next to, so its graphs describe
   * source that has since been re-analyzed and were NOT merged. Run `lsp-update`
   * to refresh it.
   */
  stale?: boolean;
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
  /** Cyclomatic complexity: 1 + branches + logical operators. */
  complexity: number;
  line: number;
  endLine: number;
  /**
   * Cognitive complexity (an approximation of SonarSource's metric): every
   * branch adds 1 plus its nesting depth, `else`/`elif` continuations add 1
   * without a depth penalty, logical operators add 1. Separates "many flat
   * cases" from "deeply nested logic", which the cyclomatic number cannot.
   * Absent on rows written by extractor versions before 1.49.
   */
  cognitive?: number;
  /** Deepest branch nesting in the body — 0 for a branch-free body, 1 for a
   *  single `if`, 2 for an `if` inside a loop. Absent before 1.49. */
  nestingDepth?: number;
  /** Declared parameter count. Absent before 1.49. */
  paramCount?: number;
}

export interface FileComplexityInfo {
  filePath: string;
  totalComplexity: number;
  maxComplexity: number;
  averageComplexity: number;
  /** Sum / max of the per-function cognitive complexity. Absent before 1.49. */
  totalCognitive?: number;
  maxCognitive?: number;
  /** Deepest nesting across the file's functions. Absent before 1.49. */
  maxNestingDepth?: number;
  functions: ComplexityInfo[];
}

/** Per-file git activity inside the history window (git-history.ts). */
export interface FileChurnInfo {
  /** Project-relative path, matching files[]. */
  file: string;
  /** Commits touching the file inside the window. */
  commits: number;
  additions: number;
  deletions: number;
  /** ISO timestamp of the most recent commit touching the file. */
  lastTouched: string;
  /** Top contributors by commit count (max 3). */
  authors: string[];
  authorCount: number;
}

/** Churn × complexity hotspot — where the codebase actually hurts. */
export interface HotspotInfo {
  file: string;
  /** normalizedCommits × normalizedTotalComplexity, (0..1], 3 decimals. */
  score: number;
  commits: number;
  totalComplexity: number;
}

// ─── Responsibility profile (responsibility-profile.ts) ────────────────────

/** An external boundary a file touches, derived from imports, data sources, routes and screens. */
export type BoundaryKind =
  | "database" | "http" | "graphql" | "grpc" | "queue" | "auth" | "logging"
  | "cloud" | "serialization" | "validation" | "ui" | "state" | "config"
  | "cache" | "filesystem" | "email";

/** The workflow concern a boundary evidences. */
export type WorkflowRole =
  | "persistence" | "transport" | "messaging" | "security" | "observability"
  | "integration" | "mapping" | "validation" | "presentation" | "configuration"
  | "caching";

export interface BoundaryEvidence {
  kind: BoundaryKind;
  /** Where the evidence came from. */
  source: "import" | "data-source" | "data-mutation" | "route" | "screen";
  /** Import specifier, call name, route or screen name. */
  name: string;
  /** 1-based; absent for evidence without a location (screens). */
  line?: number;
  /** What the file does at that boundary — `use` when only the import is visible. */
  operation?: "read" | "write" | "use" | "call" | "serve" | "publish" | "consume" | "route" | "render";
}

/**
 * Which concerns one file mixes. Present only for files with at least one
 * boundary. `concernCount` is the number of distinct roles minus the
 * ubiquitous ones (observability, configuration) — the responsibility-spread
 * signal the god-object function count cannot give.
 */
export interface ResponsibilityProfile {
  filePath: string;
  boundaries: BoundaryKind[];
  roles: WorkflowRole[];
  concernCount: number;
  /** Distinct non-relative import roots — library fan-out. */
  externalPackageCount: number;
  readsState: boolean;
  writesState: boolean;
  emitsEvents: boolean;
  consumesEvents: boolean;
  /** Declares at least one API route. */
  servesRequests: boolean;
  /** Calls HTTP/GraphQL/gRPC/cloud services. */
  callsExternal: boolean;
  /** Total evidence rows found; `evidence` is capped. */
  evidenceCount: number;
  evidence: BoundaryEvidence[];

  /**
   * How the concerns are DISTRIBUTED inside the file. A 900-line module where
   * one function touches the queue and the rest do not is a very different
   * refactoring job from one where every function mixes database, HTTP and
   * queue, and the file-level count cannot tell them apart. Absent when no
   * boundary evidence could be attributed to a function span.
   */
  symbolsWithBoundary?: number;
  /** Functions that mix two or more non-ubiquitous concerns on their own. */
  mixedSymbols?: number;
  /** The highest concern count carried by any single function. */
  maxSymbolConcerns?: number;
  /** The most concern-heavy functions, most concerns first. Capped. */
  topSymbols?: Array<{ symbol: string; line: number; boundaries: BoundaryKind[] }>;
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

/** One screen whose execution transitively reaches the blast subject file. */
export interface TraceImpactScreen {
  /** Screen display name (ScreenInfo.name). */
  name: string;
  /** The screen's file — deep-link target for the Screens & UI tab. */
  file: string;
  /** Frontend route serving the screen, when routed. */
  route: string | null;
}

/** One API route whose handler transitively calls into the blast subject file. */
export interface TraceImpactRoute {
  /** HTTP method, uppercased; null when the route matches any verb. */
  method: string | null;
  path: string;
  /** File declaring the route. */
  file: string;
  line: number;
}

/**
 * Cross-tier projection of a file's blast radius, computed over the SAME
 * symbol-link graph Call Traces use (including the synthetic HTTP and MQ
 * edges): upstream, the screens and API routes whose execution transitively
 * reaches a symbol in this file; downstream, the ER entities and message-broker
 * destinations the file's symbols ultimately touch. Lists are capped — the
 * `*Count` fields carry the true totals.
 */
export interface TraceImpactInfo {
  screens: TraceImpactScreen[];
  screenCount: number;
  routes: TraceImpactRoute[];
  routeCount: number;
  /** ER entity names (EntityGraph node names) transitively read/written. */
  entities: string[];
  entityCount: number;
  /** Broker destinations (exchange/queue/topic) transitively published to or consumed from. */
  queues: string[];
  queueCount: number;
}

/**
 * What KIND of thing a file is, for the purpose of deciding what changing it
 * means. The import graph answers "how much depends on this"; the category
 * answers "what sort of dependency", which is what decides whether 5 importers
 * is critical (a contract others are typed against) or unremarkable (a util).
 *
 * `unknown` is a legitimate outcome, not a failure — a file with no
 * classifying evidence says so instead of being guessed at.
 */
export type RiskCategory =
  | "foundation" | "boundary" | "flow" | "shared" | "localized" | "unknown";

/**
 * The interpretation layer over `BlastRadiusInfo`'s counts: a category, a
 * level derived from the thresholds that apply TO THAT CATEGORY, and the
 * rules that produced both.
 *
 * `reasons` is the point of the whole record. A category without the rule
 * that fired is astrology, so every verdict names its evidence the way
 * `RefactorPressureInfo.drivers` does, using the same stable-identifier
 * idiom (`REASON_LABELS` / `describeReasons` in `core/risk-verdict.ts`).
 */
export interface RiskVerdict {
  category: RiskCategory;
  /**
   * Reuses `BlastRadiusInfo["level"]`'s union deliberately — the codebase
   * already carries five scoring idioms and this is not a sixth. Derived
   * per-category, so it does NOT track the sibling `level` field.
   */
  level: "critical" | "high" | "medium" | "low";
  /** One deterministic sentence built from the category and the counts. */
  summary: string;
  /**
   * The user-visible behaviour that changes with this file — screen names,
   * route labels, entities written.
   *
   * Carries no SOURCE FILE reference: this is free text, so a file path
   * embedded here could not be lifted into a `files[]` page id by
   * `normalizeProject`, and would drift the moment a file moved. The paths
   * are already carried structurally on `traceImpact`. Route strings are
   * fine even when they look path-like (`/api/orders`, and static-site
   * screens whose route IS an html path) — routes are plain strings
   * everywhere in the artifact and are never page-encoded.
   *
   * Capped; `traceImpact`'s `*Count` fields hold the totals.
   */
  behaviourAtRisk: string[];
  /** Every rule that fired, in cascade order. Never empty. */
  reasons: string[];
  /** 0..1 — share of the evidence sources that were available for this file. */
  confidence: number;
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
  /** Cross-tier reach: screens/routes that depend on this file and the
   *  entities/queues it touches. Omitted when the file has none. */
  traceImpact?: TraceImpactInfo;
  /**
   * How much must be read to edit this file safely: its two-hop neighborhood
   * over imports AND importers (blast radius looks downstream only), with a
   * size estimate. An agent-facing signal — a file whose neighborhood is 40
   * files and 30k tokens cannot be changed from a single context window.
   */
  contextBurden?: ContextBurden;
  /**
   * The verdict over the counts above: what kind of file this is, how bad
   * changing it is FOR THAT KIND, and why. Additive — `changeRisk` and
   * `level` keep their existing meaning and values. Omitted on artifacts
   * written before the classifier existed.
   */
  verdict?: RiskVerdict;
}

export interface ContextBurden {
  /** Distinct files within two hops in either direction, excluding the file itself. */
  files: number;
  /** Physical lines of the file plus its neighborhood; null when no line counts are known. */
  lines: number | null;
  /** Rough token estimate (≈10 tokens per line); null when `lines` is null. */
  estimatedTokens: number | null;
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
  /** The concrete signals behind the suggestion (e.g. refactor-pressure drivers). Optional. */
  evidence?: string[];
  /** 0..1 — how much of the signal the suggestion rests on was actually available. Optional. */
  confidence?: number;
}

// ─── Refactor pressure (refactor-pressure.ts) ──────────────────────────────

/** Recommendation band derived from the score and any fired gates. */
export type RefactorPressureBand = "none" | "observe" | "suggest" | "strong" | "urgent";

/**
 * One file's composite refactor pressure: where to refactor FIRST. Combines
 * complexity, size, mixed concerns, coupling and churn into a 0–100 score
 * with an explicit list of the drivers behind it, the hard gates that fired
 * and a confidence that says how much of the signal was available (no git
 * history, no complexity for regex-only languages, …).
 */
export interface RefactorPressureInfo {
  filePath: string;
  /** 0–100, one decimal. */
  score: number;
  band: RefactorPressureBand;
  /** Normalized 0–100 sub-scores; `null` when that signal was unavailable for the project. */
  components: {
    complexity: number | null;
    size: number | null;
    responsibility: number;
    coupling: number;
    churn: number | null;
  };
  /** Evidence categories that pushed the score (stable identifiers). */
  drivers: string[];
  /** Hard gates that fired regardless of the weighted score. */
  gates: string[];
  /** 0..1 — share of the component weight that had evidence. */
  confidence: number;
  /**
   * Where inside the file the concerns sit, when a responsibility profile could
   * attribute them to functions. Turns "this file mixes four concerns" into
   * advice that names the functions to split off.
   */
  concentration?: {
    symbolsWithBoundary: number;
    mixedSymbols: number;
    topSymbols: Array<{ symbol: string; line: number; boundaries: BoundaryKind[] }>;
  };
  evidence: {
    loc: number | null;
    functions: number;
    maxCyclomatic: number;
    totalCyclomatic: number;
    maxCognitive: number | null;
    totalCognitive: number | null;
    maxNestingDepth: number | null;
    concernCount: number;
    roles: WorkflowRole[];
    directDependents: number;
    transitiveDependents: number;
    dependsOn: number;
    inCycle: boolean;
    layerViolations: number;
    commits: number | null;
    authors: number | null;
  };
}

export type SubProjectKind =
  | "node"
  | "dotnet"
  | "cmake"
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

/**
 * Layer-1 dead-code findings: what a static walk from the project's entry
 * points cannot reach. Precision over recall throughout — a file or export
 * the analysis cannot account for is left out, never flagged.
 */
export interface DeadCodeReport {
  /** Languages whose files were judged (their plugin declares a reachability model). */
  languages: Language[];
  /** Files judged: authored, non-test, in a judged language, in a project with an entry point. */
  judgedFiles: number;
  /** Judged files that are entry points themselves (toolchain manifest or framework convention). */
  entryFiles: number;
  /**
   * Projects (sub-project roots, "" for the analyzed root) holding files of a
   * judged language that were NOT judged, and why — a project with no
   * detectable entry point for those languages has nothing to measure
   * reachability from. Anchoring is per language: one row per project and
   * language model.
   */
  skippedProjects?: Array<{ root: string; files: number; languages?: Language[]; reason: string }>;
  /**
   * Imports that look local (`@/x`, `~/x`) but name nothing analyzed. Each
   * may hide an edge, so unreachable files in a project with any are AMBIGUOUS.
   */
  unresolvedImports?: number;
  files: UnreachableFile[];
  exports: UnusedExport[];
}

export interface UnreachableFile {
  filePath: string;
  /**
   * INFERRED — nothing reaches it. AMBIGUOUS — nothing reaches it through an
   * import, but a reachable file names it (a call, type or tag spelled like
   * its basename), so it may be loaded by convention (auto-import, global
   * registration) the resolver cannot see.
   */
  confidence: Confidence;
  /** Other unreachable files that import it; 0 = top of a dead cluster, the one to delete first. */
  deadImporters: number;
  lineCount?: number;
}

export interface UnusedExport {
  filePath: string;
  name: string;
  kind: ExportInfo["kind"];
  line: number;
  /** Still referenced inside its own file: drop the `export`, don't delete the declaration. */
  usedInFile: boolean;
}

/** Project-level summary */
/**
 * What produced this analysis and what it was able to see.
 *
 * A consumer — an MCP client, the viewer, a downstream ingester, or a person
 * diffing two runs — could not tell which extractor version wrote a summary
 * (that lived only in `manifest.json`, and only on incremental runs), whether
 * a config was found and applied, whether git history was available, or
 * whether any file silently fell back to regex. Config validation warnings
 * were computed and then printed to a verbose console, which is exactly where
 * nobody analyzing from an editor or through MCP would ever see them.
 */
export interface AnalysisProvenance {
  extractorVersion: string;
  /** On-disk normalization format of `project-summary.json`. */
  schemaVersion: number;
  toolVersion: string;
  incremental: boolean;
  /** Files reused from the cache on an incremental run. */
  reusedFiles?: number;
  config: {
    /** Whether `.clarifydoc/config.json` was found. */
    present: boolean;
    /** Validation and lint messages; empty when the file is absent or clean. */
    warnings: string[];
  };
  signals: {
    lsp: "applied" | "absent";
    gitHistory: "applied" | "disabled" | "skipped";
    /** Why git history was skipped (not a repository, shallow clone, …). */
    gitSkipReason?: string;
  };
  /** Files carrying extractor warnings from schema validation. */
  extractorWarningFiles: number;
  /** Files whose tree-sitter parse failed and fell back to regex, by language. */
  parseFallbacks?: Record<string, number>;
}

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
  /**
   * Every route in the project, one row per (sub-project, method, path,
   * version set). `projectId` names the sub-project the declaring file
   * belongs to — the same endpoint hosted by two services is two rows.
   */
  routeMap: (RouteInfo & { filePath?: string; projectId?: string; requestSchema?: JsonSchemaNode })[];
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
  /** Per-file git activity in the history window; absent for non-repos,
   *  shallow clones, or `--no-git-history` runs. */
  fileChurn?: FileChurnInfo[];
  /** Top churn × complexity hotspots (derived from fileChurn + complexity). */
  hotspots?: HotspotInfo[];
  /** Per-file boundary/concern profile for files that touch at least one
   *  boundary (responsibility-profile.ts). Omitted when empty. */
  responsibilityProfiles?: ResponsibilityProfile[];
  /** Files with measurable refactor pressure, highest first (refactor-pressure.ts). Omitted when empty. */
  refactorPressure?: RefactorPressureInfo[];
  fileLayerMap?: Record<string, ArchLayer>;
  /** What produced this analysis and what it could see. Omitted on old artifacts. */
  provenance?: AnalysisProvenance;
  /** Auto-detected generated/library barrel roots (e.g. kubb output dirs). */
  generatedRoots?: string[];
  /** Files under a generated root that nothing outside that tree imports (dead code). */
  unusedFiles?: string[];
  /**
   * Authored code no entry point reaches, and exports nothing imports
   * (core/dead-code.ts `analyzeReachability`). Only languages whose plugin
   * declares a `reachability` model are judged. Omitted when nothing was.
   */
  deadCode?: DeadCodeReport;
  /** Aggregate provenance counts across symbolLinks for at-a-glance quality assessment. */
  confidenceCounts?: { extracted: number; inferred: number; ambiguous: number };
  /** Paths the discovery layer silently skipped because their names look like credentials. */
  skippedSensitive?: string[];
  /**
   * Symlinked source paths discovery refused to read — the link leaves the
   * project root, dangles, or names a non-file. Linked directories are never
   * descended at all.
   */
  skippedSymlinks?: string[];
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
  /** Transitive "dataflow-lite" reach: per-symbol summary of the data-access
   *  effects each function reaches through the call graph (data-flow-reach.ts).
   *  Omitted when the project has no data access. */
  symbolReach?: SymbolReachSummary[];
  /** Source→sink rows: UI/route entry points that transitively reach a data
   *  effect (e.g. handlers that reach a DB write). Omitted when empty. */
  dataFlows?: DataFlowPath[];
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
  | "clojars"
  | "git";

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
  | "cache"
  | "filesystem"
  | "email"
  | "other";

/**
 * One external dependency declared in a project manifest (package.json,
 * *.csproj, go.mod, …), cross-referenced against the code that actually imports
 * it. This is the inventory the framework detector consumes and the report
 * surfaces — ClarifyDoc should know not just *which* frameworks a repo
 * uses but its full third-party surface and how much of it is live.
 */
export interface ExternalPackage {
  /** Canonical package name in its ecosystem (`react`, `gorm.io/gorm`, `Microsoft.EntityFrameworkCore`). */
  name: string;
  /**
   * Declared version / range spec, when the manifest carries one; for
   * ecosystems with a lockfile fallback (rubygems), the lock's exact resolved
   * version when the manifest declares none.
   */
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
